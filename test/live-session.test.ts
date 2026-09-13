import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerLiveSessionExtension, type LiveSessionClientHandle } from "../extensions/live-session.ts";
import { LeaseManager } from "../extensions/live-session/lease.ts";
import { SnapshotProjector, sanitizeJson } from "../extensions/live-session/projector.ts";
import type { CommandEnvelope, EventMessage } from "../extensions/live-session/protocol.ts";
import type { LiveSessionClientOptions } from "../extensions/live-session/client.ts";
import { publishLiveFeature, registerLiveFeatureCommandHandler } from "../extensions/lib/live-observer.ts";

function extensionHarness() {
  const handlers = new Map<string, Array<(event: any, ctx: ExtensionContext) => any>>();
  const commands = new Map<string, any>();
  const sent: Array<{ content: unknown; options: unknown }> = [];
  const pi = {
    on(name: string, handler: (event: any, ctx: ExtensionContext) => any) {
      const list = handlers.get(name) || [];
      list.push(handler);
      handlers.set(name, list);
    },
    registerCommand(name: string, command: unknown) { commands.set(name, command); },
    registerTool() {},
    sendUserMessage(content: unknown, options: unknown) { sent.push({ content, options }); },
    setModel: async () => true,
    setThinkingLevel() {},
    getThinkingLevel: () => "high",
  } as unknown as ExtensionAPI;
  return { pi, handlers, commands, sent };
}

function context(state: { idle: boolean; aborted: boolean; compacted?: boolean; reloaded?: boolean; notifications: string[] }): ExtensionContext {
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
    modelRegistry: {
      getAvailable: () => [{ provider: "test", id: "next", name: "Next", reasoning: true, contextWindow: 100, thinkingLevelMap: {} }],
      find: () => ({ provider: "test", id: "next", name: "Next", reasoning: true, contextWindow: 100, thinkingLevelMap: {} }),
    },
    compact: () => { state.compacted = true; },
    reload: async () => { state.reloaded = true; },
    isIdle: () => state.idle,
    abort: () => { state.aborted = true; },
    ui: { notify: (message: string) => state.notifications.push(message) },
  } as unknown as ExtensionContext;
}

function envelope(command: CommandEnvelope["command"], requestId = "request-a"): CommandEnvelope {
  return { type: "command", requestId, processInstanceId: "process-a", command };
}

