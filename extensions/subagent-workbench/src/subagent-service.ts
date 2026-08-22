import { randomBytes } from "node:crypto";
import {
  ResourceExhaustedError,
  ResourcePriority,
  type ResourceLease,
} from "./resource-governor.ts";
import {
  WorkbenchRuntimeHost,
  getWorkbenchRuntimeHost,
  type ConversationStatus,
} from "./runtime.ts";

export type { ConversationStatus } from "./runtime.ts";

export type ContextMode = "fresh" | "fork" | "summary" | "explicit";
export type IsolationMode = "native" | "process" | "mux";

export const DEFAULT_MAX_TASK_BYTES = 1 * 1024 * 1024;
export const DEFAULT_MAX_CONTEXT_BYTES = 8 * 1024 * 1024;
export const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

export interface SubagentServiceOptions {
  readonly maxTaskBytes?: number;
  readonly maxContextBytes?: number;
  readonly maxOutputBytes?: number;
}

export interface SubagentPayloadLimits {
  readonly maxTaskBytes: number;
  readonly maxContextBytes: number;
  readonly maxOutputBytes: number;
}

export interface ProviderCapabilities {
  readonly contextModes: readonly ContextMode[];
  readonly continuable: boolean;
  readonly interruptible: boolean;
  readonly structuredOutput: boolean;
}

export type AgentThinkingLevel =
  "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface AgentUsage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly cost: number;
}

export interface AgentResult {
  readonly sessionId: string;
  readonly runId: string;
  readonly output: string;
  readonly usage: AgentUsage;
  readonly model?: string;
  readonly isError: boolean;
  readonly errorMessage?: string;
}

export interface ProviderAssistantBlock {
  readonly type: "text" | "thinking" | "toolCall";
  readonly text?: string;
  readonly thinking?: string;
  readonly id?: string;
  readonly name?: string;
  readonly arguments?: unknown;
}

export interface ProviderToolOutput {
  readonly content: readonly {
    readonly type: string;
    readonly text?: string;
    readonly data?: string;
    readonly mimeType?: string;
  }[];
  readonly details?: unknown;
}

export type ProviderEvent =
  | { readonly type: "heartbeat"; readonly at?: number }
  | { readonly type: "message"; readonly text: string }
  | {
      readonly type: "session-state";
      readonly provider?: string;
      readonly model?: string;
      readonly thinkingLevel: AgentThinkingLevel;
    }
  | { readonly type: "assistant-start" }
  | {
      readonly type: "assistant-delta";
      readonly block: "text" | "thinking";
      readonly contentIndex: number;
      readonly delta: string;
    }
  | {
      readonly type: "assistant-end";
      readonly content: readonly ProviderAssistantBlock[];
      readonly provider?: string;
      readonly model?: string;
      readonly stopReason?: string;
      readonly errorMessage?: string;
      readonly usage?: AgentUsage;
    }
  | {
      readonly type: "tool-start";
      readonly toolCallId: string;
      readonly name: string;
      readonly args: unknown;
    }
  | {
      readonly type: "tool-update";
      readonly toolCallId: string;
      readonly name: string;
      readonly args: unknown;
      readonly output: ProviderToolOutput;
    }
  | {
      readonly type: "tool-end";
      readonly toolCallId: string;
      readonly name: string;
      readonly output: ProviderToolOutput;
      readonly isError: boolean;
    };

export interface ProviderRunRequest {
  readonly sessionId: string;
  readonly runId: string;
  readonly task: string;
  readonly contextMode: ContextMode;
  readonly context?: string;
  readonly cwd: string;
  readonly model?: string;
  readonly thinking?: AgentThinkingLevel;
  readonly signal: AbortSignal;
  readonly emit: (event: ProviderEvent) => void;
}

export interface SubagentProvider {
  readonly id: string;
  readonly isolation: IsolationMode;
  readonly capabilities: ProviderCapabilities;
  run(
    request: ProviderRunRequest,
  ): Promise<Omit<AgentResult, "sessionId" | "runId">>;
}

