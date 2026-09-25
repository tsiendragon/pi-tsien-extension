import { randomUUID } from "node:crypto";

export interface LeaseSnapshot {
  readonly state: "unclaimed" | "claimed";
  readonly leaseId?: string;
  readonly browserClientId?: string;
  readonly expiresAt?: number;
}

export type LeaseReleaseReason =
  | "remote_release"
  | "local_release"
  | "expired"
  | "broker_disconnect"
  | "session_shutdown"
  | "session_switch";

export class LeaseError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "LeaseError";
  }
}

export interface LeaseManagerOptions {
  readonly defaultLeaseMs?: number;
  readonly minLeaseMs?: number;
  readonly maxLeaseMs?: number;
  readonly disconnectGraceMs?: number;
  readonly now?: () => number;
  readonly idFactory?: () => string;
  readonly onChange?: (snapshot: LeaseSnapshot, reason: string) => void;
}

type ActiveLease = {
  readonly leaseId: string;
  readonly browserClientId: string;
  expiresAt: number;
  leaseMs: number;
};

export class LeaseManager {
  private readonly defaultLeaseMs: number;
  private readonly minLeaseMs: number;
  private readonly maxLeaseMs: number;
  private readonly disconnectGraceMs: number;
  private readonly now: () => number;
  private readonly idFactory: () => string;
  private readonly onChange?: (snapshot: LeaseSnapshot, reason: string) => void;
  private active?: ActiveLease;
  private expiryTimer?: ReturnType<typeof setTimeout>;
  private disconnectTimer?: ReturnType<typeof setTimeout>;

  constructor(options: LeaseManagerOptions = {}) {
    this.defaultLeaseMs = options.defaultLeaseMs ?? 30_000;
    this.minLeaseMs = options.minLeaseMs ?? 10_000;
    this.maxLeaseMs = options.maxLeaseMs ?? 120_000;
    this.disconnectGraceMs = options.disconnectGraceMs ?? 15_000;
    this.now = options.now ?? Date.now;
    this.idFactory = options.idFactory ?? randomUUID;
    this.onChange = options.onChange;
  }

  snapshot(): LeaseSnapshot {
    this.expireIfNeeded();
    if (!this.active) return { state: "unclaimed" };
    return {
      state: "claimed",
      leaseId: this.active.leaseId,
      browserClientId: this.active.browserClientId,
      expiresAt: this.active.expiresAt,
    };
  }

  isClaimed(): boolean {
    return this.snapshot().state === "claimed";
  }

  claim(browserClientId: string, requestedLeaseMs = this.defaultLeaseMs): LeaseSnapshot {
    this.expireIfNeeded();
    if (this.active) {
      throw new LeaseError("session_already_claimed", "Session is already claimed by another browser");
    }
    const leaseMs = Math.max(this.minLeaseMs, Math.min(this.maxLeaseMs, requestedLeaseMs));
    this.active = {
      leaseId: this.idFactory(),
      browserClientId,
      leaseMs,
      expiresAt: this.now() + leaseMs,
    };
    this.scheduleExpiry();
    const snapshot = this.snapshot();
    this.onChange?.(snapshot, "claimed");
    return snapshot;
  }

  renew(leaseId: string): LeaseSnapshot {
    const active = this.requireLease(leaseId);
    active.expiresAt = this.now() + active.leaseMs;
    this.scheduleExpiry();
    const snapshot = this.snapshot();
    this.onChange?.(snapshot, "renewed");
    return snapshot;
  }

  assertLease(leaseId: string): void {
    this.requireLease(leaseId);
  }

  release(leaseId?: string, reason: LeaseReleaseReason = "remote_release"): boolean {
    this.expireIfNeeded();
    if (!this.active) return false;
    if (leaseId !== undefined && leaseId !== this.active.leaseId) {
      throw new LeaseError("invalid_lease", "Lease does not own this session");
    }
    this.clearActive();
    this.onChange?.({ state: "unclaimed" }, reason);
    return true;
  }

  markBrokerDisconnected(): void {
    if (!this.active || this.disconnectTimer) return;
    this.disconnectTimer = setTimeout(() => {
      this.disconnectTimer = undefined;
      this.release(undefined, "broker_disconnect");
    }, this.disconnectGraceMs);
    this.disconnectTimer.unref?.();
  }

  markBrokerConnected(): void {
    if (!this.disconnectTimer) return;
    clearTimeout(this.disconnectTimer);
    this.disconnectTimer = undefined;
  }

  dispose(reason: LeaseReleaseReason = "session_shutdown"): void {
    if (this.disconnectTimer) clearTimeout(this.disconnectTimer);
    this.disconnectTimer = undefined;
    if (this.active) this.release(undefined, reason);
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = undefined;
  }

  private requireLease(leaseId: string): ActiveLease {
    this.expireIfNeeded();
    if (!this.active || this.active.leaseId !== leaseId) {
      throw new LeaseError("invalid_lease", "Lease does not own this session");
    }
    return this.active;
  }

  private expireIfNeeded(): void {
    if (!this.active || this.active.expiresAt > this.now()) return;
    this.clearActive();
    this.onChange?.({ state: "unclaimed" }, "expired");
  }

  private scheduleExpiry(): void {
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    if (!this.active) return;
    this.expiryTimer = setTimeout(() => {
      this.expiryTimer = undefined;
      this.expireIfNeeded();
    }, Math.max(0, this.active.expiresAt - this.now()));
    this.expiryTimer.unref?.();
  }

  private clearActive(): void {
    this.active = undefined;
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = undefined;
  }
}
