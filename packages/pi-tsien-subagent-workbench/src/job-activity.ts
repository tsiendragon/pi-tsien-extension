/**
 * Subagent activity watchdog metadata (observability only).
 *
 * The main agent currently has one weak signal about a running subagent: the
 * `subagent_results` wait timeout. That signal cannot tell a healthy long run
 * (a slow command, a long thinking block) from a wedged one, so healthy work
 * used to get cancelled. This module records, per work item:
 *
 *  - `lastActivityAt`: timestamp of the most recent child RPC event
 *    (`message_start`, `message_update`, `tool_execution_start`,
 *    `tool_execution_end`, ...).
 *  - `runningTools`: tool calls that started and have not ended yet, so a
 *    long-running command shows as busy instead of "silent".
 *  - `pendingModelRequests`: assistant `message_start` without its
 *    `message_end`, i.e. the model is thinking or streaming.
 *
 * Nothing here changes a job's state machine, cancels work, or gates anything:
 * it only classifies a pending job as busy / active / stalled? for display.
 *
 * Work item key: the child run carries trace data that the workbench controller
 * stamps per run. `activityKeyForTrace()` is the single definition of the key,
 * shared by the RPC provider (writer) and the tools (reader):
 *
 *  1. `traceContext.taskId` — a workflow task run. Every workflow task has a
 *     stable, run-scoped id (`workflow_*:task:stage:index`), so sibling tasks of
 *     one workflow no longer share a key. This is what stops a genuinely wedged
 *     task from being masked by a busy sibling.
 *  2. `traceContext.workId` — a single agent job; the controller stamps it with
 *     the job's `workId`, and workflow jobs deliberately keep it as the parent
 *     job so per-task keys stay unambiguous.
 *  3. the provider `runId` — a direct provider call without controller traces.
 *
 * So the key is `taskId`, with `workId` and then `runId` only as fallbacks.
 *
 * Idle threshold: `PI_SUBAGENT_IDLE_MS`, default 300000 ms (5 minutes).
 *
 * Busy escalation: `busy` alone cannot be told apart from a wedged call (a
 * `bash` command waiting on stdin, a hung network read). Every in-flight tool
 * call / model request therefore records when it started; once the oldest one
 * has been in flight for `PI_SUBAGENT_BUSY_MAX_MS` (default 600000 ms = 10
 * minutes) **and** the run emitted no event for that long, the job is reported
 * as a `stalled` candidate instead of `busy`. Requiring both conditions is what
 * keeps a genuinely long but still-progressing command (streaming output), or a
 * chain of short tools, classified as busy.
 *
 * Durability: the tracker is process-local, so heartbeats are also appended to
 * the job ledger (`subagent-jobs.jsonl`) at a throttled interval
 * (`PI_SUBAGENT_ACTIVITY_PERSIST_MS`, default 15000 ms) and can be replayed into
 * a fresh tracker with `restoreFromLedger()`. A restore can only recover
 * `lastActivityAt`, `eventCount` and `lastEventType`; in-flight units are not
 * recoverable, so a restored entry is neither `busy` nor escalated.
 */

export const DEFAULT_SUBAGENT_IDLE_MS = 300_000;
export const DEFAULT_ACTIVITY_PERSIST_MS = 15_000;
export const ACTIVITY_PERSIST_ENV = "PI_SUBAGENT_ACTIVITY_PERSIST_MS";
export const SUBAGENT_IDLE_ENV = "PI_SUBAGENT_IDLE_MS";
export const DEFAULT_SUBAGENT_BUSY_MAX_MS = 600_000;
export const SUBAGENT_BUSY_ENV = "PI_SUBAGENT_BUSY_MAX_MS";

const TRACKER_SYMBOL = Symbol.for("pi-subagent-workbench.job-activity.v1");

/** The subset of a child RPC event that matters for activity tracking. */
export interface JobActivityEvent {
  readonly type: string;
  readonly toolCallId?: string;
  readonly toolName?: string;
  readonly message?: { readonly role?: string };
}

/** Trace fields that decide the activity key (see `activityKeyForTrace`). */
export interface ActivityKeyTrace {
  readonly taskId?: string | undefined;
  readonly workId?: string | undefined;
}

