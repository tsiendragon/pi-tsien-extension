import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext, InputEvent } from "@earendil-works/pi-coding-agent";
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
  type LiveSessionInputChannel,
  type LiveSessionMode,
  type LiveSessionSummaryBase,
} from "./live-session/protocol.ts";

const PROCESS_IDENTITY_SYMBOL = Symbol.for("pi.live-session.process-identity.v1");
const LIVE_FEATURE_PUBLISH_INTERVAL_MS = 250;

/**
 * Live Session is only meaningful for the interactive TUI and the rpc bridge.
 * In print/json/dashboard runs there is no broker, and Pi marks the CLI prompt's
 * `input` event as `source: "interactive"` — so without this guard the input
 * handler would swallow the prompt and the headless run would produce no reply.
 */
function isLiveSessionActive(
  ctx: ExtensionContext,
): ctx is ExtensionContext & { mode: LiveSessionMode } {
  return process.env.PI_RUNTIME !== "dashboard" && (ctx.mode === "tui" || ctx.mode === "rpc");
}

type PendingFeatureSnapshot = {
  snapshot: unknown;
  ctx: ExtensionContext;
};

type QueuedInput = {
  channel: LiveSessionInputChannel;
  text: string;
  images?: InputEvent["images"];
  deliverAs?: "steer" | "followUp";
  expandPromptTemplates: boolean;
};

interface ProcessIdentity {
  readonly processInstanceId: string;
  readonly startedAt: number;
}

interface SessionLineage {
  readonly role: "main" | "subagent";
  readonly parentSessionId?: string;
  readonly parentToolCallId?: string;
  readonly subagentWorkId?: string;
}

