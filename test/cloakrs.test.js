import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  MAX_CONCURRENT_REDACTIONS,
  MAX_GRAPH_DEPTH,
  MAX_INPUT_BYTES,
  MAX_INPUT_ITEMS,
  MAX_STDERR_BYTES,
  MAX_STDOUT_BYTES,
  WITHHELD,
  hideHomePath,
  normalizeShellOutput,
  redactBashOperations,
  redactContent,
  redactContextMessages,
  redactMessages,
  redactStrings,
  redactSystemPrompt,
  withholdCompaction,
  withholdTextContent,
  withholdTreeSummary,
} from "../src/cloakrs.js";

async function withBinary(source, run) {
  const directory = await mkdtemp(join(tmpdir(), "pi-cloakrs-test-"));
  const binary = join(directory, "cloakrs");
  const previous = process.env.PI_CLOAKRS_BINARY;
  await writeFile(binary, `#!/usr/bin/env node\n${source}`);
  await chmod(binary, 0o755);
  process.env.PI_CLOAKRS_BINARY = binary;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.PI_CLOAKRS_BINARY;
    else process.env.PI_CLOAKRS_BINARY = previous;
    await rm(directory, { recursive: true, force: true });
  }
}

async function piRpc(t, command, {
  extension = "./extensions/pi-cloakrs.js",
  cwd = process.cwd(),
  env = process.env,
  waitFor = message => message.id === command.id && message.type === "response",
} = {}) {
  const child = spawn(process.env.PI_TEST_BINARY || "pi", [
    "--mode", "rpc", "--no-session", "--no-extensions", "-e", extension,
  ], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => child.kill());
  let stdout = "";
  let stderr = "";

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`pi RPC timed out: ${stderr}`)), 10_000);
    t.after(() => clearTimeout(timer));
    child.once("error", error => {
      clearTimeout(timer);
      if (error.code === "ENOENT") resolve(undefined);
      else reject(error);
    });
    child.once("close", code => {
      clearTimeout(timer);
      reject(new Error(`pi exited with ${code}: ${stderr}`));
    });
    child.stdin.on("error", () => {});
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.stdout.on("data", chunk => {
      stdout += chunk;
      let end;
      while ((end = stdout.indexOf("\n")) !== -1) {
        const line = stdout.slice(0, end);
        stdout = stdout.slice(end + 1);
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (waitFor(message)) {
          clearTimeout(timer);
          resolve(message);
        }
      }
    });
    child.stdin.write(`${JSON.stringify(command)}\n`);
  });
}

test("preserves URLs, hostnames, and filenames by default with configurable, fail-closed exclusions", async t => {
  const previous = process.env.PI_CLOAKRS_EXCLUDE_ENTITIES;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CLOAKRS_EXCLUDE_ENTITIES;
    else process.env.PI_CLOAKRS_EXCLUDE_ENTITIES = previous;
  });
  delete process.env.PI_CLOAKRS_EXCLUDE_ENTITIES;
  const texts = [
    "Open https://example.com/docs?q=hello",
    "https://example.com?email=jane%40example.com",
    "server.internal",
    "/home/another-user/project",
    "test/cloakrs.test.js",
  ];
  assert.deepEqual(await redactStrings(texts), [
    texts[0], "https://example.com?email=[EMAIL]", texts[2], "[USER_PATH]", texts[4],
  ]);

  process.env.PI_CLOAKRS_EXCLUDE_ENTITIES = "";
  assert.deepEqual(await redactStrings(texts), [
    "Open [URL]", "[URL]", "[HOSTNAME]", "[USER_PATH]", "test/[HOSTNAME]",
  ]);

  process.env.PI_CLOAKRS_EXCLUDE_ENTITIES = "url,hostname,user-path";
  assert.deepEqual(await redactStrings(texts), [
    texts[0], "https://example.com?email=[EMAIL]", texts[2], texts[3], texts[4],
  ]);
  assert.equal((await redactStrings([join(homedir(), "project")]))[0], "~/project");

  process.env.PI_CLOAKRS_EXCLUDE_ENTITIES = "not-an-entity";
  await assert.rejects(redactStrings(["secret"]));
  assert.equal(await redactSystemPrompt("secret"), WITHHELD);
  assert.deepEqual(await redactContextMessages([{ role: "user", content: "secret" }]), {
    messages: [{ role: "user", content: WITHHELD }],
  });
});

test("redacts valid Dutch BSNs and rejects invalid checksums", async () => {
  const result = await redactStrings([
    "BSN 123456782",
    "BSN 123456789",
    "unlabelled 111222333",
  ]);

  assert.deepEqual(result, ["BSN [BSN]", "BSN 123456789", "unlabelled [BSN]"]);
});

