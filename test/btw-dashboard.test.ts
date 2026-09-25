import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { BtwDashboardAdapter } from "pi-tsien-side-chat/src/bridge.ts";

function context(): ExtensionContext {
  return {
    model: { provider: "test-provider", id: "test-model" },
  } as unknown as ExtensionContext;
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
