import { randomBytes } from "node:crypto";

export type WorkbenchJobKind = "agent" | "workflow";
export type WorkbenchJobStatus =
  | "queued"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export interface WorkbenchWorkHandle {
  readonly workId: string;
  readonly kind: WorkbenchJobKind;
  readonly status: WorkbenchJobStatus;
  readonly background: boolean;
}

export interface WorkbenchJobSnapshot extends WorkbenchWorkHandle {
  readonly label: string;
  readonly createdAt: number;
  readonly startedAt?: number;
  readonly completedAt?: number;
  readonly sessionId?: string;
  readonly runId?: string;
  readonly workflowId?: string;
  readonly attempt?: number;
  readonly sourceWorkId?: string;
  readonly result?: unknown;
  readonly error?: string;
  readonly collectedAt?: number;
}

export interface CreateWorkbenchJobOptions {
  readonly kind: WorkbenchJobKind;
  readonly label: string;
  readonly background: boolean;
  readonly workId?: string;
  readonly attempt?: number;
  readonly sourceWorkId?: string;
}

export interface SettleWorkbenchJobOptions {
  readonly status: Exclude<
    WorkbenchJobStatus,
    "queued" | "running" | "paused"
  >;
  readonly result?: unknown;
  readonly error?: string;
  /** Completion messages are only queued for background submissions. */
  readonly queueCompletion?: boolean;
}

type JobListener = () => void;

interface MutableJob {
  workId: string;
  kind: WorkbenchJobKind;
  label: string;
  status: WorkbenchJobStatus;
  background: boolean;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  sessionId?: string;
  runId?: string;
  workflowId?: string;
  attempt?: number;
  sourceWorkId?: string;
  result?: unknown;
  error?: string;
  collectedAt?: number;
  readonly abort: AbortController;
  completionQueued: boolean;
}

function terminal(status: WorkbenchJobStatus): boolean {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "interrupted"
  );
}

function freezeJob(job: MutableJob): WorkbenchJobSnapshot {
  return Object.freeze({
    workId: job.workId,
    kind: job.kind,
    label: job.label,
    status: job.status,
    background: job.background,
    createdAt: job.createdAt,
    ...(job.startedAt === undefined ? {} : { startedAt: job.startedAt }),
    ...(job.completedAt === undefined ? {} : { completedAt: job.completedAt }),
    ...(job.sessionId === undefined ? {} : { sessionId: job.sessionId }),
    ...(job.runId === undefined ? {} : { runId: job.runId }),
    ...(job.workflowId === undefined ? {} : { workflowId: job.workflowId }),
    ...(job.attempt === undefined ? {} : { attempt: job.attempt }),
    ...(job.sourceWorkId === undefined ? {} : { sourceWorkId: job.sourceWorkId }),
    ...(job.result === undefined ? {} : { result: job.result }),
    ...(job.error === undefined ? {} : { error: job.error }),
    ...(job.collectedAt === undefined ? {} : { collectedAt: job.collectedAt }),
  });
}

export class WorkbenchJobRegistry {
  private readonly jobs = new Map<string, MutableJob>();
  private readonly listeners = new Set<JobListener>();

  create(options: CreateWorkbenchJobOptions): {
    readonly handle: WorkbenchWorkHandle;
    readonly signal: AbortSignal;
  } {
    const workId = options.workId?.trim() || `work_${randomBytes(8).toString("hex")}`;
    if (this.jobs.has(workId)) throw new TypeError(`Workbench job already exists: ${workId}`);
    const job: MutableJob = {
      workId,
      kind: options.kind,
      label: options.label.trim() || `${options.kind} ${workId.slice(-6)}`,
      status: "queued",
      background: options.background,
      createdAt: Date.now(),
      ...(options.attempt === undefined ? {} : { attempt: options.attempt }),
      ...(options.sourceWorkId === undefined
        ? {}
        : { sourceWorkId: options.sourceWorkId }),
      abort: new AbortController(),
      completionQueued: false,
    };
    this.jobs.set(workId, job);
    this.publish();
    return {
      handle: this.handle(job),
      signal: job.abort.signal,
    };
  }

  start(workId: string): void {
    const job = this.require(workId);
    if (terminal(job.status) || job.abort.signal.aborted) return;
    job.status = "running";
    job.startedAt ??= Date.now();
    this.publish();
  }