test("Live Session extension shares prompt input while keeping strong controls leased", async () => {
  const harness = extensionHarness();
  const state = { idle: true, aborted: false, notifications: [] as string[] };
  const ctx = context(state);
  let options: LiveSessionClientOptions | undefined;
  let started = false;
  let stopped = false;
  const published: EventMessage[] = [];
  const handle: LiveSessionClientHandle = {
    start: () => { started = true; }, publish: message => published.push(message), sendSnapshot: () => {}, stop: () => { stopped = true; },
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
  assert.deepEqual(await input?.({ source: "interactive", text: "from terminal" }, ctx), { action: "handled" });
  assert.deepEqual(await input?.({ source: "extension", text: "already queued" }, ctx), { action: "continue" });
  assert.deepEqual(harness.sent, [{ content: "from terminal", options: { expandPromptTemplates: true } }]);

  await harness.handlers.get("message_end")?.[0]({ message: { role: "user", content: "from terminal" } }, ctx);
  assert.equal((published.at(-1)?.event.data as any).channel, "terminal");
  const prompt = await options!.executeCommand(envelope({ type: "input", text: "from dashboard", channel: "web" }, "request-prompt"));
  assert.equal(prompt.ok, true);
  await harness.handlers.get("message_end")?.[0]({ message: { role: "user", content: "from dashboard" } }, ctx);
  const imagePrompt = await options!.executeCommand(envelope({
    type: "input",
    text: "look at this",
    channel: "web",
    images: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
  }, "request-image-prompt"));
  assert.equal(imagePrompt.ok, true);
  assert.deepEqual(harness.sent, [
    { content: "from terminal", options: { expandPromptTemplates: true } },
    { content: "from dashboard", options: { expandPromptTemplates: true } },
    { content: [{ type: "text", text: "look at this" }, { type: "image", data: "aGVsbG8=", mimeType: "image/png" }], options: { expandPromptTemplates: true } },
  ]);

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
  await harness.handlers.get("message_end")?.[0]({ message: { role: "user", content: "from dashboard" } }, ctx);
  assert.deepEqual(await input?.({ source: "interactive", text: "still shared" }, ctx), { action: "handled" });
  await harness.handlers.get("session_shutdown")?.[0]({ reason: "quit" }, ctx);
  assert.equal(stopped, true);
});

test("Live Session extension executes model and context controls", async () => {
  const harness = extensionHarness();
  const state = { idle: true, aborted: false, compacted: false, reloaded: false, notifications: [] as string[] };
  let options: LiveSessionClientOptions | undefined;
  registerLiveSessionExtension(harness.pi, {
    identity: { processInstanceId: "process-a", startedAt: 1 },
    createClient: value => {
      options = value;
      return { start() {}, publish() {}, sendSnapshot() {}, stop() {} };
    },
  });
  const ctx = context(state);
  await harness.handlers.get("session_start")?.[0]({}, ctx);
  const models = await options!.executeCommand(envelope({ type: "get_models" }, "request-models"));
  assert.equal(models.ok, true);
  assert.equal((models as any).result.models[0].id, "next");
  const claimed = await options!.executeCommand(envelope({ type: "claim", browserClientId: "browser-a", requestedLeaseMs: 30_000 }, "request-claim"));
  const leaseId = claimed.ok ? String((claimed as any).result.leaseId) : "";
  assert.ok(leaseId);
  const compact = await options!.executeCommand(envelope({ type: "compact", leaseId }, "request-compact"));
  assert.equal(compact.ok, true);
  assert.equal(state.compacted, true);
  const model = await options!.executeCommand(envelope({ type: "set_model", provider: "test", modelId: "next" }, "request-set-model"));
  assert.equal(model.ok, true);
  const clear = await options!.executeCommand(envelope({ type: "input", text: "/clear", channel: "web" }, "request-clear"));
  assert.equal(clear.ok, true);
  await harness.handlers.get("message_end")?.[0]({ message: { role: "user", content: "/clear" } }, ctx);
  const reload = await options!.executeCommand(envelope({ type: "reload" }, "request-reload"));
  assert.equal(reload.ok, true);
  await harness.commands.get("live-session-reload").handler("", ctx);
  assert.equal(state.reloaded, true);
  assert.deepEqual(harness.sent, [
    { content: "/clear", options: { expandPromptTemplates: true } },
    { content: "/live-session-reload", options: { expandPromptTemplates: true } },
  ]);
  await harness.handlers.get("session_shutdown")?.[0]({ reason: "quit" }, ctx);
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
  await harness.handlers.get("session_shutdown")?.[0]({ reason: "quit" }, ctx);
});

test("Live Session extension echoes the input channel on injected user messages", async () => {
  const harness = extensionHarness();
  const published: EventMessage[] = [];
  let options: LiveSessionClientOptions | undefined;
  registerLiveSessionExtension(harness.pi, {
    identity: { processInstanceId: "process-a", startedAt: 1 },
    createClient: value => {
      options = value;
      return { start() {}, publish: message => published.push(message), sendSnapshot() {}, stop() {} };
    },
  });
  const ctx = context({ idle: true, aborted: false, notifications: [] });
  await harness.handlers.get("session_start")?.[0]({}, ctx);

  const prompt = await options!.executeCommand(envelope({ type: "input", text: "hi from chatapp", channel: "chatapp" }, "request-prompt"));
  assert.equal(prompt.ok, true);

  await harness.handlers.get("message_end")?.[0]({ message: { role: "user", content: "hi from chatapp" } }, ctx);
  const userMessage = published.find(message => message.event.type === "message_end" && (message.event.data as any).message?.role === "user");
  assert.ok(userMessage);
  assert.equal((userMessage!.event.data as any).channel, "chatapp");

  await harness.handlers.get("session_shutdown")?.[0]({ reason: "quit" }, ctx);
});

test("Live Session extension skips disconnected events and coalesces feature snapshots", async () => {
  const harness = extensionHarness();
  const published: EventMessage[] = [];
  let ready = false;
  let options: LiveSessionClientOptions | undefined;
  const handle: LiveSessionClientHandle = {
    start() {},
    isReady: () => ready,
    publish: message => published.push(message),
    sendSnapshot() {},
    stop() {},
  };
  registerLiveSessionExtension(harness.pi, {
    identity: { processInstanceId: "process-a", startedAt: 1 },
    createClient: value => {
      options = value;
      return handle;
    },
  });
  const ctx = context({ idle: true, aborted: false, notifications: [] });
  await harness.handlers.get("session_start")?.[0]({}, ctx);

  await harness.handlers.get("message_end")?.[0]({ message: { role: "assistant", content: "not connected" } }, ctx);
  assert.equal(published.length, 0);

  ready = true;
  options?.onConnected?.();
  publishLiveFeature("subagent-workflow", { revision: 1 });
  publishLiveFeature("subagent-workflow", { revision: 2 });
  await new Promise(resolve => setTimeout(resolve, 300));

  const featureEvents = published.filter(message => message.event.type === "live_feature_snapshot");
  assert.equal(featureEvents.length, 1);
  assert.equal((featureEvents[0]?.event.data as any).snapshot.revision, 2);
  await harness.handlers.get("session_shutdown")?.[0]({ reason: "quit" }, ctx);
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
