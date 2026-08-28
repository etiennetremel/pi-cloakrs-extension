import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
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
  const child = spawn(process.env.PI_TEST_BINARY || "pi", [
    "--mode", "rpc",
    "--no-session",
    "--no-extensions",
    "-e", "./extensions/pi-cloakrs.js",
  ], { stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => child.kill());
  let stdout = "";
  let stderr = "";

  const response = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`pi RPC timed out: ${stderr}`)), 10_000);
    child.once("error", error => {
      clearTimeout(timer);
      if (error.code === "ENOENT") resolve(undefined);
      else reject(error);
    });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.stdout.on("data", chunk => {
      stdout += chunk;
      for (const line of stdout.trim().split("\n")) {
        try {
          const message = JSON.parse(line);
          if (message.id === "bash-test" && message.type === "response") {
            clearTimeout(timer);
            resolve(message);
          }
        } catch {}
      }
    });
    child.stdin.write(`${JSON.stringify({
      id: "bash-test",
      type: "bash",
      command: "printf 'bsn \\033[01;31m\\033[K1234\\033[m\\033[K56782 end\\n'",
    })}\n`);
  });

  if (response === undefined) return t.skip("pi executable is not available");
  assert.equal(response.data.output, "bsn [BSN] end\n");
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
