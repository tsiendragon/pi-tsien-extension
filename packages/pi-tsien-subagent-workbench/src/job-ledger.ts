import { constants as fsConstants } from "node:fs";
import { appendFile, mkdir, open } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type JobLedgerStatus =
  | "queued"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

/**
 * One line per subagent launch and one line per terminal state. The Workbench
 * registry only lives in memory, so this file is the only place that keeps a
 * history when the extension reloads or the Pi process restarts.
 */
export interface JobLedgerRecord {
  readonly v: 1;
  readonly at: number;
  readonly workId: string;
  readonly kind: "agent" | "workflow";
  readonly status: JobLedgerStatus;
  readonly label?: string;
  readonly role?: string;
  readonly tier?: string;
  readonly model?: string;
  readonly switchedFrom?: string;
  readonly background?: boolean;
  readonly attempt?: number;
  readonly sourceWorkId?: string;
  readonly sessionId?: string;
  readonly workflowId?: string;
  readonly createdAt?: number;
  readonly startedAt?: number;
  readonly completedAt?: number;
  readonly error?: string;
  /** Workflow jobs only: number of child tasks and how many of them failed. */
  readonly tasks?: number;
  readonly tasksFailed?: number;
  /** Token and cost the child burned, so the dashboard can compare it with the main agent. */
  readonly usage?: {
    readonly input: number;
    readonly output: number;
    readonly cacheRead: number;
    readonly cacheWrite: number;
    readonly cost: number;
  };
  /** Tool executions the child performed (it runs `--no-session`, so nothing else records them). */
  readonly toolCalls?: number;
  /** Assistant turns the child took. */
  readonly modelCalls?: number;
}

/**
 * One heartbeat row per activity key, appended at most every
 * `PI_SUBAGENT_ACTIVITY_PERSIST_MS` while a child keeps emitting events.
 *
 * The row deliberately has **no `status` field**: every existing consumer of
 * `subagent-jobs.jsonl` (dashboard statistics, settlement summaries) requires
 * `workId` + `status` and skips rows without them, so heartbeats stay invisible
 * to them while still being readable across processes and restarts.
 *
 * `activityKey` is the tracker key: the workflow task id for workflow task
 * runs, otherwise the job `workId`, otherwise the provider `runId`. `workId`
 * names the owning job when the writer knows it (workflow tasks: the workflow
 * job's workId), so a row can be grouped for display.
 */
export interface JobActivityLedgerRecord {
  readonly v: 1;
  readonly at: number;
  readonly event: "heartbeat";
  readonly activityKey: string;
  readonly workId: string;
  readonly lastActivityAt: number;
  readonly eventCount: number;
  readonly lastEventType?: string;
  readonly busy: boolean;
  readonly runningTools: number;
  readonly pendingModelRequests: number;
  readonly kind?: "agent" | "workflow";
  readonly taskId?: string;
  readonly taskKey?: string;
  /**
   * Terminal marker for one key: once every run under it settled the tracker
   * has no state left, so a restore must not resurrect it from an older row.
   */
  readonly settled?: boolean;
}

/** Latest heartbeat observed for one activity key. */
export interface JobActivityHeartbeat {
  readonly activityKey: string;
  readonly lastActivityAt: number;
  readonly eventCount: number;
  readonly busy: boolean;
  readonly settled: boolean;
  readonly at: number;
  readonly workId?: string;
  readonly taskId?: string;
  readonly taskKey?: string;
  readonly kind?: "agent" | "workflow";
  readonly lastEventType?: string;
}

export function defaultJobLedgerPath(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const dir =
    environment.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
  return join(dir, "subagent-jobs.jsonl");
}

/**
 * Appends JSON lines in order. Writes are serialized and failures are ignored:
 * losing a statistics row must never break a running subagent.
 */
export class JobLedger {
  readonly path: string;
  private queue: Promise<void> = Promise.resolve();

  constructor(path: string = defaultJobLedgerPath()) {
    this.path = path;
  }

  record(entry: JobLedgerRecord): void {
    this.append(entry);
  }

  /** Appends one heartbeat row; same queueing and failure policy as `record`. */
  recordActivity(entry: JobActivityLedgerRecord): void {
    this.append(entry);
  }

