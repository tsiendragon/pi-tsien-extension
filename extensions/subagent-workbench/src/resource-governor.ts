export const DEFAULT_ACTIVE_LIMIT = 8;
export const DEFAULT_QUEUE_LIMIT = 32;

export const ResourcePriority = {
  Interactive: "P0",
  DirectBackground: "P1",
  WorkflowBackground: "P2",
} as const;

export type ResourcePriority =
  (typeof ResourcePriority)[keyof typeof ResourcePriority];

export type ResourceExhaustedCode =
  | "resource_exhausted"
  | "nested_resource_exhausted";

export type ResourceExhaustedReason =
  | "queue_full"
  | "aborted"
  | "timeout"
  | "nested_capacity_unavailable";

export interface ResourceExhaustedDetails {
  readonly active: number;
  readonly queued: number;
  readonly limit: number;
  readonly queueLimit: number;
  readonly suggestedAction: string;
}

export class ResourceExhaustedError extends Error {
  readonly name = "ResourceExhaustedError";
  readonly details: ResourceExhaustedDetails;
  readonly active: number;
  readonly queued: number;
  readonly limit: number;
  readonly queueLimit: number;
  readonly suggestedAction: string;

  constructor(
    readonly code: ResourceExhaustedCode,
    readonly reason: ResourceExhaustedReason,
    details: ResourceExhaustedDetails,
    cause?: unknown,
  ) {
    super(resourceErrorMessage(code, reason, details), { cause });
    this.details = Object.freeze({ ...details });
    this.active = details.active;
    this.queued = details.queued;
    this.limit = details.limit;
    this.queueLimit = details.queueLimit;
    this.suggestedAction = details.suggestedAction;
  }
}

export interface ResourceGovernorOptions {
  readonly activeLimit?: number;
  readonly queueLimit?: number;
}

export interface ResourceAcquireOptions {
  readonly priority: ResourcePriority;
  /** Parent or workflow identity used as the round-robin scheduling subject. */
  readonly subject: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  /** A nested synchronous acquisition must not wait behind its own ancestor. */
  readonly nested?: boolean;
}

export interface ResourceLease {
  readonly id: number;
  readonly released: boolean;
  release(): void;
}

export interface ResourceGovernorSnapshot {
  readonly revision: number;
  readonly active: number;
  readonly queued: number;
  readonly activeLimit: number;
  readonly queueLimit: number;
  readonly queuedByPriority: Readonly<Record<ResourcePriority, number>>;
}

type SnapshotListener = (snapshot: ResourceGovernorSnapshot) => void;

type Waiter = {
  readonly priority: ResourcePriority;
  readonly subject: string;
  readonly resolve: (lease: ResourceLease) => void;
  readonly reject: (error: ResourceExhaustedError) => void;
  readonly signal?: AbortSignal;
  timer?: ReturnType<typeof setTimeout>;
  abortListener?: () => void;
  settled: boolean;
};

type PriorityQueue = {
  readonly subjects: string[];
  readonly waitersBySubject: Map<string, Waiter[]>;
  cursor: number;
};

const PRIORITY_ORDER: readonly ResourcePriority[] = ["P0", "P1", "P2"];

export class ResourceGovernor {
  readonly activeLimit: number;
  readonly queueLimit: number;

  private active = 0;
  private queued = 0;
  private revision = 0;
  private nextLeaseId = 1;
  private readonly listeners = new Set<SnapshotListener>();
  private readonly queues = new Map<ResourcePriority, PriorityQueue>();
  private currentSnapshot: ResourceGovernorSnapshot;

  constructor(options: ResourceGovernorOptions = {}) {
    this.activeLimit = options.activeLimit ?? DEFAULT_ACTIVE_LIMIT;
    this.queueLimit = options.queueLimit ?? DEFAULT_QUEUE_LIMIT;
    assertPositiveInteger(this.activeLimit, "activeLimit");
    assertNonNegativeInteger(this.queueLimit, "queueLimit");

    for (const priority of PRIORITY_ORDER) {
      this.queues.set(priority, {
        subjects: [],
        waitersBySubject: new Map(),
        cursor: 0,
      });
    }
    this.currentSnapshot = this.createSnapshot();
  }

