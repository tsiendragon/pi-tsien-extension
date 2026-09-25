import { CustomEditor, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, type EditorTheme, type TUI } from "@earendil-works/pi-tui";

import type { RunningCommandRegistry } from "./command-registry.ts";
import type { CommandFocusController } from "./focus-controller.ts";

export interface CommandAwareEditorOptions {
  registry: RunningCommandRegistry;
  focus: CommandFocusController;
  requestRender: () => void;
  backgroundForeground?: (toolCallId: string) => void;
}

export class CommandAwareEditor extends CustomEditor {
  private readonly registry: RunningCommandRegistry;
  private readonly commandFocus: CommandFocusController;
  private readonly requestCommandRender: () => void;
  private readonly backgroundForeground: ((toolCallId: string) => void) | undefined;
  private commandHistoryBrowsing = false;

  constructor(
    tui: TUI,
    theme: EditorTheme,
    keybindings: KeybindingsManager,
    options: CommandAwareEditorOptions,
  ) {
    super(tui, theme, keybindings);
    this.registry = options.registry;
    this.commandFocus = options.focus;
    this.requestCommandRender = options.requestRender;
    this.backgroundForeground = options.backgroundForeground;
  }

  override handleInput(data: string): void {
    const commands = this.registry.snapshot();
    this.commandFocus.reconcile(commands);

    if (this.handleBackgroundShortcut(data, commands)) return;

    if (this.commandFocus.focusMode === "editor") {
      const canBrowseCommandHistory = commands.length > 0 && (
        this.getText().length === 0 || this.commandHistoryBrowsing
      );
      if (canBrowseCommandHistory && matchesKey(data, Key.ctrl("up"))) {
        this.commandHistoryBrowsing = true;
        super.handleInput("\x1b[A");
        return;
      }
      if (canBrowseCommandHistory && matchesKey(data, Key.ctrl("down"))) {
        this.commandHistoryBrowsing = true;
        super.handleInput("\x1b[B");
        return;
      }

      this.commandHistoryBrowsing = false;
      if (this.getText().length === 0 && commands.length > 0 && matchesKey(data, Key.up)) {
        this.commandFocus.enterList(commands);
        this.requestCommandRender();
        return;
      }
      super.handleInput(data);
      return;
    }

    this.commandHistoryBrowsing = false;

    if (this.commandFocus.focusMode === "command-list") {
      if (matchesKey(data, Key.up)) {
        this.commandFocus.moveList(-1, commands);
        this.requestCommandRender();
        return;
      }
      if (matchesKey(data, Key.down)) {
        this.commandFocus.moveList(1, commands);
        this.requestCommandRender();
        return;
      }
      if (matchesKey(data, Key.enter)) {
        this.commandFocus.openOutput(commands);
        this.requestCommandRender();
        return;
      }
      if (matchesKey(data, Key.escape)) {
        this.commandFocus.returnToEditor();
        this.requestCommandRender();
        return;
      }
      return;
    }

    if (matchesKey(data, Key.up)) {
      this.commandFocus.scrollOutput(-1);
    } else if (matchesKey(data, Key.down)) {
      this.commandFocus.scrollOutput(1);
    } else if (matchesKey(data, Key.pageUp)) {
      const selected = this.commandFocus.selectedTaskId;
      const pageSize = selected ? this.commandFocus.getOutputViewport(selected).pageSize : 1;
      this.commandFocus.scrollOutput(-pageSize);
    } else if (matchesKey(data, Key.pageDown)) {
      const selected = this.commandFocus.selectedTaskId;
      const pageSize = selected ? this.commandFocus.getOutputViewport(selected).pageSize : 1;
      this.commandFocus.scrollOutput(pageSize);
    } else if (matchesKey(data, Key.left)) {
      this.commandFocus.switchOutput(-1, commands);
    } else if (matchesKey(data, Key.right)) {
      this.commandFocus.switchOutput(1, commands);
    } else if (matchesKey(data, Key.end)) {
      this.commandFocus.followLatest();
    } else if (matchesKey(data, Key.escape)) {
      this.commandFocus.returnToList();
    } else {
      return;
    }
    this.requestCommandRender();
  }

  private handleBackgroundShortcut(data: string, commands: ReturnType<RunningCommandRegistry["snapshot"]>): boolean {
    if (!this.backgroundForeground || !matchesKey(data, Key.ctrl("b"))) return false;
    const foregroundCommands = commands.filter((command) => command.mode === "foreground" && command.toolCallId);
    if (foregroundCommands.length === 0) return false;

    if (this.commandFocus.focusMode === "editor") {
      if (foregroundCommands.length > 1) {
        this.commandFocus.enterList(foregroundCommands);
        this.requestCommandRender();
        return true;
      }
      this.backgroundForeground(foregroundCommands[0]!.toolCallId!);
      return true;
    }

    const selected = commands.find((command) => command.id === this.commandFocus.selectedTaskId);
    if (selected?.mode === "foreground" && selected.toolCallId) {
      this.backgroundForeground(selected.toolCallId);
    }
    return true;
  }
}
