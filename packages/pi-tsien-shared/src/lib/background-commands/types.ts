/** `foreground` tasks run inside a blocking `bash` tool call and can be moved to the background. */
export type BackgroundTaskMode = "foreground" | "background";

export type BackgroundTaskState =
  | "starting"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timed_out";

export type BackgroundTaskExitReason =
  | "exit"
  | "signal"
  | "timeout"
  | "session_shutdown"
  | "output_limit"
  | "log_error";

export interface BackgroundTaskSnapshot {
  readonly id: string;
  readonly owner: "agent-bash";
  readonly mode: BackgroundTaskMode;
  /** Set when the task was started by a foreground `bash` tool call. */
  readonly toolCallId?: string;
  /** Human-readable label; falls back to the sanitized Bash command. */
  readonly title: string;
  readonly sessionId: string;
  readonly command: string;
  readonly cwd: string;
  readonly state: BackgroundTaskState;
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly pid?: number;
  readonly exitCode?: number | null;
  readonly exitSignal?: NodeJS.Signals | null;
  readonly exitReason?: BackgroundTaskExitReason;
  readonly outputFile: string;
  readonly outputBytes: number;
  readonly outputTail: string;
  readonly outputTruncated: boolean;
  readonly timeoutMs?: number;
  readonly error?: string;
  readonly experimentalPlatform: boolean;
}

export interface BackgroundTaskStartRequest {
  readonly command: string;
  readonly title?: string;
  readonly cwd: string;
  readonly sessionId: string;
  readonly sessionFile?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly thinkingLevel?: string;
  readonly timeoutSeconds?: number;
  readonly launchSignal?: AbortSignal;
}

export interface ForegroundCommandStartRequest {
  readonly toolCallId: string;
  readonly command: string;
  readonly cwd: string;
  readonly sessionId: string;
  readonly startedAt?: number;
  readonly timeoutSeconds?: number;
  readonly env?: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
  readonly onData: (data: Buffer) => void;
}

export interface ForegroundCommandResult {
  readonly exitCode: number | null;
}

export type BackgroundTaskEvent =
  | { readonly type: "started"; readonly task: BackgroundTaskSnapshot }
  | { readonly type: "updated"; readonly task: BackgroundTaskSnapshot }
  | { readonly type: "finished"; readonly task: BackgroundTaskSnapshot };

export interface BackgroundTaskOutput {
  readonly taskId: string;
  readonly title: string;
  readonly command: string;
  readonly state: BackgroundTaskState;
  readonly output: string;
  readonly tailLines: number;
  readonly outputBytes: number;
  readonly outputFile: string;
  readonly truncated: boolean;
}

export interface BackgroundCommandManagerOptions {
  readonly maxConcurrent?: number;
  readonly maxOutputBytes?: number;
  readonly maxTailBytes?: number;
  readonly outputRoot?: string;
  readonly killGraceMs?: number;
  readonly reloadGraceMs?: number;
  readonly updateThrottleMs?: number;
  readonly now?: () => number;
  readonly idFactory?: () => string;
}
