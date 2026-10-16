import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerLiveSessionExtension, type LiveSessionClientHandle } from "pi-tsien-live-session/src/index.ts";
import { buildContextView, CONTEXT_VIEW_VERSION, estimateTokens, type ContextView as View } from "pi-tsien-live-session/src/context-view.ts";
import { LiveSessionClient, type LiveSessionClientOptions } from "pi-tsien-live-session/src/client.ts";
import { LIVE_SESSION_PROTOCOL_VERSION, parseBrokerMessage, type CommandEnvelope } from "pi-tsien-live-session/src/protocol.ts";

/** Minimal file fixture: one real system prompt with every block the view parses. */
const SYSTEM_PROMPT = [
  "You are an expert coding assistant.",
  "",
  "Available tools:",
  "- read: Read a file",
  "",
  "Guidelines:",
  "- Be concise in your responses",
  "- Prefer `rg` over `find`",
  "",
  "Pi documentation (read only when the user asks):",
  "- Main documentation: /pi/README.md",
  "",
  "<project_context>",
  "",
  "Project-specific instructions and guidelines:",
  "",
  '<project_instructions path="/repo/AGENTS.md">',
  "AGENTS-".repeat(400),
  "</project_instructions>",
  "",
  "</project_context>",
  "",
  "<available_skills>",
  "<skill><name>a</name><description>d</description><location>/s/a</location></skill>",
  "<skill><name>b</name><description>d</description><location>/s/b</location></skill>",
  "</available_skills>",
  "",
  "Current working directory: /repo",
].join("\n");

function openaiResponsesPayload(): unknown {
  return {
    model: "gpt-test",
    store: false,
    instructions: SYSTEM_PROMPT,
    input: [
      { role: "user", content: [{ type: "input_text", text: "hello there" }] },
      {
        type: "reasoning",
        summary: [{ type: "summary_text", text: "1+1 nice" }],
        encrypted_content: "x".repeat(64),
      },
      {
        type: "function_call",
        name: "read",
        arguments: JSON.stringify({ path: "/repo/a.ts", offset: null, limit: null }),
      },
      { type: "function_call_output", call_id: "call-1", output: "file contents " + "y".repeat(200) },
      { role: "assistant", content: [{ type: "output_text", text: "here you go" }] },
      { role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,AAAA" }] },
    ],
    tools: [
      { type: "function", name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } } },
      { type: "function", name: "bash", description: "Run a command", parameters: { type: "object" } },
    ],
    tool_choice: "auto",
    parallel_tool_calls: true,
    reasoning: { effort: "medium" },
  };
}

function anthropicPayload(): unknown {
  return {
    model: "claude-test",
    max_tokens: 32000,
    system: SYSTEM_PROMPT,
    messages: [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "let me look" },
          { type: "tool_use", id: "t1", name: "read", input: { path: "/repo/a.ts" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "file body" }] },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "A".repeat(4096) } },
        ],
      },
    ],
    tools: [{ name: "read", description: "Read a file", input_schema: { type: "object" } }],
  };
}

test("estimateTokens counts CJK by character and ASCII by four", () => {
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens("abcd"), 1);
  assert.equal(estimateTokens("中文"), 2);
  assert.equal(estimateTokens("a中"), 1 + 1);
});

