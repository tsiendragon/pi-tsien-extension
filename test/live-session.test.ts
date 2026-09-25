import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerLiveSessionExtension, type LiveSessionClientHandle } from "pi-tsien-live-session/src/index.ts";
import { LeaseManager } from "pi-tsien-live-session/src/lease.ts";
import { SnapshotProjector, sanitizeJson } from "pi-tsien-live-session/src/projector.ts";
import { parseBrokerMessage } from "pi-tsien-live-session/src/protocol.ts";
import type { CommandEnvelope, EventMessage } from "pi-tsien-live-session/src/protocol.ts";
import type { LiveSessionClientOptions } from "pi-tsien-live-session/src/client.ts";
import { publishLiveFeature, registerLiveFeatureCommandHandler } from "pi-tsien-shared/src/lib/live-observer.ts";

function extensionHarness() {
  const handlers = new Map<string, Array<(event: any, ctx: ExtensionContext) => any>>();
  const commands = new Map<string, any>();
  const sent: Array<{ content: unknown; options: unknown }> = [];
  const pendingSends: Array<() => void> = [];
  const pi = {
    on(name: string, handler: (event: any, ctx: ExtensionContext) => any) {
      const list = handlers.get(name) || [];
      list.push(handler);
      handlers.set(name, list);
    },
    registerCommand(name: string, command: unknown) { commands.set(name, command); },
    registerTool() {},
    sendUserMessage(content: unknown, options: unknown) {
      sent.push({ content, options });
      return new Promise<void>(resolve => { pendingSends.push(resolve); });
    },
    setModel: async () => true,
    setThinkingLevel() {},
    getThinkingLevel: () => "high",
  } as unknown as ExtensionAPI;
  return { pi, handlers, commands, sent, pendingSends };
}

