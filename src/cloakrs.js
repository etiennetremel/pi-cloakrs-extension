import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundledBinary = join(root, "bin", process.platform === "win32" ? "cloakrs.exe" : "cloakrs");

export const WITHHELD = "[REDACTED: cloakrs failed; content withheld]";
export const MAX_INPUT_BYTES = 1024 * 1024;
export const MAX_INPUT_ITEMS = 1000;
export const MAX_STDOUT_BYTES = 2 * 1024 * 1024;
export const MAX_STDERR_BYTES = 64 * 1024;
export const MAX_CONCURRENT_REDACTIONS = 4;
export const MAX_GRAPH_BYTES = 16 * 1024 * 1024;
export const MAX_GRAPH_DEPTH = 100;
export const MAX_GRAPH_PROPERTIES = 10_000;

let activeRedactions = 0;

export function hideHomePath(value, home = homedir(), platform = process.platform) {
  if (!home || home === "/") return value;
  if (platform !== "win32") {
    return value.replaceAll(home, "~").replaceAll(home.replaceAll("\\", "/"), "~");
  }

  const pattern = home
    .split(/[\\/]/)
    .map(part => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("[\\\\/]");
  return value.replace(new RegExp(`${pattern}(?=$|[\\\\/])`, "gi"), "~");
}

export function cloakrsBinary() {
  return process.env.PI_CLOAKRS_BINARY || (existsSync(bundledBinary) ? bundledBinary : "cloakrs");
}

export function redactStrings(values, { timeoutMs = 5_000, signal } = {}) {
  if (!Array.isArray(values)) {
    return Promise.reject(new TypeError("redactStrings expects an array of strings"));
  }
  if (values.length > MAX_INPUT_ITEMS) {
    return Promise.reject(new Error(`redaction input exceeds ${MAX_INPUT_ITEMS} items`));
  }
  if (values.some(value => typeof value !== "string")) {
    return Promise.reject(new TypeError("redactStrings expects an array of strings"));
  }
  if (values.length === 0) return Promise.resolve(values);
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("redaction aborted"));
  if (values.reduce((bytes, value) => bytes + Buffer.byteLength(value), 0) > MAX_INPUT_BYTES) {
    return Promise.reject(new Error(`redaction input exceeds ${MAX_INPUT_BYTES} bytes`));
  }
  if (activeRedactions >= MAX_CONCURRENT_REDACTIONS) {
    return Promise.reject(new Error("too many concurrent redactions"));
  }

  // Keep local paths usable without exposing the username portion.
  values = values.map(value => hideHomePath(value));
  const input = `${JSON.stringify(values)}\n`;
  if (Buffer.byteLength(input) > MAX_INPUT_BYTES) {
    return Promise.reject(new Error(`serialized redaction input exceeds ${MAX_INPUT_BYTES} bytes`));
  }

  return new Promise((resolve, reject) => {
    const child = spawn(cloakrsBinary(), [
      "--locale", process.env.PI_CLOAKRS_LOCALE || "nl",
      "--strategy", "redact",
      "--min-confidence", process.env.PI_CLOAKRS_MIN_CONFIDENCE || "0.35",
      "--quiet",
      "stream",
    ], { stdio: ["pipe", "pipe", "pipe"] });
    activeRedactions++;
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let released = false;

    const release = () => {
      if (released) return;
      released = true;
      activeRedactions--;
    };
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      callback(value);
    };
    const stop = error => {
      child.kill("SIGKILL");
      finish(reject, error);
    };
    const abort = () => stop(signal.reason ?? new Error("redaction aborted"));
    const timer = setTimeout(
      () => stop(new Error(`cloakrs timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    timer.unref?.();
    signal?.addEventListener("abort", abort, { once: true });

    child.stdout.on("data", chunk => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_STDOUT_BYTES) return stop(new Error("cloakrs stdout exceeded limit"));
      stdout.push(chunk);
    });
    child.stderr.on("data", chunk => {
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_STDERR_BYTES) return stop(new Error("cloakrs stderr exceeded limit"));
      stderr.push(chunk);
    });
    child.stdin.on("error", () => {});
    child.once("error", error => {
      release();
      finish(reject, error);
    });
    child.once("close", code => {
      release();
      if (settled) return;
      // cloakrs uses exit code 1 to report that it found PII.
      if (code !== 0 && code !== 1) {
        return finish(
          reject,
          new Error(Buffer.concat(stderr).toString().trim() || `cloakrs exited with ${code}`),
        );
      }

      try {
        const output = Buffer.concat(stdout).toString().replace(/\r?\n$/, "");
        const result = JSON.parse(output);
        if (
          !Array.isArray(result)
          || result.length !== values.length
          || result.some(value => typeof value !== "string")
        ) {
          throw new Error("cloakrs returned an unexpected result");
        }
        finish(resolve, result);
      } catch (error) {
        finish(reject, error);
      }
    });

    // A JSON array stays on one physical line, so cloakrs scans all strings in
    // one process without changing embedded newlines or other formatting.
    child.stdin.end(input);
  });
}

function assertBoundedGraph(root) {
  const stack = [{ value: root, depth: 0 }];
  const seen = new WeakSet();
  let bytes = 0;
  let properties = 0;

  while (stack.length > 0) {
    const { value, depth } = stack.pop();
    if (typeof value === "string") {
      bytes += Buffer.byteLength(value);
      if (bytes > MAX_GRAPH_BYTES) throw new Error("message graph exceeds byte limit");
      continue;
    }
    if (!value || typeof value !== "object") continue;
    if (!Array.isArray(value)) {
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new Error("message graph contains an unsupported object");
      }
    }
    if (seen.has(value)) throw new Error("message graph contains repeated references");
    if (depth > MAX_GRAPH_DEPTH) throw new Error("message graph exceeds depth limit");
    seen.add(value);

    for (const key in value) {
      if (!Object.hasOwn(value, key)) continue;
      properties++;
      bytes += Buffer.byteLength(key);
      if (properties > MAX_GRAPH_PROPERTIES) throw new Error("message graph exceeds property limit");
      if (bytes > MAX_GRAPH_BYTES) throw new Error("message graph exceeds byte limit");
      stack.push({ value: value[key], depth: depth + 1 });
    }
  }
}

function collectObjectStrings(value, locations) {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === "string") locations.push([value, key, false]);
    else collectObjectStrings(child, locations);
    locations.push([value, key, true]);
  }
}

function collectContentStrings(parent, key, locations, includeToolArguments) {
  const content = parent[key];
  if (typeof content === "string") {
    locations.push([parent, key]);
    return;
  }
  if (!Array.isArray(content)) return;

  for (const item of content) {
    if (item?.type === "text" && typeof item.text === "string") locations.push([item, "text"]);
    if (item?.type === "thinking" && typeof item.thinking === "string") locations.push([item, "thinking"]);
    if (includeToolArguments && item?.type === "toolCall") {
      collectObjectStrings(item.arguments, locations);
    }
  }
}

function cloneMessagesAndLocations(messages, includeToolArguments) {
  assertBoundedGraph(messages);
  const result = structuredClone(messages);
  const locations = [];
  for (const message of result) {
    switch (message?.role) {
      case "user":
      case "assistant":
      case "toolResult":
      case "custom":
        collectContentStrings(message, "content", locations, includeToolArguments);
        break;
      case "bashExecution":
        if (typeof message.command === "string") locations.push([message, "command"]);
        if (typeof message.output === "string") locations.push([message, "output"]);
        break;
      case "branchSummary":
      case "compactionSummary":
        if (typeof message.summary === "string") locations.push([message, "summary"]);
        break;
    }
  }
  return { result, locations };
}

export async function redactMessages(messages, {
  includeToolArguments = true,
  ...options
} = {}) {
  const { result, locations } = cloneMessagesAndLocations(messages, includeToolArguments);
  if (locations.length === 0) return undefined;

  const texts = locations.map(([parent, key, isKey]) => isKey ? key : parent[key]);
  const masked = await redactStrings(texts, options);
  let changed = false;
  locations.forEach(([parent, key, isKey], index) => {
    if (masked[index] === texts[index]) return;
    if (isKey) {
      const value = parent[key];
      delete parent[key];
      parent[masked[index]] = value;
    } else {
      parent[key] = masked[index];
    }
    changed = true;
  });
  return changed ? result : undefined;
}

export function withholdMessages(messages) {
  const { result, locations } = cloneMessagesAndLocations(messages, true);
  locations.forEach(([parent, key, isKey]) => {
    if (isKey) {
      const value = parent[key];
      delete parent[key];
      parent[WITHHELD] = value;
    } else {
      parent[key] = WITHHELD;
    }
  });
  return result;
}

export async function redactSystemPrompt(systemPrompt, options) {
  try {
    return (await redactStrings([systemPrompt], options))[0];
  } catch {
    return WITHHELD;
  }
}

export function withholdCompaction(preparation) {
  return {
    compaction: {
      summary: WITHHELD,
      firstKeptEntryId: preparation.firstKeptEntryId,
      tokensBefore: preparation.tokensBefore,
    },
  };
}

export function withholdTreeSummary(preparation) {
  return preparation.userWantsSummary ? { summary: { summary: WITHHELD } } : undefined;
}

export async function redactContextMessages(messages, options) {
  try {
    const redacted = await redactMessages(messages, options);
    return redacted === undefined ? undefined : { messages: redacted };
  } catch {
    // Do not clone or walk a failed graph again: Pi keeps original messages if
    // a context handler throws, so always return one opaque replacement.
    return { messages: [{ role: "user", content: WITHHELD }] };
  }
}

export async function redactContent(content, options) {
  const holder = { role: "user", content };
  const result = await redactMessages([holder], options);
  return result?.[0].content;
}

export function withholdTextContent(content) {
  if (typeof content === "string") return WITHHELD;
  if (!Array.isArray(content)) return WITHHELD;
  return content.map(item => {
    if (item?.type === "text") return { ...item, text: WITHHELD };
    if (item?.type === "thinking") return { ...item, thinking: WITHHELD };
    return item;
  });
}

// Strip terminal controls in one pass before cloakrs scans the exact bytes Pi
// will persist. Malformed or nested sequences fail closed instead of leaving a
// fragment that a later normalization pass could remove and join into PII.
export function normalizeShellOutput(text) {
  let output = "";
  const malformed = () => WITHHELD;

  for (let index = 0; index < text.length;) {
    const code = text.charCodeAt(index);
    if (code === 27 || code === 155) {
      const csi = code === 155 || text[index + 1] === "[";
      if (!csi) {
        if (text[index + 1] !== "]") {
          index++;
          while (index < text.length && text.charCodeAt(index) >= 32 && text.charCodeAt(index) <= 47) {
            index++;
          }
          if (index >= text.length) return malformed();
          const final = text.charCodeAt(index);
          if (final < 48 || final > 126) return malformed();
          index++;
          continue;
        }
        index += 2;
        let terminated = false;
        while (index < text.length) {
          const current = text.charCodeAt(index++);
          if (current === 7 || current === 156) {
            terminated = true;
            break;
          }
          if (current === 27) {
            if (text[index] !== "\\") return malformed();
            index++;
            terminated = true;
            break;
          }
        }
        if (!terminated) return malformed();
        continue;
      }

      index += code === 155 ? 1 : 2;
      let terminated = false;
      while (index < text.length) {
        const current = text.charCodeAt(index++);
        if (current === 27 || (current >= 128 && current <= 159)) return malformed();
        if (current >= 64 && current <= 126) {
          terminated = true;
          break;
        }
        if (current < 32 || current > 63) return malformed();
      }
      if (!terminated) return malformed();
      continue;
    }

    if (code === 157) return malformed(); // C1 OSC
    if (code === 9 || code === 10) output += text[index];
    else if (code > 31 && !(code >= 127 && code <= 159) && !(code >= 65529 && code <= 65531)) {
      output += text[index];
    }
    index++;
  }
  return output;
}

export function redactBashOperations(operations) {
  return {
    async exec(command, cwd, options) {
      // Buffering the whole result is required: PII can straddle chunk
      // boundaries, so there is no safe way to redact the stream chunk-wise.
      const chunks = [];
      let bytes = 0;
      let overLimit = false;
      let flushed = false;
      const flush = async () => {
        if (flushed) return;
        flushed = true;
        if (overLimit) return options.onData(Buffer.from(WITHHELD));
        const output = normalizeShellOutput(Buffer.concat(chunks).toString());
        if (output === "") return;
        try {
          // options.signal is deliberately not forwarded: once the command is
          // aborted its output is already captured, and reusing the aborted
          // signal would withhold that output instead of redacting it. The
          // redactStrings timeout still bounds this call.
          const [masked] = await redactStrings([output]);
          options.onData(Buffer.from(masked));
        } catch {
          options.onData(Buffer.from(WITHHELD));
        }
      };

      try {
        const result = await operations.exec(command, cwd, {
          ...options,
          onData: chunk => {
            bytes += chunk.length;
            if (bytes > MAX_INPUT_BYTES) overLimit = true;
            else chunks.push(chunk);
          },
        });
        await flush();
        return result;
      } catch (error) {
        // pi keeps whatever reached onData when exec rejects (for example on
        // abort), so buffered output still has to be redacted and emitted.
        await flush();
        throw error;
      }
    },
  };
}
