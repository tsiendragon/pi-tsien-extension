import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  activityKeyForTrace,
  jobActivityTracker,
  type ActivityKeyMetadata,
  type JobActivityEvent,
} from "../job-activity.ts";
import {
  budgetExhaustedMessage,
  budgetHandoffMessage,
  BUDGET_NOTICE_RATIO,
} from "../role-budget.ts";
import {
  promptStateAt,
  roleProfile,
  rolesDirPath,
  type PromptState,
} from "../roles-registry.ts";
import { homedir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type {
  AgentThinkingLevel,
  AgentUsage,
  ProviderRunRequest,
  SubagentProvider,
  SubagentTraceContext,
} from "../subagent-service.ts";

/**
 * Child sessions live next to the main agent dir but in their own folder, so a
 * subagent never shows up in the normal session list. Set
 * `PI_SUBAGENT_SESSION_DIR` to move them (for example onto a NAS mount) or to
 * `off` to keep children fully ephemeral.
 */
export function defaultSubagentSessionDir(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  const explicit = environment.PI_SUBAGENT_SESSION_DIR?.trim();
  if (explicit === "off" || explicit === "0" || explicit === "false") {
    return undefined;
  }
  if (explicit) return explicit;
  const agentDir =
    environment.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
  return join(agentDir, "subagent-sessions");
}

export function serializeTraceContext(
  traceContext: SubagentTraceContext | undefined,
): string | undefined {
  return traceContext ? JSON.stringify(traceContext) : undefined;
}

function traceContextKey(traceContext: SubagentTraceContext | undefined): string {
  if (!traceContext) return "";
  return JSON.stringify([
    traceContext.parentSessionId ?? "",
    traceContext.parentToolCallId ?? "",
    traceContext.parentWorkflowId ?? "",
    traceContext.parentWorkId ?? "",
    traceContext.parentTaskId ?? "",
    traceContext.workflowId ?? "",
    traceContext.workId ?? "",
    traceContext.taskId ?? "",
    traceContext.taskKey ?? "",
    traceContext.stageIndex ?? -1,
    traceContext.iterationIndex ?? -1,
    traceContext.sourceWorkId ?? "",
    traceContext.sourceWorkflowId ?? "",
    traceContext.attempt ?? -1,
  ]);
}

export type PiRpcProviderErrorCode =
  | "invalid_options"
  | "session_busy"
  | "session_unavailable"
  | "session_configuration_mismatch"
  | "provider_capacity"
  | "process_start_failed"
  | "process_exited"
  | "rpc_timeout"
  | "rpc_protocol_error"
  | "rpc_command_failed"
  | "run_timeout"
  | "run_idle_timeout"
  | "run_wall_timeout"
  | "model_call_budget"
  | "token_budget"
  | "tool_not_allowed";

export class PiRpcProviderError extends Error {
  readonly name = "PiRpcProviderError";

  constructor(
    readonly code: PiRpcProviderErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export interface PiRpcProcessProviderOptions {
  readonly executable?: string;
  readonly baseArgs?: readonly string[];
  readonly cliArgs?: readonly string[];
  readonly defaultModel?: string;
  readonly thinking?:
    "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  readonly allowTools?: boolean;
  /**
   * Where child sessions are written. Defaults to `<agent dir>/subagent-sessions`
   * so the dashboard can read the child's tool calls and token usage; pass
   * `null` to run ephemeral (`--no-session`), or a path (possibly on a network
   * mount) to keep the files elsewhere. `PI_SUBAGENT_SESSION_DIR=off` disables
   * persistence without code changes.
   */
  readonly sessionDir?: string | null;
  readonly loadExtensions?: boolean;
  readonly loadSkills?: boolean;
  readonly loadPromptTemplates?: boolean;
  readonly loadContextFiles?: boolean;
  /**
   * Generic subagent prompt used when a role has no usable prompt file.
   * Defaults to `<agent dir>/rules/subagent-system.md`; tests and alternate
   * layouts can point it elsewhere. When it is unusable the provider reports a
   * warning instead of silently starting the child without the shared rules.
   */
  readonly genericPromptPath?: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly commandTimeoutMs?: number;
  readonly startupTimeoutMs?: number;
  /** @deprecated Use runIdleWarningMs. This alias now controls a warning, not cancellation. */
  readonly runTimeoutMs?: number;
  /** @deprecated Use runIdleWarningMs. This alias now controls a warning, not cancellation. */
  readonly runIdleTimeoutMs?: number;
  readonly runIdleWarningMs?: number;
  /** @deprecated Use runWallWarningMs. This alias now controls a warning, not cancellation. */
  readonly maxRunWallTimeMs?: number;
  readonly runWallWarningMs?: number;
  readonly warningRepeatMs?: number;
  readonly hardRunWallTimeMs?: number | false;
  readonly timeoutAbortGraceMs?: number;
  readonly shutdownTimeoutMs?: number;
  readonly heartbeatIntervalMs?: number;
  readonly maxStderrBytes?: number;
  readonly maxSessions?: number;
}

export interface PiRpcProviderSnapshot {
  readonly sessions: number;
  readonly active: number;
  readonly unavailable: number;
  readonly limit: number;
  readonly acceptedRuns: number;
  readonly processIds: readonly number[];
}

interface RpcResponse {
  readonly id?: string;
  readonly type: "response";
  readonly command: string;
  readonly success: boolean;
  readonly data?: unknown;
  readonly error?: string;
}

interface RpcAssistantMessage {
  readonly role?: string;
  readonly content?: readonly {
    readonly type?: string;
    readonly text?: string;
    readonly thinking?: string;
    readonly id?: string;
    readonly name?: string;
    readonly arguments?: unknown;
  }[];
  readonly provider?: string;
  readonly model?: string;
  readonly usage?: {
    readonly input?: number;
    readonly output?: number;
    readonly cacheRead?: number;
    readonly cacheWrite?: number;
    readonly cost?: { readonly total?: number };
  };
  readonly stopReason?: string;
  readonly errorMessage?: string;
}

interface RpcSessionState {
  readonly provider?: string;
  readonly model?: string;
  readonly thinkingLevel: AgentThinkingLevel;
}

interface RpcEvent {
  readonly type?: string;
  readonly id?: string;
  readonly message?: RpcAssistantMessage;
  readonly assistantMessageEvent?: {
    readonly type?: string;
    readonly contentIndex?: number;
    readonly delta?: string;
  };
  readonly toolCallId?: string;
  readonly toolName?: string;
  readonly args?: unknown;
  readonly partialResult?: RpcToolOutput;
  readonly result?: RpcToolOutput;
  readonly isError?: boolean;
}

interface RpcToolOutput {
  readonly content?: readonly {
    readonly type?: string;
    readonly text?: string;
    readonly data?: string;
    readonly mimeType?: string;
  }[];
  readonly details?: unknown;
}

type RpcEventListener = (event: RpcEvent) => void;
type ExitListener = (error: PiRpcProviderError) => void;

interface PendingRequest {
  readonly resolve: (response: RpcResponse) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface ProviderSession {
  readonly id: string;
  /** Startup diagnostics (role prompt fallbacks) surfaced with the Run result. */
  startupWarnings: readonly string[];
  readonly cwd: string;
  readonly model?: string;
  readonly thinking?: AgentThinkingLevel;
  readonly traceContext?: SubagentTraceContext;
  readonly client: PiRpcClient;
  activeRun?: symbol;
}

interface DeadSession {
  readonly reason: string;
}

const EMPTY_USAGE: AgentUsage = Object.freeze({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
});
const AGENT_THINKING_LEVELS = new Set<AgentThinkingLevel>([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

function positiveInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new PiRpcProviderError(
      "invalid_options",
      `${name} must be a positive safe integer.`,
    );
  }
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 软提醒阀值：与 role-budget.ts 的 BUDGET_NOTICE_RATIO 保持一致（回合、token 同比例）。 */
function noticeAt(limit: number): number {
  return Math.max(1, Math.floor(limit * BUDGET_NOTICE_RATIO));
}

/** 任一维度达到软提醒阀值就算“接近预算”，且仅在有该维度限制时判定。 */
function nearBudget(
  request: ProviderRunRequest,
  modelCalls: number,
  totalTokens: number,
): boolean {
  return (
    (request.maxModelCalls !== undefined && modelCalls >= noticeAt(request.maxModelCalls)) ||
    (request.maxTokens !== undefined && totalTokens >= noticeAt(request.maxTokens))
  );
}

function appendLimited(current: string, chunk: string, limit: number): string {
  const next = current + chunk;
  return next.length <= limit ? next : next.slice(-limit);
}

function toolOutput(output: RpcToolOutput | undefined): {
  readonly content: readonly {
    readonly type: string;
    readonly text?: string;
    readonly data?: string;
    readonly mimeType?: string;
  }[];
  readonly details?: unknown;
} {
  return {
    content: (output?.content ?? []).map((item) => ({
      type: item.type ?? "text",
      ...(item.text === undefined ? {} : { text: item.text }),
      ...(item.data === undefined ? {} : { data: item.data }),
      ...(item.mimeType === undefined ? {} : { mimeType: item.mimeType }),
    })),
    ...(output?.details === undefined ? {} : { details: output.details }),
  };
}

function sessionState(data: unknown): RpcSessionState {
  const record =
    data && typeof data === "object"
      ? (data as Record<string, unknown>)
      : undefined;
  const rawModel =
    record?.model && typeof record.model === "object"
      ? (record.model as Record<string, unknown>)
      : undefined;
  const thinkingLevel = record?.thinkingLevel;
  return {
    ...(typeof rawModel?.provider === "string"
      ? { provider: rawModel.provider }
      : {}),
    ...(typeof rawModel?.id === "string" ? { model: rawModel.id } : {}),
    thinkingLevel:
      typeof thinkingLevel === "string" &&
      AGENT_THINKING_LEVELS.has(thinkingLevel as AgentThinkingLevel)
        ? (thinkingLevel as AgentThinkingLevel)
        : "off",
  };
}

function assistantText(message: RpcAssistantMessage): string {
  return (message.content ?? [])
    .filter((content) => content.type === "text")
    .map((content) => content.text ?? "")
    .join("");
}

function addUsage(total: AgentUsage, message: RpcAssistantMessage): AgentUsage {
  const usage = message.usage;
  if (!usage) return total;
  return {
    input: total.input + (usage.input ?? 0),
    output: total.output + (usage.output ?? 0),
    cacheRead: total.cacheRead + (usage.cacheRead ?? 0),
    cacheWrite: total.cacheWrite + (usage.cacheWrite ?? 0),
    cost: total.cost + (usage.cost?.total ?? 0),
  };
}

type DeadlineExtension =
  | { readonly ok: true; readonly previousDeadlineAt: number; readonly deadlineAt: number; readonly extendMs: number }
  | { readonly ok: false; readonly reason: string };

class PiRpcClient {
  private process: ChildProcessWithoutNullStreams | undefined;
  private readonly eventListeners = new Set<RpcEventListener>();
  private readonly exitListeners = new Set<ExitListener>();
  private readonly pending = new Map<string, PendingRequest>();
  private requestId = 0;
  private stderr = "";
  private exited: PiRpcProviderError | undefined;
  private stopReader: (() => void) | undefined;
  private stopPromise: Promise<void> | undefined;
  private state: RpcSessionState | undefined;

  constructor(
    private readonly command: string,
    private readonly args: readonly string[],
    private readonly cwd: string,
    private readonly environment: Readonly<Record<string, string>>,
    private readonly commandTimeoutMs: number,
    private readonly shutdownTimeoutMs: number,
    private readonly maxStderrBytes: number,
  ) {}

  get pid(): number | undefined {
    return this.process?.pid;
  }

  async start(startupTimeoutMs: number): Promise<void> {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(this.command, [...this.args], {
        cwd: this.cwd,
        env: { ...process.env, ...this.environment },
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      throw new PiRpcProviderError(
        "process_start_failed",
        `Could not spawn Pi RPC process: ${errorMessage(error)}`,
        { cause: error },
      );
    }
    this.process = child;
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.stderr = appendLimited(this.stderr, chunk, this.maxStderrBytes);
    });
    child.once("error", (error) => {
      this.failProcess(
        new PiRpcProviderError(
          "process_start_failed",
          `Pi RPC process error: ${error.message}${this.stderrSuffix()}`,
          { cause: error },
        ),
      );
    });
    child.once("exit", (code, signal) => {
      this.failProcess(
        new PiRpcProviderError(
          "process_exited",
          `Pi RPC process exited (code=${String(code)} signal=${String(signal)})${this.stderrSuffix()}`,
        ),
      );
    });
    child.stdin.on("error", (error) => {
      this.failProcess(
        new PiRpcProviderError(
          "process_exited",
          `Pi RPC stdin failed: ${error.message}${this.stderrSuffix()}`,
          { cause: error },
        ),
      );
    });
    this.stopReader = this.attachReader(child.stdout);

    try {
      await this.getState(startupTimeoutMs);
    } catch (error) {
      await this.stop();
      if (error instanceof PiRpcProviderError) throw error;
      throw new PiRpcProviderError(
        "process_start_failed",
        `Pi RPC readiness check failed: ${errorMessage(error)}`,
        { cause: error },
      );
    }
  }

  onEvent(listener: RpcEventListener): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onExit(listener: ExitListener): () => void {
    this.exitListeners.add(listener);
    if (this.exited) listener(this.exited);
    return () => this.exitListeners.delete(listener);
  }

  async prompt(message: string): Promise<void> {
    await this.send("prompt", { message });
  }

  /**
   * Queue a steering message that the child sees after its current turn's tool
   * calls, before its next model call. Used for budget handoff nudges; a
   * failure here must never fail the run itself.
   */
  async steer(message: string): Promise<void> {
    await this.send("steer", { message });
  }

  async abort(): Promise<void> {
    await this.send("abort", {});
  }

  currentState(): RpcSessionState | undefined {
    return this.state;
  }

  async getState(timeoutMs?: number): Promise<RpcSessionState> {
    const response = await this.send("get_state", {}, timeoutMs);
    this.state = sessionState(response.data);
    return this.state;
  }

  async heartbeat(): Promise<RpcSessionState> {
    return this.getState();
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    const child = this.process;
    if (!child) return Promise.resolve();

    this.stopPromise = (async () => {
      if (child.exitCode === null && child.signalCode === null) {
        await new Promise<void>((resolve) => {
          let settled = false;
          let killTimer: ReturnType<typeof setTimeout> | undefined;
          const finish = (): void => {
            if (settled) return;
            settled = true;
            if (killTimer) clearTimeout(killTimer);
            resolve();
          };
          child.once("exit", finish);
          child.kill("SIGTERM");
          if (child.exitCode !== null || child.signalCode !== null) {
            finish();
            return;
          }
          killTimer = setTimeout(() => {
            child.kill("SIGKILL");
          }, this.shutdownTimeoutMs);
        });
      }
      if (this.process === child) this.process = undefined;
      this.stopReader?.();
      this.stopReader = undefined;
      const stopped = new PiRpcProviderError(
        "session_unavailable",
        "Pi RPC client was stopped.",
      );
      this.rejectPending(stopped);
      this.eventListeners.clear();
      this.exitListeners.clear();
    })();
    return this.stopPromise;
  }

  private send(
    type: string,
    payload: Readonly<Record<string, unknown>>,
    timeoutMs = this.commandTimeoutMs,
  ): Promise<RpcResponse> {
    const child = this.process;
    if (!child || this.exited || this.stopPromise) {
      return Promise.reject(
        this.exited ??
          new PiRpcProviderError(
            "session_unavailable",
            "Pi RPC client is not running.",
          ),
      );
    }
    const id = `workbench_${++this.requestId}`;
    return new Promise<RpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new PiRpcProviderError(
            "rpc_timeout",
            `Timed out waiting for Pi RPC response to ${type}.`,
          ),
        );
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      const record = `${JSON.stringify({ id, type, ...payload })}\n`;
      child.stdin.write(record, (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        pending.reject(
          new PiRpcProviderError(
            "process_exited",
            `Could not write Pi RPC command ${type}: ${error.message}`,
            { cause: error },
          ),
        );
      });
    }).then((response) => {
      if (!response.success) {
        throw new PiRpcProviderError(
          "rpc_command_failed",
          `Pi RPC command ${type} failed: ${response.error ?? "unknown error"}`,
        );
      }
      return response;
    });
  }

  private attachReader(stream: NodeJS.ReadableStream): () => void {
    const decoder = new StringDecoder("utf8");
    let buffer = "";
    const consume = (line: string): void => {
      const normalized = line.endsWith("\r") ? line.slice(0, -1) : line;
      if (!normalized) return;
      let record: unknown;
      try {
        record = JSON.parse(normalized);
      } catch (error) {
        this.failProcess(
          new PiRpcProviderError(
            "rpc_protocol_error",
            `Pi RPC emitted invalid JSON: ${normalized.slice(0, 200)}`,
            { cause: error },
          ),
        );
        this.process?.kill("SIGTERM");
        return;
      }
      if (!record || typeof record !== "object") return;
      const event = record as RpcEvent & Partial<RpcResponse>;
      if (event.type === "response" && event.id) {
        const pending = this.pending.get(event.id);
        if (!pending) return;
        this.pending.delete(event.id);
        clearTimeout(pending.timer);
        pending.resolve(event as RpcResponse);
        return;
      }
      for (const listener of [...this.eventListeners]) {
        try {
          listener(event);
        } catch {
          // Observer failures must not break RPC framing or process cleanup.
        }
      }
    };
    const onData = (chunk: string | Buffer): void => {
      buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
      while (true) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        consume(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
      }
    };
    const onEnd = (): void => {
      buffer += decoder.end();
      if (buffer) consume(buffer);
      buffer = "";
    };
    stream.on("data", onData);
    stream.on("end", onEnd);
    return () => {
      stream.off("data", onData);
      stream.off("end", onEnd);
    };
  }

  private failProcess(error: PiRpcProviderError): void {
    if (this.exited) return;
    this.exited = error;
    this.rejectPending(error);
    for (const listener of [...this.exitListeners]) {
      try {
        listener(error);
      } catch {
        // Exit observer failures cannot block cleanup.
      }
    }
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private stderrSuffix(): string {
    return this.stderr ? `; stderr: ${this.stderr}` : "";
  }
}

export const GENERIC_SUBAGENT_PROMPT_PATH = join(
  homedir(),
  ".pi/agent/rules/subagent-system.md",
);

function readPromptFile(path: string): string | undefined {
  try {
    const text = readFileSync(path, "utf8");
    return text.trim() ? text : undefined;
  } catch {
    return undefined;
  }
}

function describePromptState(state: PromptState): string {
  switch (state) {
    case "missing":
      return "不存在";
    case "empty":
      return "为空";
    case "unreadable":
      return "不可读";
    default:
      return "可用";
  }
}

export class PiRpcProcessProvider implements SubagentProvider {
  readonly id = "pi-rpc-process";
  readonly isolation = "process" as const;
  readonly capabilities = Object.freeze({
    contextModes: Object.freeze(["fresh", "explicit"] as const),
    continuable: true,
    interruptible: true,
    structuredOutput: false,
  });

  private readonly executable: string;
  private readonly baseArgs: readonly string[];
  private readonly cliArgs: readonly string[];
  private readonly defaultModel?: string;
  private readonly thinking?: PiRpcProcessProviderOptions["thinking"];
  private readonly allowTools: boolean;
  private readonly sessionDir: string | undefined;
  private readonly loadExtensions: boolean;
  private readonly loadSkills: boolean;
  private readonly loadPromptTemplates: boolean;
  private readonly loadContextFiles: boolean;
  private readonly genericPromptPath: string;
  private readonly environment: Readonly<Record<string, string>>;
  private readonly commandTimeoutMs: number;
  private readonly startupTimeoutMs: number;
  private readonly runIdleWarningMs: number;
  private readonly runWallWarningMs: number;
  private readonly warningRepeatMs: number;
  private readonly hardRunWallTimeMs: number | undefined;
  private readonly timeoutAbortGraceMs: number;
  private readonly shutdownTimeoutMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly maxStderrBytes: number;
  private readonly maxSessions: number;
  private readonly sessions = new Map<string, ProviderSession>();
  private readonly deadSessions = new Map<string, DeadSession>();
  private readonly deadlineControls = new Map<string, (extendMs: number) => DeadlineExtension>();
  private acceptedRuns = 0;

  extendRunDeadline(runId: string, extendMs: number): DeadlineExtension {
    return this.deadlineControls.get(runId)?.(extendMs) ?? { ok: false, reason: "No live extendable deadline for this run." };
  }
  private disposed = false;
  private disposePromise: Promise<void> | undefined;

  constructor(options: PiRpcProcessProviderOptions = {}) {
    this.executable = options.executable ?? "pi";
    this.baseArgs = Object.freeze([...(options.baseArgs ?? [])]);
    this.cliArgs = Object.freeze([...(options.cliArgs ?? [])]);
    this.defaultModel = options.defaultModel;
    this.thinking = options.thinking;
    this.allowTools = options.allowTools ?? true;
    this.sessionDir =
      options.sessionDir === null
        ? undefined
        : (options.sessionDir ?? defaultSubagentSessionDir());
    this.loadExtensions = options.loadExtensions ?? true;
    this.loadSkills = options.loadSkills ?? true;
    this.loadPromptTemplates = options.loadPromptTemplates ?? true;
    this.loadContextFiles = options.loadContextFiles ?? true;
    this.genericPromptPath =
      options.genericPromptPath ?? GENERIC_SUBAGENT_PROMPT_PATH;
    this.environment = Object.freeze({ ...(options.environment ?? {}) });
    // 30s was not enough under load: 35 runs in 30 days died in
    // "Timed out waiting for Pi RPC response to get_state" after the child had
    // already started, so the handshake gets the same room as a slow model.
    this.commandTimeoutMs = positiveInteger(
      "commandTimeoutMs",
      options.commandTimeoutMs ?? 60_000,
    );
    this.startupTimeoutMs = positiveInteger(
      "startupTimeoutMs",
      options.startupTimeoutMs ?? 180_000,
    );
    this.runIdleWarningMs = positiveInteger(
      "runIdleWarningMs",
      options.runIdleWarningMs ??
        options.runIdleTimeoutMs ??
        options.runTimeoutMs ??
        10 * 60_000,
    );
    this.runWallWarningMs = positiveInteger(
      "runWallWarningMs",
      options.runWallWarningMs ??
        options.maxRunWallTimeMs ??
        60 * 60_000,
    );
    this.warningRepeatMs = positiveInteger(
      "warningRepeatMs",
      options.warningRepeatMs ?? 6 * 60 * 60_000,
    );
    this.hardRunWallTimeMs =
      options.hardRunWallTimeMs === false
        ? undefined
        : positiveInteger(
            "hardRunWallTimeMs",
            options.hardRunWallTimeMs ?? 72 * 60 * 60_000,
          );
    this.timeoutAbortGraceMs = positiveInteger(
      "timeoutAbortGraceMs",
      options.timeoutAbortGraceMs ?? 5_000,
    );
    this.shutdownTimeoutMs = positiveInteger(
      "shutdownTimeoutMs",
      options.shutdownTimeoutMs ?? 2_000,
    );
    this.heartbeatIntervalMs = positiveInteger(
      "heartbeatIntervalMs",
      options.heartbeatIntervalMs ?? 5_000,
    );
    this.maxStderrBytes = positiveInteger(
      "maxStderrBytes",
      options.maxStderrBytes ?? 16_384,
    );
    this.maxSessions = positiveInteger("maxSessions", options.maxSessions ?? 16);
  }

  async run(request: ProviderRunRequest): Promise<{
    readonly output: string;
    readonly usage: AgentUsage;
    readonly model?: string;
    readonly isError: boolean;
    readonly errorMessage?: string;
    /** Explicit diagnostics (e.g. a missing role prompt) shown to the main agent. */
    readonly warnings?: readonly string[];
    readonly toolCalls: number;
    readonly modelCalls: number;
    /** Present when a role budget stopped the run; partial output is still returned. */
    readonly budgetStop?: {
      readonly kind: "maxTurns" | "maxTokens";
      readonly used: number;
      readonly limit: number;
    };
  }> {
    if (this.disposed) {
      throw new PiRpcProviderError(
        "session_unavailable",
        "Pi RPC provider is disposed.",
      );
    }
    const dead = this.deadSessions.get(request.sessionId);
    if (dead) {
      throw new PiRpcProviderError(
        "session_unavailable",
        `Pi RPC session ${request.sessionId} is unavailable: ${dead.reason}`,
      );
    }
    const effectiveModel = request.model ?? this.defaultModel;
    const effectiveThinking = request.thinking ?? this.thinking;
    const runToken = Symbol(request.runId);
    let session = this.sessions.get(request.sessionId);
    let needsStartup = false;
    if (session) {
      if (session.activeRun) {
        throw new PiRpcProviderError(
          "session_busy",
          `Pi RPC session ${request.sessionId} already has an active Run.`,
        );
      }
      if (
        session.cwd !== request.cwd ||
        session.model !== effectiveModel ||
        session.thinking !== effectiveThinking ||
        (request.traceContext !== undefined &&
          traceContextKey(session.traceContext) !== traceContextKey(request.traceContext))
      ) {
        throw new PiRpcProviderError(
          "session_configuration_mismatch",
          `Pi RPC session ${request.sessionId} cannot change cwd, model, thinking, or trace context.`,
        );
      }
      session.startupWarnings = this.refreshStartupWarnings(request);
      session.activeRun = runToken;
    } else {
      session = this.reserveSession(
        request,
        effectiveModel,
        effectiveThinking,
        runToken,
      );
      needsStartup = true;
    }

    try {
      if (needsStartup) await this.startSession(session);
      const result = await this.runPrompt(session, request, effectiveModel);
      const warnings = session.startupWarnings;
      return warnings.length ? { ...result, warnings: [...warnings] } : result;
    } finally {
      if (session.activeRun === runToken) session.activeRun = undefined;
    }
  }

  snapshot(): PiRpcProviderSnapshot {
    const entries = [...this.sessions.values()];
    return Object.freeze({
      sessions: entries.length,
      active: entries.filter((session) => session.activeRun).length,
      unavailable: this.deadSessions.size,
      limit: this.maxSessions,
      acceptedRuns: this.acceptedRuns,
      processIds: Object.freeze(
        entries
          .map((session) => session.client.pid)
          .filter((pid): pid is number => pid !== undefined),
      ),
    });
  }

  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  async closeSession(
    sessionId: string,
    reason = "Session closed.",
  ): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    if (!this.deadSessions.has(sessionId)) {
      this.deadSessions.set(sessionId, { reason });
    }
    await session.client.stop();
    if (this.sessions.get(sessionId) === session) {
      this.sessions.delete(sessionId);
    }
    return true;
  }

  async dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    const sessions = [...this.sessions.values()];
    for (const session of sessions) {
      if (!this.deadSessions.has(session.id)) {
        this.deadSessions.set(session.id, { reason: "Provider disposed." });
      }
    }
    this.disposePromise = (async () => {
      await Promise.allSettled(
        sessions.map((session) => session.client.stop()),
      );
      for (const session of sessions) {
        if (this.sessions.get(session.id) === session) {
          this.sessions.delete(session.id);
        }
      }
    })();
    return this.disposePromise;
  }

  /**
   * 子代理用独立角色 prompt（共享公约 + 执行者角色），不加载主 agent 的 AGENTS.md。
   * PI_SUBAGENT_MAIN_CONTEXT=1 回退到旧行为（加载主 agent 上下文文件）。
   *
   * 角色 prompt 缺失/为空/不可读时**不再静默回退**：每条诊断写进 `warnings`，
   * 由 run() 放进 Run 结果的 `warnings` 交给主 agent，并同时写入 stderr 日志。
   */
  private childContextArgs(
    role: string | undefined,
    warnings: string[],
  ): { readonly args: readonly string[]; readonly warnings: readonly string[] } {
    const fallbackArgs: readonly string[] = this.loadContextFiles
      ? []
      : ["--no-context-files"];
    const fallbackLabel = this.loadContextFiles
      ? "cwd 上下文文件"
      : "--no-context-files（不加载任何上下文文件）";

    if (process.env.PI_SUBAGENT_MAIN_CONTEXT === "1") {
      if (role) {
        warnings.push(
          "PI_SUBAGENT_MAIN_CONTEXT=1：角色 " +
            role +
            " 的专属 prompt 未使用，回退到" +
            fallbackLabel +
            "。",
        );
      }
      return { args: fallbackArgs, warnings };
    }

    const readPrompt = (path: string): string | undefined => readPromptFile(path);
    const promptArgs = (body: string): readonly string[] => [
      "--no-context-files",
      "--append-system-prompt",
      body,
    ];
    const genericCandidates: string[] = [
      ...(process.env.PI_SUBAGENT_SYSTEM_PROMPT
        ? [process.env.PI_SUBAGENT_SYSTEM_PROMPT]
        : []),
      this.genericPromptPath,
    ];
    const usableGeneric = genericCandidates.find(
      (candidate) =>
        promptStateAt(candidate) === "present" && readPrompt(candidate) !== undefined,
    );

    const profile = role ? roleProfile(role) : undefined;
    if (role && !profile) {
      warnings.push(
        "角色 " +
          role +
          " 没有角色定义文件（" +
          join(rolesDirPath(), role + ".md") +
          "），角色 prompt 不可用。",
      );
    } else if (profile?.invalid) {
      warnings.push(
        "角色 " +
          role +
          " 定义非法（" +
          (profile.invalidReason ?? "frontmatter 校验失败") +
          "），工具集已按最小权限 " +
          profile.base +
          " 处理。",
      );
    }

    if (profile) {
      const state = promptStateAt(profile.promptPath);
      const body = state === "present" ? readPrompt(profile.promptPath) : undefined;
      if (body !== undefined) {
        return { args: promptArgs(body), warnings };
      }
      const next = usableGeneric
        ? "回退到 " + usableGeneric
        : "没有可用的通用子代理 prompt，回退到" + fallbackLabel;
      warnings.push(
        "角色 " +
          role +
          " 的 prompt 文件 " +
          profile.promptPath +
          " " +
          describePromptState(state) +
          "，" +
          next +
          "。运行 python3 ~/.pi/agent/rules/build.py 生成缺失的角色 prompt。",
      );
    }

    if (usableGeneric) {
      return { args: promptArgs(readPrompt(usableGeneric) ?? ""), warnings };
    }

    warnings.push(
      "所有子代理 prompt 来源都不可用（" +
        genericCandidates.join(", ") +
        "），回退到" +
        fallbackLabel +
        "；子代理将缺少共享公约。",
    );
    return { args: fallbackArgs, warnings };
  }
  private refreshStartupWarnings(request: ProviderRunRequest): readonly string[] {
    const { warnings } = this.childContextArgs(request.role, []);
    for (const warning of warnings) {
      process.stderr.write(`[pi-subagent-workbench] ${warning}\n`);
    }
    return warnings;
  }

  private reserveSession(
    request: ProviderRunRequest,
    model: string | undefined,
    thinking: AgentThinkingLevel | undefined,
    runToken: symbol,
  ): ProviderSession {
    if (this.sessions.size >= this.maxSessions) {
      throw new PiRpcProviderError(
        "provider_capacity",
        `Pi RPC provider reached its persistent session limit (${this.maxSessions}).`,
      );
    }
    const contextArgs = this.childContextArgs(request.role, []);
    const warnings = contextArgs.warnings;
    for (const warning of warnings) {
      process.stderr.write(`[pi-subagent-workbench] ${warning}\n`);
    }
    const args = [
      ...this.baseArgs,
      "--mode",
      "rpc",
      // Persisting child sessions is what makes their tool calls and token usage
      // visible to the dashboard; `--session-dir` keeps them out of the main list.
      ...(this.sessionDir
        ? ["--session-dir", this.sessionDir]
        : ["--no-session"]),
      ...(this.loadExtensions ? [] : ["--no-extensions"]),
      ...(this.loadSkills ? [] : ["--no-skills"]),
      ...(this.loadPromptTemplates ? [] : ["--no-prompt-templates"]),
      ...contextArgs.args,
      "--no-approve",
      ...(this.allowTools ? [] : ["--no-tools"]),
      // Expose only the role's tools so the child never picks a tool it will be stopped for.
      ...(this.allowTools && request.allowedTools?.length
        ? ["--tools", request.allowedTools.join(",")]
        : []),
      ...(model ? ["--model", model] : []),
      ...(thinking ? ["--thinking", thinking] : []),
      ...this.cliArgs,
    ];
    const serializedTraceContext = serializeTraceContext(request.traceContext);
    const client = new PiRpcClient(
      this.executable,
      args,
      request.cwd,
      {
        PI_SKIP_VERSION_CHECK: "1",
        PI_TELEMETRY: "0",
        ...this.environment,
        ...(serializedTraceContext
          ? { PI_TRACE_CONTEXT: serializedTraceContext }
          : {}),
        PI_SUBAGENT_WORKBENCH_CHILD: "1",
      },
      this.commandTimeoutMs,
      this.shutdownTimeoutMs,
      this.maxStderrBytes,
    );
    const session: ProviderSession = {
      id: request.sessionId,
      startupWarnings: warnings,
      cwd: request.cwd,
      model,
      thinking,
      traceContext: request.traceContext,
      client,
      activeRun: runToken,
    };
    this.sessions.set(session.id, session);
    client.onExit((error) => {
      if (this.sessions.get(session.id) !== session) return;
      void this.invalidateSession(session, error.message);
    });
    return session;
  }

  private async startSession(session: ProviderSession): Promise<void> {
    try {
      await session.client.start(this.startupTimeoutMs);
    } catch (error) {
      await this.invalidateSession(session, errorMessage(error));
      throw error;
    }
    const dead = this.deadSessions.get(session.id);
    if (this.disposed || dead || this.sessions.get(session.id) !== session) {
      const reason = dead?.reason ?? "Session closed during startup.";
      await this.invalidateSession(session, reason);
      throw new PiRpcProviderError(
        "session_unavailable",
        `Pi RPC session ${session.id} is unavailable: ${reason}`,
      );
    }
  }

  /**
   * Activity-tracking key for a run. `activityKeyForTrace` is shared with the
   * readers (tools and dashboard), so a workflow task run is keyed by its own
   * `taskId` (falling back to the job `workId`, then to `runId` for direct
   * provider calls). Without the fallback chain a workflow would report one key
   * for all of its tasks and a wedged task would hide behind a busy sibling.
   */
  private activityKeyFor(request: ProviderRunRequest): string {
    return (
      activityKeyForTrace({
        trace: request.traceContext,
        runId: request.runId,
      }) ?? request.runId
    );
  }

  /**
   * Owning job and task identity for a heartbeat row. `traceContext.workId` is
   * the job that owns the key (the workflow job for a workflow task run).
   */
  private activityMetaFor(request: ProviderRunRequest): ActivityKeyMetadata {
    const trace = request.traceContext;
    return {
      ...(trace?.workflowId ? { kind: "workflow" as const } : { kind: "agent" as const }),
      ...(trace?.workId ? { workId: trace.workId } : {}),
      ...(trace?.taskId ? { taskId: trace.taskId } : {}),
      ...(trace?.taskKey ? { taskKey: trace.taskKey } : {}),
    };
  }

  private noteActivityEvent(
    request: ProviderRunRequest,
    event: JobActivityEvent,
  ): void {
    try {
      jobActivityTracker().noteEvent(
        this.activityKeyFor(request),
        request.runId,
        event,
        Date.now(),
        this.activityMetaFor(request),
      );
    } catch {
      // Observability must never break a run.
    }
  }

  private noteActivityRunStarted(request: ProviderRunRequest): void {
    try {
      jobActivityTracker().noteRunStarted(
        this.activityKeyFor(request),
        request.runId,
        Date.now(),
        this.activityMetaFor(request),
      );
    } catch {
      // Observability must never break a run.
    }
  }

  private clearActivity(request: ProviderRunRequest): void {
    try {
      jobActivityTracker().noteRunSettled(
        this.activityKeyFor(request),
        request.runId,
      );
    } catch {
      // Observability must never break a run.
    }
  }

  private runPrompt(
    session: ProviderSession,
    request: ProviderRunRequest,
    model: string | undefined,
  ): Promise<{
    readonly output: string;
    readonly usage: AgentUsage;
    readonly model?: string;
    readonly isError: boolean;
    readonly errorMessage?: string;
    readonly toolCalls: number;
    readonly modelCalls: number;
    /** Present when a role budget stopped the run; partial output is still returned. */
    readonly budgetStop?: {
      readonly kind: "maxTurns" | "maxTokens";
      readonly used: number;
      readonly limit: number;
    };
  }> {
    const prompt =
      request.contextMode === "explicit" && request.context
        ? `<explicit_context>\n${request.context}\n</explicit_context>\n\n${request.task}`
        : request.task;
    const currentState = session.client.currentState();
    if (currentState) {
      request.emit({ type: "session-state", ...currentState });
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      let output = "";
      let usage = EMPTY_USAGE;
      let stopReason = "stop";
      let providerError: string | undefined;
      let toolCalls = 0;
      let modelCalls = 0;
      let totalTokens = 0;
      let budgetNoticeSent = false;
      let budgetStop: { readonly kind: "maxTurns" | "maxTokens"; readonly used: number; readonly limit: number } | undefined;
      let abortSent = false;
      const runStartedAt = Date.now();
      let lastProgressAt = runStartedAt;
      let idleWarningTimer: ReturnType<typeof setTimeout> | undefined;
      let wallWarningTimer: ReturnType<typeof setTimeout> | undefined;
      let hardWallTimer: ReturnType<typeof setTimeout> | undefined;
      let softDeadlineTimer: ReturnType<typeof setTimeout> | undefined;
      let timeoutAbortGraceTimer: ReturnType<typeof setTimeout> | undefined;
      let pendingTimeout: PiRpcProviderError | undefined;
      let timeoutTerminationStarted = false;
      let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
      let heartbeatInFlight = false;
      let unsubscribeEvents = (): void => {};
      let unsubscribeExit = (): void => {};

      this.noteActivityRunStarted(request);
      const finish = (action: () => void): void => {
        if (settled) return;
        settled = true;
        this.clearActivity(request);
        if (idleWarningTimer) clearTimeout(idleWarningTimer);
        if (wallWarningTimer) clearTimeout(wallWarningTimer);
        if (hardWallTimer) clearTimeout(hardWallTimer);
        if (softDeadlineTimer) clearTimeout(softDeadlineTimer);
        this.deadlineControls.delete(request.runId);
        if (timeoutAbortGraceTimer) clearTimeout(timeoutAbortGraceTimer);
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        unsubscribeEvents();
        unsubscribeExit();
        request.signal.removeEventListener("abort", onAbort);
        action();
      };
      const fail = (error: unknown): void =>
        finish(() =>
          reject(error instanceof Error ? error : new Error(String(error))),
        );
      const terminateTimedOutSession = (error: PiRpcProviderError): void => {
        if (settled || timeoutTerminationStarted) return;
        timeoutTerminationStarted = true;
        unsubscribeExit();
        void this.invalidateSession(session, error.message).finally(() =>
          fail(error),
        );
      };
      const beginTimeout = (error: PiRpcProviderError): void => {
        if (settled || pendingTimeout) return;
        pendingTimeout = error;
        if (idleWarningTimer) clearTimeout(idleWarningTimer);
        if (wallWarningTimer) clearTimeout(wallWarningTimer);
        if (hardWallTimer) clearTimeout(hardWallTimer);
        abortSent = true;
        timeoutAbortGraceTimer = setTimeout(
          () => terminateTimedOutSession(error),
          this.timeoutAbortGraceMs,
        );
        timeoutAbortGraceTimer.unref?.();
        void session.client.abort().catch(() => terminateTimedOutSession(error));
      };
      /**
       * Budget exhaustion must NOT throw away the partial result: stop the child,
       * then settle with what was produced so the main agent can collect
       * artifacts and decide the next step.
       */
      let settleBudgetStop: (
        kind: "maxTurns" | "maxTokens",
        used: number,
        limit: number,
        message: string,
      ) => void = () => {};
      const emitRunWarning = (warning: "idle" | "wall"): void => {
        const now = Date.now();
        const elapsedMs = now - runStartedAt;
        const idleMs = now - lastProgressAt;
        request.emit({
          type: "run-warning",
          warning,
          elapsedMs,
          ...(warning === "idle" ? { idleMs } : {}),
          message:
            warning === "idle"
              ? `Pi RPC Run ${request.runId} has had no RPC progress for ${idleMs} ms and is still running.`
              : `Pi RPC Run ${request.runId} has been running for ${elapsedMs} ms and is still running.`,
        });
      };
      const armIdleWarning = (delay = this.runIdleWarningMs): void => {
        if (settled || pendingTimeout) return;
        if (idleWarningTimer) clearTimeout(idleWarningTimer);
        idleWarningTimer = setTimeout(() => {
          emitRunWarning("idle");
          armIdleWarning(this.warningRepeatMs);
        }, delay);
        idleWarningTimer.unref?.();
      };
      const armWallWarning = (delay = this.runWallWarningMs): void => {
        if (settled || pendingTimeout) return;
        if (wallWarningTimer) clearTimeout(wallWarningTimer);
        wallWarningTimer = setTimeout(() => {
          emitRunWarning("wall");
          armWallWarning(this.warningRepeatMs);
        }, delay);
        wallWarningTimer.unref?.();
      };
      const settleBudget = (
        kind: "maxTurns" | "maxTokens",
        used: number,
        limit: number,
        message: string,
      ): void => {
        if (settled) return;
        budgetStop = { kind, used, limit };
        providerError = message;
        stopReason = "error";
        void session.client.abort().catch(() => {});
        finish(() =>
          resolve({
            output,
            usage,
            ...(model ? { model } : {}),
            toolCalls,
            modelCalls,
            budgetStop: { kind, used, limit },
            isError: true,
            errorMessage: message,
          }),
        );
      };
      settleBudgetStop = settleBudget;
      const markProgress = (): void => {
        lastProgressAt = Date.now();
        armIdleWarning();
      };
      const onAbort = (): void => {
        if (abortSent) return;
        abortSent = true;
        void session.client.abort().catch((error) => {
          unsubscribeExit();
          void this.invalidateSession(session, errorMessage(error)).then(
            () => fail(error),
            fail,
          );
        });
      };
      unsubscribeEvents = session.client.onEvent((event) => {
        markProgress();
        this.noteActivityEvent(request, {
          type: event.type ?? "unknown",
          ...(event.toolCallId === undefined ? {} : { toolCallId: event.toolCallId }),
          ...(event.toolName === undefined ? {} : { toolName: event.toolName }),
          ...(event.message?.role === undefined
            ? {}
            : { message: { role: event.message.role } }),
        });
        request.emit({ type: "heartbeat" });
        if (
          event.type === "message_start" &&
          event.message?.role === "assistant"
        ) {
          request.emit({ type: "assistant-start" });
        } else if (event.type === "message_update") {
          const delta = event.assistantMessageEvent;
          if (delta?.type === "text_delta" && delta.delta) {
            request.emit({ type: "message", text: delta.delta });
            request.emit({
              type: "assistant-delta",
              block: "text",
              contentIndex: delta.contentIndex ?? 0,
              delta: delta.delta,
            });
          } else if (delta?.type === "thinking_delta" && delta.delta) {
            request.emit({
              type: "assistant-delta",
              block: "thinking",
              contentIndex: delta.contentIndex ?? 0,
              delta: delta.delta,
            });
          }
        } else if (event.type === "tool_execution_start" && event.toolName) {
          toolCalls += 1;
          const toolCallId = event.toolCallId ?? `${request.runId}:${event.toolName}`;
          if (request.allowedTools && !request.allowedTools.includes(event.toolName)) {
            request.emit({
              type: "tool-end",
              toolCallId,
              name: event.toolName,
              output: {
                content: [{ type: "text", text: `Tool ${event.toolName} is not allowed for this role.` }],
              },
              isError: true,
            });
            beginTimeout(
              new PiRpcProviderError(
                "tool_not_allowed",
                `Subagent called tool "${event.toolName}", which this role does not allow (allowed: ${request.allowedTools.join(", ")}). The run was stopped.`,
              ),
            );
          } else {
            request.emit({
              type: "tool-start",
              toolCallId,
              name: event.toolName,
              args: event.args ?? {},
            });
          }
        } else if (event.type === "tool_execution_update" && event.toolName) {
          request.emit({
            type: "tool-update",
            toolCallId:
              event.toolCallId ?? `${request.runId}:${event.toolName}`,
            name: event.toolName,
            args: event.args ?? {},
            output: toolOutput(event.partialResult),
          });
        } else if (event.type === "tool_execution_end" && event.toolName) {
          request.emit({
            type: "tool-end",
            toolCallId:
              event.toolCallId ?? `${request.runId}:${event.toolName}`,
            name: event.toolName,
            output: toolOutput(event.result),
            isError: event.isError ?? false,
          });
        } else if (
          event.type === "message_end" &&
          event.message?.role === "assistant"
        ) {
          output = assistantText(event.message);
          usage = addUsage(usage, event.message);
          modelCalls += 1;
          totalTokens += (event.message.usage?.input ?? 0) + (event.message.usage?.output ?? 0);
          // Turn budget: stop hard, but keep partial artifacts for collection.
          if (request.maxModelCalls !== undefined && modelCalls >= request.maxModelCalls) {
            const message = `Pi RPC Run ${request.runId} ${budgetExhaustedMessage("maxTurns", request.maxModelCalls)}`;
            settleBudgetStop("maxTurns", modelCalls, request.maxModelCalls, message);
            return;
          }
          if (request.maxTokens !== undefined && totalTokens >= request.maxTokens) {
            const message = `Pi RPC Run ${request.runId} ${budgetExhaustedMessage("maxTokens", request.maxTokens)}`;
            settleBudgetStop("maxTokens", totalTokens, request.maxTokens, message);
            return;
          }
          if (!budgetNoticeSent && nearBudget(request, modelCalls, totalTokens)) {
            // Soft notice: warn the main agent AND tell the child to hand off now.
            budgetNoticeSent = true;
            const kind = request.maxModelCalls !== undefined && modelCalls >= noticeAt(request.maxModelCalls)
              ? "maxTurns" as const
              : "maxTokens" as const;
            const limit = kind === "maxTurns" ? request.maxModelCalls! : request.maxTokens!;
            const used = kind === "maxTurns" ? modelCalls : totalTokens;
            request.emit({
              type: "run-warning",
              warning: "budget",
              elapsedMs: Date.now() - runStartedAt,
              budget: { kind, used, limit },
              message:
                `Pi RPC Run ${request.runId} is near its ${kind} budget (${used}/${limit}); asked the child to hand off partial artifacts.`,
            });
            void session.client
              .steer(budgetHandoffMessage({
                modelCalls,
                tokens: totalTokens,
                ...(request.maxModelCalls === undefined ? {} : { maxTurns: request.maxModelCalls }),
                ...(request.maxTokens === undefined ? {} : { maxTokens: request.maxTokens }),
              }))
              .catch(() => {
                // Steering is advisory; never fail a run because the nudge was rejected.
              });
          }
          stopReason = event.message.stopReason ?? stopReason;
          providerError = event.message.errorMessage;
          request.emit({
            type: "assistant-end",
            content: (event.message.content ?? [])
              .filter((block) =>
                ["text", "thinking", "toolCall"].includes(block.type ?? ""),
              )
              .map((block) => ({
                type: block.type as "text" | "thinking" | "toolCall",
                ...(block.text === undefined ? {} : { text: block.text }),
                ...(block.thinking === undefined
                  ? {}
                  : { thinking: block.thinking }),
                ...(block.id === undefined ? {} : { id: block.id }),
                ...(block.name === undefined ? {} : { name: block.name }),
                ...(block.arguments === undefined
                  ? {}
                  : { arguments: block.arguments }),
              })),
            ...(event.message.provider
              ? { provider: event.message.provider }
              : {}),
            ...(event.message.model ? { model: event.message.model } : {}),
            ...(event.message.stopReason
              ? { stopReason: event.message.stopReason }
              : {}),
            ...(event.message.errorMessage
              ? { errorMessage: event.message.errorMessage }
              : {}),
            ...(event.message.usage
              ? {
                  usage: {
                    input: event.message.usage.input ?? 0,
                    output: event.message.usage.output ?? 0,
                    cacheRead: event.message.usage.cacheRead ?? 0,
                    cacheWrite: event.message.usage.cacheWrite ?? 0,
                    cost: event.message.usage.cost?.total ?? 0,
                  },
                }
              : {}),
          });
        } else if (event.type === "agent_settled") {
          if (pendingTimeout) {
            terminateTimedOutSession(pendingTimeout);
            return;
          }
          finish(() =>
            resolve({
              output,
              usage,
              ...(model ? { model } : {}),
              toolCalls,
              modelCalls,
              ...(budgetStop ? { budgetStop } : {}),
              isError:
                stopReason === "error" ||
                stopReason === "aborted" ||
                Boolean(providerError),
              ...(providerError ? { errorMessage: providerError } : {}),
            }),
          );
        }
      });
      unsubscribeExit = session.client.onExit((error) => {
        unsubscribeExit();
        void this.invalidateSession(session, error.message).then(
          () => fail(error),
          fail,
        );
      });
      heartbeatTimer = setInterval(() => {
        if (settled || heartbeatInFlight) return;
        heartbeatInFlight = true;
        void session.client
          .heartbeat()
          .then((state) => {
            if (settled) return;
            request.emit({ type: "session-state", ...state });
            request.emit({ type: "heartbeat" });
          })
          .catch((error) => {
            if (settled) return;
            unsubscribeExit();
            void this.invalidateSession(session, errorMessage(error)).then(
              () => fail(error),
              fail,
            );
          })
          .finally(() => {
            heartbeatInFlight = false;
          });
      }, this.heartbeatIntervalMs);
      heartbeatTimer.unref?.();
      armIdleWarning();
      armWallWarning();
      const hardRunWallTimeMs = request.hardWallTimeMs ?? this.hardRunWallTimeMs;
      if (hardRunWallTimeMs !== undefined) {
        let budgetMs = hardRunWallTimeMs;
        let deadlineAt = runStartedAt + budgetMs;
        let extended = false;
        const maxExtensionMs = Math.max(0, Math.min(request.workExtensionMaxMs ?? 300_000, (request.hardWallMaxMs ?? budgetMs) - budgetMs));
        const armHardDeadline = () => {
          if (hardWallTimer) clearTimeout(hardWallTimer);
          hardWallTimer = setTimeout(() => beginTimeout(new PiRpcProviderError(
            "run_wall_timeout", `Pi RPC Run ${request.runId} exceeded hard wall time ${budgetMs} ms.`,
          )), Math.max(0, deadlineAt - Date.now()));
          hardWallTimer.unref?.();
        };
        if (maxExtensionMs > 0) this.deadlineControls.set(request.runId, (extendMs) => {
          if (settled || abortSent || pendingTimeout || request.signal.aborted || Date.now() >= deadlineAt) {
            return { ok: false, reason: "Deadline elapsed or run is terminating." };
          }
          if (extended) return { ok: false, reason: "This run has already been extended once." };
          if (!Number.isSafeInteger(extendMs) || extendMs <= 0 || extendMs > maxExtensionMs) {
            return { ok: false, reason: `Extension must be a positive integer no larger than ${maxExtensionMs} ms.` };
          }
          const previousDeadlineAt = deadlineAt;
          budgetMs += extendMs;
          deadlineAt += extendMs;
          extended = true;
          armHardDeadline();
          return { ok: true, previousDeadlineAt, deadlineAt, extendMs };
        });
        if (request.hardWallTimeMs !== undefined && hardRunWallTimeMs >= 1000) {
          const leadMs = Math.min(60_000, Math.floor(hardRunWallTimeMs / 3));
          softDeadlineTimer = setTimeout(() => {
            if (settled || pendingTimeout || abortSent || request.signal.aborted) return;
            request.emit({
              type: "run-warning", warning: "soft-deadline",
              elapsedMs: Date.now() - runStartedAt, deadlineAt,
              maxExtensionMs: extended ? 0 : maxExtensionMs,
              message: "The work is still running and approaching its hard deadline.",
            });
          }, hardRunWallTimeMs - leadMs);
          softDeadlineTimer.unref?.();
        }
        armHardDeadline();
      }
      if (request.signal.aborted) {
        fail(
          request.signal.reason instanceof Error
            ? request.signal.reason
            : new Error(String(request.signal.reason ?? "Run aborted.")),
        );
        return;
      }
      request.signal.addEventListener("abort", onAbort, { once: true });

      void session.client
        .prompt(prompt)
        .then(() => {
          this.acceptedRuns++;
          markProgress();
        })
        .catch((error) => {
          void this.invalidateSession(session, errorMessage(error)).finally(
            () => fail(error),
          );
        });
    });
  }

  private async invalidateSession(
    session: ProviderSession,
    reason: string,
  ): Promise<void> {
    if (
      this.sessions.get(session.id) === session &&
      !this.deadSessions.has(session.id)
    ) {
      this.deadSessions.set(session.id, { reason });
    }
    await session.client.stop();
    if (this.sessions.get(session.id) === session) {
      this.sessions.delete(session.id);
    }
  }
}