export interface StartAgentRequest {
  readonly task: string;
  readonly label?: string;
  readonly sessionId?: string;
  readonly contextMode?: ContextMode;
  readonly context?: string;
  readonly isolation?: IsolationMode;
  readonly cwd?: string;
  readonly model?: string;
  readonly thinking?: AgentThinkingLevel;
  readonly parentId?: string;
  readonly workflowId?: string;
  readonly foreground?: boolean;
  readonly nested?: boolean;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface ChildSessionSnapshot {
  readonly id: string;
  readonly label: string;
  readonly providerId?: string;
  readonly isolation?: IsolationMode;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly latestRunId?: string;
  readonly runIds: readonly string[];
}

export interface AgentRunSnapshot {
  readonly id: string;
  readonly sessionId: string;
  readonly status: ConversationStatus;
  readonly isolation: IsolationMode;
  readonly providerId: string;
  readonly startedAt?: number;
  readonly completedAt?: number;
  readonly error?: string;
}

export interface SubagentRunStartConfig {
  readonly cwd: string;
  readonly model?: string;
  readonly thinking?: AgentThinkingLevel;
  /** Controller-owned work handle for result collection and cancellation. */
  readonly parentId?: string;
  readonly workflowId?: string;
}

export type SubagentServiceEvent =
  | {
      readonly type: "run-started";
      readonly session: ChildSessionSnapshot;
      readonly run: AgentRunSnapshot;
      readonly task: string;
      readonly config: SubagentRunStartConfig;
    }
  | {
      readonly type: "provider-event";
      readonly sessionId: string;
      readonly runId: string;
      readonly event: ProviderEvent;
    }
  | {
      readonly type: "run-settled";
      readonly sessionId: string;
      readonly session: ChildSessionSnapshot;
      readonly run: AgentRunSnapshot;
      readonly result?: AgentResult;
      readonly error?: string;
    };

export type SubagentServiceListener = (event: SubagentServiceEvent) => void;

interface MutableChildSession {
  id: string;
  label: string;
  providerId: string;
  isolation: IsolationMode;
  createdAt: number;
  updatedAt: number;
  latestRunId?: string;
  runIds: string[];
}

interface MutableAgentRun {
  id: string;
  sessionId: string;
  status: ConversationStatus;
  isolation: IsolationMode;
  providerId: string;
  interruptible: boolean;
  startedAt?: number;
  completedAt?: number;
  error?: string;
  abort?: AbortController;
}

export class ProviderUnavailableError extends Error {
  readonly name = "ProviderUnavailableError";

  constructor(readonly isolation: IsolationMode) {
    super(`No provider is registered for isolation=${isolation}.`);
  }
}

export class ProviderCapabilityError extends Error {
  readonly name = "ProviderCapabilityError";

  constructor(
    readonly providerId: string,
    readonly capability: string,
  ) {
    super(`Provider ${providerId} does not support ${capability}.`);
  }
}

export class ChildSessionOwnershipError extends Error {
  readonly name = "ChildSessionOwnershipError";

  constructor(
    readonly sessionId: string,
    readonly dimension: "provider" | "isolation",
    readonly expected: string,
    readonly requested: string,
  ) {
    super(
      `ChildSession ${sessionId} belongs to ${dimension}=${expected}; requested ${dimension}=${requested}.`,
    );
  }
}

export type SubagentInputErrorCode =
  | "invalid_request"
  | "invalid_task"
  | "task_too_large"
  | "invalid_context"
  | "context_too_large"
  | "invalid_timeout"
  | "invalid_parameter";

export class SubagentInputError extends Error {
  readonly name = "SubagentInputError";

  constructor(
    readonly code: SubagentInputErrorCode,
    readonly field: string,
    message: string,
    readonly actualBytes?: number,
    readonly limitBytes?: number,
  ) {
    super(message);
  }
}

export type ProviderOutputErrorCode = "invalid_output" | "output_too_large";

export class ProviderOutputError extends Error {
  readonly name = "ProviderOutputError";

  constructor(
    readonly code: ProviderOutputErrorCode,
    message: string,
    readonly actualBytes?: number,
    readonly limitBytes?: number,
  ) {
    super(message);
  }
}

export class SubagentExecutionError extends Error {
  readonly name = "SubagentExecutionError";

