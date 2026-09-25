import type { RunningCommand } from "./command-registry.ts";

export type CommandFocusMode = "editor" | "command-list" | "command-output";

interface OutputScrollState {
  scrollTop: number;
  totalLines: number;
  pageSize: number;
  following: boolean;
  pausedAtLines: number;
}

export interface OutputViewport {
  readonly scrollTop: number;
  readonly pageSize: number;
  readonly following: boolean;
  readonly newLines: number;
}

function createOutputState(): OutputScrollState {
  return {
    scrollTop: 0,
    totalLines: 1,
    pageSize: 1,
    following: true,
    pausedAtLines: 1,
  };
}

export class CommandFocusController {
  private mode: CommandFocusMode = "editor";
  private selectedId: string | undefined;
  private selectedIndex = 0;
  private readonly outputStates = new Map<string, OutputScrollState>();

  get focusMode(): CommandFocusMode {
    return this.mode;
  }

  get selectedTaskId(): string | undefined {
    return this.selectedId;
  }

  enterList(commands: readonly RunningCommand[]): boolean {
    if (commands.length === 0) return false;
    this.mode = "command-list";
    this.select(commands, commands.length - 1);
    return true;
  }

  moveList(direction: -1 | 1, commands: readonly RunningCommand[]): void {
    this.reconcile(commands);
    if (commands.length === 0 || this.mode !== "command-list") return;

    const index = this.indexOfSelected(commands);
    if (direction > 0 && index >= commands.length - 1) {
      this.returnToEditor();
      return;
    }
    this.select(commands, Math.max(0, Math.min(commands.length - 1, index + direction)));
  }

  openOutput(commands: readonly RunningCommand[]): void {
    this.reconcile(commands);
    if (commands.length === 0 || !this.selectedId) return;
    this.mode = "command-output";
    this.outputStates.set(this.selectedId, this.outputStates.get(this.selectedId) ?? createOutputState());
  }

  switchOutput(direction: -1 | 1, commands: readonly RunningCommand[]): void {
    this.reconcile(commands);
    if (commands.length === 0 || this.mode !== "command-output") return;
    const index = this.indexOfSelected(commands);
    this.select(commands, Math.max(0, Math.min(commands.length - 1, index + direction)));
    if (this.selectedId) {
      this.outputStates.set(this.selectedId, this.outputStates.get(this.selectedId) ?? createOutputState());
    }
  }

  returnToList(): void {
    if (this.selectedId) this.mode = "command-list";
    else this.mode = "editor";
  }

  returnToEditor(): void {
    this.mode = "editor";
    this.selectedId = undefined;
    this.selectedIndex = 0;
  }

  reconcile(commands: readonly RunningCommand[]): void {
    const liveIds = new Set(commands.map((command) => command.id));
    for (const taskId of this.outputStates.keys()) {
      if (!liveIds.has(taskId)) this.outputStates.delete(taskId);
    }

    if (commands.length === 0) {
      this.returnToEditor();
      return;
    }
    if (this.mode === "editor") return;

    const selectedIndex = this.selectedId
      ? commands.findIndex((command) => command.id === this.selectedId)
      : -1;
    if (selectedIndex >= 0) {
      this.selectedIndex = selectedIndex;
      return;
    }

    this.select(commands, Math.min(this.selectedIndex, commands.length - 1));
    if (this.mode === "command-output" && this.selectedId) {
      this.outputStates.set(this.selectedId, this.outputStates.get(this.selectedId) ?? createOutputState());
    }
  }

  setOutputMetrics(taskId: string, totalLines: number, pageSize: number): void {
    const state = this.outputStates.get(taskId) ?? createOutputState();
    state.totalLines = Math.max(1, totalLines);
    state.pageSize = Math.max(1, pageSize);
    const maxScroll = Math.max(0, state.totalLines - state.pageSize);
    state.scrollTop = state.following ? maxScroll : Math.min(state.scrollTop, maxScroll);
    if (state.following) state.pausedAtLines = state.totalLines;
    this.outputStates.set(taskId, state);
  }

  scrollOutput(delta: number): void {
    if (this.mode !== "command-output" || !this.selectedId || delta === 0) return;
    const state = this.outputStates.get(this.selectedId) ?? createOutputState();
    const maxScroll = Math.max(0, state.totalLines - state.pageSize);

    if (delta < 0 && state.following) {
      state.following = false;
      state.pausedAtLines = state.totalLines;
      state.scrollTop = maxScroll;
    }

    state.scrollTop = Math.max(0, Math.min(maxScroll, state.scrollTop + delta));
    if (delta > 0 && state.scrollTop >= maxScroll) {
      state.following = true;
      state.pausedAtLines = state.totalLines;
    }
    this.outputStates.set(this.selectedId, state);
  }

  followLatest(): void {
    if (this.mode !== "command-output" || !this.selectedId) return;
    const state = this.outputStates.get(this.selectedId) ?? createOutputState();
    state.following = true;
    state.scrollTop = Math.max(0, state.totalLines - state.pageSize);
    state.pausedAtLines = state.totalLines;
    this.outputStates.set(this.selectedId, state);
  }

  getOutputViewport(taskId: string): OutputViewport {
    const state = this.outputStates.get(taskId) ?? createOutputState();
    return {
      scrollTop: state.scrollTop,
      pageSize: state.pageSize,
      following: state.following,
      newLines: state.following ? 0 : Math.max(0, state.totalLines - state.pausedAtLines),
    };
  }

  reset(): void {
    this.returnToEditor();
    this.outputStates.clear();
  }

  private select(commands: readonly RunningCommand[], index: number): void {
    const selected = commands[index];
    if (!selected) return;
    this.selectedId = selected.id;
    this.selectedIndex = index;
  }

  private indexOfSelected(commands: readonly RunningCommand[]): number {
    if (!this.selectedId) return Math.min(this.selectedIndex, commands.length - 1);
    const index = commands.findIndex((command) => command.id === this.selectedId);
    return index >= 0 ? index : Math.min(this.selectedIndex, commands.length - 1);
  }
}
