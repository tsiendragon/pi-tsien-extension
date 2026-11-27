import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_SUBAGENT_BUSY_MAX_MS,
  DEFAULT_SUBAGENT_IDLE_MS,
  JobActivityTracker,
  activityKeyForTrace,
  classifyJobActivity,
  jobActivityTracker,
  resolveActivityPersistMs,
  resolveSubagentBusyMaxMs,
  resolveSubagentIdleMs,
  summarizeWorkflowTaskActivity,
  type JobActivityRawEntry,
} from "pi-tsien-subagent-workbench/src/job-activity.ts";
import {
  readJobLedgerActivity,
  type JobActivityLedgerRecord,
} from "pi-tsien-subagent-workbench/src/job-ledger.ts";
import {
  STALLED_PARTIAL_CHARS,
  formatJobQuery,
} from "pi-tsien-subagent-workbench/src/index.ts";

afterEach(() => {
  vi.unstubAllEnvs();
  // `formatJobQuery` reads the process-wide tracker, so every test starts clean.
  for (const key of TRACKED_KEYS) jobActivityTracker().clear(key);
});

const TRACKED_KEYS = [
  "work-hang",
  "work-stalled",
  "work-busy",
  "work-empty",
  "work-plain",
  "work-streaming",
  "work-chain",
  "work-long",
  "work-thinking",
  "work-short-ceiling",
  "workflow_w:task:1:1",
  "workflow_w:task:1:2",
  "work_parent",
];

const T0 = 1_700_000_000_000;

function toolStart(tracker: JobActivityTracker, key: string, at: number, toolCallId = "call-1", toolName = "bash"): void {
  tracker.noteRunStarted(key, "run-1", at);
  tracker.noteEvent(key, "run-1", { type: "tool_execution_start", toolCallId, toolName }, at);
}

/** Seeds the process-wide tracker, which is what `formatJobQuery` reads. */
function toolStartGlobal(key: string, at: number, toolCallId = "call-1", toolName = "bash"): void {
  toolStart(jobActivityTracker(), key, at, toolCallId, toolName);
}

function settleGlobal(key: string, at: number): void {
  const tracker = jobActivityTracker();
  tracker.noteRunStarted(key, "run-1", at);
  tracker.noteEvent(key, "run-1", { type: "tool_execution_end", toolCallId: "call-1" }, at);
}

function pendingJob(workId: string) {
  return {
    workId,
    kind: "agent",
    label: `Worker ${workId}`,
    status: "running",
    background: true,
    createdAt: T0,
  } as any;
}

function partialOutputWith(text: string, omittedSources = 0) {
  return {
    workId: "work-stalled",
    kind: "agent",
    status: "running",
    sources: [
      {
        label: "Worker",
        sessionId: "session-1",
        runId: "run-1",
        status: "running",
        text,
        truncated: false,
        streaming: true,
      },
    ],
    omittedSources,
  } as any;
}