  acquire(options: ResourceAcquireOptions): Promise<ResourceLease> {
    const validationError = validateAcquireOptions(options);
    if (validationError) return Promise.reject(validationError);

    if (options.signal?.aborted) {
      return Promise.reject(
        this.resourceError("resource_exhausted", "aborted", options.signal.reason),
      );
    }

    if (this.active < this.activeLimit) {
      const lease = this.createLease();
      this.publish();
      return Promise.resolve(lease);
    }

    if (options.nested) {
      return Promise.reject(
        this.resourceError(
          "nested_resource_exhausted",
          "nested_capacity_unavailable",
        ),
      );
    }

    if (this.queued >= this.queueLimit) {
      return Promise.reject(
        this.resourceError("resource_exhausted", "queue_full"),
      );
    }

    return new Promise<ResourceLease>((resolve, reject) => {
      const waiter: Waiter = {
        priority: options.priority,
        subject: options.subject,
        resolve,
        reject,
        signal: options.signal,
        settled: false,
      };

      this.enqueue(waiter);
      if (options.signal) {
        waiter.abortListener = () => {
          this.rejectWaiter(waiter, "aborted", options.signal?.reason);
        };
        options.signal.addEventListener("abort", waiter.abortListener, {
          once: true,
        });
      }
      if (options.timeoutMs !== undefined) {
        waiter.timer = setTimeout(() => {
          this.rejectWaiter(waiter, "timeout");
        }, options.timeoutMs);
      }
      this.publish();
    });
  }

  snapshot(): ResourceGovernorSnapshot {
    return this.currentSnapshot;
  }

