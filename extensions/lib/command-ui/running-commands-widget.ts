import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
  type Component,
  type TUI,
} from "@earendil-works/pi-tui";

import type { RunningCommand, RunningCommandRegistry } from "./command-registry.ts";
import type { CommandFocusController } from "./focus-controller.ts";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MAX_VISIBLE_COMMANDS = 4;

export interface RunningCommandsWidgetOptions {
  registry: RunningCommandRegistry;
  focus: CommandFocusController;
  getEditorText: () => string;
  now?: () => number;
}

export function formatCommandStartTime(timestamp: number): string {
  const date = new Date(timestamp);
  const hours = date.getHours();
  const hour12 = hours % 12 || 12;
  const suffix = hours >= 12 ? "pm" : "am";
  return `${MONTHS[date.getMonth()]} ${String(hour12).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}:${String(date.getSeconds()).padStart(2, "0")}${suffix}`;
}

export function formatElapsedDuration(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m${String(totalSeconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(totalMinutes / 60)}h${String(totalMinutes % 60).padStart(2, "0")}m`;
}

export function sanitizeOutputLines(output: string): string[] {
  const safe = stripTerminalSequences(output)
    .replace(/\r\n?/gu, "\n")
    .replace(/\t/gu, "    ")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "");
  if (!safe) return ["（暂无输出）"];
  const lines = safe.split("\n");
  if (lines.length > 1 && lines.at(-1) === "") lines.pop();
  return lines.length > 0 ? lines : ["（暂无输出）"];
}

function alignedLine(left: string, right: string, width: number): string {
  if (width <= 0) return "";
  const fittedRight = truncateToWidth(right, width, "…");
  const rightWidth = visibleWidth(fittedRight);
  if (rightWidth >= width) return fittedRight;

  const leftLimit = Math.max(0, width - rightWidth - 1);
  const fittedLeft = truncateToWidth(left, leftLimit, "…");
  const gap = Math.max(1, width - visibleWidth(fittedLeft) - rightWidth);
  return `${fittedLeft}${" ".repeat(gap)}${fittedRight}`;
}

function commandLabel(command: RunningCommand): string {
  return command.title ?? command.command;
}

function commandWindowStart(commands: readonly RunningCommand[], selectedId: string | undefined): number {
  if (commands.length <= MAX_VISIBLE_COMMANDS || !selectedId) return 0;
  const selectedIndex = commands.findIndex((command) => command.id === selectedId);
  if (selectedIndex < 0) return 0;
  return Math.max(0, Math.min(selectedIndex - MAX_VISIBLE_COMMANDS + 1, commands.length - MAX_VISIBLE_COMMANDS));
}

function labeledBorder(left: string, label: string, right: string, width: number): string {
  if (width <= 0) return "";
  if (width < 4) return truncateToWidth(`${left}${right}`, width, "");
  const innerWidth = width - visibleWidth(left) - visibleWidth(right);
  const prefix = `─ ${label} `;
  const content = truncateToWidth(prefix, innerWidth, "…");
  return `${left}${content}${"─".repeat(Math.max(0, innerWidth - visibleWidth(content)))}${right}`;
}

export class RunningCommandsWidget implements Component {
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly options: RunningCommandsWidgetOptions;
  private readonly now: () => number;

  constructor(tui: TUI, theme: Theme, options: RunningCommandsWidgetOptions) {
    this.tui = tui;
    this.theme = theme;
    this.options = options;
    this.now = options.now ?? Date.now;
  }

  invalidate(): void {}

  render(width: number): string[] {
    if (width <= 0) return [];
    const commands = this.options.registry.snapshot();
    this.options.focus.reconcile(commands);
    if (commands.length === 0) return [];

    if (this.options.focus.focusMode === "command-output") {
      return this.renderOutput(commands, width);
    }
    return this.renderCommandList(commands, width);
  }

  private renderCommandList(commands: readonly RunningCommand[], width: number): string[] {
    const focus = this.options.focus.focusMode;
    const selectedId = this.options.focus.selectedTaskId;
    const editorHasText = this.options.getEditorText().length > 0;
    const foregroundCount = commands.filter((command) => command.mode === "foreground").length;
    const backgroundCount = commands.length - foregroundCount;
    const interruptHint = foregroundCount > 0 ? " · Esc 中断" : "";
    const hint = focus === "command-list"
      ? "↑↓ 选择 · Enter 输出 · Esc 输入框"
      : editorHasText
        ? `Enter 排队${interruptHint}`
        : `↑ 选择${interruptHint}`;

    if (commands.length === 1) {
      const command = commands[0]!;
      const marker = focus === "command-list" ? "› " : "";
      const elapsed = formatElapsedDuration(this.now() - command.startedAt);
      const label = commandLabel(command);
      const body = command.mode === "background"
        ? `${marker}◷ Background · ${formatCommandStartTime(command.startedAt)}: ${command.taskId} · ${label} (${elapsed})`
        : `${marker}⠋ Bash · ${formatCommandStartTime(command.startedAt)}: ${label} (${elapsed})`;
      return [alignedLine(this.theme.fg("accent", body), this.theme.fg("muted", hint), width)];
    }

    const summary = foregroundCount > 0 && backgroundCount > 0
      ? `⠋ ${foregroundCount} 个前台 · ${backgroundCount} 个后台任务`
      : foregroundCount > 0
        ? `⠋ ${foregroundCount} 个前台命令运行中`
        : `◷ ${backgroundCount} 个后台任务运行中`;
    const header = alignedLine(
      this.theme.fg("accent", summary),
      this.theme.fg("muted", hint),
      width,
    );
    const start = commandWindowStart(commands, selectedId);
    const visibleCommands = commands.slice(start, start + MAX_VISIBLE_COMMANDS);
    const rows = visibleCommands.map((command) => {
      const marker = focus === "command-list" && command.id === selectedId ? "  ›" : "   ";
      const elapsed = formatElapsedDuration(this.now() - command.startedAt);
      const identity = command.mode === "background"
        ? `Background · ${command.taskId}`
        : "Foreground";
      const icon = command.mode === "background" ? "◷" : "⠋";
      const body = `${marker} ${icon} ${formatCommandStartTime(command.startedAt)}: ${identity} · ${commandLabel(command)} (${elapsed})`;
      const color = command.id === selectedId ? "accent" : "muted";
      return truncateToWidth(this.theme.fg(color, body), width, "…");
    });
    return [header, ...rows];
  }

  private renderOutput(commands: readonly RunningCommand[], width: number): string[] {
    const selectedId = this.options.focus.selectedTaskId;
    const selectedIndex = commands.findIndex((command) => command.id === selectedId);
    const commandIndex = selectedIndex >= 0 ? selectedIndex : 0;
    const command = commands[commandIndex];
    if (!command) return [];

    const outputIdentity = command.mode === "background"
      ? `◷ Output ${commandIndex + 1}/${commands.length} · ${command.taskId} · ${commandLabel(command)}`
      : `⠋ Output ${commandIndex + 1}/${commands.length} · ${commandLabel(command)}`;
    const header = alignedLine(
      this.theme.fg(
        "accent",
        `${outputIdentity} · running (${formatElapsedDuration(this.now() - command.startedAt)})`,
      ),
      this.theme.fg("muted", "←→ 切换 · Esc 返回"),
      width,
    );

    const outputLines = sanitizeOutputLines(command.outputTail);
    const maxPanelHeight = Math.max(4, Math.floor(this.tui.terminal.rows * 0.4));
    const pageSize = Math.max(1, maxPanelHeight - 3);
    this.options.focus.setOutputMetrics(command.id, outputLines.length, pageSize);
    const viewport = this.options.focus.getOutputViewport(command.id);
    const visibleOutput = outputLines.slice(viewport.scrollTop, viewport.scrollTop + viewport.pageSize);

    if (width < 12) {
      return [header, ...visibleOutput.map((line) => truncateToWidth(line, width, "…"))];
    }

    const contentWidth = Math.max(1, width - 4);
    const content = visibleOutput.map((line) => {
      const value = truncateToWidth(this.theme.fg("toolOutput", line), contentWidth, "…", true);
      return `${this.theme.fg("border", "│ ")}${value}${this.theme.fg("border", " │")}`;
    });

    const stateLabel = viewport.following
      ? "Live · ↑↓ 滚动 · PageUp/PageDown 翻页 · End 跟随最新"
      : `Paused${viewport.newLines > 0 ? ` · +${viewport.newLines} 新行` : ""} · End 跟随最新`;
    const truncationLabel = command.outputTruncated ? " · 50KB tail" : "";
    return [
      header,
      this.theme.fg("border", labeledBorder("┌", "Recent output", "┐", width)),
      ...content,
      this.theme.fg("border", labeledBorder("└", `${stateLabel}${truncationLabel}`, "┘", width)),
    ];
  }
}
