import { appendFile, mkdir } from "node:fs/promises";
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