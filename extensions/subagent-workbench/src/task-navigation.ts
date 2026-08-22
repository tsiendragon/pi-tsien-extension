import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  truncateToWidth,
  type Component,
} from "@earendil-works/pi-tui";
import type {
  ConversationRecord,
  SubagentWorkbenchRuntime,
  WorkflowRecord,
  WorkbenchSnapshot,
} from "./runtime.ts";

export const TASK_NAVIGATION_WIDGET_KEY = "subagent-workbench-navigation";

export type TaskNavigationTarget =
  | { readonly kind: "main"; readonly id: "main"; readonly label: "Main" }
  | {
      readonly kind: "agent";
      readonly id: string;
      readonly label: string;
      readonly conversation: ConversationRecord;
    }
  | {
      readonly kind: "workflow";
      readonly id: string;
      readonly label: string;
      readonly workflow: WorkflowRecord;
    };

export interface TaskNavigationHandle {
  dispose(): void;
  blur(): void;
  suspend(): void;
  resume(): void;
}

export interface TaskNavigationOptions {
  readonly onOpen: (target: TaskNavigationTarget) => Promise<void> | void;
}

function conversationSymbol(conversation: ConversationRecord): string {
  switch (conversation.status) {
    case "running":
      return "●";
    case "completed":
    case "idle":
      return "✓";
    case "failed":
      return "!";
    case "interrupted":
      return "‖";
    case "cancelled":
      return "×";
    default:
      return "○";
  }
}

function workflowSymbol(workflow: WorkflowRecord): string {
  switch (workflow.status) {
    case "running":
      return "◆";
    case "paused":
      return "Ⅱ";
    case "completed":
      return "✓";
    case "failed":
      return "!";
    case "cancelled":
      return "×";
    default:
      return "◇";
  }
}

function isTerminalStatus(status: string): boolean {
  return !["queued", "running", "paused"].includes(status);
}

function cleanLabel(label: string): string {
  return label.replace(/\s+/g, " ").trim() || "Untitled";
}

function workflowProgress(workflow: WorkflowRecord): string {
  const tasks = (workflow.stages ?? []).flatMap((stage) => stage.tasks);
  if (tasks.length === 0) return "";
  const completed = tasks.filter((task) => task.status === "completed").length;
  return ` ${completed}/${tasks.length}`;
}

function statusColor(
  status: string,
): "success" | "warning" | "error" | "muted" | "accent" {
  if (status === "running") return "success";
  if (status === "paused") return "warning";
  if (status === "failed") return "error";
  if (status === "interrupted" || status === "cancelled") return "warning";
  if (status === "queued") return "muted";
  return "accent";
}

class TaskNavigationComponent implements Component {
  constructor(private readonly controller: TaskNavigationController) {}

  render(width: number): string[] {
    return this.controller.render(width);
  }

  invalidate(): void {}
}

class TaskNavigationController implements TaskNavigationHandle {
  private snapshot: WorkbenchSnapshot;
  private readonly dismissed = new Set<string>();
  private selectedId = "main";
  private focused = false;
  private opening = false;
  private suspended = false;
  private requestRender: (() => void) | undefined;
  private theme: Theme | undefined;
  private unsubscribeRuntime: (() => void) | undefined;
  private unsubscribeInput: (() => void) | undefined;
  private disposed = false;

  constructor(
    private readonly ctx: ExtensionContext,
    private readonly runtime: SubagentWorkbenchRuntime,
    private readonly options: TaskNavigationOptions,
  ) {
    this.snapshot = runtime.getSnapshot();
  }

  install(): this {
    this.ctx.ui.setWidget(
      TASK_NAVIGATION_WIDGET_KEY,
      (tui, theme) => {
        this.requestRender = () => tui.requestRender();
        this.theme = theme;
        return new TaskNavigationComponent(this);
      },
      { placement: "aboveStatus" } as never,
    );
    this.unsubscribeRuntime = this.runtime.subscribe((snapshot) => {
      if (this.disposed) return;
      this.snapshot = snapshot;
      this.reconcileSelection();
      this.requestRender?.();
    });
    this.unsubscribeInput = this.ctx.ui.onTerminalInput((data) =>
      this.handleTerminalInput(data),
    );
    return this;
  }