test("keeps home-directory paths usable without exposing the username", async () => {
  const result = await redactStrings([`Read ${join(homedir(), "security-findings.md")}`]);
  assert.equal(result[0], "Read ~/security-findings.md");
  assert.equal(
    hideHomePath("read c:/USERS/aLiCe/project/file", "C:\\Users\\Alice", "win32"),
    "read ~/project/file",
  );
  assert.equal(
    hideHomePath("read C:\\Users\\Alice2\\file", "C:\\Users\\Alice", "win32"),
    "read C:\\Users\\Alice2\\file",
  );
  assert.equal(
    hideHomePath("read /Users/alice2/file", "/Users/alice", "darwin"),
    "read /Users/alice2/file",
  );
});

test("redacts text items without changing images", async () => {
  const image = { type: "image", data: "123456782" };
  const result = await redactContent([
    { type: "text", text: "burgerservicenummer 999990639" },
    image,
  ]);

  assert.deepEqual(result, [
    { type: "text", text: "burgerservicenummer [BSN]" },
    image,
  ]);
});

test("redacts every message shape used in model context", async () => {
  const messages = [{
    role: "assistant",
    content: [
      { type: "thinking", thinking: "Contact alice@example.com" },
      { type: "toolCall", id: "1", name: "send", arguments: { to: "alice@example.com" } },
    ],
  }, {
    role: "bashExecution",
    command: "echo alice@example.com",
    output: "alice@example.com",
  }, {
    role: "branchSummary",
    summary: "Contact alice@example.com",
  }];

  const result = await redactMessages(messages);
  assert.equal(result[0].content[0].thinking, "Contact [EMAIL]");
  assert.equal(result[0].content[1].arguments.to, "[EMAIL]");
  assert.equal(result[1].command, "echo [EMAIL]");
  assert.equal(result[1].output, "[EMAIL]");
  assert.equal(result[2].summary, "Contact [EMAIL]");
});

test("redacts PII in tool argument object keys", async () => {
  const email = "alice" + "@" + "example.com";
  const result = await redactMessages([{
    role: "assistant",
    content: [{ type: "toolCall", id: "1", name: "lookup", arguments: { [email]: true } }],
  }]);

  assert.deepEqual(result[0].content[0].arguments, { "[EMAIL]": true });

  await assert.rejects(redactMessages([{
    role: "assistant",
    content: [{
      type: "toolCall",
      id: "2",
      name: "lookup",
      arguments: { [email]: 1, ["bob" + "@" + "example.com"]: 2 },
    }],
  }]), /duplicate object key/);
});

test("enforces timeout when cloakrs ignores SIGTERM", async () => {
  await withBinary(
    "process.on('SIGTERM', () => {}); process.stdin.resume(); setInterval(() => {}, 1000);",
    async () => {
      await assert.rejects(redactStrings(["text"], { timeoutMs: 50 }), /timed out after 50ms/);
    },
  );
});

test("rejects non-zero, malformed, and mismatched cloakrs output", async () => {
  await withBinary("process.exit(2);", () => assert.rejects(redactStrings(["text"]), /exited with 2/));
  await withBinary("process.stdin.on('data', () => process.stdout.write('nope\\n'));", () => (
    assert.rejects(redactStrings(["text"]), SyntaxError)
  ));
  await withBinary("process.stdin.on('data', () => process.stdout.write('[]\\n'));", () => (
    assert.rejects(redactStrings(["text"]), /unexpected result/)
  ));
});

test("validates input and withholds invalid content shapes", async () => {
  await assert.rejects(redactStrings([42]), /array of strings/);
  assert.equal(withholdTextContent({ unexpected: true }), WITHHELD);
  assert.equal(withholdTextContent([{ type: "thinking", thinking: "secret" }])[0].thinking, WITHHELD);
});

test("bounds redaction input, output, and concurrency", async () => {
  await assert.rejects(redactStrings(Array(MAX_INPUT_ITEMS + 1).fill("")), /exceeds 1000 items/);
  await assert.rejects(redactStrings(["x".repeat(MAX_INPUT_BYTES + 1)]), /input exceeds .* bytes/);

  await withBinary(
    "process.stdin.resume(); setTimeout(() => process.stdout.write('[\"text\"]\\n'), 100);",
    async () => {
      const running = Array.from(
        { length: MAX_CONCURRENT_REDACTIONS },
        () => redactStrings(["text"]),
      );
      await assert.rejects(redactStrings(["text"]), /too many concurrent redactions/);
      await Promise.all(running);
    },
  );
  await withBinary(
    `process.stdin.on("data", () => process.stdout.write("x".repeat(${MAX_STDOUT_BYTES + 1})));`,
    () => assert.rejects(redactStrings(["text"]), /stdout exceeded limit/),
  );
  await withBinary(
    `process.stdin.on("data", () => process.stderr.write("x".repeat(${MAX_STDERR_BYTES + 1})));`,
    () => assert.rejects(redactStrings(["text"]), /stderr exceeded limit/),
  );
});