/** Where an event belongs: which key, and which job owns that key. */
export interface ActivityKeyContext {
  readonly trace?: ActivityKeyTrace | undefined;
  /** Provider run id; last-resort key for direct provider calls. */
  readonly runId?: string | undefined;
}

/**
 * The one definition of the activity key, shared by writer and reader:
 * `taskId` (workflow task run) → `workId` (agent job) → `runId` (provider only).
 * Both `activityKeyFor()` and `activityKeyForTrace()` are the same function, so
 * the tools cannot drift from what the provider writes.
 */
export function activityKeyForTrace(
  context: ActivityKeyContext | undefined,
): string | undefined {
  const trace = context?.trace;
  const taskId = trace?.taskId?.trim();
  if (taskId) return taskId;
  const workId = trace?.workId?.trim();
  if (workId) return workId;
  const runId = context?.runId?.trim();
  return runId ? runId : undefined;
}

/**
 * Additional metadata for a persisted heartbeat. The key alone cannot tell a
 * workflow task key from a job key, and the owning job is useful when a
 * heartbeat row is read back long after the process that wrote it exited.
 */
export interface ActivityKeyMetadata {
  readonly kind?: "agent" | "workflow" | undefined;
  /** Owning job workId (workflow tasks report the workflow job). */
  readonly workId?: string | undefined;
  readonly taskId?: string | undefined;
  readonly taskKey?: string | undefined;
}

/** A ledger row the tracker can ingest, satisfied by `JobActivityHeartbeat`. */
export interface PersistedActivityHeartbeat {
  readonly activityKey: string;
  readonly lastActivityAt: number;
  readonly eventCount?: number;
  readonly lastEventType?: string;
  readonly busy?: boolean;
  readonly settled?: boolean;
}

interface MutableRun {
  /** toolCallId (or synthetic id) → start timestamp of the in-flight call. */
  tools: Map<string, number>;
  /** Start timestamps of assistant `message_start` events without `message_end`. */
  modelRequests: number[];
  toolSequence: number;
}

interface MutableActivity {
  lastActivityAt: number;
  eventCount: number;
  lastEventType?: string;
  runs: Map<string, MutableRun>;
  /** Set by the writer so a later heartbeat row can name the owning job. */
  meta?: ActivityKeyMetadata;
}

/** Exactly what a tracker holds for one key, plus the key itself. */
export interface JobActivityRawEntry {
  readonly key: string;
  readonly lastActivityAt: number;
  readonly eventCount: number;
  readonly lastEventType?: string;
  readonly runningTools: number;
  readonly pendingModelRequests: number;
  readonly busy: boolean;
  readonly meta?: ActivityKeyMetadata;
}

export interface JobActivitySnapshot {
  readonly key: string;
  readonly lastActivityAt: number;
  readonly eventCount: number;
  readonly lastEventType?: string;
  readonly activeRuns: number;
  readonly runningTools: number;
  readonly pendingModelRequests: number;
  /** True while a tool call or a model request is still in flight. */
  readonly busy: boolean;
  /** Start timestamp of the oldest in-flight tool call / model request. */
  readonly oldestInFlightAt?: number;
}

export type JobActivityPhase = "busy" | "active" | "stalled";

export interface JobActivityClassification {
  readonly phase: JobActivityPhase;
  readonly idleMs: number;
  /** Age of the oldest in-flight unit; 0 when nothing is in flight. */
  readonly busyMs: number;
  /** True when a `busy` job aged past the busy ceiling without progress. */
  readonly escalated: boolean;
  /** Render suffix, including the leading separator. */
  readonly suffix: string;
  /**
   * For a workflow job: the task whose own state decided the verdict, so a
   * stalled sibling is reported as that sibling instead of as the whole job.
   */
  readonly taskKey?: string;
  readonly taskLabel?: string;
  readonly taskId?: string;
}

export interface JobActivityFormatOptions {
  readonly snapshot?: JobActivitySnapshot | undefined;
  readonly now?: number;
  readonly idleThresholdMs?: number;
  readonly busyMaxMs?: number;
}

/** The subset of a pending job entry needed to render its activity suffix. */
export interface PendingJobLineFields {
  readonly workId: string;
  readonly kind: string;
  readonly status: string;
  readonly label: string;
}