  private append(entry: JobLedgerRecord | JobActivityLedgerRecord): void {
    const line = `${JSON.stringify(entry)}\n`;
    this.queue = this.queue
      .then(async () => {
        await mkdir(dirname(this.path), { recursive: true });
        await appendFile(this.path, line, "utf8");
      })
      .catch(() => undefined);
  }

  /** Resolves once every queued write has been attempted; used by tests. */
  flush(): Promise<void> {
    return this.queue;
  }
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseHeartbeat(line: string): JobActivityLedgerRecord | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  if (raw.event !== "heartbeat") return undefined;
  const activityKey = stringField(raw.activityKey);
  const lastActivityAt = numberField(raw.lastActivityAt);
  const at = numberField(raw.at);
  if (!activityKey || lastActivityAt === undefined || at === undefined) return undefined;
  const taskId = stringField(raw.taskId);
  const taskKey = stringField(raw.taskKey);
  const kind = raw.kind === "workflow" ? "workflow" : raw.kind === "agent" ? "agent" : undefined;
  const merged: JobActivityLedgerRecord = {
    v: 1,
    at,
    event: "heartbeat",
    activityKey,
    workId: stringField(raw.workId) ?? activityKey,
    lastActivityAt,
    eventCount: numberField(raw.eventCount) ?? 0,
    busy: raw.busy === true,
    runningTools: numberField(raw.runningTools) ?? 0,
    pendingModelRequests: numberField(raw.pendingModelRequests) ?? 0,
    ...(stringField(raw.lastEventType) ? { lastEventType: stringField(raw.lastEventType)! } : {}),
    ...(kind ? { kind } : {}),
    ...(taskId ? { taskId } : {}),
    ...(taskKey ? { taskKey } : {}),
    ...(raw.settled === true ? { settled: true } : {}),
  };
  return merged;
}

/** Default tail window read by `readJobLedgerActivity` (rows are small, but the file grows). */
export const DEFAULT_ACTIVITY_TAIL_BYTES = 4 * 1024 * 1024;

/**
 * Latest heartbeat per activity key, read from the tail of the ledger.
 *
 * Missing file, unreadable file, partial first line of the tail window and
 * rows written by older versions are all tolerated: the function resolves with
 * whatever it could parse instead of throwing, because a heartbeat is
 * observability data and must never break a start-up path.
 */
export async function readJobLedgerActivity(
  path: string = defaultJobLedgerPath(),
  options: { readonly tailBytes?: number } = {},
): Promise<Map<string, JobActivityHeartbeat>> {
  const latest = new Map<string, JobActivityHeartbeat>();
  const tailBytes = Math.max(1, options.tailBytes ?? DEFAULT_ACTIVITY_TAIL_BYTES);
  let content = "";
  try {
    const handle = await open(path, fsConstants.O_RDONLY);
    try {
      const stat = await handle.stat();
      const length = Math.min(stat.size, tailBytes);
      const start = stat.size - length;
      const buffer = Buffer.alloc(length);
      if (length > 0) await handle.read(buffer, 0, length, start);
      content = buffer.toString("utf8");
      // Drop a possibly split first line unless the window covers the whole file.
      if (start > 0) {
        const newline = content.indexOf("\n");
        content = newline < 0 ? "" : content.slice(newline + 1);
      }
    } finally {
      await handle.close();
    }
  } catch {
    return latest;
  }
  for (const line of content.split("\n")) {
    if (!line.includes("heartbeat")) continue;
    const row = parseHeartbeat(line);
    if (!row) continue;
    const existing = latest.get(row.activityKey);
    if (existing && existing.at > row.at) continue;
    const merged: JobActivityHeartbeat = {
      activityKey: row.activityKey,
      lastActivityAt: row.lastActivityAt,
      eventCount: row.eventCount,
      busy: row.busy,
      settled: row.settled === true,
      at: row.at,
      ...(row.workId ? { workId: row.workId } : {}),
      ...(row.taskId ? { taskId: row.taskId } : {}),
      ...(row.taskKey ? { taskKey: row.taskKey } : {}),
      ...(row.kind ? { kind: row.kind } : {}),
      ...(row.lastEventType ? { lastEventType: row.lastEventType } : {}),
    };
    latest.set(row.activityKey, merged);
  }
  return latest;
}