describe("busy escalation", () => {
  it("escalates an in-flight call that outlives the busy ceiling with no progress (hung bash on stdin)", () => {
    const tracker = new JobActivityTracker();
    // bash started at T0 and never emitted anything else: typical stdin wait.
    toolStart(tracker, "work-hang", T0);
    const snapshot = tracker.get("work-hang")!;
    expect(snapshot.busy).toBe(true);
    expect(snapshot.oldestInFlightAt).toBe(T0);

    // One second before the ceiling this is still a healthy busy job.
    const before = classifyJobActivity(snapshot, {
      now: T0 + DEFAULT_SUBAGENT_BUSY_MAX_MS - 1_000,
      busyMaxMs: DEFAULT_SUBAGENT_BUSY_MAX_MS,
      idleThresholdMs: DEFAULT_SUBAGENT_IDLE_MS,
    })!;
    expect(before.phase).toBe("busy");
    expect(before.escalated).toBe(false);
    expect(before.suffix).toContain("in flight");

    const escalated = classifyJobActivity(snapshot, {
      now: T0 + DEFAULT_SUBAGENT_BUSY_MAX_MS + 1_000,
      busyMaxMs: DEFAULT_SUBAGENT_BUSY_MAX_MS,
      idleThresholdMs: DEFAULT_SUBAGENT_IDLE_MS,
    })!;
    expect(escalated).toMatchObject({ phase: "stalled", escalated: true });
    expect(escalated.busyMs).toBe(DEFAULT_SUBAGENT_BUSY_MAX_MS + 1_000);
    expect(escalated.suffix).toContain("stalled?");
    expect(escalated.suffix).toContain("waiting on input");
  });

  it("honours PI_SUBAGENT_BUSY_MAX_MS for the escalation ceiling", () => {
    vi.stubEnv("PI_SUBAGENT_BUSY_MAX_MS", "60000");
    expect(resolveSubagentBusyMaxMs()).toBe(60_000);

    const tracker = new JobActivityTracker();
    toolStart(tracker, "work-short-ceiling", T0);
    const classification = classifyJobActivity(tracker.get("work-short-ceiling"), {
      now: T0 + 61_000,
      idleThresholdMs: 300_000,
    })!;
    expect(classification).toMatchObject({ phase: "stalled", escalated: true });
  });

  it("does not misjudge a long command that keeps streaming progress", () => {
    const tracker = new JobActivityTracker();
    toolStart(tracker, "work-streaming", T0);
    // 30 minutes of one long-running command, but events keep arriving.
    for (let elapsed = 30_000; elapsed <= 1_800_000; elapsed += 30_000) {
      tracker.noteEvent(
        "work-streaming",
        "run-1",
        { type: "tool_execution_update", toolCallId: "call-1", toolName: "bash" },
        T0 + elapsed,
      );
      const classification = classifyJobActivity(tracker.get("work-streaming"), {
        now: T0 + elapsed,
        busyMaxMs: DEFAULT_SUBAGENT_BUSY_MAX_MS,
        idleThresholdMs: DEFAULT_SUBAGENT_IDLE_MS,
      })!;
      expect(classification.phase).toBe("busy");
      expect(classification.escalated).toBe(false);
    }
  });

  it("does not misjudge a chain of short tools or a single tool under the ceiling", () => {
    const tracker = new JobActivityTracker();
    // 20 short calls of 5s each: total wall clock exceeds the ceiling, but no
    // single call does, and idle time stays small.
    for (let index = 0; index < 20; index += 1) {
      const start = T0 + index * 5_000;
      toolStart(tracker, "work-chain", start, `call-${index}`);
      tracker.noteEvent(
        "work-chain",
        "run-1",
        { type: "tool_execution_end", toolCallId: `call-${index}` },
        start + 4_000,
      );
      tracker.noteEvent(
        "work-chain",
        "run-1",
        { type: "tool_execution_start", toolCallId: `call-${index + 1}`, toolName: "bash" },
        start + 5_000,
      );
      const classification = classifyJobActivity(tracker.get("work-chain"), {
        now: start + 5_000,
        busyMaxMs: DEFAULT_SUBAGENT_BUSY_MAX_MS,
        idleThresholdMs: DEFAULT_SUBAGENT_IDLE_MS,
      })!;
      expect(classification.phase).toBe("busy");
      expect(classification.escalated).toBe(false);
      tracker.noteEvent(
        "work-chain",
        "run-1",
        { type: "tool_execution_end", toolCallId: `call-${index + 1}` },
        start + 5_000,
      );
    }

    // A single 9-minute tool (under the 10-minute ceiling) stays busy.
    const long = new JobActivityTracker();
    toolStart(long, "work-long", T0);
    const classification = classifyJobActivity(long.get("work-long"), {
      now: T0 + 540_000,
      busyMaxMs: DEFAULT_SUBAGENT_BUSY_MAX_MS,
      idleThresholdMs: DEFAULT_SUBAGENT_IDLE_MS,
    })!;
    expect(classification.phase).toBe("busy");
    expect(classification.escalated).toBe(false);
  });

  it("keeps a pending model request busy and escalates it the same way", () => {
    const tracker = new JobActivityTracker();
    tracker.noteRunStarted("work-thinking", "run-1", T0);
    tracker.noteEvent(
      "work-thinking",
      "run-1",
      { type: "message_start", message: { role: "assistant" } },
      T0,
    );
    const fresh = classifyJobActivity(tracker.get("work-thinking"), {
      now: T0 + 60_000,
      busyMaxMs: DEFAULT_SUBAGENT_BUSY_MAX_MS,
      idleThresholdMs: DEFAULT_SUBAGENT_IDLE_MS,
    })!;
    expect(fresh.phase).toBe("busy");

    const stuck = classifyJobActivity(tracker.get("work-thinking"), {
      now: T0 + DEFAULT_SUBAGENT_BUSY_MAX_MS + 5_000,
      busyMaxMs: DEFAULT_SUBAGENT_BUSY_MAX_MS,
      idleThresholdMs: DEFAULT_SUBAGENT_IDLE_MS,
    })!;
    expect(stuck).toMatchObject({ phase: "stalled", escalated: true });
  });

  it("falls back to defaults for unset or invalid busy ceilings", () => {
    expect(resolveSubagentBusyMaxMs({})).toBe(DEFAULT_SUBAGENT_BUSY_MAX_MS);
    expect(resolveSubagentBusyMaxMs({ PI_SUBAGENT_BUSY_MAX_MS: "abc" })).toBe(
      DEFAULT_SUBAGENT_BUSY_MAX_MS,
    );
    expect(resolveSubagentBusyMaxMs({ PI_SUBAGENT_BUSY_MAX_MS: "-5" })).toBe(
      DEFAULT_SUBAGENT_BUSY_MAX_MS,
    );
    expect(resolveSubagentBusyMaxMs({ PI_SUBAGENT_BUSY_MAX_MS: " 12345 " })).toBe(12_345);
  });
});

