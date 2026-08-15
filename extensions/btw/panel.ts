import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  Input,
  type Component,
  type Focusable,
  type TUI,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { BtwSessionController, type BtwConversationItem } from "./session.ts";

const PAGE_SIZE = 8;

type PanelCallbacks = {
  close: () => void;
  copyToMain: (text: string) => void;
  notify: (message: string, level: "info" | "warning" | "error") => void;
};

export class BtwPanel implements Component, Focusable {
  private readonly input = new Input();
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly controller: BtwSessionController;
  private readonly callbacks: PanelCallbacks;
  private scrollOffset = 0;
  private disposed = false;
  private _focused = false;

  constructor(
    tui: TUI,
    theme: Theme,
    controller: BtwSessionController,
    callbacks: PanelCallbacks,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.controller = controller;
    this.callbacks = callbacks;

    this.input.onSubmit = (value) => {
      if (this.controller.busy) {
        this.callbacks.notify("BTW 正在生成；按 Esc 可取消当前回答。", "warning");
        return;
      }
      const prompt = value.trim();
      if (!prompt) return;
      this.input.setValue("");
      this.scrollOffset = 0;
      void this.controller.submit(prompt);
      this.tui.requestRender();
    };

    this.controller.onChange = () => {
      if (this.scrollOffset === 0) this.scrollOffset = 0;
      this.tui.requestRender();
    };
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.input.focused = value;
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape")) {
      if (this.controller.busy) {
        void this.controller.abort();
      } else {
        this.callbacks.close();
      }
      return;
    }

    if (matchesKey(data, "up")) {
      this.scrollOffset += 1;
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, "down")) {
      this.scrollOffset = Math.max(0, this.scrollOffset - 1);
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, "ctrl+up")) {
      this.scrollOffset += PAGE_SIZE;
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, "ctrl+down")) {
      this.scrollOffset = Math.max(0, this.scrollOffset - PAGE_SIZE);
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, "pageUp")) {
      this.scrollOffset += PAGE_SIZE;
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, "pageDown")) {
      this.scrollOffset = Math.max(0, this.scrollOffset - PAGE_SIZE);
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, "ctrl+r")) {
      void this.controller.refreshParentSnapshot();
      return;
    }

    if (matchesKey(data, "ctrl+y")) {
      const answer = this.controller.lastAnswer;
      if (!answer) {
        this.callbacks.notify("BTW 还没有可复制的回答。", "warning");
        return;
      }
      this.callbacks.copyToMain(answer);
      return;
    }

    this.input.handleInput(data);
    this.tui.requestRender();
  }

  render(width: number): string[] {
    const panelWidth = Math.max(1, width);
    const innerWidth = Math.max(1, panelWidth - 2);
    const contentWidth = Math.max(1, innerWidth - 2);
    const terminalRows = Math.max(3, this.tui.terminal.rows);
    const maxPanelRows = Math.max(
      3,
      Math.min(Math.floor(terminalRows * 0.84), terminalRows - 2),
    );
    const border = (text: string) => this.theme.fg("border", truncateToWidth(text, panelWidth, ""));
    const row = (content: string) => {
      const clipped = truncateToWidth(content, innerWidth, "");
      const padding = " ".repeat(Math.max(0, innerWidth - visibleWidth(clipped)));
      return truncateToWidth(`${border("│")}${clipped}${padding}${border("│")}`, panelWidth, "");
    };
    const inputLines = this.input.render(contentWidth).map((line) => row(` ${line}`));

    if (maxPanelRows < 10) {
      const compact = [
        row(` ${this.theme.fg("accent", this.theme.bold("BTW · read-only"))}`),
        ...inputLines,
        row(` ${this.theme.fg("dim", "Enter 发送 · Esc 取消/关闭")}`),
      ];
      return compact.slice(0, maxPanelRows);
    }

    const fixedRows = 9;
    const transcriptRows = Math.max(1, maxPanelRows - fixedRows);
    const transcript = this.renderConversation(contentWidth);
    const maxOffset = Math.max(0, transcript.length - transcriptRows);
    this.scrollOffset = Math.min(this.scrollOffset, maxOffset);

    const end = Math.max(0, transcript.length - this.scrollOffset);
    const start = Math.max(0, end - transcriptRows);
    const visibleTranscript = transcript.slice(start, end);
    while (visibleTranscript.length < transcriptRows) visibleTranscript.unshift("");

    const status = this.controller.busy
      ? this.theme.fg("warning", `● ${this.controller.activity || "生成中"}`)
      : this.theme.fg("success", "● 空闲");
    const scroll = maxOffset > 0
      ? this.theme.fg("dim", ` · ↑↓ 单行 · Fn+↑↓/Ctrl+↑↓ 翻页 ${this.scrollOffset}/${maxOffset}`)
      : "";

    const lines = [
      border(`╭${"─".repeat(innerWidth)}╮`),
      row(` ${this.theme.fg("accent", this.theme.bold("BTW"))} ${this.theme.fg("dim", "read-only side chat")}`),
      row(` ${this.theme.fg("dim", this.controller.modelLabel)}`),
      row(` ${status}${scroll}`),
      border(`├${"─".repeat(innerWidth)}┤`),
      ...visibleTranscript.map((line) => row(` ${line}`)),
      border(`├${"─".repeat(innerWidth)}┤`),
      ...inputLines,
      row(` ${this.theme.fg("dim", "↑↓ 单行 · Fn+↑↓/Ctrl+↑↓ 翻页 · Enter 发送 · Esc 取消/关闭 · Ctrl+R 刷新 · Ctrl+Y 复制")}`),
      border(`╰${"─".repeat(innerWidth)}╯`),
    ];
    return lines.slice(0, maxPanelRows);
  }

  invalidate(): void {
    this.input.invalidate();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.controller.onChange = undefined;
  }

  private renderConversation(width: number): string[] {
    if (this.controller.conversation.length === 0) {
      return wrapTextWithAnsi(
        this.theme.fg(
          "dim",
          `已读取主 Agent 的 ${this.controller.parentMessageCount} 条上下文消息。可以询问临时问题，或让 BTW 使用 read、grep、find、ls 调查文件。`,
        ),
        width,
      );
    }

    const lines: string[] = [];
    for (const item of this.controller.conversation) {
      if (lines.length > 0) lines.push("");
      lines.push(this.renderRole(item));
      const text = item.text || (item.role === "assistant" ? "…" : "");
      for (const rawLine of text.split("\n")) {
        const wrapped = wrapTextWithAnsi(rawLine || " ", width);
        lines.push(...wrapped);
      }
    }
    return lines;
  }

  private renderRole(item: BtwConversationItem): string {
    if (item.role === "user") return this.theme.fg("accent", this.theme.bold("你"));
    if (item.role === "assistant") return this.theme.fg("success", this.theme.bold("BTW"));
    return this.theme.fg("warning", this.theme.bold("提示"));
  }
}