  constructor(
    readonly sessionId: string,
    readonly runId: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export class ProviderRegistry {
  private readonly providers = new Map<IsolationMode, SubagentProvider>();

  register(provider: SubagentProvider): () => void {
    const current = this.providers.get(provider.isolation);
    if (current && current !== provider) {
      throw new Error(
        `Provider already registered for isolation=${provider.isolation}: ${current.id}`,
      );
    }
    this.providers.set(provider.isolation, provider);
    let registered = true;
    return () => {
      if (!registered) return;
      registered = false;
      if (this.providers.get(provider.isolation) === provider) {
        this.providers.delete(provider.isolation);
      }
    };
  }

  resolve(isolation: IsolationMode): SubagentProvider {
    const provider = this.providers.get(isolation);
    if (!provider) throw new ProviderUnavailableError(isolation);
    return provider;
  }

  list(): readonly SubagentProvider[] {
    return Object.freeze([...this.providers.values()]);
  }
}

const ZERO_USAGE: AgentUsage = Object.freeze({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
});

function id(prefix: string): string {
  return `${prefix}_${randomBytes(6).toString("hex")}`;
}

function frozenSession(session: MutableChildSession): ChildSessionSnapshot {
  return Object.freeze({
    id: session.id,
    label: session.label,
    providerId: session.providerId,
    isolation: session.isolation,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    ...(session.latestRunId ? { latestRunId: session.latestRunId } : {}),
    runIds: Object.freeze([...session.runIds]),
  });
}

function frozenRun(run: MutableAgentRun): AgentRunSnapshot {
  return Object.freeze({
    id: run.id,
    sessionId: run.sessionId,
    status: run.status,
    isolation: run.isolation,
    providerId: run.providerId,
    ...(run.startedAt === undefined ? {} : { startedAt: run.startedAt }),
    ...(run.completedAt === undefined ? {} : { completedAt: run.completedAt }),
    ...(run.error === undefined ? {} : { error: run.error }),
  });
}

function frozenProviderEvent(event: ProviderEvent): ProviderEvent {
  if (event.type === "assistant-end") {
    return Object.freeze({
      ...event,
      content: Object.freeze(
        event.content.map((block) => Object.freeze({ ...block })),
      ),
    });
  }
  if (event.type === "tool-update" || event.type === "tool-end") {
    return Object.freeze({
      ...event,
      output: Object.freeze({
        ...event.output,
        content: Object.freeze(
          event.output.content.map((item) => Object.freeze({ ...item })),
        ),
      }),
    });
  }
  return Object.freeze({ ...event });
}

function frozenAgentResult(result: AgentResult): AgentResult {
  return Object.freeze({
    ...result,
    usage: Object.freeze({ ...result.usage }),
  });
}

function validateLimit(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer.`);
  }
  return value;
}

function validateTextSize(
  value: string,
  field: "task" | "context",
  code: "task_too_large" | "context_too_large",
  limitBytes: number,
): void {
  const actualBytes = Buffer.byteLength(value, "utf8");
  if (actualBytes > limitBytes) {
    throw new SubagentInputError(
      code,
      field,
      `${field} is ${actualBytes} bytes; limit is ${limitBytes}.`,
      actualBytes,
      limitBytes,
    );
  }
}

export class SubagentService {
  readonly providers = new ProviderRegistry();
  readonly limits: SubagentPayloadLimits;

  private readonly sessions = new Map<string, MutableChildSession>();
  private readonly runs = new Map<string, MutableAgentRun>();
  private readonly listeners = new Set<SubagentServiceListener>();

  constructor(
    readonly runtime: WorkbenchRuntimeHost = getWorkbenchRuntimeHost(),
    options: SubagentServiceOptions = {},
  ) {
    this.limits = Object.freeze({
      maxTaskBytes: validateLimit(
        "maxTaskBytes",
        options.maxTaskBytes ?? DEFAULT_MAX_TASK_BYTES,
      ),
      maxContextBytes: validateLimit(
        "maxContextBytes",
        options.maxContextBytes ?? DEFAULT_MAX_CONTEXT_BYTES,
      ),
      maxOutputBytes: validateLimit(
        "maxOutputBytes",
        options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
      ),
    });
  }

  subscribe(listener: SubagentServiceListener): () => void {
    this.listeners.add(listener);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.listeners.delete(listener);
    };
  }

  async start(request: StartAgentRequest): Promise<AgentResult> {
    this.validateRequest(request);
    const isolation = request.isolation ?? "native";
    const contextMode = request.contextMode ?? "fresh";
    const existingSession = request.sessionId
      ? this.resolveExistingSession(request.sessionId)
      : undefined;
    if (existingSession && existingSession.isolation !== isolation) {
      throw new ChildSessionOwnershipError(
        existingSession.id,
        "isolation",
        existingSession.isolation,
        isolation,
      );
    }

    const provider = this.providers.resolve(isolation);
    if (existingSession && existingSession.providerId !== provider.id) {
      throw new ChildSessionOwnershipError(
        existingSession.id,
        "provider",
        existingSession.providerId,
        provider.id,
      );
    }
    if (!provider.capabilities.contextModes.includes(contextMode)) {
      throw new ProviderCapabilityError(provider.id, `context=${contextMode}`);
    }
    if (existingSession && !provider.capabilities.continuable) {
      throw new ProviderCapabilityError(provider.id, "continuable sessions");
    }

    const pendingSessionId = existingSession?.id ?? id("session");
    const lease: ResourceLease = await this.runtime.governor.acquire({
      priority: request.foreground
        ? ResourcePriority.Interactive
        : request.workflowId
          ? ResourcePriority.WorkflowBackground
          : ResourcePriority.DirectBackground,
      subject: request.workflowId ?? request.parentId ?? pendingSessionId,
      signal: request.signal,
      timeoutMs: request.timeoutMs,
      nested: request.nested,
    });

    const session =
      existingSession ??
      this.createSession(request, pendingSessionId, provider);
    const runId = id("run");
    const run: MutableAgentRun = {
      id: runId,
      sessionId: session.id,
      status: "queued",
      isolation,
      providerId: provider.id,
      interruptible: provider.capabilities.interruptible,
    };
    this.runs.set(runId, run);
    session.latestRunId = runId;
    session.runIds.push(runId);
    session.updatedAt = Date.now();
    this.publishSession(session, run.status, request.workflowId);

    const abort = new AbortController();
    run.abort = abort;
    const forwardAbort = (): void => abort.abort(request.signal?.reason);
    if (request.signal?.aborted) abort.abort(request.signal.reason);
    else
      request.signal?.addEventListener("abort", forwardAbort, { once: true });

    run.status = "running";
    run.startedAt = Date.now();
    session.updatedAt = run.startedAt;
    this.publishSession(session, "running", request.workflowId);

    const cwd = request.cwd ?? process.cwd();
    const config = Object.freeze({
      cwd,
      ...(request.model === undefined ? {} : { model: request.model }),
      ...(request.thinking === undefined ? {} : { thinking: request.thinking }),
      ...(request.parentId === undefined ? {} : { parentId: request.parentId }),
      ...(request.workflowId === undefined
        ? {}
        : { workflowId: request.workflowId }),
    });
    this.emitEvent(
      Object.freeze({
        type: "run-started",
        session: frozenSession(session),
        run: frozenRun(run),
        task: request.task,
        config,
      }),
    );

    let settledResult: AgentResult | undefined;
    try {
      const result = await provider.run({
        sessionId: session.id,
        runId,
        task: request.task,
        contextMode,
        context: request.context,
        cwd,
        model: request.model,
        thinking: request.thinking,
        signal: abort.signal,
        emit: (event) =>
          this.onProviderEvent(session, run, event, request.workflowId),
      });
      this.validateProviderResult(result);
      if (abort.signal.aborted) {
        run.status = "interrupted";
        run.error = "Run interrupted.";
        throw new SubagentExecutionError(
          session.id,
          runId,
          "Run interrupted.",
          { cause: abort.signal.reason },
        );
      }
      run.status = result.isError ? "failed" : "completed";
      run.error = result.errorMessage;
      const agentResult = Object.freeze({
        ...result,
        sessionId: session.id,
        runId,
      });
      settledResult = frozenAgentResult(agentResult);
      return agentResult;
    } catch (error) {
      if (error instanceof SubagentExecutionError) throw error;
      run.status = abort.signal.aborted ? "interrupted" : "failed";
      run.error = error instanceof Error ? error.message : String(error);
      throw new SubagentExecutionError(session.id, runId, run.error, {
        cause: error,
      });
    } finally {
      request.signal?.removeEventListener("abort", forwardAbort);
      run.completedAt = Date.now();
      run.abort = undefined;
      session.updatedAt = run.completedAt;
      this.publishSession(
        session,
        run.status,
        request.workflowId,
        run.status === "failed" || run.status === "interrupted",
      );
      this.emitEvent(
        Object.freeze({
          type: "run-settled",
          sessionId: session.id,
          session: frozenSession(session),
          run: frozenRun(run),
          ...(settledResult === undefined ? {} : { result: settledResult }),
          ...(run.error === undefined ? {} : { error: run.error }),
        }),
      );
      lease.release();
    }
  }

  interrupt(runId: string, reason = "Interrupted by user."): boolean {
    const run = this.runs.get(runId);
    if (!run?.abort || run.status !== "running" || !run.interruptible) {
      return false;
    }
    run.abort.abort(reason);
    return true;
  }

  getSession(sessionId: string): ChildSessionSnapshot | undefined {
    const session = this.sessions.get(sessionId);
    return session ? frozenSession(session) : undefined;
  }

  getRun(runId: string): AgentRunSnapshot | undefined {
    const run = this.runs.get(runId);
    return run ? frozenRun(run) : undefined;
  }

  listSessions(): readonly ChildSessionSnapshot[] {
    return Object.freeze([...this.sessions.values()].map(frozenSession));
  }

  private validateRequest(request: StartAgentRequest): void {
    if (!request || typeof request !== "object") {
      throw new SubagentInputError(
        "invalid_request",
        "request",
        "request must be an object.",
      );
    }
    if (typeof request.task !== "string" || !request.task.trim()) {
      throw new SubagentInputError(
        "invalid_task",
        "task",
        "task must be a non-empty string.",
      );
    }
    validateTextSize(
      request.task,
      "task",
      "task_too_large",
      this.limits.maxTaskBytes,
    );
    if (request.context !== undefined) {
      if (typeof request.context !== "string") {
        throw new SubagentInputError(
          "invalid_context",
          "context",
          "context must be a string when provided.",
        );
      }
      validateTextSize(
        request.context,
        "context",
        "context_too_large",
        this.limits.maxContextBytes,
      );
    }
    if (
      request.timeoutMs !== undefined &&
      (!Number.isFinite(request.timeoutMs) || request.timeoutMs <= 0)
    ) {
      throw new SubagentInputError(
        "invalid_timeout",
        "timeoutMs",
        "timeoutMs must be a finite positive number.",
      );
    }
    for (const [field, value] of [
      ["label", request.label],
      ["sessionId", request.sessionId],
      ["cwd", request.cwd],
      ["model", request.model],
      ["parentId", request.parentId],
      ["workflowId", request.workflowId],
    ] as const) {
      if (value !== undefined && typeof value !== "string") {
        throw new SubagentInputError(
          "invalid_parameter",
          field,
          `${field} must be a string when provided.`,
        );
      }
    }
    if (
      request.thinking !== undefined &&
      !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(request.thinking)
    ) {
      throw new SubagentInputError(
        "invalid_parameter",
        "thinking",
        "thinking must be a supported level when provided.",
      );
    }
  }

  private validateProviderResult(
    result: Omit<AgentResult, "sessionId" | "runId">,
  ): void {
    if (
      !result ||
      typeof result !== "object" ||
      typeof result.output !== "string" ||
      typeof result.isError !== "boolean" ||
      !result.usage ||
      typeof result.usage !== "object"
    ) {
      throw new ProviderOutputError(
        "invalid_output",
        "Provider returned an invalid AgentResult.",
      );
    }
    const outputBytes = Buffer.byteLength(result.output, "utf8");
    if (outputBytes > this.limits.maxOutputBytes) {
      throw new ProviderOutputError(
        "output_too_large",
        `Provider output is ${outputBytes} bytes; limit is ${this.limits.maxOutputBytes}.`,
        outputBytes,
        this.limits.maxOutputBytes,
      );
    }
  }

  private resolveExistingSession(sessionId: string): MutableChildSession {
    const existing = this.sessions.get(sessionId);
    if (!existing) {
      throw new Error(`ChildSession not found: ${sessionId}`);
    }
    return existing;
  }

  private createSession(
    request: StartAgentRequest,
    sessionId: string,
    provider: SubagentProvider,
  ): MutableChildSession {
    const now = Date.now();
    const session: MutableChildSession = {
      id: sessionId,
      label: request.label?.trim() || "Subagent",
      providerId: provider.id,
      isolation: provider.isolation,
      createdAt: now,
      updatedAt: now,
      runIds: [],
    };
    this.sessions.set(session.id, session);
    return session;
  }

  private onProviderEvent(
    session: MutableChildSession,
    run: MutableAgentRun,
    event: ProviderEvent,
    workflowId: string | undefined,
  ): void {
    this.emitEvent(
      Object.freeze({
        type: "provider-event",
        sessionId: session.id,
        runId: run.id,
        event: frozenProviderEvent(event),
      }),
    );
    if (event.type !== "heartbeat") return;
    session.updatedAt = event.at ?? Date.now();
    this.runtime.upsertConversation({
      id: session.id,
      label: session.label,
      status: run.status,
      updatedAt: session.updatedAt,
      workflowId,
      lastHeartbeatAt: session.updatedAt,
    });
  }

  private emitEvent(event: SubagentServiceEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // Observers cannot affect provider execution or other observers.
      }
    }
  }

  private publishSession(
    session: MutableChildSession,
    status: ConversationStatus,
    workflowId?: string,
    needsAttention = false,
  ): void {
    this.runtime.upsertConversation({
      id: session.id,
      label: session.label,
      status,
      updatedAt: session.updatedAt,
      workflowId,
      needsAttention,
    });
  }
}

export function emptyAgentResult(
  output: string,
): Omit<AgentResult, "sessionId" | "runId"> {
  return Object.freeze({
    output,
    usage: ZERO_USAGE,
    isError: false,
  });
}

export { ResourceExhaustedError };
