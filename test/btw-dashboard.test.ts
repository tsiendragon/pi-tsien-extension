import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { BtwDashboardAdapter } from "pi-tsien-side-chat/src/bridge.ts";
import type { BtwSessionController, BtwSnapshot } from "pi-tsien-side-chat/src/session.ts";

function context(): ExtensionContext {
  return {
    model: { provider: "test-provider", id: "test-model" },
  } as unknown as ExtensionContext;
}

function fakeController(): BtwSessionController {
  const snapshot: BtwSnapshot = {
    apiVersion: 1,
    revision: 1,
    generatedAt: 0,
    status: "ready",
    parentMessageCount: 3,
    model: "test-provider/test-model",
    activity: "",
    conversation: [
      { role: "user", text: "之前问过什么" },
      { role: "assistant", text: "之前答过什么" },
    ],
  };
  return {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    dispose: async () => {},
    submit: async () => {},
    abort: async () => {},
    refreshParentSnapshot: async () => {},
    isDisposed: false,
  } as unknown as BtwSessionController;
}

test("BTW dashboard adapter starts closed and rejects unrecognized commands", async () => {
  const adapter = new BtwDashboardAdapter(context());
  const snapshot = adapter.getSnapshot();
  assert.equal(snapshot.status, "closed");
  assert.equal(snapshot.model, "test-provider/test-model");
  assert.deepEqual(snapshot.conversation, []);
  await assert.rejects(() => adapter.dispatch({ type: "write", path: "/tmp/no" }), /invalid_btw_command/);
  await adapter.dispatch({ type: "close" });
  assert.equal(adapter.getSnapshot().status, "closed");
  await adapter.dispose();
});

test("BTW keeps the side chat after closing and reopens the same one", async () => {
  let created = 0;
  let disposed = 0;
  const controller = fakeController();
  controller.dispose = async () => {
    disposed += 1;
  };
  const adapter = new BtwDashboardAdapter(context(), async () => {
    created += 1;
    return controller;
  });

  await adapter.dispatch({ type: "open" });
  assert.equal(adapter.getSnapshot().status, "ready");

  await adapter.dispatch({ type: "close" });
  const closed = adapter.getSnapshot();
  assert.equal(closed.status, "closed");
  // Closed panel, retained exchanges: the dashboard keeps the transcript visible.
  assert.equal(closed.conversation.length, 2);

  await adapter.dispatch({ type: "open" });
  assert.equal(adapter.getSnapshot().status, "ready");
  assert.equal(created, 1, "reopening must reuse the retained side chat");

  // Asking from a closed panel reattaches it instead of creating a second chat.
  await adapter.dispatch({ type: "close" });
  await adapter.dispatch({ type: "submit", text: "再来一句" });
  assert.equal(adapter.getSnapshot().status, "ready");
  assert.equal(created, 1);

  await adapter.dispose();
  assert.equal(disposed, 1);
  assert.equal(adapter.getSnapshot().status, "closed");
  assert.deepEqual(adapter.getSnapshot().conversation, []);
});

test("a question asked during startup waits for the side chat instead of failing", async () => {
  const submitted: string[] = [];
  const controller = fakeController();
  controller.submit = async (text: string) => {
    submitted.push(text);
  };
  let release!: (value: BtwSessionController) => void;
  const pendingStart = new Promise<BtwSessionController>((resolve) => {
    release = resolve;
  });
  const adapter = new BtwDashboardAdapter(context(), () => pendingStart);

  // Asking without opening first is allowed (the dashboard enables the composer),
  // so the question has to ride along with the startup that is already running.
  const opening = adapter.dispatch({ type: "open" });
  const asking = adapter.dispatch({ type: "submit", text: "启动中也要能问" });
  release(controller);
  await Promise.all([opening, asking]);

  assert.deepEqual(submitted, ["启动中也要能问"]);
  assert.equal(adapter.getSnapshot().status, "ready");
  await adapter.dispose();
});