function context(state: { idle: boolean; aborted: boolean; compacted?: boolean; reloaded?: boolean; notifications: string[]; scopedModels?: unknown }): ExtensionContext {
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
    scopedModels: state.scopedModels,
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
  // dashboard 输入先排队：terminal 仍在途（activeInput），未释放前不投下一条
  const prompt = await options!.executeCommand(envelope({ type: "input", text: "from dashboard", channel: "web" }, "request-prompt"));
  assert.equal(prompt.ok, true);
  assert.deepEqual(harness.sent, [{ content: "from terminal", options: { expandPromptTemplates: true } }]);
  // agent_end 释放在途 terminal → drain dashboard
  harness.pendingSends.shift()?.();
  await new Promise(resolve => setTimeout(resolve, 0));
  await harness.handlers.get("message_end")?.[0]({ message: { role: "user", content: "from dashboard" } }, ctx);
  const imagePrompt = await options!.executeCommand(envelope({
    type: "input",
    text: "look at this",
    channel: "web",
    images: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
  }, "request-image-prompt"));
  assert.equal(imagePrompt.ok, true);
  // agent_end 释放 dashboard → drain image
  harness.pendingSends.shift()?.();
  await new Promise(resolve => setTimeout(resolve, 0));
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

test("get_models mirrors the scoped model set, falling back to the whole catalogue", async () => {
  const run = async (scopedModels: unknown) => {
    const harness = extensionHarness();
    const state = { idle: true, aborted: false, notifications: [] as string[], scopedModels };
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
    const result = await options!.executeCommand(envelope({ type: "get_models" }, "request-models"));
    return ((result as any).result.models as Array<{ provider: string; id: string }>).map(model => ({ provider: model.provider, id: model.id }));
  };

  // No scope configured (empty array, like pi's "every available model is usable").
  assert.deepEqual(await run([]), [{ provider: "test", id: "next" }]);
  assert.deepEqual(await run(undefined), [{ provider: "test", id: "next" }]);

  // A configured scope wins, so the picker shows only the models we actually use.
  const scoped = await run([
    { model: { provider: "dashscope", id: "deepseek-v4.1-flash", name: "DS", reasoning: true, contextWindow: 100, thinkingLevelMap: {} } },
    { model: { provider: "openai-codex", id: "gpt-5.6-sol", name: "Sol", reasoning: true, contextWindow: 100, thinkingLevelMap: {} } },
  ]);
  assert.deepEqual(scoped, [
    { provider: "dashscope", id: "deepseek-v4.1-flash" },
    { provider: "openai-codex", id: "gpt-5.6-sol" },
  ]);
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

test("Live Session extension projects extension notifications to the web", async () => {
  const harness = extensionHarness();
  const published: EventMessage[] = [];
  registerLiveSessionExtension(harness.pi, {
    identity: { processInstanceId: "process-a", startedAt: 1 },
    createClient: () => ({ start() {}, publish: message => published.push(message), sendSnapshot() {}, stop() {} }),
  });
  const ctx = context({ idle: true, aborted: false, notifications: [] });
  await harness.handlers.get("session_start")?.[0]({}, ctx);

  // /goal prints its command options via ctx.ui.notify; the bridge must mirror it.
  await harness.handlers.get("extension_ui_notify")?.[0]({ message: "Next actions: /goal status, /goal pause", notifyType: "info" }, ctx);
  const note = published.find(message => message.event.type === "extension_ui_notify");
  assert.ok(note);
  assert.deepEqual(note!.event.data, { message: "Next actions: /goal status, /goal pause", notifyType: "info" });
  assert.equal(published.filter(message => message.event.type === "extension_ui_notify").length, 1);

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

test("Live Session extension projects extension_ui requests and their close signal", async () => {
  const harness = extensionHarness();
  const state = { idle: true, aborted: false, notifications: [] as string[] };
  const ctx = context(state);
  const published: EventMessage[] = [];
  const handle: LiveSessionClientHandle = {
    start: () => {}, publish: message => published.push(message), sendSnapshot: () => {}, stop: () => {},
  };
  registerLiveSessionExtension(harness.pi, {
    identity: { processInstanceId: "process-a", startedAt: 1 },
    createClient: () => handle,
  });
  await harness.handlers.get("session_start")?.[0]({}, ctx);

  const onUi = harness.handlers.get("extension_ui")?.[0];
  assert.ok(onUi, "extension_ui handler is registered");

  await onUi?.({ type: "extension_ui", id: "ui-1", method: "select", title: "Pick one", options: ["a", "b"] }, ctx);
  const uiEvent = published.find(message => message.event.type === "extension_ui");
  assert.ok(uiEvent, "extension_ui request is projected");
  assert.equal((uiEvent!.event.data as any).id, "ui-1");
  assert.equal((uiEvent!.event.data as any).method, "select");
  assert.deepEqual((uiEvent!.event.data as any).options, ["a", "b"]);

  await onUi?.({ type: "extension_ui", id: "ui-1", method: "select", title: "Pick one", closed: true }, ctx);
  const closedEvent = published.find(message => message.event.type === "extension_ui_closed");
  assert.ok(closedEvent, "close signal is projected as extension_ui_closed");
  assert.equal((closedEvent!.event.data as any).id, "ui-1");
});

test("Live Session extension replays unanswered dialogs on resync", async () => {
  const harness = extensionHarness();
  const state = { idle: true, aborted: false, notifications: [] as string[] };
  const ctx = context(state);
  let options: LiveSessionClientOptions | undefined;
  const published: EventMessage[] = [];
  const handle: LiveSessionClientHandle = {
    start: () => {}, publish: message => published.push(message), sendSnapshot: () => {}, stop: () => {},
  };
  registerLiveSessionExtension(harness.pi, {
    identity: { processInstanceId: "process-a", startedAt: 1 },
    createClient: value => { options = value; return handle; },
  });
  await harness.handlers.get("session_start")?.[0]({}, ctx);

  const onUi = harness.handlers.get("extension_ui")?.[0];
  await onUi?.({ type: "extension_ui", id: "ui-7", method: "select", title: "Pick", options: ["a"] }, ctx);
  published.length = 0;

  // A (re)connecting client asks for a resync and must learn about the dialog pi
  // is still blocked on; otherwise the agent waits forever with no way to answer.
  const result = await options!.executeCommand(envelope({ type: "resync" }, "request-resync"));
  assert.equal(result.ok, true);
  const replay = result as { ok: true; result: { pendingUi: number } };
  assert.equal(replay.result.pendingUi, 1);
  const replayed = published.filter(message => message.event.type === "extension_ui");
  assert.equal(replayed.length, 1);
  assert.equal((replayed[0].event.data as any).id, "ui-7");

  // Once the dialog is answered/closed it is no longer replayed.
  await onUi?.({ type: "extension_ui", id: "ui-7", method: "select", title: "Pick", closed: true }, ctx);
  published.length = 0;
  const afterClose = await options!.executeCommand(envelope({ type: "resync" }, "request-resync-2"));
  const afterReplay = afterClose as { ok: true; result: { pendingUi: number } };
  assert.equal(afterReplay.result.pendingUi, 0);
  assert.equal(published.filter(message => message.event.type === "extension_ui").length, 0);
});

test("Live Session extension answers UI requests through respondExtensionUi", async () => {
  const harness = extensionHarness();
  const state = { idle: true, aborted: false, notifications: [] as string[] };
  const ctx = context(state);
  let options: LiveSessionClientOptions | undefined;
  const handle: LiveSessionClientHandle = {
    start: () => {}, publish: () => {}, sendSnapshot: () => {}, stop: () => {},
  };
  registerLiveSessionExtension(harness.pi, {
    identity: { processInstanceId: "process-a", startedAt: 1 },
    createClient: value => { options = value; return handle; },
  });
  await harness.handlers.get("session_start")?.[0]({}, ctx);

  const answered: Array<{ id: string; response: unknown }> = [];
  (harness.pi as unknown as { respondExtensionUi: (id: string, r: unknown) => boolean }).respondExtensionUi =
    (id, response) => { answered.push({ id, response }); return true; };

  const valueRes = await options!.executeCommand(envelope({ type: "answer_ui", id: "ui-1", value: "a" }, "req-1"));
  assert.equal(valueRes.ok, true);
  assert.equal(answered.length, 1);
  assert.equal(answered[0].id, "ui-1");
  assert.deepEqual(answered[0].response, { value: "a" });

  const cancelledRes = await options!.executeCommand(envelope({ type: "answer_ui", id: "ui-2", cancelled: true }, "req-2"));
  assert.equal(cancelledRes.ok, true);
  assert.equal(answered.length, 2);
  assert.deepEqual(answered[1].response, { cancelled: true });
});

test("Live Session drains queued input after a slash-command turn with no user message_end", async () => {
  const harness = extensionHarness();
  // isIdle=false → inputs arrive while the agent runs and queue as followUp.
  const state = { idle: false, aborted: false, notifications: [] as string[] };
  const ctx = context(state);
  let options: LiveSessionClientOptions | undefined;
  registerLiveSessionExtension(harness.pi, {
    identity: { processInstanceId: "process-a", startedAt: 1 },
    createClient: value => { options = value; return { start() {}, publish() {}, sendSnapshot() {}, stop() {} }; },
  });
  await harness.handlers.get("session_start")?.[0]({}, ctx);
  const claimed = await options!.executeCommand(envelope({ type: "claim", browserClientId: "browser-a", requestedLeaseMs: 30_000 }));
  assert.ok(claimed.ok && String((claimed.result as any).leaseId));

  // A slash command dispatches through the queue but its turn emits no role:"user"
  // message_end — the exact wedge. It lands as the single in-flight input.
  const command = await options!.executeCommand(envelope({ type: "input", text: "/effort high", channel: "web", deliverAs: "followUp" }, "req-cmd"));
  assert.equal(command.ok, true);
  assert.deepEqual(harness.sent, [{ content: "/effort high", options: { deliverAs: "followUp", expandPromptTemplates: true } }]);

  // The next input is held behind activeInput (serialized), not yet delivered.
  const next = await options!.executeCommand(envelope({ type: "input", text: "after command", channel: "web" }, "req-next"));
  assert.equal(next.ok, true);
  assert.deepEqual(harness.sent, [{ content: "/effort high", options: { deliverAs: "followUp", expandPromptTemplates: true } }]);

  // A slash command completes when pi executes the extension command and returns
  // (no agent turn), so the dispatch promise settling is the release signal — not
  // agent_end, which never fires here. This drains the next queued input.
  harness.pendingSends.shift()?.();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(harness.sent, [
    { content: "/effort high", options: { deliverAs: "followUp", expandPromptTemplates: true } },
    { content: "after command", options: { deliverAs: "followUp", expandPromptTemplates: true } },
  ]);
});

test("Live Session broker protocol parses the answer_ui command", () => {
  // Regression: answer_ui was missing from parseCommand, so the client treated
  // the broker command as invalid and destroyed the socket (surfacing as HTTP 500).
  assert.deepEqual(
    parseBrokerMessage({
      type: "command",
      requestId: "req-1",
      processInstanceId: "process-a",
      command: { type: "answer_ui", id: "ui-1", value: "high" },
    }),
    {
      type: "command",
      requestId: "req-1",
      processInstanceId: "process-a",
      command: { type: "answer_ui", id: "ui-1", value: "high" },
    },
  );

  const cancelled = parseBrokerMessage({
    type: "command",
    requestId: "req-2",
    processInstanceId: "process-a",
    command: { type: "answer_ui", id: "ui-2", cancelled: true },
  }) as unknown as { command?: unknown } | undefined;
  assert.deepEqual(cancelled?.command, { type: "answer_ui", id: "ui-2", cancelled: true });

  // Still fail closed on malformed payloads (missing id, unknown fields, wrong types).
  assert.equal(parseBrokerMessage({ type: "command", requestId: "r", processInstanceId: "p", command: { type: "answer_ui" } }), undefined);
  assert.equal(parseBrokerMessage({ type: "command", requestId: "r", processInstanceId: "p", command: { type: "answer_ui", id: "ui", bogus: 1 } }), undefined);
  assert.equal(parseBrokerMessage({ type: "command", requestId: "r", processInstanceId: "p", command: { type: "answer_ui", id: "ui", value: 3 } }), undefined);
});

test("Live Session does not swallow the CLI prompt in print/json mode", () => {
  for (const mode of ["print", "json"]) {
    const harness = extensionHarness();
    registerLiveSessionExtension(harness.pi, {
      identity: { processInstanceId: `process-${mode}`, startedAt: 1 },
    });
    const ctx = { ...context({ idle: true, aborted: false, notifications: [] }), mode } as unknown as ExtensionContext;
    const result = harness.handlers.get("input")?.[0]({ type: "input", text: "hello", source: "interactive" }, ctx);
    assert.deepEqual(result, { action: "continue" });
    assert.equal(harness.sent.length, 0);
  }
});

test("Live Session still routes interactive input in tui mode", () => {
  const harness = extensionHarness();
  registerLiveSessionExtension(harness.pi, {
    identity: { processInstanceId: "process-tui", startedAt: 1 },
  });
  const ctx = context({ idle: true, aborted: false, notifications: [] });
  const result = harness.handlers.get("input")?.[0]({ type: "input", text: "hello", source: "interactive" }, ctx);
  assert.deepEqual(result, { action: "handled" });
  assert.equal(harness.sent.length, 1);
});

/**
 * The dashboard graph page drives session-tree writes through the plain `input`
 * channel (`/ls-navigate`, `/ls-fork`) to avoid a wire-protocol change. Two
 * guarantees are covered here: the capability flag the dashboard gates on, and
 * the guards that stop a stale/incorrect client from polluting the model
 * context or fighting a live turn.
 */
test("Live Session advertises the session_tree capability and re-snapshots on tree navigation", async () => {
  const harness = extensionHarness();
  const state = { idle: true, aborted: false, notifications: [] as string[] };
  const ctx = context(state);
  let options: LiveSessionClientOptions | undefined;
  const published: EventMessage[] = [];
  let snapshots = 0;
  const handle: LiveSessionClientHandle = {
    start: () => {},
    publish: message => published.push(message),
    sendSnapshot: () => { snapshots += 1; },
    stop: () => {},
  };
  registerLiveSessionExtension(harness.pi, {
    identity: { processInstanceId: "process-tree", startedAt: 1 },
    createClient: value => { options = value; return handle; },
  });
  await harness.handlers.get("session_start")?.[0]({}, ctx);

  assert.deepEqual(options!.getSnapshot().summary.capabilities, ["session_tree"]);

  // Terminal `/tree` (or our own command) must push a fresh snapshot: the
  // snapshot only carries the ACTIVE branch, so an event alone would leave the
  // web transcript on the abandoned branch.
  await harness.handlers.get("session_tree")?.[0]({ type: "session_tree", newLeafId: "m2", oldLeafId: "m1" }, ctx);
  assert.equal(snapshots, 1);
  const last = published.at(-1);
  assert.equal(last?.event.type, "session_tree");
  assert.equal(last?.event.data?.newLeafId, "m2");
});

test("Live Session advertises session_clear only while /clear is really registered", async () => {
  const harness = extensionHarness();
  (harness.pi as unknown as { getCommands: () => unknown[] }).getCommands = () => [
    { name: "clear", description: "Start a fresh session", source: "extension" },
  ];
  let options: LiveSessionClientOptions | undefined;
  registerLiveSessionExtension(harness.pi, {
    identity: { processInstanceId: "process-clear", startedAt: 1 },
    createClient: value => { options = value; return { start() {}, publish() {}, sendSnapshot() {}, stop() {} }; },
  });
  const ctx = context({ idle: true, aborted: false, notifications: [] });
  await harness.handlers.get("session_start")?.[0]({}, ctx);
  assert.deepEqual(options!.getSnapshot().summary.capabilities, ["session_tree", "session_clear"]);

  // The dashboard's 「清空」rides the input channel as `/clear`, and `/clear` comes from
  // the session-aliases EXTENSION, not from pi. pi skips an extension whose file is
  // missing without a word, and then hands `/clear` to the model as plain text — a
  // click that burns a turn and clears nothing. So the flag is checked, not assumed.
  (harness.pi as unknown as { getCommands: () => unknown[] }).getCommands = () => [];
  await harness.handlers.get("session_start")?.[0]({}, ctx);
  assert.deepEqual(options!.getSnapshot().summary.capabilities, ["session_tree"]);
  await harness.handlers.get("session_shutdown")?.[0]({ reason: "quit" }, ctx);
});

test("ls-navigate / ls-fork call the command-context tree actions", async () => {
  const harness = extensionHarness();
  const state = { idle: true, aborted: false, notifications: [] as string[] };
  const ctx = context(state);
  registerLiveSessionExtension(harness.pi, {
    identity: { processInstanceId: "process-tree", startedAt: 1 },
    createClient: () => ({ start: () => {}, publish: () => {}, sendSnapshot: () => {}, stop: () => {} }),
  });
  await harness.handlers.get("session_start")?.[0]({}, ctx);

  const calls: string[] = [];
  const commandCtx = {
    ...ctx,
    navigateTree: async (targetId: string) => { calls.push(`navigate:${targetId}`); return { cancelled: false }; },
    fork: async (entryId: string) => { calls.push(`fork:${entryId}`); return { cancelled: false }; },
  };

  await harness.commands.get("ls-navigate").handler("m2", commandCtx);
  await harness.commands.get("ls-fork").handler("m3", commandCtx);
  assert.deepEqual(calls, ["navigate:m2", "fork:m3"]);
});

test("session-tree writes are refused while running, without args, or under another browser's lease", async () => {
  const harness = extensionHarness();
  const state = { idle: true, aborted: false, notifications: [] as string[] };
  const ctx = context(state);
  let options: LiveSessionClientOptions | undefined;
  registerLiveSessionExtension(harness.pi, {
    identity: { processInstanceId: "process-tree", startedAt: 1 },
    createClient: value => { options = value; return { start: () => {}, publish: () => {}, sendSnapshot: () => {}, stop: () => {} }; },
  });
  await harness.handlers.get("session_start")?.[0]({}, ctx);

  let navigated = 0;
  const commandCtx = { ...ctx, navigateTree: async () => { navigated += 1; return { cancelled: false }; } };
  const navigate = harness.commands.get("ls-navigate");

  // 1) missing target id
  await navigate.handler("", commandCtx);
  assert.equal(navigated, 0);

  // 2) agent is not idle: pi rejects navigateTree mid-turn, so refuse early
  state.idle = false;
  await navigate.handler("m2", commandCtx);
  assert.equal(navigated, 0);
  assert.ok(state.notifications.some(message => message.includes("正在运行")));
  state.idle = true;

  // 3) another browser holds the lease: a lease-less call must be refused
  const claimed = await options!.executeCommand(envelope({ type: "claim", browserClientId: "browser-a", requestedLeaseMs: 30_000 }));
  const leaseId = claimed.ok ? String((claimed.result as any).leaseId) : "";
  assert.ok(leaseId);
  await navigate.handler("m2", commandCtx);
  assert.equal(navigated, 0);

  // ...and accepted once the matching lease is supplied
  await navigate.handler(`m2 ${leaseId}`, commandCtx);
  assert.equal(navigated, 1);
});

/**
 * The dashboard cannot see `ctx.ui.notify`, so every `/ls-*` outcome is published
 * as a `tree_action` event. Two traps this pins down, both found by driving a real
 * pi session: (1) pi makes the captured command ctx STALE after a fork, so
 * post-fork work must use the `withSession` ctx; and (2) pi defers the forked
 * session file when the branch has no assistant message yet, which the dashboard
 * must be told about instead of showing “no new session”.
 */
test("ls-fork reports its outcome through withSession and flags a deferred session file", async () => {
  const harness = extensionHarness();
  const state = { idle: true, aborted: false, notifications: [] as string[] };
  const ctx = context(state);
  const published: EventMessage[] = [];
  registerLiveSessionExtension(harness.pi, {
    identity: { processInstanceId: "process-tree", startedAt: 1 },
    createClient: () => ({ start: () => {}, publish: message => published.push(message), sendSnapshot: () => {}, stop: () => {} }),
  });
  await harness.handlers.get("session_start")?.[0]({}, ctx);

  const oldCtxNotifications: string[] = [];
  const newCtxNotifications: string[] = [];
  const missingFile = `/tmp/does-not-exist-${Math.random().toString(36).slice(2)}.jsonl`;
  const commandCtx = {
    ...ctx,
    ui: { notify: (message: string) => oldCtxNotifications.push(message) },
    fork: async (_entryId: string, options: { withSession?: (next: unknown) => Promise<void> }) => {
      await options.withSession?.({
        ...ctx,
        ui: { notify: (message: string) => newCtxNotifications.push(message) },
        sessionManager: { ...(ctx as any).sessionManager, getSessionFile: () => missingFile },
      });
      return { cancelled: false };
    },
  };

  await harness.commands.get("ls-fork").handler("m3", commandCtx);

  // The outcome reached the dashboard...
  const action = published.find(message => message.event.type === "tree_action");
  assert.equal(action?.event.data?.ok, true);
  assert.equal(action?.event.data?.entryId, "m3");
  assert.equal(action?.event.data?.filePending, true);
  assert.equal(action?.event.data?.sessionFile, missingFile);
  // ...and the terminal notice used the REPLACEMENT ctx, never the stale one.
  assert.equal(newCtxNotifications.length, 1);
  assert.ok(newCtxNotifications[0].includes("还没把它写入磁盘"));
  assert.deepEqual(oldCtxNotifications, []);
});

test("a refused ls-navigate is published, not just notified", async () => {
  const harness = extensionHarness();
  const state = { idle: true, aborted: false, notifications: [] as string[] };
  const ctx = context(state);
  const published: EventMessage[] = [];
  registerLiveSessionExtension(harness.pi, {
    identity: { processInstanceId: "process-tree", startedAt: 1 },
    createClient: () => ({ start: () => {}, publish: message => published.push(message), sendSnapshot: () => {}, stop: () => {} }),
  });
  await harness.handlers.get("session_start")?.[0]({}, ctx);

  state.idle = false; // pi refuses navigateTree mid-turn
  await harness.commands.get("ls-navigate").handler("m2", { ...ctx, navigateTree: async () => ({ cancelled: false }) });

  const action = published.find(message => message.event.type === "tree_action");
  assert.equal(action?.event.data?.ok, false);
  assert.equal(action?.event.data?.action, "navigate");
  assert.ok(String(action?.event.data?.message).includes("正在运行"));

  // A cancelled fork is an outcome too: the graph must not claim success.
  state.idle = true;
  await harness.commands.get("ls-fork").handler("m3", { ...ctx, fork: async () => ({ cancelled: true }) });
  const cancelled = published.filter(message => message.event.type === "tree_action").at(-1);
  assert.equal(cancelled?.event.data?.action, "fork");
  assert.equal(cancelled?.event.data?.ok, false);
  assert.ok(String(cancelled?.event.data?.message).includes("已取消"));
});

test("Live Session extension binds a message's session entry id after pi persists it", async () => {
  const harness = extensionHarness();
  const published: EventMessage[] = [];
  registerLiveSessionExtension(harness.pi, {
    identity: { processInstanceId: "process-a", startedAt: 1 },
    createClient: () => ({ start() {}, publish: message => published.push(message), sendSnapshot() {}, stop() {} }),
  });

  // `message_end` is emitted BEFORE `SessionManager.appendMessage` runs, so the
  // entry only exists once the handler has returned. The id therefore arrives on
  // a later macrotask, published as its own `message_entry` event.
  const message = { role: "user", content: "fork me here" };
  const entries: unknown[] = [];
  const base = context({ idle: true, aborted: false, notifications: [] });
  const ctx = {
    ...base,
    sessionManager: { ...(base as any).sessionManager, getEntries: () => entries },
  } as unknown as ExtensionContext;
  await harness.handlers.get("session_start")?.[0]({}, ctx);

  await harness.handlers.get("message_end")?.[0]({ message }, ctx);
  assert.equal(published.some(entry => entry.event.type === "message_entry"), false);

  entries.push({ type: "message", id: "entry-42", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message });
  await new Promise(resolve => setTimeout(resolve, 0));

  const bound = published.find(entry => entry.event.type === "message_entry");
  assert.equal((bound?.event.data as any).entryId, "entry-42");
  assert.equal((bound?.event.data as any).message, undefined, "the carrier must stay tiny");
  await harness.handlers.get("session_shutdown")?.[0]({ reason: "quit" }, ctx);
});

test("Live Session derives status from pi's idle state and re-asserts it on a heartbeat", async () => {
  const harness = extensionHarness();
  const published: EventMessage[] = [];
  let options: LiveSessionClientOptions | undefined;
  registerLiveSessionExtension(harness.pi, {
    identity: { processInstanceId: "process-a", startedAt: 1 },
    statusHeartbeatMs: 5,
    createClient: value => { options = value; return { start() {}, publish: message => published.push(message), sendSnapshot() {}, stop() {} }; },
  });
  // A standalone compaction (auto-compact-target calling ctx.compact()) makes pi
  // non-idle without ever emitting agent_start/agent_settled, so a reload landing
  // during it seeded "running" with nothing left to clear it. The dashboard showed
  // 工作中 on a session sitting at its prompt.
  const state = { idle: false, aborted: false, notifications: [] };
  const ctx = context(state);
  await harness.handlers.get("session_start")?.[0]({ reason: "reload" }, ctx);
  assert.equal((options!.getSnapshot().summary as any).status, "running", "pi's own idle state is the source, not the agent event history");

  // pi finishes the compaction on its own and no agent event fires: only the beat notices.
  state.idle = true;
  await new Promise(resolve => setTimeout(resolve, 25));
  const patch = published.find(entry => entry.event.type === "summary_update");
  assert.ok(patch, "the heartbeat must publish the drifted status");
  assert.equal((patch!.event.data as any).status, "idle");
  assert.equal((options!.getSnapshot().summary as any).status, "idle");

  // An unchanged status stays silent: no per-beat chatter on an idle session.
  published.length = 0;
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.deepEqual(published, []);

  await harness.handlers.get("agent_start")?.[0]({}, ctx);
  state.idle = false;
  assert.equal((options!.getSnapshot().summary as any).status, "running");
  await harness.handlers.get("session_shutdown")?.[0]({ reason: "quit" }, ctx);
  published.length = 0;
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.deepEqual(published, [], "the heartbeat must stop with the session");
});

test("Live Session publishes context telemetry on the event stream, not only in snapshots", async () => {
  const harness = extensionHarness();
  const published: EventMessage[] = [];
  let options: LiveSessionClientOptions | undefined;
  registerLiveSessionExtension(harness.pi, {
    identity: { processInstanceId: "process-a", startedAt: 1 },
    createClient: value => { options = value; return { start() {}, publish: message => published.push(message), sendSnapshot() {}, stop() {} }; },
  });
  const ctx = context({ idle: true, aborted: false, notifications: [] });
  await harness.handlers.get("session_start")?.[0]({}, ctx);

  // The snapshot carries the trigger so a freshly attached dashboard can draw it
  // before the first turn.
  const snapshotCompact = (options!.getSnapshot().summary as any).compact;
  assert.equal(snapshotCompact?.enabled, true);
  assert.equal(snapshotCompact?.candidates?.[0]?.source, "auto-compact-target");

  await harness.handlers.get("agent_settled")?.[0]({}, ctx);
  const telemetry = published.find(entry => entry.event.type === "summary_update");
  assert.ok(telemetry, "agent_settled must publish summary_update");
  assert.deepEqual((telemetry!.event.data as any).contextUsage, { tokens: 20, contextWindow: 100, percent: 20 });
  assert.equal((telemetry!.event.data as any).compact.enabled, true);
  assert.equal(
    (telemetry!.event.data as any).compact.triggerTokens,
    (telemetry!.event.data as any).compact.candidates[0].tokens,
  );

  // Ordering contract: the transcript binds a message's entry id to the nearest
  // PRECEDING `message_end`, so telemetry must not land between `message_end` and
  // its deferred `message_entry`.
  published.length = 0;
  await harness.handlers.get("message_end")?.[0]({ message: { role: "user", content: "hi" } }, ctx);
  assert.equal(published.at(-1)?.event.type, "message_end");
  assert.equal(published.at(-2)?.event.type, "summary_update");
  await harness.handlers.get("session_shutdown")?.[0]({ reason: "quit" }, ctx);
});