/**
 * Per-work-item activity ledger. Observation only: entries are dropped as soon
 * as every run recorded under a key has settled.
 *
 * Persistence is optional and driven by the writer: pass an `onPersist` sink
 * (the controller wires it to `JobLedger.recordActivity`) and every activity
 * change is handed over, throttled per key by `persistIntervalMs` so a chatty
 * run does not append a ledger row per token. `flushPersist()`/`settle()` force
 * a final write, including a `settled: true` marker so a restart cannot
 * resurrect a finished key from an older heartbeat row.
 */
export class JobActivityTracker {
  private readonly activities = new Map<string, MutableActivity>();
  private readonly lastPersistedAt = new Map<string, number>();
  private persistIntervalMs: number;
  private onPersist:
    | ((entry: JobActivityRawEntry, settled: boolean) => void)
    | undefined;
  private readonly now: () => number;

  constructor(
    options: {
      readonly persistIntervalMs?: number;
      readonly onPersist?: (entry: JobActivityRawEntry, settled: boolean) => void;
      readonly now?: () => number;
    } = {},
  ) {
    this.persistIntervalMs = Math.max(0, options.persistIntervalMs ?? 0);
    this.onPersist = options.onPersist;
    this.now = options.now ?? Date.now;
  }

  /** True when this tracker writes heartbeats somewhere. */
  get persisting(): boolean {
    return this.onPersist !== undefined;
  }

  /** The installed heartbeat sink, if any (used for ownership checks). */
  currentPersistSink():
    | ((entry: JobActivityRawEntry, settled: boolean) => void)
    | undefined {
    return this.onPersist;
  }

  /**
   * Installs/replaces the heartbeat sink at runtime (the controller learns its
   * ledger path after the process-wide tracker already exists).
   */
  setPersistSink(
    sink: ((entry: JobActivityRawEntry, settled: boolean) => void) | undefined,
    persistIntervalMs: number = this.persistIntervalMs,
  ): void {
    this.onPersist = sink;
    this.persistIntervalMs = Math.max(0, persistIntervalMs);
    this.lastPersistedAt.clear();
  }

  noteRunStarted(
    key: string,
    runId: string,
    at: number = Date.now(),
    meta?: ActivityKeyMetadata,
  ): void {
    const activity = this.activityFor(key, at);
    if (meta) activity.meta = { ...activity.meta, ...meta };
    if (!activity.runs.has(runId)) {
      activity.runs.set(runId, {
        tools: new Map<string, number>(),
        modelRequests: [],
        toolSequence: 0,
      });
    }
    this.persist(key, activity, false);
  }

  noteEvent(
    key: string,
    runId: string,
    event: JobActivityEvent,
    at: number = Date.now(),
    meta?: ActivityKeyMetadata,
  ): void {
    const activity = this.activityFor(key, at);
    if (meta) activity.meta = { ...activity.meta, ...meta };
    activity.lastActivityAt = at;
    activity.eventCount += 1;
    activity.lastEventType = event.type;
    const run = this.runFor(activity, runId);
    this.applyEvent(run, event, at);
    this.persist(key, activity, false);
  }

  private applyEvent(run: MutableRun, event: JobActivityEvent, at: number): void {
    if (event.type === "tool_execution_start") {
      run.toolSequence += 1;
      const id =
        event.toolCallId ??
        (event.toolName ? `${event.toolName}#${run.toolSequence}` : `tool#${run.toolSequence}`);
      run.tools.set(id, at);
      return;
    }
    if (event.type === "tool_execution_end") {
      const id = event.toolCallId ?? event.toolName;
      if (id !== undefined && run.tools.delete(id)) return;
      // Unidentified end event: retire the oldest outstanding tool call so a
      // missing toolCallId cannot keep a finished run marked busy forever.
      const oldest = run.tools.keys().next();
      if (!oldest.done) run.tools.delete(oldest.value);
      return;
    }
    if (event.message?.role !== "assistant") return;
    if (event.type === "message_start") run.modelRequests.push(at);
    else if (event.type === "message_end") {
      if (run.modelRequests.length === 0) return;
      run.modelRequests.shift();
    }
  }

  /**
   * Drops one run. When its key has no run left the key is gone, so the last
   * `lastActivityAt` leaves memory for good; a `settled` heartbeat row keeps a
   * later restore from resurrecting it out of an older row.
   */
  noteRunSettled(key: string, runId: string): void {
    const activity = this.activities.get(key);
    if (!activity) return;
    activity.runs.delete(runId);
    if (activity.runs.size > 0) return;
    const entry = this.rawEntry(key, activity);
    this.activities.delete(key);
    this.lastPersistedAt.delete(key);
    this.emit(entry, true);
  }