test("withholds shell output above the redaction input limit", async () => {
  const chunks = [];
  const operations = redactBashOperations({
    async exec(_command, _cwd, options) {
      options.onData(Buffer.alloc(MAX_INPUT_BYTES + 1));
      return { exitCode: 0 };
    },
  });

  await operations.exec("echo", ".", { onData: chunk => chunks.push(chunk) });
  assert.equal(Buffer.concat(chunks).toString(), WITHHELD);
});

test("buffers and redacts user bash output before forwarding it", async () => {
  const chunks = [];
  const operations = redactBashOperations({
    async exec(_command, _cwd, options) {
      options.onData(Buffer.from("alice@example.com"));
      return { exitCode: 0 };
    },
  });

  const result = await operations.exec("echo", ".", { onData: chunk => chunks.push(chunk) });
  assert.equal(Buffer.concat(chunks).toString(), "[EMAIL]");
  assert.equal(result.exitCode, 0);
});

test("user_bash handler redacts output through pi", async t => {
  const response = await piRpc(t, {
    id: "bash-test",
    type: "bash",
    command: "printf 'bsn \\033[01;31m\\033[K1234\\033[m\\033[K56782 end\\n'",
  });
  if (response === undefined) return t.skip("pi executable is not available");
  assert.equal(response.data.output, "bsn [BSN] end\n");
});

test("status command reports settings and binary failures through pi", async t => {
  const request = env => piRpc(t, {
    id: "status-test", type: "prompt", message: "/cloakrs-status",
  }, {
    env,
    waitFor: message => message.type === "extension_ui_request" && message.method === "notify",
  });
  const status = await request({ ...process.env, PI_CLOAKRS_EXCLUDE_ENTITIES: "" });
  if (status === undefined) return t.skip("pi executable is not available");
  assert.equal(status.notifyType, "info");
  assert.match(status.message, /cloakrs 0\.4\.0; binary=.+; locale=.+; min-confidence=.+; exclude-entities=none/);
  const defaultEnv = { ...process.env };
  delete defaultEnv.PI_CLOAKRS_EXCLUDE_ENTITIES;
  const defaultStatus = await request(defaultEnv);
  assert.equal(defaultStatus.notifyType, "info");
  assert.match(defaultStatus.message, /exclude-entities=url,hostname \(CLI; cloakrs config may add exclusions\)/);

  await withBinary("console.error('broken binary'); process.exit(2);", async () => {
    const failed = await request(process.env);
    assert.equal(failed.notifyType, "error");
    assert.match(failed.message, /cloakrs unavailable; binary=.+broken binary/);
  });
  const missing = await request({ ...process.env, PI_CLOAKRS_BINARY: resolve("missing-cloakrs-binary") });
  assert.equal(missing.notifyType, "error");
  assert.match(missing.message, /cloakrs unavailable; binary=.+missing-cloakrs-binary/);
});

