import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerLiveSessionExtension, type LiveSessionClientHandle } from "../extensions/live-session.ts";
import { LeaseManager } from "../extensions/live-session/lease.ts";
import { SnapshotProjector, sanitizeJson } from "../extensions/live-session/projector.ts";
import type { CommandEnvelope, EventMessage } from "../extensions/live-session/protocol.ts";
import type { LiveSessionClientOptions } from "../extensions/live-session/client.ts";
import { registerLiveFeatureCommandHandler } from "../extensions/lib/live-observer.ts";

function extensionHarness() {
  const handlers = new Map<string, Array<(event: any, ctx: ExtensionContext) => any>>();
  const commands = new Map<string, any>();
  const sent: Array<{ text: string; options: unknown }> = [];
  const pi = {
    on(name: string, handler: (event: any, ctx: ExtensionContext) => any) {
      const list = handlers.get(name) || [];
      list.push(handler);
      handlers.set(name, list);
    },
    registerCommand(name: string, command: unknown) { commands.set(name, command); },
    sendUserMessage(text: string, options: unknown) { sent.push({ text, options }); },
  } as unknown as ExtensionAPI;
  return { pi, handlers, commands, sent };
}

function context(state: { idle: boolean; aborted: boolean; notifications: string[] }): ExtensionContext {
  return {
    mode: "tui",
    cwd: "/mnt/workspace/lilong/repos/worktree/task-a",
    model: { provider: "test", id: "model" },
    thinkingLevel: "high",
    sessionManager: {
      getSessionId: () => "session-a",
      getSessionFile: () => "/tmp/session-a.jsonl",
      getSessionName: () => "Task A",
      getCwd: () => "/mnt/workspace/lilong/repos/worktree/task-a",
      getBranch: () => [{ type: "message", id: "m1", message: { role: "user", content: "hello" } }],
    },
    getContextUsage: () => ({ tokens: 20, contextWindow: 100, percent: 20 }),
    isIdle: () => state.idle,
    abort: () => { state.aborted = true; },
    ui: { notify: (message: string) => state.notifications.push(message) },
  } as unknown as ExtensionContext;
}

function envelope(command: CommandEnvelope["command"], requestId = "request-a"): CommandEnvelope {
  return { type: "command", requestId, processInstanceId: "process-a", command };
}

test("Live Session extension claims, injects prompts, gates TUI input, aborts, and releases locally", async () => {
  const harness = extensionHarness();
  const state = { idle: true, aborted: false, notifications: [] as string[] };
  const ctx = context(state);
  let options: LiveSessionClientOptions | undefined;
  let started = false;
  let stopped = false;
  const handle: LiveSessionClientHandle = {
    start: () => { started = true; }, publish: () => {}, sendSnapshot: () => {}, stop: () => { stopped = true; },
  };
  registerLiveSessionExtension(harness.pi, {
    identity: { processInstanceId: "process-a", startedAt: 1 },
    createClient: value => { options = value; return handle; },
  });
  await harness.handlers.get("session_start")?.[0]({}, ctx);
  assert.equal(started, true);
  assert.ok(options);
  assert.equal(options!.getHello("broker-token").sessionId, "session-a");
  assert.equal(options!.getSnapshot().entries.length, 1);

  const claimed = await options!.executeCommand(envelope({ type: "claim", browserClientId: "browser-a", requestedLeaseMs: 30_000 }));
  assert.equal(claimed.ok, true);
  const leaseId = claimed.ok ? String((claimed.result as any).leaseId) : "";
  assert.ok(leaseId);

  const input = harness.handlers.get("input")?.[0];
  assert.deepEqual(await input?.({ source: "interactive", text: "blocked" }, ctx), { action: "handled" });
  assert.deepEqual(await input?.({ source: "extension", text: "allowed" }, ctx), { action: "continue" });

  const prompt = await options!.executeCommand(envelope({ type: "prompt", leaseId, text: "from dashboard", expandPromptTemplates: false }, "request-prompt"));
  assert.equal(prompt.ok, true);
  assert.deepEqual(harness.sent, [{ text: "from dashboard", options: { expandPromptTemplates: false } }]);

  const featureCommands: unknown[] = [];
  const unregisterFeature = registerLiveFeatureCommandHandler("btw", async command => {
    featureCommands.push(command);
    return { status: "ready" };
  });
  const feature = await options!.executeCommand(envelope({ type: "feature_command", leaseId, feature: "btw", command: { type: "open" } }, "request-feature"));
  unregisterFeature();
  assert.equal(feature.ok, true);
  assert.deepEqual(featureCommands, [{ type: "open" }]);

  state.idle = false;
  const abort = await options!.executeCommand(envelope({ type: "abort", leaseId }, "request-abort"));
  assert.equal(abort.ok, true);
  assert.equal(state.aborted, true);

  await harness.commands.get("dashboard-release").handler("", ctx);
  assert.deepEqual(await input?.({ source: "interactive", text: "allowed again" }, ctx), { action: "continue" });
  await harness.handlers.get("session_shutdown")?.[0]({ reason: "quit" }, ctx);
  assert.equal(stopped, true);
});

