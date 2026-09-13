import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  extractProviderThinking,
  registerTrajectoryRecorder,
  toJsonSafe,
} from "../extensions/trajectory-recorder.ts";

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
  } as unknown as ExtensionAPI;
  return { pi, handlers };
}

function context(): ExtensionContext {
  return {
    mode: "tui",
    hasUI: false,
    cwd: "/tmp/trajectory-project",
    model: {
      provider: "anthropic",
      id: "claude-test",
      api: "anthropic-messages",
      reasoning: true,
      input: ["text"],
      contextWindow: 100_000,
      maxTokens: 8_000,
    },
    thinkingLevel: "high",
    sessionManager: {
      getSessionId: () => "session-a",
      getSessionFile: () => "/tmp/session-a.jsonl",
      getSessionName: () => "Recorder test",
      getCwd: () => "/tmp/trajectory-project",
    },
    ui: { notify() {} },
  } as unknown as ExtensionContext;
}

async function emit(
  handlers: Map<string, Handler[]>,
  name: string,
  event: unknown,
  ctx: ExtensionContext,
): Promise<void> {
  for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
}

function readEvents(traceDir: string): any[] {
  const path = join(traceDir, "sessions", "session-a", "events-99.jsonl");
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

test("trajectory recorder preserves the final prompt, model effort, messages, and tools", async () => {
  const traceDir = mkdtempSync(join(tmpdir(), "pi-trajectory-"));
  try {
    const harness = extensionHarness();
    const ctx = context();
    let clock = 1_000;
    let id = 0;
    registerTrajectoryRecorder(harness.pi, {
      traceDir,
      processId: 99,
      now: () => ++clock,
      idFactory: () => `id-${++id}`,
      traceContext: {
        parentSessionId: "parent-session",
        parentToolCallId: "parent-tool-call",
        workflowId: "workflow-1",
        workId: "work-1",
        taskKey: "inspect",
        stageIndex: 1,
        iterationIndex: 0,
      },
    });

    await emit(harness.handlers, "session_start", {
      type: "session_start",
      reason: "startup",
    }, ctx);
    await emit(harness.handlers, "input", {
      type: "input",
      text: "/task inspect the project",
      source: "interactive",
    }, ctx);
    await emit(harness.handlers, "before_agent_start", {
      type: "before_agent_start",
      prompt: "inspect the project",
      systemPrompt: "SYSTEM: use the available tools",
      systemPromptOptions: {
        selectedTools: ["read", "bash"],
        contextFiles: [{ path: "/tmp/AGENTS.md" }],
        skills: [{ name: "test-skill" }],
      },
    }, ctx);
    await emit(harness.handlers, "agent_start", { type: "agent_start" }, ctx);
    await emit(harness.handlers, "turn_start", {
      type: "turn_start",
      turnIndex: 0,
      timestamp: 1_010,
    }, ctx);
    await emit(harness.handlers, "context", {
      type: "context",
      messages: [{ role: "user", content: "inspect the project", timestamp: 1_011 }],
    }, ctx);
    await emit(harness.handlers, "before_provider_headers", {
      type: "before_provider_headers",
      headers: { authorization: "do-not-save", "x-request-id": "request-1" },
    }, ctx);
    await emit(harness.handlers, "before_provider_request", {
      type: "before_provider_request",
      payload: {
        model: "claude-test",
        reasoning_effort: "high",
        api_key: "do-not-save",
        messages: [{ role: "user", content: "inspect the project" }],
        tools: [{ type: "function", function: { name: "read" } }],
      },
    }, ctx);
    await emit(harness.handlers, "after_provider_response", {
      type: "after_provider_response",
      status: 200,
      headers: { "content-type": "application/json" },
    }, ctx);

    const assistant = {
      role: "assistant",
      content: [{ type: "text", text: "I will inspect it." }],
      provider: "anthropic",
      model: "claude-test",
      usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 120, cost: { total: 0 } },
      stopReason: "toolUse",
      timestamp: 1_020,
    };
    await emit(harness.handlers, "message_end", { type: "message_end", message: assistant }, ctx);
    await emit(harness.handlers, "tool_execution_start", {
      type: "tool_execution_start",
      toolCallId: "call-1",
      toolName: "bash",
      args: { command: "npm test" },
    }, ctx);
    await emit(harness.handlers, "tool_call", {
      type: "tool_call",
      toolCallId: "call-1",
      toolName: "bash",
      input: { command: "npm test", timeout: 30 },
    }, ctx);
    await emit(harness.handlers, "tool_result", {
      type: "tool_result",
      toolCallId: "call-1",
      toolName: "bash",
      input: { command: "npm test", timeout: 30 },
      content: [{ type: "text", text: "all tests passed" }],
      details: { exitCode: 0 },
      isError: false,
    }, ctx);
    await emit(harness.handlers, "tool_execution_end", {
      type: "tool_execution_end",
      toolCallId: "call-1",
      toolName: "bash",
      result: { content: [{ type: "text", text: "all tests passed" }] },
      isError: false,
    }, ctx);
    await emit(harness.handlers, "message_end", {
      type: "message_end",
      message: {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "bash",
        content: [{ type: "text", text: "all tests passed" }],
        isError: false,
        timestamp: 1_030,
      },
    }, ctx);
    await emit(harness.handlers, "turn_end", {
      type: "turn_end",
      turnIndex: 0,
      message: assistant,
      toolResults: [],
    }, ctx);
    await emit(harness.handlers, "agent_end", { type: "agent_end", messages: [assistant] }, ctx);
    await emit(harness.handlers, "agent_settled", { type: "agent_settled" }, ctx);
    await emit(harness.handlers, "session_shutdown", {
      type: "session_shutdown",
      reason: "quit",
    }, ctx);

    const events = readEvents(traceDir);
    const byType = (type: string) => events.filter(event => event.event === type);
    assert.ok(byType("session_start").length === 1);
    assert.deepEqual(byType("session_start")[0].traceContext, {
      parentSessionId: "parent-session",
      parentToolCallId: "parent-tool-call",
      workflowId: "workflow-1",
      workId: "work-1",
      taskKey: "inspect",
      stageIndex: 1,
      iterationIndex: 0,
    });
    assert.equal(byType("before_agent_start")[0].systemPrompt, "SYSTEM: use the available tools");
    assert.deepEqual(byType("context")[0].messages[0].content, "inspect the project");

    const request = byType("provider_request")[0];
    assert.deepEqual(request.traceContext, {
      parentSessionId: "parent-session",
      parentToolCallId: "parent-tool-call",
      workflowId: "workflow-1",
      workId: "work-1",
      taskKey: "inspect",
      stageIndex: 1,
      iterationIndex: 0,
    });
    assert.equal(request.piThinkingLevel, "high");
    assert.equal(request.providerThinking.reasoningEffort, "high");
    assert.equal(request.payload.messages[0].content, "inspect the project");
    assert.equal(request.payload.api_key, "do-not-save");
    assert.equal(request.requestId, byType("message_end")[0].requestId);

    const toolCall = byType("tool_call")[0];
    assert.equal(toolCall.input.command, "npm test");
    const toolResult = byType("tool_result")[0];
    assert.equal(toolResult.content[0].text, "all tests passed");
    assert.equal(toolResult.isError, false);
    assert.ok(toolResult.durationMs >= 0);
    assert.equal(byType("provider_headers")[0].headers.authorization, "do-not-save");
    assert.equal(byType("provider_headers")[0].headers["x-request-id"], "request-1");
    assert.ok(JSON.stringify(events).includes("do-not-save"));
    assert.ok(byType("session_shutdown").length === 1);
  } finally {
    rmSync(traceDir, { recursive: true, force: true });
  }
});