  blur(): void {
    if (!this.focused) return;
    this.focused = false;
    this.requestRender?.();
  }

  suspend(): void {
    if (this.disposed || this.suspended) return;
    this.suspended = true;
    this.focused = false;
    this.requestRender?.();
  }

  resume(): void {
    if (this.disposed || !this.suspended) return;
    this.suspended = false;
    this.requestRender?.();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribeInput?.();
    this.unsubscribeInput = undefined;
    this.unsubscribeRuntime?.();
    this.unsubscribeRuntime = undefined;
    this.ctx.ui.setWidget(TASK_NAVIGATION_WIDGET_KEY, undefined);
    this.requestRender = undefined;
    this.theme = undefined;
  }

  render(width: number): string[] {
    if (width <= 0) return [];
    const targets = this.targets();
    if (targets.length <= 1) return [];
    this.reconcileSelection(targets);
    const theme = this.theme;
    if (!theme) return [];

    const workTargets = targets.slice(1);
    const selectedWorkIndex = Math.max(
      0,
      workTargets.findIndex((target) => target.id === this.selectedId),
    );
    const visibleCount = Math.max(1, Math.floor((width - 12) / 28));
    const start =
      this.selectedId === "main"
        ? 0
        : Math.max(
            0,
            Math.min(
              selectedWorkIndex - Math.floor(visibleCount / 2),
              Math.max(0, workTargets.length - visibleCount),
            ),
          );
    const visible = workTargets.slice(start, start + visibleCount);
    const pieces: string[] = [];
    pieces.push(this.styleTarget(targets[0]!, "=> Main"));
    if (start > 0) pieces.push(theme.fg("dim", "‹"));
    for (const target of visible) {
      if (target.kind === "agent") {
        const symbol = theme.fg(
          statusColor(target.conversation.status),
          conversationSymbol(target.conversation),
        );
        pieces.push(
          this.styleTarget(
            target,
            `${symbol} ${truncateToWidth(cleanLabel(target.label), 22, "…")}`,
          ),
        );
      } else if (target.kind === "workflow") {
        const symbol = theme.fg(
          statusColor(target.workflow.status),
          workflowSymbol(target.workflow),
        );
        pieces.push(
          this.styleTarget(
            target,
            `${symbol} ${truncateToWidth(cleanLabel(target.label), 18, "…")}${workflowProgress(target.workflow)}`,
          ),
        );
      }
    }
    if (start + visible.length < workTargets.length) {
      pieces.push(theme.fg("dim", "›"));
    }
    return [truncateToWidth(pieces.join("   "), width, "")];
  }

  private styleTarget(target: TaskNavigationTarget, text: string): string {
    const theme = this.theme!;
    if (!this.focused || target.id !== this.selectedId) return text;
    return theme.bg("selectedBg", theme.fg("accent", `▸ ${text}`));
  }

  private targets(): TaskNavigationTarget[] {
    const conversations = this.snapshot.conversations.items
      .filter((conversation) => !conversation.workflowId)
      .filter(
        (conversation) =>
          !this.dismissed.has(conversation.id) ||
          !isTerminalStatus(conversation.status),
      )
      .map((conversation): TaskNavigationTarget => ({
        kind: "agent",
        id: conversation.id,
        label: conversation.label,
        conversation,
      }));
    const workflows = this.snapshot.workflows.items
      .filter(
        (workflow) =>
          !this.dismissed.has(workflow.id) ||
          !isTerminalStatus(workflow.status),
      )
      .map((workflow): TaskNavigationTarget => ({
        kind: "workflow",
        id: workflow.id,
        label: workflow.label,
        workflow,
      }));
    return [
      { kind: "main", id: "main", label: "Main" },
      ...conversations,
      ...workflows,
    ];
  }