test("clean package installation downloads cloakrs and loads through pi", {
  skip: process.env.PI_CLOAKRS_TEST_INSTALL !== "1",
  timeout: 120_000,
}, async t => {
  const directory = await mkdtemp(join(tmpdir(), "pi-cloakrs-install-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("PI_CLOAKRS_")) delete env[key];
  }
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const pack = spawnSync(npm, ["pack", "--ignore-scripts", "--json", "--pack-destination", directory], {
    encoding: "utf8", env, timeout: 30_000,
  });
  assert.equal(pack.status, 0, pack.error?.message || pack.stderr);
  const [{ filename }] = JSON.parse(pack.stdout);
  await writeFile(join(directory, "package.json"), '{"private":true}');
  const install = spawnSync(npm, [
    "install", join(directory, filename), "--ignore-scripts=false", "--legacy-peer-deps",
    "--no-audit", "--no-fund",
  ], { cwd: directory, encoding: "utf8", env, timeout: 90_000 });
  assert.equal(install.status, 0, install.error?.message || install.stderr);
  const installed = join(directory, "node_modules", "pi-cloakrs-extension");
  const version = spawnSync(join(installed, "bin", process.platform === "win32" ? "cloakrs.exe" : "cloakrs"), ["--version"], {
    encoding: "utf8", timeout: 5_000,
  });
  assert.equal(version.status, 0, version.error?.message || version.stderr);
  assert.equal(version.stdout.trim(), "cloakrs 0.4.0");

  const response = await piRpc(t, {
    id: "install-test", type: "bash",
    command: "echo 'https://example.com/docs jane@example.com BSN 123456782'",
  }, { extension: installed, cwd: directory, env });
  assert.ok(response, "pi executable is required for the installation smoke test");
  assert.equal(response.data.output.trim(), "https://example.com/docs [EMAIL] BSN [BSN]");
});

test("context handler fails closed", async () => {
  await withBinary("process.exit(2);", async () => {
    const result = await redactContextMessages([{ role: "user", content: "secret" }]);
    assert.equal(result.messages[0].content, WITHHELD);
  });
});

test("shell normalization is stable and fails closed on nested or malformed controls", () => {
  const escape = String.fromCharCode(27);
  const csi = String.fromCharCode(155);
  const normal = `a${escape}[31mred${escape}[0m${escape}(Bz`;
  assert.equal(normalizeShellOutput(normal), "aredz");
  assert.equal(normalizeShellOutput(normalizeShellOutput(normal)), "aredz");
  assert.equal(normalizeShellOutput(`${escape}${escape}`), WITHHELD);
  assert.equal(normalizeShellOutput(`1234${csi}${escape}[m[m56782`), WITHHELD);
  assert.equal(normalizeShellOutput(`${escape}]`.repeat(10_000)), WITHHELD);
});

test("redacts PII that ANSI escapes split apart in shell output", async () => {
  const escape = String.fromCharCode(27);
  // What `grep --color 1234` emits over a BSN: the escapes split the digits, so
  // redacting the raw bytes finds nothing and pi's stripAnsi would then restore
  // intact PII. Normalising first is what makes this match.
  const coloured = `bsn ${escape}[01;31m${escape}[K1234${escape}[m${escape}[K56782 end`;
  const chunks = [];
  const operations = redactBashOperations({
    async exec(_command, _cwd, options) {
      options.onData(Buffer.from(coloured));
      return { exitCode: 0 };
    },
  });

  await operations.exec("grep", ".", { onData: chunk => chunks.push(chunk) });
  assert.equal(Buffer.concat(chunks).toString(), "bsn [BSN] end");
});

test("redacts buffered shell output even when exec rejects", async () => {
  const chunks = [];
  const operations = redactBashOperations({
    async exec(_command, _cwd, options) {
      options.onData(Buffer.from("alice@example.com"));
      throw new Error("command aborted");
    },
  });

  await assert.rejects(
    operations.exec("echo", ".", { onData: chunk => chunks.push(chunk) }),
    /command aborted/,
  );
  assert.equal(Buffer.concat(chunks).toString(), "[EMAIL]");
});

test("redacts the system prompt and keeps internal summaries local", async () => {
  await withBinary(
    "let input = ''; process.stdin.on('data', chunk => input += chunk); process.stdin.on('end', () => process.stdout.write(JSON.stringify(JSON.parse(input).map(value => value.replaceAll('secret', '[MASKED]'))) + '\\n'));",
    async () => {
      assert.equal(await redactSystemPrompt("project secret"), "project [MASKED]");
    },
  );

  const preparation = { firstKeptEntryId: "kept", tokensBefore: 42 };
  assert.deepEqual(withholdCompaction(preparation), {
    compaction: { summary: WITHHELD, firstKeptEntryId: "kept", tokensBefore: 42 },
  });
  assert.deepEqual(withholdTreeSummary({ userWantsSummary: true }), {
    summary: { summary: WITHHELD },
  });
  assert.equal(withholdTreeSummary({ userWantsSummary: false }), undefined);
});

test("context failure withholds PII in tool argument object keys", async () => {
  const email = "alice" + "@" + "example.com";
  await withBinary("process.exit(2);", async () => {
    const result = await redactContextMessages([{
      role: "assistant",
      content: [{ type: "toolCall", id: "1", name: "lookup", arguments: { [email]: true } }],
    }]);
    assert.deepEqual(result.messages, [{ role: "user", content: WITHHELD }]);
  });
});

test("system prompt redaction fails closed", async () => {
  await withBinary("process.exit(2);", async () => {
    assert.equal(await redactSystemPrompt("secret"), WITHHELD);
  });
});

test("context handler stays closed for uncloneable and over-deep messages", async () => {
  const uncloneable = await redactContextMessages([{ role: "user", content: "secret", fn() {} }]);
  assert.deepEqual(uncloneable.messages, [{ role: "user", content: WITHHELD }]);

  let argumentsObject = {};
  for (let index = 0; index <= MAX_GRAPH_DEPTH; index++) argumentsObject = { child: argumentsObject };
  const overDeep = await redactContextMessages([{
    role: "assistant",
    content: [{ type: "toolCall", id: "1", name: "lookup", arguments: argumentsObject }],
  }]);
  assert.deepEqual(overDeep.messages, [{ role: "user", content: WITHHELD }]);

  const unsupported = await redactContextMessages([{
    role: "assistant",
    content: [{ type: "toolCall", id: "1", name: "lookup", arguments: new Map([["key", "value"]]) }],
  }]);
  assert.deepEqual(unsupported.messages, [{ role: "user", content: WITHHELD }]);
});