test("Live Session extension does not publish hidden goal context messages", async () => {
  const harness = extensionHarness();
  const published: EventMessage[] = [];
  registerLiveSessionExtension(harness.pi, {
    identity: { processInstanceId: "process-a", startedAt: 1 },
    createClient: () => ({ start() {}, publish: message => published.push(message), sendSnapshot() {}, stop() {} }),
  });
  const ctx = context({ idle: true, aborted: false, notifications: [] });
  await harness.handlers.get("session_start")?.[0]({}, ctx);
  const hidden = { role: "custom", customType: "goal-context", display: false, content: "<goal_context>secret</goal_context>" };
  await harness.handlers.get("message_start")?.[0]({ message: hidden }, ctx);
  await harness.handlers.get("message_end")?.[0]({ message: hidden }, ctx);
  await harness.handlers.get("message_end")?.[0]({ message: { role: "assistant", content: "visible" } }, ctx);
  assert.equal(published.filter(message => message.event.type.startsWith("message_")).length, 1);
  assert.equal((published.at(-1)?.event.data as any).message.content, "visible");
});

test("Live Session extension does not register a Dashboard-owned session", async () => {
  const previous = process.env.PI_RUNTIME;
  process.env.PI_RUNTIME = "dashboard";
  try {
    const harness = extensionHarness();
    let clients = 0;
    registerLiveSessionExtension(harness.pi, {
      identity: { processInstanceId: "process-dashboard", startedAt: 1 },
      createClient: () => { clients += 1; throw new Error("must not create"); },
    });
    await harness.handlers.get("session_start")?.[0]({}, context({ idle: true, aborted: false, notifications: [] }));
    assert.equal(clients, 0);
  } finally {
    if (previous === undefined) delete process.env.PI_RUNTIME;
    else process.env.PI_RUNTIME = previous;
  }
});

test("LeaseManager expires and disconnect fail-open releases control", async () => {
  let now = 1_000;
  let id = 0;
  const lease = new LeaseManager({ now: () => now, idFactory: () => `lease-${++id}`, minLeaseMs: 10, maxLeaseMs: 100, defaultLeaseMs: 50, disconnectGraceMs: 5 });
  const claimed = lease.claim("browser", 50);
  assert.equal(claimed.state, "claimed");
  now = 2_000;
  assert.equal(lease.snapshot().state, "unclaimed");
  lease.claim("browser", 50);
  lease.markBrokerDisconnected();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(lease.snapshot().state, "unclaimed");
  lease.dispose();
});

test("SnapshotProjector redacts sensitive keys and enforces event sequence", () => {
  const sanitized = sanitizeJson({ authorization: "secret", nested: { api_key: "value", ok: "visible" } });
  assert.deepEqual(sanitized.value, { authorization: "[redacted]", nested: { api_key: "[redacted]", ok: "visible" } });
  const projector = new SnapshotProjector({
    processInstanceId: "process-a",
    snapshotEntryLimit: 20,
    getSummary: () => ({
      processInstanceId: "process-a", sessionId: "session-a", pid: 1,
      cwd: "/tmp", canonicalCwd: "/tmp", mode: "tui", status: "idle",
      claim: { state: "unclaimed" }, startedAt: 1, lastActivityAt: 1,
    }),
    getBranch: () => [{ type: "message", id: "m1", message: { role: "assistant", content: "ok" } }],
  });
  assert.equal(projector.createSnapshot().sequence, 0);
  assert.equal(projector.createEvent("agent_start", {}).sequence, 1);
  assert.equal(projector.createEvent("agent_settled", {}).sequence, 2);
  assert.equal(projector.createSnapshot().summary.eventSequence, 2);
});