  private reconcileSelection(targets = this.targets()): void {
    if (!targets.some((target) => target.id === this.selectedId)) {
      this.selectedId = "main";
    }
    if (targets.length <= 1) this.focused = false;
  }

  private handleTerminalInput(
    data: string,
  ): { consume?: boolean; data?: string } | undefined {
    if (this.disposed || this.opening || this.suspended) return undefined;
    const targets = this.targets();
    if (matchesKey(data, "f6")) {
      if (targets.length <= 1) return undefined;
      this.focused = !this.focused;
      this.requestRender?.();
      return { consume: true };
    }
    const isHorizontalArrow =
      matchesKey(data, "left") || matchesKey(data, "right");
    const isArrow =
      isHorizontalArrow || matchesKey(data, "up") || matchesKey(data, "down");
    if (
      !this.focused &&
      isHorizontalArrow &&
      targets.length > 1 &&
      this.ctx.ui.getEditorText() === ""
    ) {
      this.focused = true;
    } else if (!this.focused) {
      return undefined;
    }
    if (matchesKey(data, "escape")) {
      this.blur();
      return { consume: true };
    }
    if (isArrow) {
      const delta = matchesKey(data, "left") || matchesKey(data, "up") ? -1 : 1;
      const current = Math.max(
        0,
        targets.findIndex((target) => target.id === this.selectedId),
      );
      const next = (current + delta + targets.length) % targets.length;
      this.selectedId = targets[next]!.id;
      this.requestRender?.();
      return { consume: true };
    }
    if (matchesKey(data, "enter")) {
      const target =
        targets.find((candidate) => candidate.id === this.selectedId) ??
        targets[0]!;
      if (target.kind === "main") {
        this.blur();
      } else if (!this.opening) {
        this.opening = true;
        this.focused = false;
        if (
          (target.kind === "agent" &&
            isTerminalStatus(target.conversation.status)) ||
          (target.kind === "workflow" &&
            isTerminalStatus(target.workflow.status))
        ) {
          this.dismissed.add(target.id);
        }
        this.requestRender?.();
        void Promise.resolve(this.options.onOpen(target))
          .catch((error: unknown) => {
            this.ctx.ui.notify(
              `Unable to open ${target.label}: ${error instanceof Error ? error.message : String(error)}`,
              "error",
            );
          })
          .finally(() => {
            this.opening = false;
            this.requestRender?.();
          });
      }
      return { consume: true };
    }
    if (data.toLowerCase() === "i") {
      const target = targets.find(
        (candidate) => candidate.id === this.selectedId,
      );
      if (target?.kind === "agent") {
        void this.runtime.dispatch({
          type: "interrupt-agent",
          sessionId: target.id,
        });
      } else if (target?.kind === "workflow") {
        void this.runtime.dispatch({
          type: "interrupt-workflow",
          workflowId: target.id,
        });
      }
      return { consume: true };
    }
    if (data.toLowerCase() === "x") {
      const target = targets.find(
        (candidate) => candidate.id === this.selectedId,
      );
      if (
        target?.kind === "agent" &&
        isTerminalStatus(target.conversation.status)
      ) {
        this.dismissed.add(target.id);
        this.selectedId = "main";
        this.requestRender?.();
      } else if (
        target?.kind === "workflow" &&
        isTerminalStatus(target.workflow.status)
      ) {
        this.dismissed.add(target.id);
        this.selectedId = "main";
        this.requestRender?.();
      }
      return { consume: true };
    }
    if (data === "?") {
      this.ctx.ui.notify(
        "Empty editor: ←/→ select · ↑/↓ history · Enter open · F6 focus · Esc return to editor",
        "info",
      );
      return { consume: true };
    }
    return { consume: true };
  }
}

export function installTaskNavigation(
  ctx: ExtensionContext,
  runtime: SubagentWorkbenchRuntime,
  options: TaskNavigationOptions,
): TaskNavigationHandle {
  return new TaskNavigationController(ctx, runtime, options).install();
}