  /** Writes the current state of every key once, ignoring the throttle. */
  flushPersist(): void {
    if (!this.onPersist) return;
    for (const [key, activity] of this.activities) {
      this.lastPersistedAt.set(key, this.now());
      this.emit(this.rawEntry(key, activity), false);
    }
  }

  /**
   * Replays persisted heartbeats into this tracker, typically at start-up.
   *
   * Only `lastActivityAt`, `eventCount` and `lastEventType` survive a restart:
   * the in-flight tool calls and model requests of the previous process are
   * unobservable, so restored keys report `busy: false` and cannot escalate.
   * Rows with a `settled` marker are skipped, and a key whose in-memory state
   * is already newer always wins.
   *
   * Returns the number of keys restored.
   */
  restoreFromLedger(rows: Iterable<PersistedActivityHeartbeat>): number {
    let restored = 0;
    for (const row of rows) {
      const key = row.activityKey?.trim();
      if (!key) continue;
      if (row.settled === true) continue;
      if (!Number.isFinite(row.lastActivityAt)) continue;
      const existing = this.activities.get(key);
      if (existing) {
        // Live state from this process is authoritative for the same key.
        if (existing.lastActivityAt >= row.lastActivityAt) continue;
        existing.lastActivityAt = row.lastActivityAt;
        existing.eventCount = Math.max(existing.eventCount, row.eventCount ?? 0);
        if (row.lastEventType) existing.lastEventType = row.lastEventType;
        restored += 1;
        continue;
      }
      const activity: MutableActivity = {
        lastActivityAt: row.lastActivityAt,
        eventCount: row.eventCount ?? 0,
        ...(row.lastEventType === undefined ? {} : { lastEventType: row.lastEventType }),
        // No runs: in-flight units from a previous process are not recoverable.
        runs: new Map<string, MutableRun>(),
      };
      this.activities.set(key, activity);
      // A restored key is already durable; do not rewrite it immediately.
      this.lastPersistedAt.set(key, this.now());
      restored += 1;
    }
    return restored;
  }

  get(key: string): JobActivitySnapshot | undefined {
    const activity = this.activities.get(key);
    if (!activity) return undefined;
    let runningTools = 0;
    let pendingModelRequests = 0;
    let oldestInFlightAt: number | undefined;
    for (const run of activity.runs.values()) {
      runningTools += run.tools.size;
      pendingModelRequests += run.modelRequests.length;
      for (const startedAt of [...run.tools.values(), ...run.modelRequests]) {
        if (oldestInFlightAt === undefined || startedAt < oldestInFlightAt) {
          oldestInFlightAt = startedAt;
        }
      }
    }
    return Object.freeze({
      key,
      lastActivityAt: activity.lastActivityAt,
      eventCount: activity.eventCount,
      ...(activity.lastEventType === undefined
        ? {}
        : { lastEventType: activity.lastEventType }),
      activeRuns: activity.runs.size,
      runningTools,
      pendingModelRequests,
      busy: runningTools > 0 || pendingModelRequests > 0,
      ...(oldestInFlightAt === undefined ? {} : { oldestInFlightAt }),
    });
  }

  clear(key: string): void {
    this.activities.delete(key);
    this.lastPersistedAt.delete(key);
  }

  /** Raw entry for one key, including in-flight counts; used for persistence. */
  raw(key: string): JobActivityRawEntry | undefined {
    const activity = this.activities.get(key);
    return activity ? this.rawEntry(key, activity) : undefined;
  }

  size(): number {
    return this.activities.size;
  }

  private rawEntry(key: string, activity: MutableActivity): JobActivityRawEntry {
    let runningTools = 0;
    let pendingModelRequests = 0;
    for (const run of activity.runs.values()) {
      runningTools += run.tools.size;
      pendingModelRequests += run.modelRequests.length;
    }
    return Object.freeze({
      key,
      lastActivityAt: activity.lastActivityAt,
      eventCount: activity.eventCount,
      ...(activity.lastEventType === undefined
        ? {}
        : { lastEventType: activity.lastEventType }),
      runningTools,
      pendingModelRequests,
      busy: runningTools > 0 || pendingModelRequests > 0,
      ...(activity.meta === undefined ? {} : { meta: { ...activity.meta } }),
    });
  }

