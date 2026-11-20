import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerLiveSessionExtension } from "../src/index.ts";
import { LIVE_SESSION_PROTOCOL_VERSION, parseBrokerMessage, type EventMessage, type SnapshotMessage } from "../src/protocol.ts";

const requestChannel = "pimatrix:proof-jobs:request";
const snapshotChannel = "pimatrix:proof-jobs:snapshot";
const task = { id: "job-1", label: "Check lemma", state: "running", createdAt: 100, startedAt: 200 };

function harness() {
  const events = new EventEmitter();
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  const frames: (EventMessage | SnapshotMessage)[] = [];
  const requests: unknown[] = [];
  let ready = false;
  let connect: () => void;
  let disconnect: () => void;
  const pi = {
    events: {
      on: (channel: string, handler: (data: unknown) => void) => {
        events.on(channel, handler);
        return () => events.off(channel, handler);
      },
      emit: (channel: string, data: unknown) => events.emit(channel, data),
    },
    on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.set(name, handler),
    registerCommand() {},
    registerTool() {},
  } as unknown as ExtensionAPI;
  events.on(requestChannel, data => requests.push(data));
  registerLiveSessionExtension(pi, {
    createClient: (options) => {
      const sendSnapshot = () => {
        frames.push(options.getSnapshot());
        options.afterSnapshot?.();
      };
      connect = () => { ready = true; options.onConnected?.(); sendSnapshot(); };
      disconnect = () => { ready = false; options.onDisconnected?.(); };
      return {
        start() {},
        stop() { ready = false; },
        isReady: () => ready,
        publish: message => frames.push(message),
        sendSnapshot,
      };
    },
  });
  return {
    events, frames, requests,
    connect: () => connect(),
    disconnect: () => disconnect(),
    fire: (name: string, event: unknown, sessionId = "session-a") => handlers.get(name)!(event, {
      mode: "rpc", cwd: "/tmp", isIdle: () => true, getContextUsage: () => undefined,
      sessionManager: {
        getSessionId: () => sessionId, getCwd: () => "/tmp", getBranch: () => [],
        getSessionName: () => undefined, getSessionFile: () => undefined,
      },
    } as unknown as ExtensionContext),
    snapshots: () => frames.flatMap(frame => frame.type === "event" && frame.event.type === "live_feature_snapshot"
      && frame.event.data.feature === "proof-jobs" ? [frame.event.data.snapshot] : []),
  };
}

test("proof jobs request a refresh and replay scoped data after connect, reconnect, and tree snapshots", async (t) => {
  const h = harness();
  t.after(() => { h.fire("session_shutdown", { reason: "quit" }); });
  h.events.once(requestChannel, ({ sessionId }) => {
    h.events.emit(snapshotChannel, { sessionId, tasks: [{ ...task, privateDetails: "not for the dashboard" }] });
  });
  await h.fire("session_start", { reason: "startup" });
  h.connect();
  assert.equal(h.frames[0]?.type, "snapshot");
  assert.deepEqual(h.requests, [{ sessionId: "session-a" }]);
  assert.deepEqual(h.snapshots(), [{ tasks: [task] }]);

  h.disconnect();
  const finished = { ...task, state: "done", finishedAt: 300 };
  h.events.emit(snapshotChannel, { sessionId: "session-a", tasks: [finished] });
  h.events.emit(snapshotChannel, { sessionId: "session-b", tasks: [] });
  h.events.emit(snapshotChannel, { sessionId: "session-a", tasks: [{ id: "malformed" }] });
  h.events.emit(snapshotChannel, { tasks: [] });
  h.frames.length = 0;
  h.connect();
  await delay(300); // let any queued pre-reconnect update flush
  assert.deepEqual(h.requests, [{ sessionId: "session-a" }, { sessionId: "session-a" }]);
  assert.equal(h.frames[0]?.type, "snapshot");
  assert.deepEqual(h.snapshots(), [{ tasks: [finished] }]);

  h.events.emit(snapshotChannel, { sessionId: "session-a", tasks: [] });
  await delay(300);
  assert.deepEqual(h.snapshots().at(-1), { tasks: [] });
  h.frames.length = 0;
  await h.fire("session_tree", { newLeafId: "leaf-b", oldLeafId: "leaf-a" });
  assert.equal(h.frames[0]?.type, "snapshot");
  assert.deepEqual(h.requests.at(-1), { sessionId: "session-a" });
  assert.deepEqual(h.snapshots(), [{ tasks: [] }]);
});

test("proof jobs reset on fork and unsubscribe on shutdown", async (t) => {
  const h = harness();
  t.after(() => { h.fire("session_shutdown", { reason: "quit" }, "session-b"); });
  await h.fire("session_start", { reason: "startup" });
  h.connect();
  assert.deepEqual(h.snapshots(), [{ tasks: [] }]);
  h.events.emit(snapshotChannel, { sessionId: "session-a", tasks: [task] });

  h.frames.length = 0;
  await h.fire("session_start", { reason: "fork" }, "session-b");
  h.events.emit(snapshotChannel, { sessionId: "session-a", tasks: [task] });
  assert.equal(h.events.listenerCount(snapshotChannel), 1);
  assert.deepEqual(h.requests.at(-1), { sessionId: "session-b" });
  assert.equal(h.frames[0]?.type, "snapshot");
  assert.deepEqual(h.snapshots(), [{ tasks: [] }]);

  await h.fire("session_shutdown", { reason: "quit" }, "session-b");
  assert.equal(h.events.listenerCount(snapshotChannel), 0);
});

test("proof jobs are read-only in protocol v2", () => {
  assert.equal(LIVE_SESSION_PROTOCOL_VERSION, 2);
  assert.equal(parseBrokerMessage({
    type: "command", requestId: "request", processInstanceId: "process",
    command: { type: "feature_command", feature: "proof-jobs", leaseId: "lease", command: { type: "cancel" } },
  }), undefined);
});
