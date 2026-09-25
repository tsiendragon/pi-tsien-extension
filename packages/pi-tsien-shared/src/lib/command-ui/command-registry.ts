import { stripTerminalSequences } from "@earendil-works/pi-tui";

export const MAX_FOREGROUND_OUTPUT_BYTES = 50 * 1024;
export const MAX_BACKGROUND_TITLE_LENGTH = 120;

export type RunningCommandMode = "foreground" | "background";

export interface RunningCommand {
  /** Namespaced key used only by the shared focus controller. */
  readonly id: string;
  readonly toolCallId?: string;
  readonly command: string;
  readonly title?: string;
  readonly startedAt: number;
  readonly outputTail: string;
  readonly outputTruncated: boolean;
  readonly mode: RunningCommandMode;
  readonly taskId?: string;
  readonly outputFile?: string;
}

export interface BackgroundCommandView {
  readonly taskId: string;
  readonly command: string;
  readonly title?: string;
  readonly startedAt: number;
  readonly outputTail: string;
  readonly outputTruncated: boolean;
  readonly outputFile: string;
}

interface MutableRunningCommand {
  id: string;
  toolCallId?: string;
  command: string;
  title?: string;
  startedAt: number;
  sequence: number;
  outputTail: string;
  outputTruncated: boolean;
  mode: RunningCommandMode;
  taskId?: string;
  outputFile?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeDisplayText(raw: string): string {
  return stripTerminalSequences(raw)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

export function normalizeCommand(args: unknown): string {
  const raw = isRecord(args) && typeof args.command === "string" ? args.command : "";
  return normalizeDisplayText(raw) || "(empty command)";
}

export function normalizeCommandTitle(value: unknown, command: string): string {
  const fallback = normalizeCommand({ command });
  if (typeof value !== "string") return fallback;
  const normalized = normalizeDisplayText(value);
  if (!normalized) return fallback;
  return Array.from(normalized).slice(0, MAX_BACKGROUND_TITLE_LENGTH).join("");
}

function foregroundSelectionId(toolCallId: string): string {
  return `foreground:${toolCallId}`;
}

function backgroundSelectionId(taskId: string): string {
  return `background:${taskId}`;
}

export function extractTextResult(result: unknown): string {
  if (!isRecord(result) || !Array.isArray(result.content)) return "";
  return result.content
    .filter((part): part is Record<string, unknown> => isRecord(part))
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("");
}

function resultWasTruncated(result: unknown): boolean {
  if (!isRecord(result) || !isRecord(result.details) || !isRecord(result.details.truncation)) return false;
  return result.details.truncation.truncated === true;
}

export function truncateUtf8Tail(
  value: string,
  maxBytes = MAX_FOREGROUND_OUTPUT_BYTES,
): { text: string; truncated: boolean } {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maxBytes) return { text: value, truncated: false };

  let start = bytes.byteLength - maxBytes;
  while (start < bytes.byteLength && (bytes[start]! & 0xc0) === 0x80) start += 1;
  return {
    text: bytes.subarray(start).toString("utf8"),
    truncated: true,
  };
}

export class RunningCommandRegistry {
  private readonly commands = new Map<string, MutableRunningCommand>();
  private nextSequence = 0;

  get size(): number {
    return this.commands.size;
  }

  start(toolCallId: string, args: unknown, startedAt = Date.now()): void {
    const selectionId = foregroundSelectionId(toolCallId);
    this.commands.set(selectionId, {
      id: selectionId,
      toolCallId,
      command: normalizeCommand(args),
      startedAt,
      sequence: this.nextSequence++,
      outputTail: "",
      outputTruncated: false,
      mode: "foreground",
    });
  }

  startBackground(task: BackgroundCommandView): void {
    const selectionId = backgroundSelectionId(task.taskId);
    const existing = this.commands.get(selectionId);
    this.commands.set(selectionId, {
      id: selectionId,
      taskId: task.taskId,
      command: normalizeCommand({ command: task.command }),
      title: normalizeCommandTitle(task.title, task.command),
      startedAt: task.startedAt,
      sequence: existing?.sequence ?? this.nextSequence++,
      outputTail: task.outputTail,
      outputTruncated: task.outputTruncated,
      mode: "background",
      outputFile: task.outputFile,
    });
  }

  update(toolCallId: string, partialResult: unknown): boolean {
    const command = this.commands.get(foregroundSelectionId(toolCallId));
    if (!command || command.mode !== "foreground") return false;

    const output = truncateUtf8Tail(extractTextResult(partialResult));
    command.outputTail = output.text;
    command.outputTruncated = output.truncated || resultWasTruncated(partialResult);
    return true;
  }

  updateBackground(task: BackgroundCommandView): boolean {
    const command = this.commands.get(backgroundSelectionId(task.taskId));
    if (!command || command.mode !== "background") return false;
    command.title = normalizeCommandTitle(task.title, task.command);
    command.outputTail = task.outputTail;
    command.outputTruncated = task.outputTruncated;
    command.outputFile = task.outputFile;
    return true;
  }

  end(toolCallId: string): boolean {
    return this.commands.delete(foregroundSelectionId(toolCallId));
  }

  endBackground(taskId: string): boolean {
    return this.commands.delete(backgroundSelectionId(taskId));
  }

  snapshot(): RunningCommand[] {
    return [...this.commands.values()]
      .sort((left, right) => {
        if (left.mode !== right.mode) return left.mode === "foreground" ? -1 : 1;
        return left.startedAt - right.startedAt || left.sequence - right.sequence;
      })
      .map((command) => ({
        id: command.id,
        toolCallId: command.toolCallId,
        command: command.command,
        title: command.title,
        startedAt: command.startedAt,
        outputTail: command.outputTail,
        outputTruncated: command.outputTruncated,
        mode: command.mode,
        taskId: command.taskId,
        outputFile: command.outputFile,
      }));
  }

  clearForeground(): void {
    for (const [id, command] of this.commands) {
      if (command.mode === "foreground") this.commands.delete(id);
    }
  }

  clearBackground(): void {
    for (const [id, command] of this.commands) {
      if (command.mode === "background") this.commands.delete(id);
    }
  }

  clear(): void {
    this.commands.clear();
    this.nextSequence = 0;
  }
}