  private persist(key: string, activity: MutableActivity, settled: boolean): void {
    if (!this.onPersist) return;
    const at = this.now();
    const previous = this.lastPersistedAt.get(key);
    if (!settled && previous !== undefined && at - previous < this.persistIntervalMs) {
      return;
    }
    this.lastPersistedAt.set(key, at);
    this.emit(this.rawEntry(key, activity), settled);
  }

  private emit(entry: JobActivityRawEntry, settled: boolean): void {
    if (!this.onPersist) return;
    try {
      this.onPersist(entry, settled);
    } catch {
      // A heartbeat sink must never break a run.
    }
  }

  private activityFor(key: string, at: number): MutableActivity {
    const existing = this.activities.get(key);
    if (existing) return existing;
    const created: MutableActivity = {
      lastActivityAt: at,
      eventCount: 0,
      runs: new Map<string, MutableRun>(),
    };
    this.activities.set(key, created);
    return created;
  }

  private runFor(activity: MutableActivity, runId: string): MutableRun {
    const existing = activity.runs.get(runId);
    if (existing) return existing;
    const created: MutableRun = {
      tools: new Map<string, number>(),
      modelRequests: [],
      toolSequence: 0,
    };
    activity.runs.set(runId, created);
    return created;
  }
}

const globalScope = globalThis as unknown as Record<symbol, unknown>;

/** Process-wide tracker shared by the RPC provider (writer) and tools (reader). */
export function jobActivityTracker(): JobActivityTracker {
  const existing = globalScope[TRACKER_SYMBOL];
  if (existing instanceof JobActivityTracker) return existing;
  const created = new JobActivityTracker({
    persistIntervalMs: resolveActivityPersistMs(),
  });
  globalScope[TRACKER_SYMBOL] = created;
  return created;
}

/**
 * Installs (or replaces) the heartbeat sink of the process-wide tracker.
 * Called by the workbench controller once its `JobLedger` is known, so the
 * provider keeps writing through `jobActivityTracker()` without knowing about
 * ledger paths. Replacing the sink is idempotent and keeps memory state.
 */
export function setJobActivityPersistSink(
  sink: ((entry: JobActivityRawEntry, settled: boolean) => void) | undefined,
): void {
  jobActivityTracker().setPersistSink(sink, resolveActivityPersistMs());
}

/**
 * Removes `sink` from the process-wide tracker, but only if it is still the
 * installed one: the tracker is shared, so a disposed controller must not
 * uninstall the sink of a controller that replaced it.
 */
export function clearJobActivityPersistSink(
  sink: (entry: JobActivityRawEntry, settled: boolean) => void,
): void {
  const tracker = jobActivityTracker();
  if (tracker.currentPersistSink() === sink) tracker.setPersistSink(undefined);
}

/** Reads `PI_SUBAGENT_ACTIVITY_PERSIST_MS`; 0 disables throttling, default 15s. */
export function resolveActivityPersistMs(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const raw = env[ACTIVITY_PERSIST_ENV]?.trim();
  if (!raw) return DEFAULT_ACTIVITY_PERSIST_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_ACTIVITY_PERSIST_MS;
  return Math.floor(parsed);
}

/** Reads `PI_SUBAGENT_IDLE_MS`, falling back to five minutes when unset/invalid. */
export function resolveSubagentIdleMs(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const raw = env[SUBAGENT_IDLE_ENV]?.trim();
  if (!raw) return DEFAULT_SUBAGENT_IDLE_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_SUBAGENT_IDLE_MS;
  return Math.floor(parsed);
}

function idleSeconds(idleMs: number): number {
  return Math.max(0, Math.floor(idleMs / 1_000));
}

/** Reads `PI_SUBAGENT_BUSY_MAX_MS`, falling back to ten minutes when unset/invalid. */
export function resolveSubagentBusyMaxMs(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const raw = env[SUBAGENT_BUSY_ENV]?.trim();
  if (!raw) return DEFAULT_SUBAGENT_BUSY_MAX_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_SUBAGENT_BUSY_MAX_MS;
  return Math.floor(parsed);
}