function sessionLineage(): SessionLineage {
  if (process.env.PI_SUBAGENT_WORKBENCH_CHILD !== "1") return { role: "main" };
  try {
    const raw = JSON.parse(process.env.PI_TRACE_CONTEXT || "{}") as Record<string, unknown>;
    const bounded = (value: unknown): string | undefined => typeof value === "string" && value.length > 0 ? value.slice(0, 512) : undefined;
    return {
      role: "subagent",
      ...(bounded(raw.parentSessionId) ? { parentSessionId: bounded(raw.parentSessionId) } : {}),
      ...(bounded(raw.parentToolCallId) ? { parentToolCallId: bounded(raw.parentToolCallId) } : {}),
      ...(bounded(raw.workId) ? { subagentWorkId: bounded(raw.workId) } : {}),
    };
  } catch {
    return { role: "subagent" };
  }
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
  const lineage = sessionLineage();
  const createClient = options.createClient ?? ((clientOptions) => new LiveSessionClient(clientOptions));
  let currentContext: ExtensionContext | undefined;
  let client: LiveSessionClientHandle | undefined;
  let projector: SnapshotProjector | undefined;
  let running = false;
  let reconnecting = false;
  let featureCleanup: (() => void) | undefined;
  let featurePublishTimer: ReturnType<typeof setTimeout> | undefined;
  const pendingFeatureSnapshots = new Map<string, PendingFeatureSnapshot>();
  const inputQueue: QueuedInput[] = [];
  let activeInput: QueuedInput | undefined;
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

  const drainInputQueue = (): void => {
    if (activeInput || !currentContext) return;
    const next = inputQueue.shift();
    if (!next) return;
    activeInput = next;
    const content: Parameters<ExtensionAPI["sendUserMessage"]>[0] = next.images?.length
      ? [{ type: "text", text: next.text }, ...next.images]
      : next.text;
    // Release the in-flight input when this dispatch actually completes.
    // For a model prompt sendUserMessage resolves at the end of the turn; for a
    // slash command (e.g. /effort raising a dialog) pi executes the extension
    // command and returns without any agent turn, so a turn-based release
    // (agent_end) never fires and would wedge the queue forever.
    void Promise.resolve(
      pi.sendUserMessage(content, {
        ...(next.deliverAs ? { deliverAs: next.deliverAs } : {}),
        expandPromptTemplates: next.expandPromptTemplates,
      }),
    ).catch(() => {}).finally(() => {
      if (activeInput !== next) return;
      activeInput = undefined;
      queueMicrotask(drainInputQueue);
    });
  };

  const enqueueInput = (input: QueuedInput): void => {
    inputQueue.push(input);
    drainInputQueue();
  };

  const clearInputQueue = (): void => {
    inputQueue.length = 0;
    activeInput = undefined;
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

  /**
   * Capabilities this bridge advertises to the dashboard (see
   * `LiveSessionSummary.capabilities`). `session_tree` means the `/ls-navigate`
   * and `/ls-fork` extension commands below are registered, so the dashboard may
   * send them. Additive: no protocol version bump.
   */
  const LIVE_SESSION_CAPABILITIES: readonly string[] = ["session_tree"];

  const summary = (): LiveSessionSummaryBase => {
    const ctx = currentContext;
    if (!ctx) throw new Error("Live Session context is unavailable");
    const usage = ctx.getContextUsage();
    const claim = lease.snapshot();
    const mode: LiveSessionMode = ctx.mode === "rpc" ? "rpc" : "tui";
    return {
      processInstanceId: identity.processInstanceId,
      sessionId: ctx.sessionManager.getSessionId(),
      ...lineage,
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
      capabilities: LIVE_SESSION_CAPABILITIES,
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

  pi.registerTool({
    name: "set_session_title",
    label: "Set session title",
    description: "Set a short natural-language title for the current Pi session. Use this when the user's main goal becomes clear or changes. Keep it under 80 characters.",
    promptSnippet: "Set the current session's short display title.",
    parameters: Type.Object({
      title: Type.String({ minLength: 1, maxLength: 80, description: "Short natural-language session title" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const title = params.title.trim().slice(0, 80);
      if (!title) return { content: [{ type: "text", text: "session title must not be empty" }], details: { code: "invalid_title" }, isError: true };
      pi.setSessionName(title);
      return { content: [{ type: "text", text: `Session title set: ${title}` }], details: { title } };
    },
  });

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
      if (command.type === "input") {
        // 统一输入模型：与 TUI 逐字等价，命令/skill/template 统一展开。
        // running 且未显式指定交付方式时，默认 followUp 排队（等价 TUI 运行中继续输入）。
        const deliverAs = command.deliverAs ?? (!ctx.isIdle() ? "followUp" : undefined);
        enqueueInput({
          channel: command.channel,
          text: command.text,
          ...(command.images?.length ? { images: command.images.map(image => ({ type: "image" as const, data: image.data, mimeType: image.mimeType })) } : {}),
          ...(deliverAs ? { deliverAs } : {}),
          expandPromptTemplates: true,
        });
        return { ok: true, result: { accepted: true } };
      }
      if (command.type === "abort") {
        lease.assertLease(command.leaseId);
        if (ctx.isIdle()) return { ok: true, result: { aborted: false, reason: "idle" } };
        ctx.abort();
        return { ok: true, result: { aborted: true } };
      }
      if (command.type === "set_session_name") {
        const name = command.name.trim().slice(0, 80);
        if (!name) return commandError("invalid_title", "session title must not be empty");
        pi.setSessionName(name);
        return { ok: true, result: { name } };
      }
      if (command.type === "get_models") {
        // Mirror the built-in picker: `ctx.scopedModels` is resolved from the
        // `--models` flag and the `enabledModels` setting, so it is exactly the
        // "models we actually use" set (see docs/extensions.md). Enumerating
        // `getAvailable()` instead would list every catalog model of every
        // credentialed provider. Empty scope = no scoping configured → keep the
        // old full-catalog behaviour.
        const scoped = ctx.scopedModels ?? [];
        const models = (scoped.length ? scoped.map(entry => entry.model) : ctx.modelRegistry.getAvailable()).map(model => ({
          provider: model.provider,
          id: model.id,
          name: model.name,
          reasoning: model.reasoning,
          contextWindow: model.contextWindow,
          thinkingLevels: Object.keys(model.thinkingLevelMap || {}),
        }));
        return { ok: true, result: { models } };
      }
      if (command.type === "set_model") {
        const model = ctx.modelRegistry.find(command.provider, command.modelId);
        if (!model) return commandError("model_not_found", `${command.provider}/${command.modelId} is not available`);
        const changed = await pi.setModel(model);
        return changed ? { ok: true, result: { provider: command.provider, modelId: command.modelId } } : commandError("model_not_changed", "model was not changed");
      }
      if (command.type === "compact") {
        lease.assertLease(command.leaseId);
        if (!ctx.isIdle()) return commandError("session_busy", "wait for the current response before compacting");
        await ctx.compact();
        return { ok: true, result: { compacted: true } };
      }
      if (command.type === "reload") {
        pi.sendUserMessage("/live-session-reload", { expandPromptTemplates: true, ...(ctx.isIdle() ? {} : { deliverAs: "followUp" }) });
        return { ok: true, result: { reloading: true } };
      }
      if (command.type === "feature_command") {
        lease.assertLease(command.leaseId);
        const result = await dispatchLiveFeatureCommand(command.feature, command.command);
        return { ok: true, result: result as JsonObject };
      }
      if (command.type === "answer_ui") {
        // 首答胜出，任意渠道可应答，故不做 lease 校验。
        const accepted = pi.respondExtensionUi(command.id, {
          ...(command.cancelled ? { cancelled: true } : { value: command.value }),
        });
        return { ok: true, result: { accepted } };
      }
      return { ok: true, result: { resynced: true } };
    } catch (error) {
      if (error instanceof LeaseError) return commandError(error.code, error.message);
      return commandError("command_failed", error instanceof Error ? error.message : String(error));
    }
  };

  pi.registerCommand("dashboard-release", {
    description: "立即释放 Dashboard 对当前 session 的强控制权限",
    handler: async (_args, ctx) => {
      const released = lease.release(undefined, "local_release");
      ctx.ui.notify(
        released ? "已释放 Dashboard 强控制权限。" : "当前 session 没有 Dashboard 强控制权限。",
        "info",
      );
    },
  });

  pi.registerCommand("live-session-reload", {
    description: "通过 live-session 触发 reload（重载 extensions/skills/prompts/themes）",
    handler: async (_args, ctx) => {
      await ctx.reload();
    },
  });

  /**
   * Session-tree actions for the dashboard graph page.
   *
   * These are plain extension slash commands on purpose: the dashboard already
   * has an `input` command channel that runs text through
   * `pi.sendUserMessage(..., { expandPromptTemplates: true })`, and pi executes
   * a leading `/` as a command (same mechanism as `/live-session-reload`). That
   * keeps the whole feature inside the two repos with **no wire-protocol change**
   * and no `parseHello` version negotiation.
   *
   * Trust model: like `input`, this channel carries no browserClientId, so a
   * caller cannot be authenticated here. Two guards apply instead — the action
   * is refused while the agent is not idle (pi rejects `navigateTree` during a
   * turn/compaction anyway), and when the session IS claimed by a browser the
   * matching leaseId must be supplied. Every navigation then broadcasts
   * `session_tree`, so all viewers (terminal + web) stay consistent.
   */
  const treeActionDenial = (leaseId: string | undefined): string | null => {
    const claim = lease.snapshot();
    if (claim.state !== "claimed") return null;
    if (!leaseId) return "该会话已被浏览器接管，请在 Dashboard 图谱页重新发起操作。";
    try {
      lease.assertLease(leaseId);
      return null;
    } catch {
      return "Dashboard 接管已失效，请刷新页面后重试。";
    }
  };

  const parseTreeArgs = (args: string): { targetId: string; leaseId?: string } => {
    const [targetId = "", leaseId] = args.trim().split(/\s+/);
    return { targetId, ...(leaseId ? { leaseId } : {}) };
  };

  pi.registerCommand("ls-navigate", {
    description: "切换到会话树的指定节点（pi-dashboard 图谱页调用）",
    handler: async (args, ctx) => {
      const { targetId, leaseId } = parseTreeArgs(args);
      if (!targetId) {
        ctx.ui.notify("用法：/ls-navigate <entry-id> [leaseId]", "error");
        return;
      }
      const denial = treeActionDenial(leaseId);
      if (denial) {
        ctx.ui.notify(denial, "error");
        return;
      }
      if (!ctx.isIdle()) {
        ctx.ui.notify("会话正在运行，请等当前回合结束后再切换分支。", "warning");
        return;
      }
      try {
        const result = await ctx.navigateTree(targetId);
        ctx.ui.notify(result.cancelled ? "已取消分支切换。" : `已切换到 ${targetId}。`, "info");
      } catch (error) {
        ctx.ui.notify(`切换分支失败：${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });

  pi.registerCommand("ls-fork", {
    description: "从会话树的指定节点分叉出新会话（pi-dashboard 图谱页调用）",
    handler: async (args, ctx) => {
      const { targetId, leaseId } = parseTreeArgs(args);
      if (!targetId) {
        ctx.ui.notify("用法：/ls-fork <entry-id> [leaseId]", "error");
        return;
      }
      const denial = treeActionDenial(leaseId);
      if (denial) {
        ctx.ui.notify(denial, "error");
        return;
      }
      if (!ctx.isIdle()) {
        ctx.ui.notify("会话正在运行，请等当前回合结束后再分叉。", "warning");
        return;
      }
      try {
        const result = await ctx.fork(targetId, { position: "at" });
        if (result.cancelled) {
          ctx.ui.notify("已取消分叉。", "info");
          return;
        }
        // A fork swaps the session file in place, and pi has no post-fork event,
        // so push a fresh snapshot explicitly instead of waiting for the next
        // event: the web needs the new sessionId/sessionFile immediately.
        projector?.markChanged();
        client?.sendSnapshot();
        publish("session_tree", { newLeafId: null, oldLeafId: null, fromExtension: true }, ctx);
      } catch (error) {
        ctx.ui.notify(`分叉失败：${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    currentContext = ctx;
    running = !ctx.isIdle();
    reconnecting = false;
    lastActivityAt = Date.now();
    if (!isLiveSessionActive(ctx)) return;
    const mode: LiveSessionMode = ctx.mode;

    client?.stop("session_switch");
    featureCleanup?.();
    featureCleanup = undefined;
    clearFeaturePublishQueue();
    clearInputQueue();
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
  // Tree navigation (terminal `/tree`, or the web `/ls-navigate` above).
  // The snapshot only carries the ACTIVE branch, so without this subscription a
  // terminal-side branch switch would leave the web transcript showing the old
  // branch. `markChanged()` bumps the revision and `sendSnapshot()` pushes the
  // re-projected branch.
  pi.on("session_tree", (event, ctx) => {
    projector?.markChanged();
    client?.sendSnapshot();
    publish("session_tree", {
      newLeafId: event.newLeafId,
      oldLeafId: event.oldLeafId,
      fromExtension: event.fromExtension ?? false,
    }, ctx);
  });
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
    if (!isVisibleMessage(event.message)) return;
    const record = event.message as unknown as Record<string, unknown>;
    const completedInput = record.role === "user" ? activeInput : undefined;
    const entries = typeof ctx.sessionManager.getEntries === "function" ? ctx.sessionManager.getEntries() : [];
    const entryId = record.role === "user" ? undefined : [...entries].reverse().find(entry => {
      const candidate = entry as unknown as Record<string, unknown>;
      return candidate.type === "message" && candidate.message === event.message && typeof candidate.id === "string";
    }) as unknown as Record<string, unknown> | undefined;
    publish("message_end", {
      message: event.message,
      ...(completedInput ? { channel: completedInput.channel } : {}),
      ...(entryId?.id ? { entryId: entryId.id } : {}),
    }, ctx);
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

  pi.on("extension_ui", (event, ctx) => {
    if (event.closed) {
      publish("extension_ui_closed", { id: event.id }, ctx);
      return;
    }
    publish(
      "extension_ui",
      {
        id: event.id,
        method: event.method,
        title: event.title,
        ...(event.message !== undefined ? { message: event.message } : {}),
        ...(event.options !== undefined ? { options: event.options } : {}),
        ...(event.placeholder !== undefined ? { placeholder: event.placeholder } : {}),
        ...(event.prefill !== undefined ? { prefill: event.prefill } : {}),
      },
      ctx,
    );
  });

  // One-way notifications: /goal prints its command options via ctx.ui.notify,
  // which must mirror to the web UI just like the interactive dialogs above.
  pi.on("extension_ui_notify", (event, ctx) =>
    publish("extension_ui_notify", { message: event.message, notifyType: event.notifyType }, ctx),
  );

  pi.on("input", (event, ctx) => {
    if (!isLiveSessionActive(ctx)) return { action: "continue" };
    currentContext = ctx;
    if (event.source !== "interactive") return { action: "continue" };
    enqueueInput({
      channel: "terminal",
      text: event.text,
      ...(event.images?.length ? { images: event.images } : {}),
      ...(event.streamingBehavior ? { deliverAs: event.streamingBehavior } : {}),
      expandPromptTemplates: true,
    });
    return { action: "handled" };
  });

  pi.on("session_shutdown", (event) => {
    lease.dispose(event.reason === "quit" ? "session_shutdown" : "session_switch");
    featureCleanup?.();
    featureCleanup = undefined;
    clearFeaturePublishQueue();
    clearInputQueue();
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