test("session replacement keeps events in the correct session file", async () => {
  const traceDir = mkdtempSync(join(tmpdir(), "pi-trajectory-switch-"));
  try {
    const harness = extensionHarness();
    const ctx = context() as any;
    let sessionId = "session-a";
    let sessionFile = "/tmp/session-a.jsonl";
    ctx.sessionManager.getSessionId = () => sessionId;
    ctx.sessionManager.getSessionFile = () => sessionFile;
    registerTrajectoryRecorder(harness.pi, {
      traceDir,
      processId: 99,
      idFactory: (() => {
        let id = 0;
        return () => `switch-id-${++id}`;
      })(),
    });

    await emit(harness.handlers, "session_start", { type: "session_start", reason: "startup" }, ctx);
    await emit(harness.handlers, "thinking_level_select", {
      type: "thinking_level_select",
      level: "high",
      previousLevel: "medium",
    }, ctx);
    await emit(harness.handlers, "session_shutdown", { type: "session_shutdown", reason: "new" }, ctx);

    sessionId = "session-b";
    sessionFile = "/tmp/session-b.jsonl";
    await emit(harness.handlers, "session_start", {
      type: "session_start",
      reason: "new",
      previousSessionFile: "/tmp/session-a.jsonl",
    }, ctx);
    await emit(harness.handlers, "session_info_changed", {
      type: "session_info_changed",
      name: "Second session",
    }, ctx);

    const first = readFileSync(join(traceDir, "sessions", "session-a", "events-99.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map(line => JSON.parse(line));
    const second = readFileSync(join(traceDir, "sessions", "session-b", "events-99.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map(line => JSON.parse(line));
    assert.ok(first.every(event => event.sessionId === "session-a" && event.sessionFile === "/tmp/session-a.jsonl"));
    assert.ok(second.every(event => event.sessionId === "session-b" && event.sessionFile === "/tmp/session-b.jsonl"));
    assert.equal(second[0].previousSessionFile, "/tmp/session-a.jsonl");
  } finally {
    rmSync(traceDir, { recursive: true, force: true });
  }
});

test("JSON conversion is non-mutating and preserves sensitive values", () => {
  const original: Record<string, unknown> = {
    authorization: "secret",
    "x-api-key": "another-key",
    sessionToken: "another-secret",
    nested: { api_key: "another-secret", visible: "ok" },
    tokenText: "prefix sk-1234567890123456 suffix",
  };
  original.self = original;

  const serialized = toJsonSafe(original) as Record<string, any>;
  assert.equal(serialized.authorization, "secret");
  assert.equal(serialized["x-api-key"], "another-key");
  assert.equal(serialized.sessionToken, "another-secret");
  assert.equal(serialized.nested.api_key, "another-secret");
  assert.equal(serialized.nested.visible, "ok");
  assert.equal(serialized.self, "[CIRCULAR]");
  assert.equal(serialized.tokenText, "prefix sk-1234567890123456 suffix");
  assert.equal(original.authorization, "secret");
});

test("provider thinking extraction keeps provider-specific effort controls", () => {
  assert.deepEqual(
    extractProviderThinking({
      reasoning_effort: "high",
      reasoning: { effort: "medium" },
      output_config: { effort: "max" },
      enable_thinking: true,
      thinking: { type: "adaptive", budget_tokens: 4_000 },
    }),
    {
      reasoningEffort: "high",
      reasoningEffortNested: "medium",
      outputConfigEffort: "max",
      enableThinking: true,
      thinkingType: "adaptive",
      thinkingBudgetTokens: 4_000,
    },
  );
});
