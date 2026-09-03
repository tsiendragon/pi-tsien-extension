import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { LiveSessionClient, type LiveSessionClientOptions } from "./live-session/client.ts";
import { LeaseError, LeaseManager, type LeaseSnapshot } from "./live-session/lease.ts";
import { SnapshotProjector } from "./live-session/projector.ts";
import { dispatchLiveFeatureCommand, subscribeLiveFeatures } from "./lib/live-observer.ts";
import {
  LIVE_SESSION_PROTOCOL_VERSION,
  type CommandEnvelope,
  type CommandExecutionResult,
  type EventMessage,
  type JsonObject,
  type LiveSessionMode,
  type LiveSessionSummaryBase,
} from "./live-session/protocol.ts";

const PROCESS_IDENTITY_SYMBOL = Symbol.for("pi.live-session.process-identity.v1");
const LIVE_FEATURE_PUBLISH_INTERVAL_MS = 250;

type PendingFeatureSnapshot = {
  snapshot: unknown;
  ctx: ExtensionContext;
};

interface ProcessIdentity {
  readonly processInstanceId: string;
  readonly startedAt: number;
}

export interface LiveSessionClientHandle {
  start(): void;
  /** Optional for test/dummy clients; real clients report broker readiness. */
  isReady?(): boolean;
  publish(message: EventMessage): void;
  sendSnapshot(): void;
  stop(reason?: string): void;
}

export interface LiveSessionExtensionOptions {
  readonly identity?: ProcessIdentity;
  readonly snapshotEntryLimit?: number;
  readonly createClient?: (options: LiveSessionClientOptions) => LiveSessionClientHandle;
}

function processIdentity(): ProcessIdentity {
  const store = globalThis as unknown as Record<PropertyKey, unknown>;
  const existing = store[PROCESS_IDENTITY_SYMBOL];
  if (typeof existing === "object" && existing !== null) {
    const candidate = existing as Partial<ProcessIdentity>;
    if (typeof candidate.processInstanceId === "string" && typeof candidate.startedAt === "number") {
      return candidate as ProcessIdentity;
    }
  }
  const created = { processInstanceId: randomUUID(), startedAt: Date.now() };
  store[PROCESS_IDENTITY_SYMBOL] = created;
  return created;
}

function leaseJson(snapshot: LeaseSnapshot): JsonObject {
  return snapshot.state === "claimed"
    ? {
        state: "claimed",
        leaseId: snapshot.leaseId ?? "",
        browserClientId: snapshot.browserClientId ?? "",
        expiresAt: snapshot.expiresAt ?? 0,
      }
    : { state: "unclaimed" };
}

function commandError(code: string, message: string): CommandExecutionResult {
  return { ok: false, error: { code, message } };
}

function isVisibleMessage(message: unknown): boolean {
  if (!message || typeof message !== "object" || Array.isArray(message)) return false;
  const record = message as Record<string, unknown>;
  if (record.role === "custom") return record.display === true && record.customType !== "goal-context";
  return record.role === "user" || record.role === "assistant" || record.role === "toolResult";
}

