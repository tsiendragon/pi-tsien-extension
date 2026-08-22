import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { DashboardFeatureAdapter } from "../lib/dashboard-bridge.ts";
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

  constructor(private readonly ctx: ExtensionContext) {}

  getSnapshot(): BridgeSnapshot {
    if (this.controller) return this.controller.getSnapshot();
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
        if (!this.controller) await this.open();
        void this.controller!.submit(parsed.text).catch(error => {
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
    await this.close();
    this.listeners.clear();
  }

  private async open(): Promise<void> {
    if (this.controller || this.status === "starting") return;
    this.status = "starting";
    this.error = undefined;
    this.emit();
    const abort = new AbortController();
    this.startupAbort = abort;
    try {
      const controller = await BtwSessionController.create(this.ctx, abort.signal);
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

  private async close(): Promise<void> {
    this.startupAbort?.abort(new Error("BTW closed"));
    this.startupAbort = undefined;
    this.unsubscribeController?.();
    this.unsubscribeController = undefined;
    const controller = this.controller;
    this.controller = undefined;
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
