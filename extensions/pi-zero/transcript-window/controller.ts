import {
  DEFAULT_TRANSCRIPT_WINDOW,
  MAX_RECENT_TURNS,
  MIN_RECENT_TURNS,
  readTranscriptWindowConfig,
  type TranscriptWindowConfig,
} from "./config.ts";
import {
  selectTranscriptWindow,
  type TranscriptSelection,
} from "./turns.ts";

export type TranscriptViewMode =
  | "follow-config"
  | "expanded"
  | "collapsed";

type RebuildableInteractiveMode = {
  rebuildChatFromMessages?: () => void;
  ui?: { requestRender?: () => void };
};

type CommandContext = {
  isIdle(): boolean;
  ui?: {
    notify?: (
      message: string,
      type?: "info" | "warning" | "error",
    ) => void;
  };
};

export type TranscriptWindowStatus = {
  mode: TranscriptViewMode;
  effectiveRecentTurns: number | null;
  hiddenTurns: number;
};

export class TranscriptWindowController {
  private config: TranscriptWindowConfig = {
    ...DEFAULT_TRANSCRIPT_WINDOW,
  };
  private viewMode: TranscriptViewMode = "follow-config";
  private temporaryTurns: number | undefined;
  private activeMode: RebuildableInteractiveMode | undefined;
  private lastHiddenTurns = 0;

  constructor(
    private readonly readConfig: (
      cwd: string,
    ) => TranscriptWindowConfig = readTranscriptWindowConfig,
  ) {}

  onSessionStart(cwd: string): void {
    this.config = this.readConfig(cwd);
    this.viewMode = "follow-config";
    this.temporaryTurns = undefined;
    this.activeMode = undefined;
    this.lastHiddenTurns = 0;
  }

  onAgentSettled(entries: readonly unknown[]): void {
    const recentTurns = this.getEffectiveRecentTurns();
    if (recentTurns === null || this.userTurnCount(entries) <= recentTurns) return;
    this.refresh({ isIdle: () => true });
  }

  onInteractiveMode(mode: RebuildableInteractiveMode): void {
    this.activeMode = mode;
  }

  selectItems<T>(items: readonly T[]): TranscriptSelection<T> {
    const selection = selectTranscriptWindow(
      items,
      this.getEffectiveRecentTurns(),
    );
    this.lastHiddenTurns = selection.hiddenTurns;
    return selection;
  }

  getStatus(): TranscriptWindowStatus {
    return {
      mode: this.viewMode,
      effectiveRecentTurns: this.getEffectiveRecentTurns(),
      hiddenTurns: this.lastHiddenTurns,
    };
  }

  async handleCommand(args: string | undefined, ctx: CommandContext): Promise<void> {
    const [command = "status", value] = (args ?? "")
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);

    if (command === "status") {
      this.notify(ctx, this.statusMessage(), "info");
      return;
    }

    if (!ctx.isIdle()) {
      this.notify(ctx, "转录窗口只能在当前响应完成后切换。", "warning");
      return;
    }

    if (command === "expand") {
      this.viewMode = "expanded";
      this.temporaryTurns = undefined;
      this.refresh(ctx);
      return;
    }

    if (command === "collapse") {
      this.viewMode = "follow-config";
      this.temporaryTurns = undefined;
      this.refresh(ctx);
      return;
    }

    if (command === "turns") {
      const turns = this.parseTurns(value);
      if (turns === undefined) {
        this.notify(
          ctx,
          "用法：/transcript turns <" +
            MIN_RECENT_TURNS +
            "-" +
            MAX_RECENT_TURNS +
            " 的整数>",
          "warning",
        );
        return;
      }

      this.viewMode = "collapsed";
      this.temporaryTurns = turns;
      this.refresh(ctx);
      return;
    }

    this.notify(
      ctx,
      "用法：/transcript [status|expand|collapse|turns <n>]",
      "warning",
    );
  }

  private userTurnCount(entries: readonly unknown[]): number {
    return entries.reduce<number>((count, entry) => {
      if (
        typeof entry !== "object" ||
        entry === null ||
        (entry as { type?: unknown }).type !== "message"
      ) {
        return count;
      }
      const message = (entry as { message?: { role?: unknown } }).message;
      return message?.role === "user" ? count + 1 : count;
    }, 0);
  }

  private getEffectiveRecentTurns(): number | null {
    if (this.viewMode === "expanded") return null;
    if (this.viewMode === "collapsed") {
      return this.temporaryTurns ?? this.config.recentTurns;
    }
    return this.config.enabled ? this.config.recentTurns : null;
  }

  private parseTurns(value: string | undefined): number | undefined {
    if (!value || !/^\d+$/.test(value)) return undefined;
    const turns = Number(value);
    if (
      !Number.isInteger(turns) ||
      turns < MIN_RECENT_TURNS ||
      turns > MAX_RECENT_TURNS
    ) {
      return undefined;
    }
    return turns;
  }

  private refresh(ctx: CommandContext): void {
    const activeMode = this.activeMode;
    try {
      activeMode?.rebuildChatFromMessages?.();
      activeMode?.ui?.requestRender?.();
      this.notify(ctx, this.statusMessage(), "info");
    } catch {
      activeMode?.ui?.requestRender?.();
      this.notify(
        ctx,
        "转录窗口状态已更新；当前 Pi 版本将在下次重建时应用该视图。",
        "warning",
      );
    }
  }

  private statusMessage(): string {
    const status = this.getStatus();
    const view =
      status.effectiveRecentTurns === null
        ? "完整历史"
        : "最近 " + status.effectiveRecentTurns + " 轮";
    return (
      "转录窗口：" +
      view +
      "；当前已折叠 " +
      status.hiddenTurns +
      " 轮。使用 /transcript expand 展开。"
    );
  }

  private notify(
    ctx: CommandContext,
    message: string,
    type: "info" | "warning" | "error",
  ): void {
    ctx.ui?.notify?.(message, type);
  }
}