  pause(workId: string): boolean {
    const job = this.require(workId);
    if (job.status !== "running" || job.abort.signal.aborted) return false;
    job.status = "paused";
    this.publish();
    return true;
  }

  resume(workId: string): boolean {
    const job = this.require(workId);
    if (job.status !== "paused" || job.abort.signal.aborted) return false;
    job.status = "running";
    this.publish();
    return true;
  }

  associate(
    workId: string,
    ids: { readonly sessionId?: string; readonly runId?: string; readonly workflowId?: string },
  ): void {
    const job = this.require(workId);
    if (ids.sessionId !== undefined) job.sessionId = ids.sessionId;
    if (ids.runId !== undefined) job.runId = ids.runId;
    if (ids.workflowId !== undefined) job.workflowId = ids.workflowId;
    this.publish();
  }

  settle(workId: string, options: SettleWorkbenchJobOptions): void {
    const job = this.require(workId);
    if (terminal(job.status)) return;
    job.status = options.status;
    job.result = options.result;
    job.error = options.error;
    job.completedAt = Date.now();
    job.completionQueued = options.queueCompletion ?? false;
    this.publish();
  }

  cancel(workId: string, reason = "Cancelled by user."): WorkbenchJobSnapshot | undefined {
    const job = this.jobs.get(workId);
    if (!job || terminal(job.status)) return undefined;
    job.abort.abort(new Error(reason));
    this.publish();
    return freezeJob(job);
  }

  get(workId: string): WorkbenchJobSnapshot | undefined {
    const job = this.jobs.get(workId);
    return job ? freezeJob(job) : undefined;
  }

  list(workIds?: readonly string[]): readonly WorkbenchJobSnapshot[] {
    const selected = workIds?.length
      ? workIds.flatMap((workId) => {
          const job = this.jobs.get(workId);
          return job ? [freezeJob(job)] : [];
        })
      : [...this.jobs.values()].map(freezeJob);
    return Object.freeze(selected);
  }

  takePendingCompletions(): readonly WorkbenchJobSnapshot[] {
    return Object.freeze(
      [...this.jobs.values()]
        .filter((job) => terminal(job.status) && job.completionQueued)
        .map(freezeJob),
    );
  }

  markCompletionDelivered(workId: string): boolean {
    const job = this.jobs.get(workId);
    if (!job?.completionQueued) return false;
    job.completionQueued = false;
    this.publish();
    return true;
  }

  markCollected(workIds: readonly string[]): void {
    const now = Date.now();
    for (const workId of workIds) {
      const job = this.jobs.get(workId);
      if (job && terminal(job.status)) job.collectedAt ??= now;
    }
    this.publish();
  }

  async wait(
    workIds: readonly string[],
    waitFor: "any" | "all",
    timeoutMs: number,
  ): Promise<readonly WorkbenchJobSnapshot[]> {
    const ready = (): boolean => {
      const jobs = this.list(workIds);
      return waitFor === "all"
        ? jobs.length === workIds.length && jobs.every((job) => terminal(job.status))
        : jobs.some((job) => terminal(job.status));
    };
    if (ready() || timeoutMs <= 0) return this.list(workIds);
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, timeoutMs);
      timer.unref?.();
      const unsubscribe = this.subscribe(() => {
        if (ready()) done();
      });
      function done(): void {
        clearTimeout(timer);
        unsubscribe();
        resolve();
      }
    });
    return this.list(workIds);
  }

  interruptAll(reason = "Workbench controller disposed."): void {
    for (const job of this.jobs.values()) {
      if (!terminal(job.status)) {
        job.abort.abort(new Error(reason));
        job.status = "interrupted";
        job.error = reason;
        job.completedAt = Date.now();
        job.completionQueued = true;
      }
    }
    this.publish();
  }

  subscribe(listener: JobListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private handle(job: MutableJob): WorkbenchWorkHandle {
    return Object.freeze({
      workId: job.workId,
      kind: job.kind,
      status: job.status,
      background: job.background,
    });
  }

  private require(workId: string): MutableJob {
    const job = this.jobs.get(workId);
    if (!job) throw new Error(`Workbench job not found: ${workId}`);
    return job;
  }

  private publish(): void {
    for (const listener of [...this.listeners]) listener();
  }
}
