// Static, not dynamic: pi resolves this specifier through a jiti alias, and
// jiti only applies that alias when native ESM resolution fails first. A
// dynamic import() loads natively and then throws ERR_MODULE_NOT_FOUND at call
// time, which pi swallows -- silently leaving ! output unredacted.
import { createLocalBashOperations } from "@earendil-works/pi-coding-agent";
import {
  cloakrsBinary,
  cloakrsExcludedEntities,
  redactBashOperations,
  redactContent,
  redactContextMessages,
  redactStrings,
  redactSystemPrompt,
  withholdCompaction,
  withholdTextContent,
  withholdTreeSummary,
} from "../src/cloakrs.js";

export default function (pi) {
  // The system prompt contains cwd and loaded project instructions, so redact
  // it before every agent run as well as redacting conversation messages.
  pi.on("before_agent_start", async (event, ctx) => {
    const systemPrompt = await redactSystemPrompt(event.systemPrompt, { signal: ctx.signal });
    return systemPrompt === event.systemPrompt ? undefined : { systemPrompt };
  });

  // Pi's internal summarizers bypass the context hook. Supplying a local,
  // opaque summary prevents those separate model calls from seeing session
  // history; recent messages remain available after compaction.
  pi.on("session_before_compact", event => withholdCompaction(event.preparation));
  pi.on("session_before_tree", event => withholdTreeSummary(event.preparation));

  // Redact typed prompts before they enter the session or model context.
  pi.on("input", async (event, ctx) => {
    if (event.source === "extension") return { action: "continue" };
    try {
      const [text] = await redactStrings([event.text], { signal: ctx.signal });
      return text === event.text
        ? { action: "continue" }
        : { action: "transform", text, images: event.images };
    } catch (error) {
      ctx.ui.notify(`cloakrs failed: ${error}`, "error");
      return { action: "handled" }; // Redaction failures must not leak the prompt.
    }
  });

  // Redact textual tool results before Pi sends them to the model.
  pi.on("tool_result", async (event, ctx) => {
    try {
      const content = await redactContent(event.content, { signal: ctx.signal });
      return content === undefined ? undefined : { content };
    } catch {
      return { content: withholdTextContent(event.content) };
    }
  });

  // Redact persisted messages early. Tool arguments are left intact here so
  // redaction cannot change the tool call that Pi is about to execute.
  pi.on("message_end", async (event, ctx) => {
    if (!["user", "assistant", "custom"].includes(event.message.role)) return;
    try {
      const content = await redactContent(event.message.content, {
        includeToolArguments: false,
        signal: ctx.signal,
      });
      return content === undefined
        ? undefined
        : { message: { ...event.message, content } };
    } catch {
      return {
        message: {
          ...event.message,
          content: withholdTextContent(event.message.content),
        },
      };
    }
  });

  // Backstop every normal model request, including ! output, summaries, tool
  // arguments, thinking blocks, restored sessions, and future message roles.
  pi.on("context", (event, ctx) => redactContextMessages(event.messages, { signal: ctx.signal }));

  // Bash execution messages bypass message_end. Buffer normal ! output and
  // redact it before Pi persists or adds it to model context; !! stays local.
  pi.on("user_bash", event => {
    if (event.excludeFromContext) return undefined;
    return { operations: redactBashOperations(createLocalBashOperations()) };
  });

  pi.registerCommand("cloakrs-status", {
    description: "Show the cloakrs binary, version, and redaction settings",
    handler: async (_args, ctx) => {
      const binary = cloakrsBinary();
      try {
        const result = await pi.exec(binary, ["--version"], { timeout: 5_000 });
        if (result.code !== 0 || result.killed) {
          throw new Error(result.stderr.trim() || `version check failed (exit=${result.code}, killed=${result.killed})`);
        }
        ctx.ui.notify(
          `${result.stdout.trim()}; binary=${binary}; locale=${process.env.PI_CLOAKRS_LOCALE || "nl"}; min-confidence=${process.env.PI_CLOAKRS_MIN_CONFIDENCE || "0.35"}; exclude-entities=${cloakrsExcludedEntities() || "none"} (CLI; cloakrs config may add exclusions)`,
          "info",
        );
      } catch (error) {
        ctx.ui.notify(`cloakrs unavailable; binary=${binary}: ${error}`, "error");
      }
    },
  });
}
