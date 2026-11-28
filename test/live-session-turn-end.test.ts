import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  registerLiveSessionExtension,
  type LiveSessionClientHandle,
} from "pi-tsien-live-session/src/index.ts";
import type { EventMessage } from "pi-tsien-live-session/src/protocol.ts";

type Handler = (event: any, ctx: ExtensionContext) => unknown;

function extensionHarness() {
  const handlers = new Map<string, Handler[]>();
  const pi = {
    on(name: string, handler: Handler) {
      const current = handlers.get(name) ?? [];
      current.push(handler);
      handlers.set(name, current);
    },
    getThinkingLevel: () => "high",
    registerCommand() {},
    registerTool() {},
    events: { on: () => () => {} },
  } as unknown as ExtensionAPI;
  return { pi, handlers };
}

function context(): ExtensionContext {
  return {
    mode: "tui",
    cwd: "/tmp/live-session-turn-end",
    model: { provider: "test", id: "model" },
    thinkingLevel: "high",
    sessionManager: {
      getSessionId: () => "session-a",
      getSessionFile: () => "/tmp/session-a.jsonl",
      getSessionName: () => "Turn end test",
      getCwd: () => "/tmp/live-session-turn-end",
      getBranch: () => [],
    },
    getContextUsage: () => ({ tokens: 20, contextWindow: 100, percent: 20 }),
    isIdle: () => false,
    isProjectTrusted: () => true,
    ui: { notify() {} },
  } as unknown as ExtensionContext;
}

test("turn_end publishes only the explicit allowlist, preserving turn data without context", async () => {
  const harness = extensionHarness();
  const ctx = context();
  const published: EventMessage[] = [];
  const handle: LiveSessionClientHandle = {
    start() {},
    publish: message => published.push(message),
    sendSnapshot() {},
    stop() {},
  };
  registerLiveSessionExtension(harness.pi, {
    identity: { processInstanceId: "process-a", startedAt: 1 },
    createClient: () => handle,
  });
  await harness.handlers.get("session_start")?.[0]({}, ctx);
  published.length = 0;

  const message = {
    role: "assistant",
    content: [{ type: "text", text: "done" }],
  };
  const toolResults = [{
    role: "toolResult",
    toolCallId: "call-1",
    toolName: "bash",
    content: [{ type: "text", text: "ok" }],
    isError: false,
  }];
  const largeFuturePayload = "x".repeat(1_000_000);
  await harness.handlers.get("turn_end")?.[0]({
    type: "turn_end",
    turnIndex: 7,
    message,
    toolResults,
    messageEntryId: "message-entry-1",
    toolResultEntryIds: ["tool-entry-1"],
    entries: [{ type: "custom", customType: "boundary", data: { kept: true } }],
    outcome: "completed",
    continue: true,
    context: {
      contextEntries: [{ large: largeFuturePayload }],
      contextMessages: [{ large: largeFuturePayload }],
      llmMessages: [{ large: largeFuturePayload }],
      pendingMessages: [{ large: largeFuturePayload }],
      canContinue: true,
    },
    futureLargePayload: largeFuturePayload,
  }, ctx);

  assert.equal(published.length, 1);
  const event = published[0].event;
  assert.equal(event.type, "turn_end");
  const data = event.data as Record<string, unknown>;
  assert.equal("context" in data, false);
  assert.equal("type" in data, false, "the envelope already carries the event type");
  assert.equal("futureLargePayload" in data, false, "new pi fields are not forwarded implicitly");
  assert.equal(data.turnIndex, 7);
  assert.deepEqual(data.message, message);
  assert.deepEqual(data.toolResults, toolResults);
  assert.equal(data.messageEntryId, "message-entry-1");
  assert.deepEqual(data.toolResultEntryIds, ["tool-entry-1"]);
  assert.deepEqual(data.entries, [{ type: "custom", customType: "boundary", data: { kept: true } }]);
  assert.equal(data.outcome, "completed");
  assert.equal(data.continue, true);
  assert.deepEqual(Object.keys(data), [
    "turnIndex",
    "message",
    "toolResults",
    "messageEntryId",
    "toolResultEntryIds",
    "entries",
    "outcome",
    "continue",
  ]);

  await harness.handlers.get("session_shutdown")?.[0]({ reason: "quit" }, ctx);
});