describe("stalled pending jobs carry a bounded partial-output preview", () => {
  it("attaches a truncated, unverified preview so one call is enough to decide", () => {
    settleGlobal("work-stalled", T0);
    const snapshot = jobActivityTracker().get("work-stalled")!;
    // Make it stalled: idle past the threshold and nothing in flight.
    expect(snapshot.busy).toBe(false);

    const longText = `${"progress line ".repeat(500)}final checkpoint saved to experiments/x/result.json`;
    const partialOutput = vi.fn(() => partialOutputWith(longText, 3));
    const query = { completed: [], pending: [pendingJob("work-stalled")], missing: [] } as any;

    const rendered = formatJobQuery(query, false, {
      now: T0 + 400_000,
      partialOutput,
    });

    expect(partialOutput).toHaveBeenCalledWith("work-stalled");
    expect(rendered).toContain("stalled?");
    expect(rendered).toContain("↳ partial (unverified, may be incomplete):");
    expect(rendered).toContain("final checkpoint saved");
    expect(rendered).toContain("(+3 more task(s) omitted)");
    const previewLine = rendered
      .split("\n")
      .find((line) => line.includes("↳ partial"))!;
    // The budget covers the whole line: prefix + tail + omitted suffix.
    expect(previewLine.length).toBeLessThanOrEqual(STALLED_PARTIAL_CHARS);
    expect(previewLine.startsWith("  ↳ partial")).toBe(true);
    // Tail-biased: the line starts with the truncation marker and keeps the
    // newest text, so the very first characters of the source are gone.
    expect(previewLine).toContain("…");
    expect(previewLine).toContain("final checkpoint saved to");
  });

  it("does not attach a preview for busy or active jobs", () => {
    toolStartGlobal("work-busy", T0);
    const partialOutput = vi.fn(() => partialOutputWith("draft text"));
    const query = { completed: [], pending: [pendingJob("work-busy")], missing: [] } as any;

    const busy = formatJobQuery(query, false, { now: T0 + 1_000, partialOutput });
    expect(busy).toContain("busy");
    expect(busy).not.toContain("↳ partial");
    expect(partialOutput).not.toHaveBeenCalled();

    const active = formatJobQuery(
      { completed: [], pending: [pendingJob("work-unknown")], missing: [] } as any,
      false,
      { now: T0, partialOutput },
    );
    expect(active).not.toContain("↳ partial");
    expect(partialOutput).not.toHaveBeenCalled();
  });

  it("renders the stalled busy-escalation preview and skips already-rendered workIds", () => {
    toolStartGlobal("work-hang", T0);
    const partialOutput = vi.fn(() => partialOutputWith("half-written artifact"));

    const escalated = formatJobQuery(
      { completed: [], pending: [pendingJob("work-hang")], missing: [] } as any,
      false,
      { now: T0 + DEFAULT_SUBAGENT_BUSY_MAX_MS + 1_000, partialOutput },
    );
    expect(escalated).toContain("stalled?");
    expect(escalated).toContain("half-written artifact");

    partialOutput.mockClear();
    const skipped = formatJobQuery(
      { completed: [], pending: [pendingJob("work-hang")], missing: [] } as any,
      false,
      {
        now: T0 + DEFAULT_SUBAGENT_BUSY_MAX_MS + 1_000,
        partialOutput,
        skipPartialWorkIds: new Set(["work-hang"]),
      },
    );
    expect(partialOutput).not.toHaveBeenCalled();
    expect(skipped).not.toContain("↳ partial");
  });

  it("says so when a stalled job has no assistant text yet, and survives a throwing provider", () => {
    settleGlobal("work-empty", T0);
    const query = { completed: [], pending: [pendingJob("work-empty")], missing: [] } as any;

    const empty = formatJobQuery(query, false, {
      now: T0 + 400_000,
      partialOutput: () => partialOutputWith("   "),
    });
    expect(empty).toContain("no assistant text captured yet");

    const throwing = formatJobQuery(query, false, {
      now: T0 + 400_000,
      partialOutput: () => {
        throw new Error("transcript unavailable");
      },
    });
    expect(throwing).toContain("stalled?");
    expect(throwing).not.toContain("↳ partial");
  });

  it("keeps the preview out of the line when no partial provider is supplied", () => {
    settleGlobal("work-plain", T0);
    const rendered = formatJobQuery(
      { completed: [], pending: [pendingJob("work-plain")], missing: [] } as any,
      false,
      { now: T0 + 400_000 },
    );
    expect(rendered).toContain("stalled?");
    expect(rendered).not.toContain("↳ partial");
    expect(resolveSubagentIdleMs({})).toBe(DEFAULT_SUBAGENT_IDLE_MS);
  });
});
describe("activity key: taskId first, then workId, then runId", () => {
  it("prefers the workflow taskId so sibling tasks no longer share a key", () => {
    expect(
      activityKeyForTrace({
        trace: { taskId: "workflow_w:task:1:1", workId: "work_parent" },
        runId: "run_1",
      }),
    ).toBe("workflow_w:task:1:1");
  });

  it("falls back to workId for a single agent job and to runId without traces", () => {
    expect(
      activityKeyForTrace({ trace: { workId: "work_parent" }, runId: "run_1" }),
    ).toBe("work_parent");
    expect(activityKeyForTrace({ runId: "run_1" })).toBe("run_1");
    expect(activityKeyForTrace(undefined)).toBeUndefined();
    // Blank strings are not keys.
    expect(activityKeyForTrace({ trace: { taskId: "  " }, runId: "run_1" })).toBe("run_1");
  });
});

