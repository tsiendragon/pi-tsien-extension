import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { DashboardFeatureAdapter } from "pi-tsien-shared/src/lib/dashboard-bridge.ts";
import { BtwSessionController, type BtwSnapshot } from "./session.ts";

type BridgeSnapshot = BtwSnapshot | {
  apiVersion: 1;
  revision: number;
  generatedAt: number;
  status: "closed" | "starting" | "error";
  parentMessageCount: 0;
  model?: string;
  activity: string;
  conversation: [];
  error?: string;
};

type Command =
  | { type: "open" }
  | { type: "submit"; text: string }
  | { type: "abort" }
  | { type: "refresh-parent" }
  | { type: "close" };

function command(value: unknown): Command | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  switch (candidate.type) {
    case "open":
    case "abort":
    case "refresh-parent":
    case "close":
      return { type: candidate.type };
    case "submit":
      return typeof candidate.text === "string" ? { type: "submit", text: candidate.text } : undefined;
    default:
      return undefined;
  }
}

export class BtwDashboardAdapter implements DashboardFeatureAdapter {
  readonly feature = "btw" as const;
  readonly apiVersion = 1 as const;

  private readonly listeners = new Set<(snapshot: unknown) => void>();
  private controller?: BtwSessionController;
  private unsubscribeController?: () => void;
  private startupAbort?: AbortController;
  private revision = 0;
  private status: "closed" | "starting" | "error" = "closed";
  private error?: string;
  /** Whether the dashboard panel is showing. The side chat outlives a close. */
  private panelOpen = false;
  /** In-flight startup, so a question asked during it waits instead of failing. */
  private startup?: Promise<void>;

  constructor(
    private readonly ctx: ExtensionContext,
    private readonly createController: (signal: AbortSignal) => Promise<BtwSessionController> = (signal) =>
      BtwSessionController.create(ctx, signal),
  ) {}

  getSnapshot(): BridgeSnapshot {
    if (this.controller) {
      const snapshot = this.controller.getSnapshot();
      // Closing the panel keeps the side chat in memory so the earlier exchanges
      // stay browsable and reopening does not pay for a new parent-context
      // snapshot (Claude Code's `/btw` keeps its thread the same way). While
      // detached the dashboard must still read "closed", otherwise its panel
      // would claim to be open.
      return this.panelOpen ? snapshot : { ...snapshot, status: "closed" };
    }
    return {
      apiVersion: 1,
      revision: this.revision,
      generatedAt: Date.now(),
      status: this.status,
      parentMessageCount: 0,
      ...(this.ctx.model ? { model: `${this.ctx.model.provider}/${this.ctx.model.id}` } : {}),
      activity: this.status === "starting" ? "正在启动" : "",
      conversation: [],
      ...(this.error ? { error: this.error } : {}),
    };
  }

  subscribe(listener: (snapshot: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async dispatch(value: unknown): Promise<unknown> {
    const parsed = command(value);
    if (!parsed) throw new Error("invalid_btw_command");
    switch (parsed.type) {
      case "open":
        await this.open();
        return this.getSnapshot();
      case "submit":
        // Also reattaches the panel when the side chat was closed but retained.
        await this.open();
        // The panel allows asking without clicking 打开 first, so a question can
        // arrive before a side chat exists if the startup failed.
        if (!this.controller) throw new Error("btw_unavailable");
        void this.controller.submit(parsed.text).catch(error => {
          this.status = "error";
          this.error = error instanceof Error ? error.message : String(error);
          this.emit();
        });
        return { ok: true, accepted: true };
      case "abort":
        await this.controller?.abort();
        return { ok: true };
      case "refresh-parent":
        if (!this.controller) throw new Error("btw_not_open");
        await this.controller.refreshParentSnapshot();
        return { ok: true };
      case "close":
        await this.close();
        return { ok: true };
    }
  }

  async dispose(): Promise<void> {
    await this.drop();
    this.listeners.clear();
  }

  private async open(): Promise<void> {
    this.panelOpen = true;
    if (this.controller) {
      this.emit();
      return;
    }
    // A question can arrive while the previous open is still starting: wait for
    // that startup instead of failing on a controller that is not there yet.
    if (this.startup) {
      await this.startup.catch(() => undefined);
      return;
    }
    const abort = new AbortController();
    this.startupAbort = abort;
    const startup = this.start(abort);
    this.startup = startup;
    try {
      await startup;
    } finally {
      if (this.startup === startup) this.startup = undefined;
    }
  }

  private async start(abort: AbortController): Promise<void> {
    this.status = "starting";
    this.error = undefined;
    this.emit();
    try {
      const controller = await this.createController(abort.signal);
      if (this.startupAbort !== abort) {
        await controller.dispose();
        return;
      }
      this.controller = controller;
      this.status = "closed";
      this.unsubscribeController = controller.subscribe(snapshot => this.emit(snapshot));
      this.emit(controller.getSnapshot());
    } catch (error) {
      if (this.startupAbort !== abort) return;
      this.status = "error";
      this.error = error instanceof Error ? error.message : String(error);
      this.emit();
      throw error;
    } finally {
      if (this.startupAbort === abort) this.startupAbort = undefined;
    }
  }

  /** Hide the panel but keep the side chat, so its exchanges stay browsable. */
  private async close(): Promise<void> {
    this.startupAbort?.abort(new Error("BTW closed"));
    this.startupAbort = undefined;
    this.panelOpen = false;
    this.emit();
  }

  /** Throw the side chat away for good (extension shutdown, new parent session). */
  private async drop(): Promise<void> {
    this.startupAbort?.abort(new Error("BTW disposed"));
    this.startupAbort = undefined;
    this.unsubscribeController?.();
    this.unsubscribeController = undefined;
    const startup = this.startup;
    this.startup = undefined;
    await startup?.catch(() => undefined);
    const controller = this.controller;
    this.controller = undefined;
    this.panelOpen = false;
    await controller?.dispose();
    this.status = "closed";
    this.error = undefined;
    this.emit();
  }

  private emit(snapshot: unknown = this.getSnapshot()): void {
    this.revision += 1;
    const value = snapshot && typeof snapshot === "object"
      ? { ...(snapshot as Record<string, unknown>), revision: this.revision, generatedAt: Date.now() }
      : this.getSnapshot();
    for (const listener of this.listeners) listener(value);
  }
}