test("context view normalizes an OpenAI Responses payload into ranked sections", () => {
  const view = buildContextView({ source: "provider_request", payload: openaiResponsesPayload(), capturedAt: 123, now: 456 });

  assert.equal(view.source, "provider_request");
  assert.equal(view.format, "openai-responses");
  assert.equal(view.capturedAt, 123);
  assert.equal(view.generatedAt, 456);
  assert.equal(view.version, CONTEXT_VIEW_VERSION, "a version field distinguishes a stale session from an empty section");
  assert.equal(view.truncated, false);
  assert.equal(view.system.text, SYSTEM_PROMPT);

  // Messages: user, reasoning, tool call, tool result, assistant, image.
  assert.deepEqual(
    view.messages.map(message => message.kind),
    ["message", "reasoning", "tool_call", "tool_result", "message", "message"],
  );
  assert.equal(view.messages[0].category, "user");
  assert.equal(view.messages[5].images, 1, "an image block is counted, never inlined");
  assert.equal(view.messages[2].label, "调用 read");
  assert.deepEqual(JSON.parse(view.messages[2].text), { path: "/repo/a.ts", offset: null, limit: null });
  assert.equal(view.messages[3].label, "工具结果");
  assert.match(view.messages[3].text, /^file contents y+/);
  assert.equal(view.messages[1].category, "reasoning");
  assert.equal(view.messages[5].category, "user", "an image-only turn is a user message, not a tool result");

  // The system prompt's own blocks are attributed, biggest first.
  const kinds = view.systemParts.map(part => part.kind);
  assert.equal(kinds[0], "context_file");
  assert.deepEqual(kinds, ["context_file", "base", "skills", "guidelines"]);
  assert.equal(view.systemParts[0].label, "/repo/AGENTS.md");
  assert.equal(view.systemParts[0].chars, view.system.text.match(/<project_instructions[\s\S]*?<\/project_instructions>/)![0].length);
  assert.equal(view.systemParts.find(part => part.kind === "skills")?.count, 2);
  assert.equal(view.systemParts.find(part => part.kind === "guidelines")?.count, 2);
  const partChars = view.systemParts.reduce((sum, part) => sum + part.chars, 0);
  assert.equal(partChars, view.system.text.length, "parts account for the whole prompt exactly once");

  // Tools carry their schema size; settings carry non-content request fields.
  assert.deepEqual(view.tools.map(tool => tool.name), ["read", "bash"]);
  assert.ok(view.tools[0].parametersChars > 0);
  assert.equal(view.settings.model, '"gpt-test"');
  assert.equal(view.settings.reasoning, '{"effort":"medium"}');
  assert.equal(view.settings.instructions, undefined);
  assert.equal(view.settings.input, undefined);

  // Totals cover every category and the system prompt dominates this fixture.
  assert.deepEqual(Object.keys(view.totals.byCategory).sort(), ["assistant", "other", "reasoning", "system", "tool_call", "tool_result", "tools", "user"]);
  assert.ok(view.totals.byCategory.system > view.totals.byCategory.assistant);
  assert.ok(view.totals.byCategory.tool_result > 0);
  assert.ok(view.totals.byCategory.user >= 1_000, "an image is charged a flat allowance instead of its bytes");
  assert.equal(view.totals.tokens, Object.values(view.totals.byCategory).reduce((sum, n) => sum + n, 0));
  assert.ok(view.totals.chars > view.totals.tokens);
});