export function registerLiveSessionExtension(
  pi: ExtensionAPI,
  options: LiveSessionExtensionOptions = {},
): void {
  const identity = options.identity ?? processIdentity();
  const createClient = options.createClient ?? ((clientOptions) => new LiveSessionClient(clientOptions));
  let currentContext: ExtensionContext | undefined;
  let client: LiveSessionClientHandle | undefined;
  let projector: SnapshotProjector | undefined;
  let running = false;
  let reconnecting = false;
  let featureCleanup: (() => void) | undefined;
  let featurePublishTimer: ReturnType<typeof setTimeout> | undefined;
  const pendingFeatureSnapshots = new Map<string, PendingFeatureSnapshot>();
  let lastActivityAt = identity.startedAt;

  const clientIsReady = (): boolean => {
    const current = client;
    return Boolean(current) && (current?.isReady?.() ?? true);
  };

  const publish = (type: string, data: unknown, ctx?: ExtensionContext): void => {
    if (ctx) currentContext = ctx;
    lastActivityAt = Date.now();
    const currentClient = client;
    if (!projector || !currentClient || (currentClient.isReady && !currentClient.isReady())) return;
    const event = projector.createEvent(type, data);
    currentClient.publish(event);
  };

  const clearFeaturePublishQueue = (): void => {
    if (featurePublishTimer) clearTimeout(featurePublishTimer);
    featurePublishTimer = undefined;
    pendingFeatureSnapshots.clear();
  };

  const flushFeatureSnapshots = (): void => {
    if (featurePublishTimer) clearTimeout(featurePublishTimer);
    featurePublishTimer = undefined;
    if (!clientIsReady()) return;

    const pending = [...pendingFeatureSnapshots.entries()];
    pendingFeatureSnapshots.clear();
    for (const [feature, value] of pending) {
      publish("live_feature_snapshot", { feature, snapshot: value.snapshot }, value.ctx);
    }
  };

  const queueFeatureSnapshot = (
    feature: string,
    snapshot: unknown,
    ctx: ExtensionContext,
  ): void => {
    pendingFeatureSnapshots.set(feature, { snapshot, ctx });
    if (featurePublishTimer) return;
    featurePublishTimer = setTimeout(
      flushFeatureSnapshots,
      LIVE_FEATURE_PUBLISH_INTERVAL_MS,
    );
    featurePublishTimer.unref?.();
  };

  const lease = new LeaseManager({
    onChange: (snapshot, reason) => {
      projector?.markChanged();
      publish("claim_changed", { claim: leaseJson(snapshot), reason });
    },
  });

  const summary = (): LiveSessionSummaryBase => {
    const ctx = currentContext;
    if (!ctx) throw new Error("Live Session context is unavailable");
    const usage = ctx.getContextUsage();
    const claim = lease.snapshot();
    const mode: LiveSessionMode = ctx.mode === "rpc" ? "rpc" : "tui";
    return {
      processInstanceId: identity.processInstanceId,
      sessionId: ctx.sessionManager.getSessionId(),
      ...(ctx.sessionManager.getSessionFile() ? { sessionFile: ctx.sessionManager.getSessionFile() } : {}),
      ...(ctx.sessionManager.getSessionName() ? { sessionName: ctx.sessionManager.getSessionName() } : {}),
      pid: process.pid,
      cwd: ctx.sessionManager.getCwd(),
      canonicalCwd: ctx.sessionManager.getCwd(),
      mode,
      ...(ctx.model ? { model: { provider: ctx.model.provider, id: ctx.model.id } } : {}),
      ...(ctx.thinkingLevel ? { thinkingLevel: ctx.thinkingLevel } : {}),
      status: reconnecting ? "reconnecting" : running ? "running" : "idle",
      claim: claim.state === "claimed"
        ? { state: "claimed", leaseId: claim.leaseId, expiresAt: claim.expiresAt }
        : { state: "unclaimed" },
      startedAt: identity.startedAt,
      lastActivityAt,
      ...(usage
        ? {
            contextUsage: {
              tokens: usage.tokens,
              contextWindow: usage.contextWindow,
              percent: usage.percent,
            },
          }
        : {}),
    };
  };

  const executeCommand = async (envelope: CommandEnvelope): Promise<CommandExecutionResult> => {
    const ctx = currentContext;
    if (!ctx) return commandError("session_unavailable", "Session context is unavailable");
    const command = envelope.command;
    try {
      if (command.type === "claim") {
        return { ok: true, result: leaseJson(lease.claim(command.browserClientId, command.requestedLeaseMs)) };
      }
      if (command.type === "renew") {
        return { ok: true, result: leaseJson(lease.renew(command.leaseId)) };
      }
      if (command.type === "release") {
        const released = lease.release(command.leaseId, "remote_release");
        return { ok: true, result: { released } };
      }
      if (command.type === "prompt") {
        lease.assertLease(command.leaseId);
        if (ctx.isIdle()) {
          pi.sendUserMessage(command.text, { expandPromptTemplates: false });
        } else {
          if (!command.deliverAs) {
            return commandError("deliver_as_required", "Running sessions require steer or followUp delivery");
          }
          pi.sendUserMessage(command.text, {
            deliverAs: command.deliverAs,
            expandPromptTemplates: false,
          });
        }
        return { ok: true, result: { accepted: true } };
      }
      if (command.type === "abort") {
        lease.assertLease(command.leaseId);
        if (ctx.isIdle()) return { ok: true, result: { aborted: false, reason: "idle" } };
        ctx.abort();
        return { ok: true, result: { aborted: true } };
      }
      if (command.type === "feature_command") {
        lease.assertLease(command.leaseId);
        const result = await dispatchLiveFeatureCommand(command.feature, command.command);
        return { ok: true, result: result as JsonObject };
      }
      return { ok: true, result: { resynced: true } };
    } catch (error) {
      if (error instanceof LeaseError) return commandError(error.code, error.message);
      return commandError("command_failed", error instanceof Error ? error.message : String(error));
    }
  };

  pi.registerCommand("dashboard-release", {
    description: "立即归还 Dashboard 对当前 session 的控制权",
    handler: async (_args, ctx) => {
      const released = lease.release(undefined, "local_release");
      ctx.ui.notify(
        released ? "已收回 Dashboard 控制权。" : "当前 session 未被 Dashboard 接管。",
        "info",
      );
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    currentContext = ctx;
    running = !ctx.isIdle();
    reconnecting = false;
    lastActivityAt = Date.now();
    if (process.env.PI_RUNTIME === "dashboard" || ctx.mode === "print" || ctx.mode === "json") return;
    if (ctx.mode !== "tui" && ctx.mode !== "rpc") return;
    const mode: LiveSessionMode = ctx.mode;

    client?.stop("session_switch");
    featureCleanup?.();
    featureCleanup = undefined;
    clearFeaturePublishQueue();
    lease.release(undefined, "session_switch");
    projector = new SnapshotProjector({
      processInstanceId: identity.processInstanceId,
      snapshotEntryLimit: options.snapshotEntryLimit,
      getSummary: summary,
      getBranch: () => currentContext?.sessionManager.getBranch() ?? [],
    });
    client = createClient({
      processInstanceId: identity.processInstanceId,
      getHello: (brokerToken) => ({
        type: "hello",
        protocolVersion: LIVE_SESSION_PROTOCOL_VERSION,
        brokerToken,
        processInstanceId: identity.processInstanceId,
        pid: process.pid,
        cwd: ctx.sessionManager.getCwd(),
        mode,
        sessionId: ctx.sessionManager.getSessionId(),
      }),
      getSnapshot: () => {
        if (!projector) throw new Error("Live Session projector is unavailable");
        return projector.createSnapshot();
      },
      executeCommand,
      onConnected: () => {
        reconnecting = false;
        lease.markBrokerConnected();
        projector?.markChanged();
        // The client sends its initial session snapshot immediately after this callback.
        // Flush feature state in a microtask so that snapshot remains first on the wire.
        queueMicrotask(flushFeatureSnapshots);
      },
      onDisconnected: () => {
        reconnecting = true;
        projector?.markChanged();
        lease.markBrokerDisconnected();
      },
    });
    client.start();
    featureCleanup = subscribeLiveFeatures((feature, snapshot) => {
      queueFeatureSnapshot(feature, snapshot, ctx);
    });
  });

  pi.on("session_info_changed", (event, ctx) => publish("session_info_changed", { name: event.name ?? null }, ctx));
  pi.on("agent_start", (_event, ctx) => {
    running = true;
    publish("agent_start", {}, ctx);
  });
  pi.on("agent_end", (event, ctx) => publish("agent_end", { messages: event.messages }, ctx));
  pi.on("agent_settled", (_event, ctx) => {
    running = false;
    publish("agent_settled", {}, ctx);
  });
  pi.on("turn_start", (event, ctx) => publish("turn_start", event, ctx));
  pi.on("turn_end", (event, ctx) => publish("turn_end", event, ctx));
  pi.on("message_start", (event, ctx) => {
    if (isVisibleMessage(event.message)) publish("message_start", { message: event.message }, ctx);
  });
  pi.on("message_update", (event, ctx) => {
    if (isVisibleMessage(event.message)) publish("message_update", {
      message: event.message,
      assistantMessageEvent: event.assistantMessageEvent,
    }, ctx);
  });
  pi.on("message_end", (event, ctx) => {
    if (isVisibleMessage(event.message)) publish("message_end", { message: event.message }, ctx);
  });
  pi.on("tool_execution_start", (event, ctx) => publish("tool_execution_start", event, ctx));
  pi.on("tool_execution_update", (event, ctx) => publish("tool_execution_update", event, ctx));
  pi.on("tool_execution_end", (event, ctx) => publish("tool_execution_end", event, ctx));
  pi.on("model_select", (event, ctx) => publish("model_select", {
    model: { provider: event.model.provider, id: event.model.id },
    previousModel: event.previousModel
      ? { provider: event.previousModel.provider, id: event.previousModel.id }
      : null,
    source: event.source,
  }, ctx));
  pi.on("thinking_level_select", (event, ctx) => publish("thinking_level_select", {
    level: event.level,
    previousLevel: event.previousLevel,
  }, ctx));

  pi.on("input", (event, ctx) => {
    currentContext = ctx;
    if (!lease.isClaimed() || event.source === "extension") return { action: "continue" };
    if (event.source === "interactive") {
      ctx.ui.notify(
        "当前 session 由 Dashboard 控制；输入 /dashboard-release 可收回控制权",
        "warning",
      );
    }
    return { action: "handled" };
  });

  pi.on("session_shutdown", (event) => {
    lease.dispose(event.reason === "quit" ? "session_shutdown" : "session_switch");
    featureCleanup?.();
    featureCleanup = undefined;
    clearFeaturePublishQueue();
    client?.stop(event.reason === "quit" ? "session_shutdown" : "session_switch");
    client = undefined;
    projector = undefined;
    currentContext = undefined;
    running = false;
    reconnecting = false;
  });
}

export default function liveSessionExtension(pi: ExtensionAPI): void {
  registerLiveSessionExtension(pi);
}
