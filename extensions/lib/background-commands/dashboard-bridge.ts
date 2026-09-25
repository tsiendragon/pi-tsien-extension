import type { DashboardFeatureAdapter } from "../dashboard-bridge.ts";
import {
  DEFAULT_BACKGROUND_TAIL_LINES,
  type BackgroundCommandManager,
} from "./manager.ts";
import type { BackgroundTaskSnapshot } from "./types.ts";

const MAX_SNAPSHOT_TAIL_CHARS = 512 * 1024;

type Command =
  | { type: "refresh" }
  | { type: "output"; taskId: string; tailLines?: number }
  | { type: "cancel"; taskId: string }
  | { type: "background"; toolCallId: string };

const MAX_TOOL_CALL_ID_LENGTH = 256;

function parseCommand(value: unknown): Command | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (candidate.type === "refresh") return { type: "refresh" };
  if (candidate.type === "background") {
    const toolCallId = candidate.toolCallId;
    if (typeof toolCallId !== "string" || !toolCallId.trim() || toolCallId.length > MAX_TOOL_CALL_ID_LENGTH) return undefined;
    return { type: "background", toolCallId };
  }
  if ((candidate.type === "output" || candidate.type === "cancel") && typeof candidate.taskId === "string") {
    if (candidate.type === "cancel") return { type: "cancel", taskId: candidate.taskId };
    if (candidate.tailLines !== undefined && (!Number.isInteger(candidate.tailLines) || Number(candidate.tailLines) < 1 || Number(candidate.tailLines) > 2_000)) return undefined;
    return {
      type: "output",
      taskId: candidate.taskId,
      ...(candidate.tailLines === undefined ? {} : { tailLines: Number(candidate.tailLines) }),
    };
  }
  return undefined;
}

function publicTask(task: BackgroundTaskSnapshot) {
  const tail = task.outputTail.length > MAX_SNAPSHOT_TAIL_CHARS
    ? task.outputTail.slice(-MAX_SNAPSHOT_TAIL_CHARS)
    : task.outputTail;
  return {
    taskId: task.id,
    owner: task.owner,
    mode: task.mode,
    toolCallId: task.toolCallId,
    title: task.title,
    status: task.state,
    command: task.command,
    cwd: task.cwd,
    pid: task.pid,
    startedAt: task.startedAt,
    endedAt: task.endedAt,
    exitCode: task.exitCode,
    exitSignal: task.exitSignal,
    exitReason: task.exitReason,
    timeoutMs: task.timeoutMs,
    outputBytes: task.outputBytes,
    outputFile: task.outputFile,
    outputTail: tail,
    outputTruncated: task.outputTruncated || tail.length !== task.outputTail.length,
    error: task.error,
    experimentalPlatform: task.experimentalPlatform,
  };
}

export class BackgroundCommandsDashboardAdapter implements DashboardFeatureAdapter {
  readonly feature = "background-commands" as const;
  readonly apiVersion = 1 as const;

  private revision = 0;
  private readonly listeners = new Set<(snapshot: unknown) => void>();
  private readonly unsubscribeManager: () => void;

  constructor(private readonly manager: BackgroundCommandManager) {
    this.unsubscribeManager = manager.subscribe(() => this.emit());
  }

  getSnapshot() {
    return {
      apiVersion: 1,
      revision: this.revision,
      generatedAt: Date.now(),
      tasks: this.listTasks(),
    };
  }

  /** Running foreground commands are listed too so the dashboard can move them to the background. */
  private listTasks() {
    return [...this.manager.list(), ...this.manager.listForeground()]
      .sort((left, right) => left.startedAt - right.startedAt || left.id.localeCompare(right.id))
      .map(publicTask);
  }

  subscribe(listener: (snapshot: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async dispatch(value: unknown): Promise<unknown> {
    const command = parseCommand(value);
    if (!command) throw new Error("invalid_background_command");
    if (command.type === "refresh") {
      this.emit();
      return this.getSnapshot();
    }
    if (command.type === "output") {
      return this.manager.output(command.taskId, command.tailLines ?? DEFAULT_BACKGROUND_TAIL_LINES);
    }
    if (command.type === "background") {
      return publicTask(this.manager.backgroundForeground(command.toolCallId));
    }
    const result = await this.manager.cancel(command.taskId);
    return publicTask(result);
  }

  dispose(): void {
    this.unsubscribeManager();
    this.listeners.clear();
  }

  private emit(): void {
    this.revision += 1;
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) listener(snapshot);
  }
}