test("context view normalizes an Anthropic payload", () => {
  const view = buildContextView({ source: "provider_request", payload: anthropicPayload() });
  assert.equal(view.format, "anthropic-messages");
  assert.equal(view.system.text, SYSTEM_PROMPT);
  assert.deepEqual(view.messages.map(message => message.kind), ["message", "tool_call", "tool_result"]);
  assert.equal(view.messages[2].images, 1);
  assert.match(view.messages[1].text, /→ read\(/);
  assert.match(view.messages[2].text, /← t1 结果\nfile body/);
  assert.equal(view.tools.length, 1);
});

test("the reconstructed view is flagged as approximate and keeps the system prompt", () => {
  const view = buildContextView({
    source: "reconstructed",
    format: "pi",
    payload: { systemPrompt: SYSTEM_PROMPT, tools: [{ name: "read", description: "d", parameters: {} }], messages: [{ role: "user", content: "hi" }] },
  });
  assert.equal(view.source, "reconstructed");
  assert.equal(view.format, "pi");
  assert.equal(view.system.text, SYSTEM_PROMPT);
  assert.equal(view.messages.length, 1);
});

test("a huge payload is clipped and says so", () => {
  const huge = "Z".repeat(200_000);
  const payload = {
    instructions: SYSTEM_PROMPT,
    input: Array.from({ length: 20 }, (_, index) => ({ role: "user", content: [{ type: "input_text", text: `${index}:${huge}` }] })),
    tools: [],
  };
  const view = buildContextView({ source: "provider_request", payload });
  assert.equal(view.truncated, true);
  assert.ok(view.messages.every(message => message.text.length <= 48 * 1024));
  // `chars` keeps the true size even when the text is clipped.
  assert.ok(view.messages[0].chars > view.messages[0].text.length);
  assert.ok(JSON.stringify(view).length < 3 * 1024 * 1024);
});

interface Harness {
  pi: ExtensionAPI;
  handlers: Map<string, Array<(event: any, ctx: ExtensionContext) => any>>;
}

function extensionHarness(): Harness {
  const handlers = new Map<string, Array<(event: any, ctx: ExtensionContext) => any>>();
  const pi = {
    on(name: string, handler: (event: any, ctx: ExtensionContext) => any) {
      const list = handlers.get(name) || [];
      list.push(handler);
      handlers.set(name, list);
    },
    registerCommand() {},
    registerTool() {},
    getActiveTools: () => ["read"],
    getAllTools: () => [{ name: "read", description: "Read a file", parameters: { type: "object" }, sourceInfo: {} }],
    events: { on: () => () => {}, emit() {} },
    setSessionName() {},
    respondExtensionUi: () => true,
  } as unknown as ExtensionAPI;
  return { pi, handlers };
}

function context(): ExtensionContext {
  return {
    mode: "tui",
    cwd: "/repo",
    model: { provider: "test", id: "model" },
    sessionManager: {
      getSessionId: () => "session-a",
      getSessionFile: () => "/tmp/session-a.jsonl",
      getSessionName: () => "Task A",
      getCwd: () => "/repo",
      getBranch: () => [],
      buildContextEntries: () => [],
    },
    getContextUsage: () => ({ tokens: 20, contextWindow: 100, percent: 20 }),
    getSystemPrompt: () => SYSTEM_PROMPT,
    isIdle: () => true,
    ui: { notify() {} },
  } as unknown as ExtensionContext;
}

function envelope(command: CommandEnvelope["command"]): CommandEnvelope {
  return { type: "command", requestId: "request-context", processInstanceId: "process-a", command };
}

/** Narrow a command result (opaque JSON on the wire) to the view under test. */
function viewOf(result: unknown): View {
  return (result as unknown as { result: View }).result;
}

/** The dashboard's shape, run through the real broker-message parser this package uses. */
function parseEnvelope(command: unknown): CommandEnvelope {
  const parsed = parseBrokerMessage({ type: "command", requestId: "request-context", processInstanceId: "process-a", command });
  assert.ok(parsed, "the broker message parser must accept the dashboard's envelope");
  assert.equal(parsed.type, "command");
  return parsed as CommandEnvelope;
}

async function startExtension(pi: ExtensionAPI, handlers: Harness["handlers"]) {
  let options: LiveSessionClientOptions | undefined;
  const handle: LiveSessionClientHandle = { start() {}, publish() {}, sendSnapshot() {}, stop() {} };
  registerLiveSessionExtension(pi, {
    identity: { processInstanceId: "process-a", startedAt: 1 },
    createClient: value => { options = value as typeof options; return handle; },
  });
  const ctx = context();
  await handlers.get("session_start")?.[0]({ reason: "startup" }, ctx);
  assert.ok(options, "session_start must register the live session client");
  return { options: options!, ctx };
}

test("get_context rebuilds an approximate view before the first provider request", async () => {
  const harness = extensionHarness();
  const { options } = await startExtension(harness.pi, harness.handlers);

  const result = await options.executeCommand(envelope({ type: "get_context" }));
  assert.equal(result.ok, true);
  const view = viewOf(result);
  assert.equal(view.source, "reconstructed", "nothing has been sent yet, and the view says so");
  assert.equal(view.system.text, SYSTEM_PROMPT);
  assert.deepEqual(view.tools.map(tool => tool.name), ["read"]);
  assert.deepEqual(view.contextUsage, { tokens: 20, contextWindow: 100, percent: 20 });
});

test("get_context reports the real provider payload once a request has gone out", async () => {
  const harness = extensionHarness();
  const { options, ctx } = await startExtension(harness.pi, harness.handlers);

  // The capture hook must be observe-only: whatever it returns reaches the provider.
  const hook = harness.handlers.get("before_provider_request")?.[0];
  assert.ok(hook, "the extension must subscribe to before_provider_request");
  const untouched = await hook({ type: "before_provider_request", payload: openaiResponsesPayload() }, ctx);
  assert.equal(untouched, undefined);

  const result = await options.executeCommand(envelope({ type: "get_context" }));
  assert.equal(result.ok, true);
  const view = viewOf(result);
  assert.equal(view.source, "provider_request");
  assert.equal(view.format, "openai-responses");
  assert.equal(view.messages.length, 6);
  assert.equal(view.systemParts[0].kind, "context_file");
});

test("get_context survives the broker message parser the dashboard writes through", async () => {
  assert.equal(LIVE_SESSION_PROTOCOL_VERSION, 2);
  const harness = extensionHarness();
  const { options } = await startExtension(harness.pi, harness.handlers);

  const result = await options.executeCommand(parseEnvelope({ type: "get_context" }));
  assert.equal(result.ok, true);
  assert.equal(viewOf(result).source, "reconstructed");
});

test("a session switch drops the previous session's captured payload", async () => {
  const harness = extensionHarness();
  const { options, ctx } = await startExtension(harness.pi, harness.handlers);
  await harness.handlers.get("before_provider_request")?.[0]({ payload: openaiResponsesPayload() }, ctx);

  await harness.handlers.get("session_start")?.[0]({ reason: "new" }, ctx);
  const result = await options.executeCommand(envelope({ type: "get_context" }));
  assert.equal(viewOf(result).source, "reconstructed");
});