/**
 * busy = a tool call or model request is in flight; otherwise the run is
 * "active" while its last event is recent and "stalled?" once it is older than
 * the threshold. A missing snapshot yields no suffix (nothing observed yet).
 *
 * Escalation: a job that is still `busy` only because some call never returned
 * is the classic wedged command (`bash` waiting on stdin). When the oldest
 * in-flight unit has been running for `busyMaxMs` **and** no event arrived in
 * that window, the phase becomes `stalled` with `escalated: true`. Both guards
 * are needed: a long command that keeps emitting output refreshes
 * `lastActivityAt`, and a chain of short tools keeps `busyMs` small.
 */
export function classifyJobActivity(
  snapshot: JobActivitySnapshot | undefined,
  options: JobActivityFormatOptions = {},
): JobActivityClassification | undefined {
  if (!snapshot) return undefined;
  const now = options.now ?? Date.now();
  const idleThresholdMs = options.idleThresholdMs ?? resolveSubagentIdleMs();
  const idleMs = Math.max(0, now - snapshot.lastActivityAt);
  const seconds = idleSeconds(idleMs);
  if (snapshot.busy) {
    const busyMaxMs = options.busyMaxMs ?? resolveSubagentBusyMaxMs();
    const busyMs = Math.max(
      0,
      snapshot.oldestInFlightAt === undefined
        ? idleMs
        : now - snapshot.oldestInFlightAt,
    );
    const busySeconds = idleSeconds(busyMs);
    // `lastActivityAt` is never older than the in-flight start (the start event
    // itself refreshed it), so `idleMs >= busyMaxMs` already implies
    // `busyMs >= busyMaxMs`. Both are checked anyway so the intent survives a
    // future change to what refreshes `lastActivityAt`: escalate only when a
    // call has been in flight for the ceiling *and* nothing arrived meanwhile.
    // A silent-but-healthy long build trips this on purpose; the suffix asks for
    // inspection first (`stalled?`) instead of cancelling, and
    // `PI_SUBAGENT_BUSY_MAX_MS` raises the ceiling for known-slow commands.
    if (busyMs >= busyMaxMs && idleMs >= busyMaxMs) {
      return Object.freeze({
        phase: "stalled" as const,
        idleMs,
        busyMs,
        escalated: true,
        suffix: ` · stalled? (in flight ${busySeconds}s, no progress ${seconds}s; likely a command waiting on input/network — inspect partial output, then cancel if it does not recover)`,
      });
    }
    return Object.freeze({
      phase: "busy" as const,
      idleMs,
      busyMs,
      escalated: false,
      suffix: ` · busy (${busySeconds}s in flight; until ${idleSeconds(busyMaxMs)}s it is treated as healthy)`,
    });
  }
  if (idleMs < idleThresholdMs) {
    return Object.freeze({
      phase: "active" as const,
      idleMs,
      busyMs: 0,
      escalated: false,
      suffix: ` · active (idle ${seconds}s)`,
    });
  }
  return Object.freeze({
    phase: "stalled" as const,
    idleMs,
    busyMs: 0,
    escalated: false,
    suffix: ` · stalled? (${seconds}s no activity; may be stuck, inspect partial output before cancel)`,
  });
}

export function formatJobActivitySuffix(
  snapshot: JobActivitySnapshot | undefined,
  options: JobActivityFormatOptions = {},
): string {
  return classifyJobActivity(snapshot, options)?.suffix ?? "";
}

/** One in-flight workflow task, as known from the controller's projections. */
export interface WorkflowTaskActivityInput {
  /** Activity key written by the provider for this task run (`taskId`). */
  readonly taskId: string;
  readonly taskKey?: string;
  readonly label: string;
}

/**
 * Activity for a workflow job, derived from its in-flight tasks instead of the
 * parent job key.
 *
 * Workflow task runs are keyed by their own `taskId`, so each task is judged on
 * its own events; a wedged task is no longer hidden behind a busy sibling. The
 * most severe task decides the job's phase (`stalled` > `busy` > `active`) and
 * the suffix names that task, while `idleMs` is the *oldest* task's idle time:
 * the job cannot be healthier than its least recently active task.
 */
export interface WorkflowActivitySummary {
  readonly snapshot: JobActivitySnapshot;
  readonly classification: JobActivityClassification;
  readonly taskKey?: string;
  readonly taskLabel?: string;
  readonly taskId?: string;
  /** How many in-flight tasks had a snapshot; 0 means nothing observed yet. */
  readonly observedTasks: number;
}

