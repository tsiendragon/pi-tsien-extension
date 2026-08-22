import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type {
  AgentThinkingLevel,
  AgentUsage,
  ProviderRunRequest,
  SubagentProvider,
} from "../subagent-service.ts";

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
  | "run_wall_timeout";

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
  readonly loadExtensions?: boolean;
  readonly loadSkills?: boolean;
  readonly loadPromptTemplates?: boolean;
  readonly loadContextFiles?: boolean;
  readonly environment?: Readonly<Record<string, string>>;
  readonly commandTimeoutMs?: number;
  readonly startupTimeoutMs?: number;
  /** @deprecated Use runIdleTimeoutMs. */
  readonly runTimeoutMs?: number;
  readonly runIdleTimeoutMs?: number;
  readonly maxRunWallTimeMs?: number;
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
  readonly cwd: string;
  readonly model?: string;
  readonly thinking?: AgentThinkingLevel;
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
  private readonly loadExtensions: boolean;
  private readonly loadSkills: boolean;
  private readonly loadPromptTemplates: boolean;
  private readonly loadContextFiles: boolean;
  private readonly environment: Readonly<Record<string, string>>;
  private readonly commandTimeoutMs: number;
  private readonly startupTimeoutMs: number;
  private readonly runIdleTimeoutMs: number;
  private readonly maxRunWallTimeMs: number;
  private readonly timeoutAbortGraceMs: number;
  private readonly shutdownTimeoutMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly maxStderrBytes: number;
  private readonly maxSessions: number;
  private readonly sessions = new Map<string, ProviderSession>();
  private readonly deadSessions = new Map<string, DeadSession>();
  private acceptedRuns = 0;
  private disposed = false;
  private disposePromise: Promise<void> | undefined;

  constructor(options: PiRpcProcessProviderOptions = {}) {
    this.executable = options.executable ?? "pi";
    this.baseArgs = Object.freeze([...(options.baseArgs ?? [])]);
    this.cliArgs = Object.freeze([...(options.cliArgs ?? [])]);
    this.defaultModel = options.defaultModel;
    this.thinking = options.thinking;
    this.allowTools = options.allowTools ?? true;
    this.loadExtensions = options.loadExtensions ?? true;
    this.loadSkills = options.loadSkills ?? true;
    this.loadPromptTemplates = options.loadPromptTemplates ?? true;
    this.loadContextFiles = options.loadContextFiles ?? true;
    this.environment = Object.freeze({ ...(options.environment ?? {}) });
    this.commandTimeoutMs = positiveInteger(
      "commandTimeoutMs",
      options.commandTimeoutMs ?? 30_000,
    );
    this.startupTimeoutMs = positiveInteger(
      "startupTimeoutMs",
      options.startupTimeoutMs ?? 180_000,
    );
    this.runIdleTimeoutMs = positiveInteger(
      "runIdleTimeoutMs",
      options.runIdleTimeoutMs ?? options.runTimeoutMs ?? 10 * 60_000,
    );
    this.maxRunWallTimeMs = positiveInteger(
      "maxRunWallTimeMs",
      options.maxRunWallTimeMs ?? 60 * 60_000,
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
    this.maxSessions = positiveInteger("maxSessions", options.maxSessions ?? 8);
  }

  async run(request: ProviderRunRequest): Promise<{
    readonly output: string;
    readonly usage: AgentUsage;
    readonly model?: string;
    readonly isError: boolean;
    readonly errorMessage?: string;
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
        session.thinking !== effectiveThinking
      ) {
        throw new PiRpcProviderError(
          "session_configuration_mismatch",
          `Pi RPC session ${request.sessionId} cannot change cwd, model, or thinking.`,
        );
      }
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
      return await this.runPrompt(session, request, effectiveModel);
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
    const args = [
      ...this.baseArgs,
      "--mode",
      "rpc",
      "--no-session",
      ...(this.loadExtensions ? [] : ["--no-extensions"]),
      ...(this.loadSkills ? [] : ["--no-skills"]),
      ...(this.loadPromptTemplates ? [] : ["--no-prompt-templates"]),
      ...(this.loadContextFiles ? [] : ["--no-context-files"]),
      "--no-approve",
      ...(this.allowTools ? [] : ["--no-tools"]),
      ...(model ? ["--model", model] : []),
      ...(thinking ? ["--thinking", thinking] : []),
      ...this.cliArgs,
    ];
    const client = new PiRpcClient(
      this.executable,
      args,
      request.cwd,
      {
        PI_SKIP_VERSION_CHECK: "1",
        PI_TELEMETRY: "0",
        ...this.environment,
        PI_SUBAGENT_WORKBENCH_CHILD: "1",
      },
      this.commandTimeoutMs,
      this.shutdownTimeoutMs,
      this.maxStderrBytes,
    );
    const session: ProviderSession = {
      id: request.sessionId,
      cwd: request.cwd,
      model,
      thinking,
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
      let abortSent = false;
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      let wallTimer: ReturnType<typeof setTimeout> | undefined;
      let timeoutAbortGraceTimer: ReturnType<typeof setTimeout> | undefined;
      let pendingTimeout: PiRpcProviderError | undefined;
      let timeoutTerminationStarted = false;
      let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
      let heartbeatInFlight = false;
      let unsubscribeEvents = (): void => {};
      let unsubscribeExit = (): void => {};

      const finish = (action: () => void): void => {
        if (settled) return;
        settled = true;
        if (idleTimer) clearTimeout(idleTimer);
        if (wallTimer) clearTimeout(wallTimer);
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
        if (idleTimer) clearTimeout(idleTimer);
        if (wallTimer) clearTimeout(wallTimer);
        abortSent = true;
        timeoutAbortGraceTimer = setTimeout(
          () => terminateTimedOutSession(error),
          this.timeoutAbortGraceMs,
        );
        timeoutAbortGraceTimer.unref?.();
        void session.client.abort().catch(() => terminateTimedOutSession(error));
      };
      const armIdleTimer = (): void => {
        if (settled || pendingTimeout) return;
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(
          () =>
            beginTimeout(
              new PiRpcProviderError(
                "run_idle_timeout",
                `Pi RPC Run ${request.runId} was idle for ${this.runIdleTimeoutMs} ms without RPC progress.`,
              ),
            ),
          this.runIdleTimeoutMs,
        );
        idleTimer.unref?.();
      };
      const markProgress = (): void => {
        armIdleTimer();
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
          request.emit({
            type: "tool-start",
            toolCallId:
              event.toolCallId ?? `${request.runId}:${event.toolName}`,
            name: event.toolName,
            args: event.args ?? {},
          });
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
      armIdleTimer();
      wallTimer = setTimeout(
        () =>
          beginTimeout(
            new PiRpcProviderError(
              "run_wall_timeout",
              `Pi RPC Run ${request.runId} exceeded maximum wall time ${this.maxRunWallTimeMs} ms.`,
            ),
          ),
        this.maxRunWallTimeMs,
      );
      wallTimer.unref?.();
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
