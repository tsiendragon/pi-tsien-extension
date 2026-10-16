import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  Input,
  type Component,
  type Focusable,
  type TUI,
  getKeybindings,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { BtwSessionController, type BtwConversationItem } from "./session.ts";

const PAGE_SIZE = 8;

function keyLabel(key: string): string {
  return key
    .split("+")
    .map((part) => (part === "enter" || part === "return" ? "Enter" : part === "esc" ? "Esc" : part.charAt(0).toUpperCase() + part.slice(1)))
    .join("+");
}

/**
 * The key that sends a question is rebindable (`tui.input.submit`), and users who
 * remap it (enter → newline) found the panel's “Enter 发送” hint plainly wrong.
 */
function submitHint(): string {
  const resolved: unknown = getKeybindings().getResolvedBindings()["tui.input.submit"];
  const keys = (Array.isArray(resolved) ? resolved : [resolved]).filter(
    (key): key is string => typeof key === "string" && key.length > 0,
  );
  const labels = keys.map(keyLabel);
  return labels.length > 0 ? labels.join("/") : "Enter";
}

type PanelCallbacks = {
  close: () => void;
  copyToMain: (text: string) => void;
  /** Copy the raw Markdown of the last answer to the system clipboard. */
  copyAnswer: (text: string) => void;
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

    if (matchesKey(data, "f5")) {
      void this.controller.refreshParentSnapshot();
      return;
    }

    // Claude Code's `/btw` overlay copies the answer as raw Markdown with `c`.
    // This panel also owns a text box, so `c` only means "copy" while the box is
    // empty — otherwise it is a normal keystroke (you cannot type `c` otherwise).
    if (data === "c" && !this.input.getValue().trim()) {
      const answer = this.controller.lastAnswer;
      if (!answer) {
        this.callbacks.notify("BTW 还没有可复制的回答。", "warning");
        return;
      }
      this.callbacks.copyAnswer(answer);
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
        row(` ${this.theme.fg("dim", `↑↓ 翻页 · ${submitHint()} 发送 · ${this.controller.busy ? "Esc 取消" : "Esc 关闭"}`)}`),
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
      ? this.theme.fg("dim", ` · ${this.scrollOffset}/${maxOffset}`)
      : "";
    const contextLine = `只读 · ${this.controller.modelLabel} · 主上下文 ${this.controller.parentMessageCount} 条（每次提问前自动同步）`;

    const lines = [
      border(`╭${"─".repeat(innerWidth)}╮`),
      row(` ${this.theme.fg("accent", this.theme.bold("BTW"))} ${this.theme.fg("dim", "只读侧聊 · 不改动主会话")}`),
      row(` ${this.theme.fg("dim", contextLine)}`),
      row(` ${status}${scroll}`),
      border(`├${"─".repeat(innerWidth)}┤`),
      ...visibleTranscript.map((line) => row(` ${line}`)),
      border(`├${"─".repeat(innerWidth)}┤`),
      ...inputLines,
      row(` ${this.theme.fg("dim", this.footerHints())}`),
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

  /**
   * Only the keys that do something *right now*: the panel is a narrow overlay and
   * a fixed hint line made users hunt for the one key that mattered.
   */
  private footerHints(): string {
    const hints = [
      "↑↓ 翻页",
      `${submitHint()} 发送`,
      this.controller.busy ? "Esc 取消" : "Esc 关闭",
      "F5 同步主上下文",
    ];
    if (this.controller.lastAnswer) hints.push("c 复制回答");
    hints.push("Ctrl+Y 送主输入");
    return hints.join(" · ");
  }

  private renderConversation(width: number): string[] {
    if (this.controller.conversation.length === 0) {
      return wrapTextWithAnsi(
        this.theme.fg(
          "dim",
          `已同步主 Agent 的 ${this.controller.parentMessageCount} 条上下文消息。可以问“刚才那个配置文件叫什么”，也可以让它用 read、grep、find、ls 去查；每次提问前会自动再同步一次。`,
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