export function summarizeWorkflowTaskActivity(
  jobKey: string,
  tasks: readonly WorkflowTaskActivityInput[],
  getSnapshot: (key: string) => JobActivitySnapshot | undefined,
  options: JobActivityFormatOptions = {},
): WorkflowActivitySummary | undefined {
  const snapshots: { task: WorkflowTaskActivityInput; snapshot: JobActivitySnapshot }[] = [];
  for (const task of tasks) {
    const snapshot = getSnapshot(task.taskId);
    if (snapshot) snapshots.push({ task, snapshot });
  }
  if (!snapshots.length) return undefined;
  const now = options.now ?? Date.now();
  const classifications = snapshots.map(({ snapshot }) => {
    const classification = classifyJobActivity(snapshot, { ...options, now });
    return classification!;
  });
  // stalled > busy > active; among equals the oldest idle time decides.
  const weight = (phase: JobActivityPhase): number =>
    phase === "stalled" ? 2 : phase === "busy" ? 1 : 0;
  let chosen = 0;
  for (let index = 1; index < snapshots.length; index += 1) {
    const current = classifications[index]!;
    const best = classifications[chosen]!;
    if (
      weight(current.phase) > weight(best.phase) ||
      (weight(current.phase) === weight(best.phase) && current.idleMs > best.idleMs)
    ) {
      chosen = index;
    }
  }
  let lastActivityAt = snapshots[0]!.snapshot.lastActivityAt;
  let eventCount = 0;
  let runningTools = 0;
  let pendingModelRequests = 0;
  let oldestInFlightAt: number | undefined;
  for (const { snapshot } of snapshots) {
    lastActivityAt = Math.min(lastActivityAt, snapshot.lastActivityAt);
    eventCount += snapshot.eventCount;
    runningTools += snapshot.runningTools;
    pendingModelRequests += snapshot.pendingModelRequests;
    if (snapshot.oldestInFlightAt !== undefined) {
      oldestInFlightAt =
        oldestInFlightAt === undefined
          ? snapshot.oldestInFlightAt
          : Math.min(oldestInFlightAt, snapshot.oldestInFlightAt);
    }
  }
  const snapshot: JobActivitySnapshot = Object.freeze({
    key: jobKey,
    lastActivityAt,
    eventCount,
    activeRuns: snapshots.length,
    runningTools,
    pendingModelRequests,
    busy: runningTools > 0 || pendingModelRequests > 0,
    ...(oldestInFlightAt === undefined ? {} : { oldestInFlightAt }),
  });
  const winner = snapshots[chosen]!;
  const classification: JobActivityClassification = Object.freeze({
    ...classifications[chosen]!,
    suffix: ` · task ${winner.task.taskKey ?? winner.task.label}:${classifications[chosen]!.suffix}`,
    taskKey: winner.task.taskKey,
    taskLabel: winner.task.label,
    taskId: winner.task.taskId,
  });
  return Object.freeze({
    snapshot,
    classification,
    observedTasks: snapshots.length,
    ...(winner.task.taskKey === undefined ? {} : { taskKey: winner.task.taskKey }),
    taskLabel: winner.task.label,
    taskId: winner.task.taskId,
  });
}

/**
 * `workId · kind · status · label` plus the activity suffix. Used by
 * `formatJobQuery` for pending jobs so a wait timeout is not the only signal.
 * `options.classification` lets a caller that already classified the job (to
 * decide whether to attach a partial preview) reuse that result instead of
 * classifying twice and possibly disagreeing across a clock tick.
 *
 * `options.subject` names the deciding workflow task, so a stalled sibling is
 * reported as that task rather than as the whole workflow.
 */
export function formatPendingJobLine(
  job: PendingJobLineFields,
  options: JobActivityFormatOptions & {
    readonly classification?: JobActivityClassification | undefined;
    readonly subject?: string | undefined;
  } = {},
): string {
  const suffix =
    options.classification === undefined
      ? formatJobActivitySuffix(options.snapshot, options)
      : options.classification.suffix;
  const subject = options.subject ? `${options.subject} · ` : "";
  return `${job.workId} · ${subject}${job.kind} · ${job.status} · ${job.label}${suffix}`;
}