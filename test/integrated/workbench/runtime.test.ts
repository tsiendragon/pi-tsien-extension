import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WORKBENCH_API_VERSION,
  WORKBENCH_RUNTIME_SYMBOL,
  WorkbenchRuntimeHost,
  installWorkbenchRuntime,
  uninstallWorkbenchRuntime,
} from "../../../extensions/subagent-workbench/src/runtime.ts";

function globals(): Record<PropertyKey, unknown> {
  return globalThis as Record<PropertyKey, unknown>;
}

afterEach(() => {
  uninstallWorkbenchRuntime();
});

describe("standalone workbench runtime", () => {
  it("publishes API v1 on the public symbol", () => {
    const runtime = installWorkbenchRuntime();

    expect(runtime.apiVersion).toBe(WORKBENCH_API_VERSION);
    expect(globals()[WORKBENCH_RUNTIME_SYMBOL]).toBe(runtime);
    expect(runtime.getSnapshot().apiVersion).toBe(WORKBENCH_API_VERSION);
  });

  it("projects immutable conversation and workflow summaries", () => {
    const host = new WorkbenchRuntimeHost();
    host.upsertConversation({
      id: "agent-1",
      label: "Agent 1",
      status: "running",
      updatedAt: 1,
      lastHeartbeatAt: 10,
    });
    host.upsertConversation({
      id: "agent-2",
      label: "Agent 2",
      status: "failed",
      updatedAt: 2,
      needsAttention: true,
      stalled: true,
    });
    host.upsertWorkflow({
      id: "workflow-1",
      label: "Workflow 1",
      status: "running",
      updatedAt: 3,
    });

    const snapshot = host.getSnapshot();

    expect(snapshot.conversations).toMatchObject({
      total: 2,
      running: 1,
      needsAttention: 1,
      completed: 0,
    });
    expect(snapshot.conversations.items.map((item) => item.id)).toEqual([
      "agent-1",
      "agent-2",
    ]);
    expect(Object.isFrozen(snapshot.conversations.items)).toBe(true);
    expect(snapshot.runHealth).toEqual({
      running: 1,
      stalled: 1,
      lastHeartbeatAt: 10,
    });
    expect(snapshot.workflows).toEqual({
      total: 1,
      active: 1,
      failed: 0,
      items: [
        {
          id: "workflow-1",
          label: "Workflow 1",
          status: "running",
          updatedAt: 3,
        },
      ],
    });
    expect(Object.isFrozen(snapshot.workflows.items)).toBe(true);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.governor)).toBe(true);
    host.dispose();
  });

  it("notifies subscribers and isolates listener failures", async () => {
    const host = new WorkbenchRuntimeHost();
    const listener = vi.fn();
    host.subscribe(() => {
      throw new Error("listener failure");
    });
    const unsubscribe = host.subscribe(listener);

    host.upsertConversation({
      id: "agent",
      label: "Agent",
      status: "queued",
      updatedAt: 1,
    });
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    await host.dispatch({ type: "refresh" });
    expect(listener).toHaveBeenCalledTimes(1);
    host.dispose();
  });

  it("dispatches only through one controlled handler and records command errors", async () => {
    const host = new WorkbenchRuntimeHost();
    const handler = vi.fn(async () => ({
      ok: true as const,
      accepted: "volatile" as const,
    }));
    const uninstall = host.setCommandHandler(handler);

    await expect(
      host.dispatch({
        type: "start-agent",
        task: "bounded task",
        cwd: "/tmp",
      }),
    ).resolves.toEqual({ ok: true, accepted: "volatile" });
    expect(handler).toHaveBeenCalledOnce();

    uninstall();
    await expect(
      host.dispatch({
        type: "interrupt-agent",
        sessionId: "missing",
      }),
    ).resolves.toEqual({
      ok: false,
      error: "workbench_controller_unavailable",
    });
    host.dispose();
  });

  it("merges service status projections without dropping controller transcript", () => {
    const host = new WorkbenchRuntimeHost();
    host.upsertConversation({
      id: "agent",
      label: "Agent",
      status: "running",
      updatedAt: 1,
      activeRunId: "run-1",
      availability: "ready",
      messages: [
        {
          id: "message-1",
          runId: "run-1",
          role: "user",
          text: "hello",
          createdAt: 1,
        },
      ],
    });
    host.upsertConversation({
      id: "agent",
      label: "Agent",
      status: "running",
      updatedAt: 2,
      lastHeartbeatAt: 2,
    });

    const conversation = host.getSnapshot().conversations.items[0]!;
    expect(conversation.activeRunId).toBe("run-1");
    expect(conversation.messages?.[0]?.text).toBe("hello");
    expect(Object.isFrozen(conversation.messages)).toBe(true);
    expect(Object.isFrozen(conversation.messages?.[0])).toBe(true);
    host.dispose();
  });

  it("reflects ResourceGovernor state in the runtime snapshot", async () => {
    const host = new WorkbenchRuntimeHost({ activeLimit: 1, queueLimit: 1 });
    const first = await host.governor.acquire({
      priority: "P1",
      subject: "parent-a",
    });
    const queued = host.governor.acquire({
      priority: "P1",
      subject: "parent-b",
    });

    expect(host.getSnapshot().governor).toMatchObject({
      active: 1,
      queued: 1,
      activeLimit: 1,
      queueLimit: 1,
    });

    first.release();
    const second = await queued;
    second.release();
    expect(host.getSnapshot().governor.active).toBe(0);
    host.dispose();
  });
});