  subscribe(listener: SnapshotListener): () => void {
    this.listeners.add(listener);
    listener(this.currentSnapshot);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      this.listeners.delete(listener);
    };
  }

  private enqueue(waiter: Waiter): void {
    const queue = this.queueFor(waiter.priority);
    let subjectWaiters = queue.waitersBySubject.get(waiter.subject);
    if (!subjectWaiters) {
      subjectWaiters = [];
      queue.waitersBySubject.set(waiter.subject, subjectWaiters);
      queue.subjects.push(waiter.subject);
    }
    subjectWaiters.push(waiter);
    this.queued++;
  }

  private rejectWaiter(
    waiter: Waiter,
    reason: "aborted" | "timeout",
    cause?: unknown,
  ): void {
    if (waiter.settled || !this.removeWaiter(waiter)) return;
    waiter.settled = true;
    this.cleanupWaiter(waiter);
    waiter.reject(this.resourceError("resource_exhausted", reason, cause));
    this.publish();
  }

  private removeWaiter(waiter: Waiter): boolean {
    const queue = this.queueFor(waiter.priority);
    const subjectWaiters = queue.waitersBySubject.get(waiter.subject);
    const waiterIndex = subjectWaiters?.indexOf(waiter) ?? -1;
    if (!subjectWaiters || waiterIndex < 0) return false;

    subjectWaiters.splice(waiterIndex, 1);
    this.queued--;
    if (subjectWaiters.length === 0) {
      this.removeSubject(queue, waiter.subject);
    }
    return true;
  }

  private removeSubject(queue: PriorityQueue, subject: string): void {
    const subjectIndex = queue.subjects.indexOf(subject);
    queue.waitersBySubject.delete(subject);
    if (subjectIndex < 0) return;

    queue.subjects.splice(subjectIndex, 1);
    if (subjectIndex < queue.cursor) queue.cursor--;
    if (queue.cursor >= queue.subjects.length) queue.cursor = 0;
  }

  private dequeue(): Waiter | undefined {
    for (const priority of PRIORITY_ORDER) {
      const queue = this.queueFor(priority);
      if (queue.subjects.length === 0) continue;

      const subjectIndex = queue.cursor % queue.subjects.length;
      const subject = queue.subjects[subjectIndex];
      const subjectWaiters = queue.waitersBySubject.get(subject);
      const waiter = subjectWaiters?.shift();
      if (!subjectWaiters || !waiter) {
        this.removeSubject(queue, subject);
        continue;
      }

      this.queued--;
      if (subjectWaiters.length === 0) {
        this.removeSubject(queue, subject);
      } else {
        queue.cursor = (subjectIndex + 1) % queue.subjects.length;
      }
      return waiter;
    }
    return undefined;
  }

  private createLease(): ResourceLease {
    const governor = this;
    const id = this.nextLeaseId++;
    let released = false;
    this.active++;
    return Object.freeze({
      id,
      get released() {
        return released;
      },
      release() {
        if (released) return;
        released = true;
        governor.release();
      },
    });
  }

  private release(): void {
    if (this.active === 0) return;
    this.active--;
    this.drain();
    this.publish();
  }

  private drain(): void {
    while (this.active < this.activeLimit) {
      const waiter = this.dequeue();
      if (!waiter) return;
      waiter.settled = true;
      this.cleanupWaiter(waiter);
      waiter.resolve(this.createLease());
    }
  }

  private cleanupWaiter(waiter: Waiter): void {
    if (waiter.timer !== undefined) clearTimeout(waiter.timer);
    if (waiter.signal && waiter.abortListener) {
      waiter.signal.removeEventListener("abort", waiter.abortListener);
    }
  }

  private publish(): void {
    this.revision++;
    this.currentSnapshot = this.createSnapshot();
    for (const listener of [...this.listeners]) {
      try {
        listener(this.currentSnapshot);
      } catch {
        // A broken observer cannot block permit release or queue progress.
      }
    }
  }

  private createSnapshot(): ResourceGovernorSnapshot {
    const queuedByPriority = Object.freeze({
      P0: this.countQueued("P0"),
      P1: this.countQueued("P1"),
      P2: this.countQueued("P2"),
    });
    return Object.freeze({
      revision: this.revision,
      active: this.active,
      queued: this.queued,
      activeLimit: this.activeLimit,
      queueLimit: this.queueLimit,
      queuedByPriority,
    });
  }

  private countQueued(priority: ResourcePriority): number {
    let count = 0;
    for (const waiters of this.queueFor(priority).waitersBySubject.values()) {
      count += waiters.length;
    }
    return count;
  }

  private queueFor(priority: ResourcePriority): PriorityQueue {
    const queue = this.queues.get(priority);
    if (!queue) throw new Error(`Unknown resource priority: ${priority}`);
    return queue;
  }

  private resourceError(
    code: ResourceExhaustedCode,
    reason: ResourceExhaustedReason,
    cause?: unknown,
  ): ResourceExhaustedError {
    return new ResourceExhaustedError(
      code,
      reason,
      {
        active: this.active,
        queued: this.queued,
        limit: this.activeLimit,
        queueLimit: this.queueLimit,
        suggestedAction: suggestedAction(reason),
      },
      cause,
    );
  }
}

function validateAcquireOptions(options: ResourceAcquireOptions): Error | undefined {
  if (!PRIORITY_ORDER.includes(options.priority)) {
    return new TypeError(`Unknown resource priority: ${options.priority}`);
  }
  if (options.subject.trim().length === 0) {
    return new TypeError("subject must not be empty");
  }
  if (
    options.timeoutMs !== undefined &&
    (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0)
  ) {
    return new TypeError("timeoutMs must be a finite non-negative number");
  }
  return undefined;
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive integer`);
  }
}

function assertNonNegativeInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative integer`);
  }
}

function suggestedAction(reason: ResourceExhaustedReason): string {
  switch (reason) {
    case "queue_full":
      return "Retry after active work completes or lower submitted concurrency.";
    case "aborted":
      return "Do not retry unless the caller starts a new request.";
    case "timeout":
      return "Retry with a longer timeout after reducing load.";
    case "nested_capacity_unavailable":
      return "Return an asynchronous job reference or retry after the parent releases its lease.";
  }
}

function resourceErrorMessage(
  code: ResourceExhaustedCode,
  reason: ResourceExhaustedReason,
  details: ResourceExhaustedDetails,
): string {
  return `${code}: ${reason} (active=${details.active} queued=${details.queued} limit=${details.limit})`;
}