describe("a workflow task's idle time is its own", () => {
  const now = T0 + 400_000;

  function workflowTasks() {
    return [
      { taskId: "workflow_w:task:1:1", taskKey: "busy_sibling", label: "Busy sibling" },
      { taskId: "workflow_w:task:1:2", taskKey: "wedged", label: "Wedged task" },
    ];
  }

  it("reports the wedged task instead of hiding it behind a busy sibling", () => {
    const tracker = new JobActivityTracker();
    // Sibling started a long tool just now: busy and fresh.
    tracker.noteRunStarted("workflow_w:task:1:1", "run_busy", now - 1_000);
    tracker.noteEvent(
      "workflow_w:task:1:1",
      "run_busy",
      { type: "tool_execution_start", toolCallId: "call-1", toolName: "bash" },
      now - 1_000,
    );
    // Wedged task finished a tool 400s ago and has been silent since: nothing
    // in flight, well past the idle threshold.
    tracker.noteRunStarted("workflow_w:task:1:2", "run_stuck", T0);
    tracker.noteEvent(
      "workflow_w:task:1:2",
      "run_stuck",
      { type: "tool_execution_start", toolCallId: "call-2", toolName: "bash" },
      T0,
    );
    tracker.noteEvent(
      "workflow_w:task:1:2",
      "run_stuck",
      { type: "tool_execution_end", toolCallId: "call-2" },
      T0,
    );
    // The parent job key has a busy run too: the old behaviour would mask it.
    tracker.noteRunStarted("work_parent", "run_parent", now - 500);
    tracker.noteEvent(
      "work_parent",
      "run_parent",
      { type: "tool_execution_start", toolCallId: "call-9", toolName: "bash" },
      now - 500,
    );

    const summary = summarizeWorkflowTaskActivity(
      "work_parent",
      workflowTasks(),
      (key) => tracker.get(key),
      { now, idleThresholdMs: DEFAULT_SUBAGENT_IDLE_MS, busyMaxMs: DEFAULT_SUBAGENT_BUSY_MAX_MS },
    )!;

    expect(summary.observedTasks).toBe(2);
    expect(summary.classification.phase).toBe("stalled");
    expect(summary.classification.escalated).toBe(false);
    expect(summary.taskKey).toBe("wedged");
    expect(summary.classification.taskKey).toBe("wedged");
    expect(summary.classification.suffix).toContain("task wedged:");
    // The job is only as fresh as its least recently active task, and the
    // busy sibling (1s in flight) does not mask the stalled one (400s idle).
    expect(summary.snapshot.lastActivityAt).toBe(T0);
    expect(summary.snapshot.busy).toBe(true);
    expect(summary.classification.idleMs).toBe(now - T0);
    expect(summary.classification.suffix).toContain("stalled?");
    // Per-task keys: the parent job key is not part of the workflow view.
    expect(summary.snapshot.eventCount).toBe(3);
  });

  it("stays busy while every task keeps emitting progress", () => {
    const tracker = new JobActivityTracker();
    for (const key of ["workflow_w:task:1:1", "workflow_w:task:1:2"]) {
      tracker.noteRunStarted(key, `run_${key}`, now - 2_000);
      tracker.noteEvent(
        key,
        `run_${key}`,
        { type: "tool_execution_start", toolCallId: "call-1", toolName: "bash" },
        now - 2_000,
      );
    }
    const summary = summarizeWorkflowTaskActivity(
      "work_parent",
      workflowTasks(),
      (key) => tracker.get(key),
      { now, idleThresholdMs: DEFAULT_SUBAGENT_IDLE_MS, busyMaxMs: DEFAULT_SUBAGENT_BUSY_MAX_MS },
    )!;
    expect(summary.classification.phase).toBe("busy");
    expect(summary.classification.escalated).toBe(false);
  });

  it("returns undefined until at least one task has emitted an event", () => {
    const tracker = new JobActivityTracker();
    expect(
      summarizeWorkflowTaskActivity("work_parent", workflowTasks(), (key) => tracker.get(key), {
        now,
      }),
    ).toBeUndefined();
  });

  it("renders the deciding task in the pending-job line", () => {
    const tracker = new JobActivityTracker();
    tracker.noteRunStarted("workflow_w:task:1:1", "run_busy", now - 1_000);
    tracker.noteEvent(
      "workflow_w:task:1:1",
      "run_busy",
      { type: "tool_execution_start", toolCallId: "call-1", toolName: "bash" },
      now - 1_000,
    );
    tracker.noteEvent(
      "workflow_w:task:1:2",
      "run_stuck",
      { type: "tool_execution_start", toolCallId: "call-2", toolName: "bash" },
      T0,
    );
    tracker.noteEvent(
      "workflow_w:task:1:2",
      "run_stuck",
      { type: "tool_execution_end", toolCallId: "call-2" },
      T0,
    );
    // formatJobQuery reads the process-wide tracker.
    for (const [key, runId, at, id] of [
      ["workflow_w:task:1:1", "run_busy", now - 1_000, "call-1"],
      ["workflow_w:task:1:2", "run_stuck", T0, "call-2"],
    ] as const) {
      jobActivityTracker().noteRunStarted(key, runId, at);
      jobActivityTracker().noteEvent(
        key,
        runId,
        { type: "tool_execution_start", toolCallId: id, toolName: "bash" },
        at,
      );
    }
    jobActivityTracker().noteEvent(
      "workflow_w:task:1:2",
      "run_stuck",
      { type: "tool_execution_end", toolCallId: "call-2" },
      T0,
    );
    const partials: (string | undefined)[] = [];
    const rendered = formatJobQuery(
      {
        completed: [],
        pending: [
          {
            workId: "work_parent",
            kind: "workflow",
            label: "Parallel workflow",
            status: "running",
            background: true,
            createdAt: T0,
            workflowId: "workflow_w",
          } as never,
        ],
        missing: [],
      },
      false,
      {
        now,
        workflowTasks: () => workflowTasks(),
        partialOutput: (workId, target) => {
          partials.push(target?.taskKey);
          return undefined;
        },
      },
    );
    expect(rendered).toContain("work_parent · task wedged · workflow · running");
    expect(rendered).toContain("stalled?");
    // The preview is asked for the stalled task, not the whole job.
    expect(partials).toEqual(["wedged"]);
  });
});

