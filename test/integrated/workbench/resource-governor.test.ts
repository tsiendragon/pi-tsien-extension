import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ResourceExhaustedError,
  ResourceGovernor,
} from "../../../extensions/subagent-workbench/src/resource-governor.ts";

afterEach(() => {
  vi.useRealTimers();
});

describe("ResourceGovernor", () => {
  it("defaults to eight active permits and queues the ninth", async () => {
    const governor = new ResourceGovernor();
    const active = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        governor.acquire({ priority: "P1", subject: `active-${index}` }),
      ),
    );
    const ninth = governor.acquire({ priority: "P1", subject: "queued-ninth" });

    expect(governor.snapshot()).toMatchObject({
      active: 8,
      queued: 1,
      activeLimit: 8,
      queueLimit: 32,
    });

    active[0]!.release();
    const admitted = await ninth;
    expect(governor.snapshot()).toMatchObject({ active: 8, queued: 0 });

    for (const lease of active.slice(1)) lease.release();
    admitted.release();
    expect(governor.snapshot()).toMatchObject({ active: 0, queued: 0 });
  });

  it("enforces the active cap and grants queued work on release", async () => {
    const governor = new ResourceGovernor({ activeLimit: 2 });
    const first = await governor.acquire({ priority: "P1", subject: "a" });
    const second = await governor.acquire({ priority: "P1", subject: "b" });
    const thirdPromise = governor.acquire({ priority: "P1", subject: "c" });

    expect(governor.snapshot()).toMatchObject({
      active: 2,
      queued: 1,
      activeLimit: 2,
    });

    first.release();
    const third = await thirdPromise;
    expect(governor.snapshot()).toMatchObject({ active: 2, queued: 0 });

    second.release();
    third.release();
    expect(governor.snapshot()).toMatchObject({ active: 0, queued: 0 });
  });

  it("rejects queue overflow with structured resource details", async () => {
    const governor = new ResourceGovernor({ activeLimit: 1, queueLimit: 1 });
    const active = await governor.acquire({ priority: "P1", subject: "active" });
    const queued = governor.acquire({ priority: "P1", subject: "queued" });

    await expect(
      governor.acquire({ priority: "P2", subject: "overflow" }),
    ).rejects.toMatchObject({
      name: "ResourceExhaustedError",
      code: "resource_exhausted",
      reason: "queue_full",
      active: 1,
      queued: 1,
      limit: 1,
      queueLimit: 1,
    });

    active.release();
    (await queued).release();
  });

  it("removes an aborted waiter without consuming a permit", async () => {
    const governor = new ResourceGovernor({ activeLimit: 1 });
    const active = await governor.acquire({ priority: "P1", subject: "active" });
    const controller = new AbortController();
    const waiting = governor.acquire({
      priority: "P1",
      subject: "waiting",
      signal: controller.signal,
    });

    controller.abort();
    await expect(waiting).rejects.toMatchObject({
      code: "resource_exhausted",
      reason: "aborted",
    });
    expect(governor.snapshot()).toMatchObject({ active: 1, queued: 0 });

    active.release();
    expect(governor.snapshot().active).toBe(0);
  });

  it("removes a timed-out waiter and clears its timer", async () => {
    vi.useFakeTimers();
    const governor = new ResourceGovernor({ activeLimit: 1 });
    const active = await governor.acquire({ priority: "P1", subject: "active" });
    const waiting = governor.acquire({
      priority: "P1",
      subject: "waiting",
      timeoutMs: 50,
    });

    const rejection = expect(waiting).rejects.toMatchObject({
      code: "resource_exhausted",
      reason: "timeout",
    });
    await vi.advanceTimersByTimeAsync(50);
    await rejection;
    expect(governor.snapshot().queued).toBe(0);

    active.release();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("returns a lease with idempotent release", async () => {
    const governor = new ResourceGovernor({ activeLimit: 1 });
    const lease = await governor.acquire({ priority: "P0", subject: "user" });

    lease.release();
    lease.release();

    expect(governor.snapshot().active).toBe(0);
    const replacement = await governor.acquire({
      priority: "P0",
      subject: "user",
    });
    expect(governor.snapshot().active).toBe(1);
    replacement.release();
  });

  it("grants higher priority work before earlier lower priority work", async () => {
    const governor = new ResourceGovernor({ activeLimit: 1 });
    const active = await governor.acquire({ priority: "P1", subject: "active" });
    const order: string[] = [];

    const low = governor
      .acquire({ priority: "P2", subject: "workflow" })
      .then((lease) => {
        order.push("low");
        lease.release();
      });
    const high = governor
      .acquire({ priority: "P0", subject: "interactive" })
      .then((lease) => {
        order.push("high");
        lease.release();
      });

    active.release();
    await Promise.all([low, high]);
    expect(order).toEqual(["high", "low"]);
  });

  it("preserves subject FIFO and round-robins subjects within a priority", async () => {
    const governor = new ResourceGovernor({ activeLimit: 1 });
    const active = await governor.acquire({ priority: "P2", subject: "gate" });
    const grants: string[] = [];
    const jobs: Promise<void>[] = [];

    for (const subject of ["a", "b", "c"]) {
      for (let index = 1; index <= 4; index++) {
        jobs.push(
          governor.acquire({ priority: "P2", subject }).then((lease) => {
            grants.push(`${subject}${index}`);
            lease.release();
          }),
        );
      }
    }

    active.release();
    await Promise.all(jobs);
    expect(grants).toEqual([
      "a1",
      "b1",
      "c1",
      "a2",
      "b2",
      "c2",
      "a3",
      "b3",
      "c3",
      "a4",
      "b4",
      "c4",
    ]);
  });

  it("exposes immutable snapshots and an unsubscribe function", async () => {
    const governor = new ResourceGovernor({ activeLimit: 1 });
    const snapshots: unknown[] = [];
    const unsubscribe = governor.subscribe((snapshot) => {
      snapshots.push(snapshot.queuedByPriority);
    });

    const lease = await governor.acquire({ priority: "P0", subject: "user" });
    expect(Object.isFrozen(governor.snapshot())).toBe(true);
    expect(Object.isFrozen(governor.snapshot().queuedByPriority)).toBe(true);
    expect(snapshots.length).toBeGreaterThan(0);

    unsubscribe();
    const count = snapshots.length;
    lease.release();
    expect(snapshots).toHaveLength(count);
  });

  it("rejects nested acquisition immediately when all permits are held", async () => {
    const governor = new ResourceGovernor({ activeLimit: 1 });
    const active = await governor.acquire({ priority: "P1", subject: "parent" });

    const nested = governor.acquire({
      priority: "P0",
      subject: "child",
      nested: true,
    });
    await expect(nested).rejects.toBeInstanceOf(ResourceExhaustedError);
    await expect(nested).rejects.toMatchObject({
      code: "nested_resource_exhausted",
      reason: "nested_capacity_unavailable",
    });
    expect(governor.snapshot()).toMatchObject({ active: 1, queued: 0 });

    active.release();
  });
});
