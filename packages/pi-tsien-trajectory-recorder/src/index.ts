import { appendFileSync, chmodSync, mkdirSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const TRACE_SCHEMA_VERSION = 1 as const;
/**
 * Portable data root: `<PI_CODING_AGENT_DIR | ~/.pi/agent>`. Nothing here is machine specific;
 * override per run with `PI_TRACE_DIR` / `PI_TIMING_DIR` or the `traceDir` / `timingDir` options.
 */
function defaultDataRoot(): string {
	return process.env.PI_CODING_AGENT_DIR?.trim()
		? resolve(process.env.PI_CODING_AGENT_DIR)
		: join(homedir(), ".pi", "agent");
}

export const DEFAULT_TRACE_DIR = join(defaultDataRoot(), "pi-traces");
export const TIMING_SCHEMA_VERSION = 1 as const;
export const DEFAULT_TIMING_DIR = join(defaultDataRoot(), "pi-timing");

export interface TrajectoryTraceContext {
  readonly parentSessionId?: string;
  readonly parentToolCallId?: string;
  readonly parentWorkflowId?: string;
  readonly parentWorkId?: string;
  readonly parentTaskId?: string;
  readonly workflowId?: string;
  readonly workId?: string;
  readonly taskId?: string;
  readonly taskKey?: string;
  /** Zero-based workflow stage index. */
  readonly stageIndex?: number;
  /** Zero-based foreach iteration index. */
  readonly iterationIndex?: number;
  readonly sourceWorkId?: string;
  readonly sourceWorkflowId?: string;
  readonly attempt?: number;
}

type UnknownRecord = Record<string, unknown>;

type PendingRequest = {
  requestId: string;
  startedAt: number;
  attempt: number;
  turnIndex?: number;
  /** Client-observed first stream delta (≈ first token). */
  firstDeltaAt?: number;
  /** HTTP response headers received (≈ server first byte). */
  responseMs?: number;
  thinkingMs: number;
  thinkingStartedAt: Map<number, number>;
};

type PendingToolExecution = {
  toolName: string;
  startedAt: number;
  args: unknown;
  endedAt?: number;
  resultRecorded: boolean;
};

type RecorderState = {
  sessionId: string;
  sessionFile?: string;
  traceContext?: TrajectoryTraceContext;
  sessionDir: string;
  eventsPath: string;
  runId?: string;
  turnIndex?: number;
  attempt: number;
  systemPromptHash?: string;
  pendingRequest?: PendingRequest;
  toolExecutions: Map<string, PendingToolExecution>;
  writeFailureReported: boolean;
  /** Compact timing ledger; undefined when disabled. */
  timingPath?: string;
  runStartedAt?: number;
  runModelMs: number;
  runToolMs: number;
  runModelCount: number;
  runToolCount: number;
  runTurnCount: number;
};

export interface TrajectoryRecorderOptions {
  /** Defaults to PI_TRACE_DIR or `<PI_CODING_AGENT_DIR | ~/.pi/agent>/pi-traces`. */
  traceDir?: string;
  /** Compact timing ledger directory. Defaults to PI_TIMING_DIR or `<PI_CODING_AGENT_DIR | ~/.pi/agent>/pi-timing`. */
  timingDir?: string;
  /** Disable the compact timing ledger (trace recording is unaffected). */
  timingEnabled?: boolean;
  /** Capture token-level streaming updates. Disabled by default. */
  includeStreamingUpdates?: boolean;
  /** Parent/workflow identifiers propagated to child Pi processes. */
  traceContext?: TrajectoryTraceContext;
  /** Injectable clock and id factory for tests. */
  now?: () => number;
  idFactory?: () => string;
  processId?: number;
}

export function resolveTraceDirectory(traceDir?: string): string {
  return resolve(traceDir || process.env.PI_TRACE_DIR || DEFAULT_TRACE_DIR);
}

export function resolveTimingDirectory(timingDir?: string): string {
  return resolve(timingDir || process.env.PI_TIMING_DIR || DEFAULT_TIMING_DIR);
}

function timingScope(traceContext?: TrajectoryTraceContext): "root" | "child" {
  if (process.env.PI_SUBAGENT_WORKBENCH_CHILD === "1") return "child";
  if (!traceContext) return "root";
  return traceContext.parentSessionId ||
    traceContext.parentToolCallId ||
    traceContext.parentWorkId ||
    traceContext.workflowId ||
    traceContext.workId
    ? "child"
    : "root";
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalIndex(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function normalizeTraceContext(value: unknown): TrajectoryTraceContext | undefined {
  const source = asRecord(value);
  if (!source) return undefined;
  const traceContext: TrajectoryTraceContext = {
    ...(optionalString(source.parentSessionId) ? { parentSessionId: source.parentSessionId as string } : {}),
    ...(optionalString(source.parentToolCallId) ? { parentToolCallId: source.parentToolCallId as string } : {}),
    ...(optionalString(source.parentWorkflowId) ? { parentWorkflowId: source.parentWorkflowId as string } : {}),
    ...(optionalString(source.parentWorkId) ? { parentWorkId: source.parentWorkId as string } : {}),
    ...(optionalString(source.parentTaskId) ? { parentTaskId: source.parentTaskId as string } : {}),
    ...(optionalString(source.workflowId) ? { workflowId: source.workflowId as string } : {}),
    ...(optionalString(source.workId) ? { workId: source.workId as string } : {}),
    ...(optionalString(source.taskId) ? { taskId: source.taskId as string } : {}),
    ...(optionalString(source.taskKey) ? { taskKey: source.taskKey as string } : {}),
    ...(optionalIndex(source.stageIndex) === undefined ? {} : { stageIndex: optionalIndex(source.stageIndex) }),
    ...(optionalIndex(source.iterationIndex) === undefined ? {} : { iterationIndex: optionalIndex(source.iterationIndex) }),
    ...(optionalString(source.sourceWorkId) ? { sourceWorkId: source.sourceWorkId as string } : {}),
    ...(optionalString(source.sourceWorkflowId) ? { sourceWorkflowId: source.sourceWorkflowId as string } : {}),
    ...(optionalIndex(source.attempt) === undefined ? {} : { attempt: optionalIndex(source.attempt) }),
  };
  return Object.keys(traceContext).length > 0 ? traceContext : undefined;
}

export function parseTraceContext(raw: string | undefined): TrajectoryTraceContext | undefined {
  if (!raw) return undefined;
  try {
    return normalizeTraceContext(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

function traceContextFromEnvironment(): TrajectoryTraceContext | undefined {
  return parseTraceContext(process.env.PI_TRACE_CONTEXT);
}

function asRecord(value: unknown): UnknownRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : undefined;
}

/**
 * Clone data into JSON-safe values without redacting any field or string.
 * This never mutates the object supplied by Pi.
 */
export function toJsonSafe(value: unknown): unknown {
  const seen = new WeakSet<object>();

  const visit = (current: unknown): unknown => {
    if (current === undefined) return undefined;
    if (current === null || typeof current === "boolean" || typeof current === "number") {
      return Number.isNaN(current) ? null : current;
    }
    if (typeof current === "string") return current;
    if (typeof current === "bigint") return `${current}n`;
    if (typeof current === "function" || typeof current === "symbol") return String(current);
    if (typeof current !== "object") return String(current);

    if (seen.has(current)) return "[CIRCULAR]";
    seen.add(current);
    try {
      if (current instanceof Error) {
        return {
          name: current.name,
          message: current.message,
          ...(current.stack ? { stack: current.stack } : {}),
        };
      }
      if (Array.isArray(current)) return current.map(item => visit(item));

      const result: UnknownRecord = {};
      for (const [childKey, childValue] of Object.entries(current)) {
        const serialized = visit(childValue);
        if (serialized !== undefined) result[childKey] = serialized;
      }
      return result;
    } finally {
      seen.delete(current);
    }
  };

  return visit(value);
}

export function extractProviderThinking(payload: unknown): UnknownRecord {
  const root = asRecord(payload);
  if (!root) return {};
  const reasoning = asRecord(root.reasoning);
  const outputConfig = asRecord(root.output_config);
  const thinking = asRecord(root.thinking);
  const result: UnknownRecord = {};

  const add = (name: string, value: unknown): void => {
    if (value !== undefined) result[name] = value;
  };

  add("reasoningEffort", root.reasoning_effort);
  add("reasoningEffortNested", reasoning?.effort);
  add("outputConfigEffort", outputConfig?.effort);
  add("enableThinking", root.enable_thinking);
  add("thinkingType", thinking?.type);
  add("thinkingBudgetTokens", thinking?.budget_tokens);
  return result;
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function safePathPart(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9._-]/g, "_");
  return normalized || "unknown";
}

function ensureDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  try {
    chmodSync(path, 0o700);
  } catch {
    // Best effort on platforms/filesystems that do not support chmod.
  }
}

function modelSnapshot(model: unknown): UnknownRecord | undefined {
  const source = asRecord(model);
  if (!source) return undefined;
  const result: UnknownRecord = {};
  for (const key of ["provider", "id", "api", "reasoning", "contextWindow", "maxTokens"]) {
    if (source[key] !== undefined) result[key] = source[key];
  }
  if (Array.isArray(source.input)) result.input = source.input;
  return Object.keys(result).length > 0 ? result : undefined;
}

function currentThinkingLevel(pi: ExtensionAPI, ctx: ExtensionContext): unknown {
  if (ctx.thinkingLevel !== undefined) return ctx.thinkingLevel;
  try {
    return pi.getThinkingLevel();
  } catch {
    return undefined;
  }
}

function sessionValue(ctx: ExtensionContext, getter: "getSessionFile" | "getSessionName"): unknown {
  try {
    return ctx.sessionManager[getter]();
  } catch {
    return undefined;
  }
}

function compactModelData(model: unknown): UnknownRecord | undefined {
  return modelSnapshot(model);
}

function eventData(value: unknown): UnknownRecord {
  return asRecord(value) ?? { value };
}

export function registerTrajectoryRecorder(
  pi: ExtensionAPI,
  options: TrajectoryRecorderOptions = {},
): void {
  const now = options.now ?? (() => Date.now());
  const idFactory = options.idFactory ?? randomUUID;
  const traceDir = resolveTraceDirectory(options.traceDir);
  const timingDir = resolveTimingDirectory(options.timingDir);
  const timingEnabled = options.timingEnabled ?? true;
  const includeStreamingUpdates = options.includeStreamingUpdates ?? false;
  const configuredTraceContext = options.traceContext ?? traceContextFromEnvironment();
  const processId = options.processId ?? process.pid;
  let state: RecorderState | undefined;

  const createState = (ctx: ExtensionContext): RecorderState => {
    const sessionId = ctx.sessionManager.getSessionId();
    const sessionDir = join(traceDir, "sessions", safePathPart(sessionId));
    ensureDirectory(traceDir);
    ensureDirectory(join(traceDir, "sessions"));
    ensureDirectory(sessionDir);
    const eventsPath = join(sessionDir, `events-${safePathPart(String(processId))}.jsonl`);
    const timingPath = timingEnabled
      ? (ensureDirectory(timingDir), join(timingDir, `${safePathPart(sessionId)}.jsonl`))
      : undefined;
    return {
      sessionId,
      sessionFile: sessionValue(ctx, "getSessionFile") as string | undefined,
      traceContext: configuredTraceContext,
      sessionDir,
      eventsPath,
      ...(timingPath ? { timingPath } : {}),
      attempt: 0,
      toolExecutions: new Map(),
      writeFailureReported: false,
      runModelMs: 0,
      runToolMs: 0,
      runModelCount: 0,
      runToolCount: 0,
      runTurnCount: 0,
    };
  };

  const ensureState = (ctx: ExtensionContext): RecorderState => {
    const sessionId = ctx.sessionManager.getSessionId();
    if (!state || state.sessionId !== sessionId) state = createState(ctx);
    return state;
  };

  const reportWriteFailure = (ctx: ExtensionContext, current: RecorderState, error: unknown): void => {
    if (current.writeFailureReported) return;
    current.writeFailureReported = true;
    const message = error instanceof Error ? error.message : String(error);
    if (ctx.hasUI) ctx.ui.notify(`轨迹/计时记录失败，Pi 仍会继续运行：${message}`, "warning");
  };

  const record = (type: string, data: unknown, ctx: ExtensionContext): void => {
    const current = ensureState(ctx);
    const timestampMs = now();
    const envelope: UnknownRecord = {
      schemaVersion: TRACE_SCHEMA_VERSION,
      eventId: idFactory(),
      event: type,
      timestamp: new Date(timestampMs).toISOString(),
      timestampMs,
      pid: processId,
      sessionId: current.sessionId,
      ...(current.sessionFile ? { sessionFile: current.sessionFile } : {}),
      ...(current.traceContext ? { traceContext: current.traceContext } : {}),
      cwd: ctx.cwd,
      mode: ctx.mode,
      ...(current.runId ? { runId: current.runId } : {}),
      ...(current.turnIndex !== undefined ? { turnIndex: current.turnIndex } : {}),
      ...(current.attempt > 0 ? { attempt: current.attempt } : {}),
      ...eventData(data),
    };

    try {
      const serialized = JSON.stringify(toJsonSafe(envelope));
      appendFileSync(current.eventsPath, `${serialized}\n`, { encoding: "utf8", mode: 0o600 });
      try {
        chmodSync(current.eventsPath, 0o600);
      } catch {
        // Best effort on platforms/filesystems that do not support chmod.
      }
    } catch (error) {
      reportWriteFailure(ctx, current, error);
    }
  };

  /**
   * Compact, append-only timing ledger (one small JSON line per model call, tool
   * call, and agent run). Kept separate from the trace file, which stores full
   * payloads, so the dashboard can aggregate latency without scanning 10s of GB.
   */
  const writeTiming = (current: RecorderState, payload: UnknownRecord, ctx: ExtensionContext): void => {
    if (!current.timingPath) return;
    const at = now();
    const entry: UnknownRecord = {
      v: TIMING_SCHEMA_VERSION,
      id: idFactory(),
      at,
      sessionId: current.sessionId,
      scope: timingScope(current.traceContext),
      ...(current.sessionFile ? { sessionFile: current.sessionFile } : {}),
      cwd: ctx.cwd,
      mode: ctx.mode,
      ...(current.runId ? { runId: current.runId } : {}),
      ...payload,
    };
    try {
      appendFileSync(current.timingPath, `${JSON.stringify(toJsonSafe(entry))}\n`, { encoding: "utf8", mode: 0o600 });
      try {
        chmodSync(current.timingPath, 0o600);
      } catch {
        // Best effort on platforms/filesystems that do not support chmod.
      }
    } catch (error) {
      reportWriteFailure(ctx, current, error);
    }
  };

  const trackThinkingTiming = (current: RecorderState, assistantMessageEvent: unknown, at: number): void => {
    const pending = current.pendingRequest;
    if (!pending) return;
    const event = asRecord(assistantMessageEvent);
    if (!event) return;
    if (pending.firstDeltaAt === undefined) pending.firstDeltaAt = at;
    const contentIndex = optionalIndex(event.contentIndex);
    if (contentIndex === undefined) return;
    if (event.type === "thinking_start") {
      pending.thinkingStartedAt.set(contentIndex, at);
      return;
    }
    if (event.type === "thinking_end") {
      const startedAt = pending.thinkingStartedAt.get(contentIndex);
      if (startedAt === undefined) return;
      pending.thinkingMs += Math.max(0, at - startedAt);
      pending.thinkingStartedAt.delete(contentIndex);
    }
  };

  const closeOpenThinking = (pending: PendingRequest, at: number): void => {
    for (const startedAt of pending.thinkingStartedAt.values()) {
      pending.thinkingMs += Math.max(0, at - startedAt);
    }
    pending.thinkingStartedAt.clear();
  };

  const writeModelTiming = (
    current: RecorderState,
    message: UnknownRecord,
    pending: PendingRequest,
    endedAt: number,
    ctx: ExtensionContext,
  ): void => {
    closeOpenThinking(pending, endedAt);
    const usage = asRecord(message.usage);
    const totalMs = Math.max(0, endedAt - pending.startedAt);
    const ttftMs = pending.firstDeltaAt !== undefined
      ? Math.max(0, pending.firstDeltaAt - pending.startedAt)
      : pending.responseMs;
    const stopReason = optionalString(message.stopReason);
    const isError = stopReason === "error" || message.errorMessage !== undefined;
    current.runModelMs += totalMs;
    current.runModelCount += 1;
    writeTiming(current, {
      kind: "model",
      provider: optionalString(message.provider),
      model: optionalString(message.responseModel) || optionalString(message.model),
      attempt: pending.attempt,
      totalMs,
      ...(ttftMs === undefined ? {} : { ttftMs }),
      ...(pending.responseMs === undefined ? {} : { responseMs: pending.responseMs }),
      ...(pending.thinkingMs > 0 ? { thinkingMs: pending.thinkingMs } : {}),
      ...(finiteNumber(usage?.output) === undefined ? {} : { outputTokens: usage?.output }),
      ...(finiteNumber(usage?.reasoning) === undefined ? {} : { reasoningTokens: usage?.reasoning }),
      ...(pending.turnIndex === undefined ? {} : { turnIndex: pending.turnIndex }),
      ...(stopReason ? { stopReason } : {}),
      isError,
    }, ctx);
  };

  pi.on("session_start", (event, ctx) => {
    state = createState(ctx);
    record("session_start", {
      reason: event.reason,
      ...(event.previousSessionFile ? { previousSessionFile: event.previousSessionFile } : {}),
      sessionFile: sessionValue(ctx, "getSessionFile"),
      sessionName: sessionValue(ctx, "getSessionName"),
      process: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
      },
      recording: {
        redacted: false,
        includeStreamingUpdates,
        fullToolResults: true,
        fullProviderHeaders: true,
        truncation: false,
      },
    }, ctx);
  });

  pi.on("session_info_changed", (event, ctx) => {
    record("session_info_changed", { name: event.name }, ctx);
  });

  pi.on("session_shutdown", (event, ctx) => {
    record("session_shutdown", {
      reason: event.reason,
      ...(event.targetSessionFile ? { targetSessionFile: event.targetSessionFile } : {}),
      sessionFile: sessionValue(ctx, "getSessionFile"),
    }, ctx);
    state = undefined;
  });

  pi.on("input", (event, ctx) => {
    record("input", {
      text: event.text,
      ...(event.images?.length ? { images: event.images } : {}),
      source: event.source,
      ...(event.streamingBehavior ? { streamingBehavior: event.streamingBehavior } : {}),
    }, ctx);
  });

  pi.on("before_agent_start", (event, ctx) => {
    const current = ensureState(ctx);
    current.systemPromptHash = hashText(event.systemPrompt);
    record("before_agent_start", {
      prompt: event.prompt,
      ...(event.images?.length ? { images: event.images } : {}),
      systemPrompt: event.systemPrompt,
      systemPromptSha256: current.systemPromptHash,
      systemPromptOptions: event.systemPromptOptions,
    }, ctx);
  });

  pi.on("agent_start", (_event, ctx) => {
    const current = ensureState(ctx);
    current.runId = idFactory();
    current.turnIndex = undefined;
    current.attempt = 0;
    current.pendingRequest = undefined;
    current.runStartedAt = now();
    current.runModelMs = 0;
    current.runToolMs = 0;
    current.runModelCount = 0;
    current.runToolCount = 0;
    current.runTurnCount = 0;
    record("agent_start", {}, ctx);
  });

  pi.on("agent_end", (event, ctx) => {
    record("agent_end", { messages: event.messages }, ctx);
  });

  pi.on("agent_settled", (_event, ctx) => {
    const current = ensureState(ctx);
    record("agent_settled", {}, ctx);
    if (current.runStartedAt !== undefined) {
      writeTiming(current, {
        kind: "run",
        durationMs: Math.max(0, now() - current.runStartedAt),
        modelMs: current.runModelMs,
        toolMs: current.runToolMs,
        modelCount: current.runModelCount,
        toolCount: current.runToolCount,
        turnCount: current.runTurnCount,
      }, ctx);
      current.runStartedAt = undefined;
    }
  });

  pi.on("turn_start", (event, ctx) => {
    const current = ensureState(ctx);
    current.turnIndex = event.turnIndex;
    current.attempt = 0;
    current.runTurnCount += 1;
    record("turn_start", { timestamp: event.timestamp }, ctx);
  });

  pi.on("turn_end", (event, ctx) => {
    record("turn_end", {
      message: event.message,
      toolResults: event.toolResults,
    }, ctx);
  });

  pi.on("context", (event, ctx) => {
    record("context", { messages: event.messages }, ctx);
  });

  pi.on("before_provider_headers", (event, ctx) => {
    record("provider_headers", { headers: event.headers }, ctx);
  });

  pi.on("before_provider_request", (event, ctx) => {
    const current = ensureState(ctx);
    current.attempt += 1;
    const requestId = idFactory();
    const startedAt = now();
    current.pendingRequest = {
      requestId,
      startedAt,
      attempt: current.attempt,
      ...(current.turnIndex !== undefined ? { turnIndex: current.turnIndex } : {}),
      thinkingMs: 0,
      thinkingStartedAt: new Map(),
    };
    record("provider_request", {
      requestId,
      requestStartedAt: startedAt,
      model: compactModelData(ctx.model),
      piThinkingLevel: currentThinkingLevel(pi, ctx),
      providerThinking: extractProviderThinking(event.payload),
      ...(current.systemPromptHash ? { systemPromptSha256: current.systemPromptHash } : {}),
      payload: event.payload,
    }, ctx);
  });

  pi.on("after_provider_response", (event, ctx) => {
    const current = ensureState(ctx);
    const responseAt = now();
    const latencyMs = current.pendingRequest ? Math.max(0, responseAt - current.pendingRequest.startedAt) : undefined;
    if (current.pendingRequest && latencyMs !== undefined) current.pendingRequest.responseMs = latencyMs;
    record("provider_response", {
      requestId: current.pendingRequest?.requestId,
      status: event.status,
      headers: event.headers,
      responseAt,
      ...(latencyMs === undefined ? {} : { latencyMs }),
    }, ctx);
  });

  pi.on("message_start", (event, ctx) => {
    const message = asRecord(event.message);
    record("message_start", { role: message?.role }, ctx);
  });

  pi.on("message_end", (event, ctx) => {
    const current = ensureState(ctx);
    const message = asRecord(event.message);
    const endedAt = now();
    const link = message?.role === "assistant" && current.pendingRequest
      ? {
          requestId: current.pendingRequest.requestId,
          requestLatencyMs: Math.max(0, endedAt - current.pendingRequest.startedAt),
        }
      : undefined;
    record("message_end", {
      message: event.message,
      ...(link ?? {}),
    }, ctx);
    if (message?.role === "assistant" && current.pendingRequest) {
      writeModelTiming(current, message, current.pendingRequest, endedAt, ctx);
      current.pendingRequest = undefined;
    }
  });

  pi.on("message_update", (event, ctx) => {
    const current = ensureState(ctx);
    trackThinkingTiming(current, event.assistantMessageEvent, now());
    if (!includeStreamingUpdates) return;
    record("message_update", {
      message: event.message,
      assistantMessageEvent: event.assistantMessageEvent,
    }, ctx);
  });

  pi.on("tool_execution_start", (event, ctx) => {
    const current = ensureState(ctx);
    current.toolExecutions.set(event.toolCallId, {
      toolName: event.toolName,
      startedAt: now(),
      args: event.args,
      resultRecorded: false,
    });
    record("tool_execution_start", {
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      args: event.args,
    }, ctx);
  });

  pi.on("tool_call", (event, ctx) => {
    // This extension is loaded last, so input is the effective post-middleware value.
    record("tool_call", {
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      input: event.input,
    }, ctx);
  });

  pi.on("tool_execution_update", (event, ctx) => {
    if (!includeStreamingUpdates) return;
    record("tool_execution_update", {
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      args: event.args,
      partialResult: event.partialResult,
    }, ctx);
  });

  pi.on("tool_result", (event, ctx) => {
    const current = ensureState(ctx);
    const pending = current.toolExecutions.get(event.toolCallId);
    const completedAt = now();
    if (pending) pending.resultRecorded = true;
    record("tool_result", {
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      input: event.input,
      content: event.content,
      details: event.details,
      usage: event.usage,
      isError: event.isError,
      ...(pending ? { durationMs: Math.max(0, completedAt - pending.startedAt) } : {}),
    }, ctx);
    if (pending?.endedAt !== undefined) current.toolExecutions.delete(event.toolCallId);
  });

  pi.on("tool_execution_end", (event, ctx) => {
    const current = ensureState(ctx);
    const pending = current.toolExecutions.get(event.toolCallId);
    const endedAt = now();
    if (pending) pending.endedAt = endedAt;
    const durationMs = pending ? Math.max(0, endedAt - pending.startedAt) : undefined;
    record("tool_execution_end", {
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      result: event.result,
      isError: event.isError,
      ...(durationMs === undefined ? {} : { durationMs }),
    }, ctx);
    if (durationMs !== undefined) {
      current.runToolMs += durationMs;
      current.runToolCount += 1;
      writeTiming(current, {
        kind: "tool",
        toolName: event.toolName,
        durationMs,
        isError: event.isError === true,
      }, ctx);
    }
    if (pending?.resultRecorded) current.toolExecutions.delete(event.toolCallId);
  });

  pi.on("model_select", (event, ctx) => {
    record("model_select", {
      model: modelSnapshot(event.model),
      previousModel: modelSnapshot(event.previousModel),
      source: event.source,
    }, ctx);
  });

  pi.on("thinking_level_select", (event, ctx) => {
    record("thinking_level_select", {
      level: event.level,
      previousLevel: event.previousLevel,
    }, ctx);
  });

  pi.on("user_bash", (event, ctx) => {
    record("user_bash", {
      command: event.command,
      excludeFromContext: event.excludeFromContext,
      cwd: event.cwd,
    }, ctx);
  });

  pi.on("session_before_compact", (event, ctx) => {
    record("session_before_compact", {
      preparation: event.preparation,
      reason: event.reason,
      willRetry: event.willRetry,
    }, ctx);
  });

  pi.on("session_compact", (event, ctx) => {
    record("session_compact", {
      compactionEntry: event.compactionEntry,
      fromExtension: event.fromExtension,
      reason: event.reason,
      willRetry: event.willRetry,
    }, ctx);
  });

  pi.on("session_tree", (event, ctx) => {
    record("session_tree", {
      newLeafId: event.newLeafId,
      oldLeafId: event.oldLeafId,
      summaryEntry: event.summaryEntry,
      fromExtension: event.fromExtension,
    }, ctx);
  });
}

export default function trajectoryRecorderExtension(pi: ExtensionAPI): void {
  registerTrajectoryRecorder(pi);
}