describe("heartbeats persist to the job ledger and survive a restart", () => {
  function sink(rows: JobActivityLedgerRecord[]) {
    return (entry: JobActivityRawEntry, settled: boolean): void => {
      rows.push({
        v: 1,
        at: Date.now(),
        event: "heartbeat",
        activityKey: entry.key,
        workId: entry.meta?.workId ?? entry.key,
        lastActivityAt: entry.lastActivityAt,
        eventCount: entry.eventCount,
        busy: entry.busy,
        runningTools: entry.runningTools,
        pendingModelRequests: entry.pendingModelRequests,
        ...(entry.lastEventType === undefined ? {} : { lastEventType: entry.lastEventType }),
        ...(entry.meta?.taskId === undefined ? {} : { taskId: entry.meta.taskId }),
        ...(entry.meta?.taskKey === undefined ? {} : { taskKey: entry.meta.taskKey }),
        ...(entry.meta?.kind === undefined ? {} : { kind: entry.meta.kind }),
        ...(settled ? { settled: true } : {}),
      });
    };
  }

  async function writeLedger(file: string, rows: JobActivityLedgerRecord[]): Promise<void> {
    const { JobLedger } = await import("pi-tsien-subagent-workbench/src/job-ledger.ts");
    const ledger = new JobLedger(file);
    for (const row of rows) ledger.recordActivity(row);
    await ledger.flush();
  }

  it("writes a throttled heartbeat per activity key", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "pi-activity-ledger-"));
    const file = path.join(dir, "jobs.jsonl");
    const rows: JobActivityLedgerRecord[] = [];
    const tracker = new JobActivityTracker({
      persistIntervalMs: 10_000,
      onPersist: sink(rows),
      now: () => T0,
    });
    tracker.noteRunStarted("workflow_w:task:1:1", "run_1", T0, {
      kind: "workflow",
      workId: "work_parent",
      taskId: "workflow_w:task:1:1",
      taskKey: "first",
    });
    tracker.noteEvent("workflow_w:task:1:1", "run_1", { type: "message_start" }, T0 + 1_000);
    tracker.noteEvent("workflow_w:task:1:1", "run_1", { type: "message_end" }, T0 + 2_000);
    // Throttled: only the first write for the key so far.
    expect(rows).toHaveLength(1);
    await writeLedger(file, rows);
    const restored = await readJobLedgerActivity(file);
    expect(restored.get("workflow_w:task:1:1")).toMatchObject({
      lastActivityAt: T0,
      workId: "work_parent",
      taskKey: "first",
      settled: false,
    });
  });

  it("restores lastActivityAt into a fresh tracker so classification continues", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "pi-activity-ledger-"));
    const file = path.join(dir, "jobs.jsonl");
    // Simulate the previous process: a heartbeat 10 minutes old.
    const lastActivityAt = T0 - 600_000;
    await writeLedger(file, [
      {
        v: 1,
        at: lastActivityAt,
        event: "heartbeat",
        activityKey: "work_restart",
        workId: "work_restart",
        lastActivityAt,
        eventCount: 7,
        lastEventType: "tool_execution_end",
        busy: false,
        runningTools: 0,
        pendingModelRequests: 0,
        kind: "agent",
      },
    ]);

    const restored = new JobActivityTracker();
    const count = restored.restoreFromLedger((await readJobLedgerActivity(file)).values());
    expect(count).toBe(1);

    const snapshot = restored.get("work_restart")!;
    expect(snapshot).toMatchObject({
      lastActivityAt,
      eventCount: 7,
      lastEventType: "tool_execution_end",
      // In-flight units of the dead process are not recoverable.
      busy: false,
      runningTools: 0,
      pendingModelRequests: 0,
    });
    const classification = classifyJobActivity(snapshot, {
      now: T0,
      idleThresholdMs: DEFAULT_SUBAGENT_IDLE_MS,
      busyMaxMs: DEFAULT_SUBAGENT_BUSY_MAX_MS,
    })!;
    // Without the restore the job would look unobserved; with it the stale
    // heartbeat is visible immediately after the restart.
    expect(classification.phase).toBe("stalled");
    expect(classification.idleMs).toBe(600_000);
  });

  it("does not resurrect a key that settled, nor overwrite newer live state", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "pi-activity-ledger-"));
    const file = path.join(dir, "jobs.jsonl");
    await writeLedger(file, [
      {
        v: 1,
        at: T0 - 5_000,
        event: "heartbeat",
        activityKey: "work_done",
        workId: "work_done",
        lastActivityAt: T0 - 5_000,
        eventCount: 3,
        busy: true,
        runningTools: 1,
        pendingModelRequests: 0,
      },
      {
        v: 1,
        at: T0 - 4_000,
        event: "heartbeat",
        activityKey: "work_done",
        workId: "work_done",
        lastActivityAt: T0 - 4_000,
        eventCount: 3,
        busy: false,
        runningTools: 0,
        pendingModelRequests: 0,
        settled: true,
      },
      {
        v: 1,
        at: T0 - 60_000,
        event: "heartbeat",
        activityKey: "work_live",
        workId: "work_live",
        lastActivityAt: T0 - 60_000,
        eventCount: 1,
        busy: false,
        runningTools: 0,
        pendingModelRequests: 0,
      },
    ]);
    const rows = await readJobLedgerActivity(file);
    expect(rows.get("work_done")?.settled).toBe(true);

    const tracker = new JobActivityTracker();
    tracker.noteEvent("work_live", "run_live", { type: "message_start" }, T0 - 1_000);
    expect(tracker.restoreFromLedger(rows.values())).toBe(0);
    // The settled key stays gone and live state keeps its newer timestamp.
    expect(tracker.get("work_done")).toBeUndefined();
    expect(tracker.get("work_live")?.lastActivityAt).toBe(T0 - 1_000);
  });

  it("ignores missing ledgers, other rows and a split first line of the tail window", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "pi-activity-ledger-"));
    expect((await readJobLedgerActivity(path.join(dir, "absent.jsonl"))).size).toBe(0);

    const file = path.join(dir, "jobs.jsonl");
    const { JobLedger } = await import("pi-tsien-subagent-workbench/src/job-ledger.ts");
    const ledger = new JobLedger(file);
    // A launch row from the existing schema must never be read as a heartbeat.
    ledger.record({ v: 1, at: T0, workId: "work_a", kind: "agent", status: "running" });
    ledger.recordActivity({
      v: 1,
      at: T0,
      event: "heartbeat",
      activityKey: "work_a",
      workId: "work_a",
      lastActivityAt: T0,
      eventCount: 1,
      busy: false,
      runningTools: 0,
      pendingModelRequests: 0,
    });
    await ledger.flush();

    const all = await readJobLedgerActivity(file);
    expect(all.size).toBe(1);
    expect(all.get("work_a")?.lastActivityAt).toBe(T0);

    // A tail window that starts mid-row must drop the partial first line
    // without losing the complete row that follows it.
    const lines = readFileSync(file, "utf8").split("\n").filter((line) => line.length > 0);
    const heartbeatBytes = Buffer.byteLength(`${lines[1]}\n`);
    expect(lines).toHaveLength(2);
    const tailed = await readJobLedgerActivity(file, {
      tailBytes: heartbeatBytes + 10,
    });
    expect(tailed.get("work_a")?.lastActivityAt).toBe(T0);
  });

  it("defaults the persist interval and honours PI_SUBAGENT_ACTIVITY_PERSIST_MS", () => {
    expect(resolveActivityPersistMs({})).toBe(15_000);
    expect(resolveActivityPersistMs({ PI_SUBAGENT_ACTIVITY_PERSIST_MS: "0" })).toBe(0);
    expect(resolveActivityPersistMs({ PI_SUBAGENT_ACTIVITY_PERSIST_MS: "2500" })).toBe(2_500);
    expect(resolveActivityPersistMs({ PI_SUBAGENT_ACTIVITY_PERSIST_MS: "abc" })).toBe(15_000);
    expect(resolveActivityPersistMs({ PI_SUBAGENT_ACTIVITY_PERSIST_MS: "-1" })).toBe(15_000);
  });
});
