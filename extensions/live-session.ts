import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { Type } from "typebox";
import {
  SettingsManager,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type InputEvent,
} from "@earendil-works/pi-coding-agent";
import { autoCompactTargetConfig, resolveCompactionTrigger } from "./auto-compact-target/core.ts";
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
  type LiveSessionStatus,
  type LiveSessionSummaryBase,
} from "./live-session/protocol.ts";

const PROCESS_IDENTITY_SYMBOL = Symbol.for("pi.live-session.process-identity.v1");
/**
 * Default status re-assert period. The dashboard only knows what this bridge last
 * told it, so a slow beat is what keeps “工作中 / 等待输入” honest when pi changes
 * state without an agent event (compaction, retry, reload landing mid-work).
 */
export const DEFAULT_STATUS_HEARTBEAT_MS = 20_000;
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

/**
 * Outcome of a `/ls-navigate` or `/ls-fork` command, published as a
 * `tree_action` event so the dashboard can show what actually happened.
 *
 * The terminal-only `ctx.ui.notify` is not visible in the web UI, which made a
 * refused action indistinguishable from a broken button.
 */
type TreeActionOutcome = {
  action: "fork" | "navigate";
  ok: boolean;
  entryId: string;
  message: string;
  /** Wall-clock stamp so the dashboard can ignore an already-shown outcome. */
  at: number;
  /** Session file the action landed on (post-fork this is the NEW file). */
  sessionFile?: string;
  /**
   * `action === "fork"` only: pi created the new session but has not written its
   * file yet (no assistant message on the forked path), so the graph — which
   * reads files from disk — cannot show it until the first reply lands.
   */
  filePending?: boolean;
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

/**
 * pi core's compaction policy for the current model, or undefined when settings
 * are unreadable. `model` is passed through so per-model `reserveTokens`
 * overrides are honoured (they are part of where compaction actually fires).
 */
function piCompactionPolicy(
  ctx: ExtensionContext,
): { enabled: boolean; reserveTokens: number } | undefined {
  try {
    const settings = SettingsManager.create(ctx.cwd, undefined, {
      projectTrusted: ctx.isProjectTrusted(),
    }).getCompactionSettings(ctx.model ?? undefined);
    return { enabled: settings.enabled, reserveTokens: settings.reserveTokens };
  } catch {
    return undefined;
  }
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
  /** How often the bridge re-asserts the session status (default {@link DEFAULT_STATUS_HEARTBEAT_MS}). */
  readonly statusHeartbeatMs?: number;
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
  /**
   * Unanswered extension UI dialogs, keyed by request id.
   *
   * `extension_ui` is a one-shot event, so a client that reconnects while pi is
   * still blocked on a dialog (page switch, network blip) would never learn the
   * request exists. Keeping the last payload lets `resync` replay it.
   */
  const pendingUi = new Map<string, JsonObject>();
  const inputQueue: QueuedInput[] = [];
  /**
   * A tree action outcome waiting for a connected client.
   *
   * A fork replaces the live client, and the dashboard ignores an event whose
   * sequence is not `snapshot.sequence + 1`. The new client sends its snapshot
   * right after `welcome`, so the outcome must be flushed AFTER that snapshot —
   * publishing it eagerly (or from `onConnected`, which runs just before the
   * snapshot) silently drops it.
   */
  let pendingTreeAction: TreeActionOutcome | undefined;
  let activeInput: QueuedInput | undefined;
  let lastActivityAt = identity.startedAt;

  const clientIsReady = (): boolean => {
    const current = client;
    return Boolean(current) && (current?.isReady?.() ?? true);
  };

  /**
   * Whether this session is busy right now, according to pi itself.
   *
   * This asks `ctx.isIdle()` instead of trusting the `running` flag, because that
   * flag is only moved by `agent_start` / `agent_settled` / `session_start`, and
   * pi emits `agent_settled` solely when the agent-run loop finishes
   * (`_runAgentPrompt` in `core/agent-session.js`). A standalone compaction is not
   * an agent run — it never emits `agent_start`, and never an `agent_settled`
   * either — while `isIdle()` is false for the whole compaction (`!isAgentRunActive
   * && !isCompacting`). So a reload landing while a compaction was in flight used
   * to seed `running = !ctx.isIdle()` with no later event able to clear it, and the
   * dashboard showed “工作中” on a session that was sitting at its prompt.
   * `isIdle()` covers run and compaction alike and returns to true by itself.
   */
  const statusNow = (): LiveSessionStatus => {
    if (reconnecting) return "reconnecting";
    if (currentContext) return currentContext.isIdle() ? "idle" : "running";
    // Before the first `session_start` there is no context to ask.
    return running ? "running" : "idle";
  };

  /** Last status this bridge put on the wire (snapshot or patch). */
  let publishedStatus: LiveSessionStatus | undefined;

  /**
   * Push the current status when it drifted from what the dashboard already has.
   *
   * A patch must not touch `lastActivityAt`: status is a property of the session,
   * not an agent event, and an idle session that the heartbeat corrected would
   * otherwise look “active just now”.
   */
  const publishStatusPatch = (): void => {
    const status = statusNow();
    if (status === publishedStatus) return;
    publishedStatus = status;
    const currentClient = client;
    if (!projector || !currentClient || (currentClient.isReady && !currentClient.isReady())) return;
    currentClient.publish(projector.createEvent("summary_update", { status }));
  };

  /**
   * Re-assert the status on a slow beat.
   *
   * The dashboard is a mirror: it can only be as fresh as the last thing this
   * bridge said. Status used to be pushed only on agent/turn events, so any state
   * change pi performs without those events (compaction, retry, a reload that
   * landed mid-work) left the mirror claiming “工作中” forever. With a cheap
   * re-check the drift heals within one beat, and because nothing is sent while
   * the status is unchanged an idle dashboard stays silent.
   */
  const STATUS_HEARTBEAT_MS = options.statusHeartbeatMs ?? DEFAULT_STATUS_HEARTBEAT_MS;
  let statusHeartbeat: ReturnType<typeof setInterval> | undefined;

  const stopStatusHeartbeat = (): void => {
    if (statusHeartbeat) clearInterval(statusHeartbeat);
    statusHeartbeat = undefined;
  };

  const startStatusHeartbeat = (): void => {
    stopStatusHeartbeat();
    statusHeartbeat = setInterval(() => {
      if (!clientIsReady()) return;
      publishStatusPatch();
    }, STATUS_HEARTBEAT_MS);
    (statusHeartbeat as { unref?: () => void }).unref?.();
  };

  const publish = (type: string, data: unknown, ctx?: ExtensionContext): void => {
    if (ctx) currentContext = ctx;
    lastActivityAt = Date.now();
    const currentClient = client;
    if (!projector || !currentClient || (currentClient.isReady && !currentClient.isReady())) return;
    const event = projector.createEvent(type, data);
    currentClient.publish(event);
  };

  /**
   * The session's live telemetry: where the context stands and where compaction
   * will fire. Both change on every turn, and both are read by the dashboard's
   * status line.
   */
  const contextTelemetry = (ctx: ExtensionContext): JsonObject | undefined => {
    const usage = ctx.getContextUsage();
    if (!usage) return undefined;
    const trigger = resolveCompactionTrigger({
      contextWindow: usage.contextWindow ?? ctx.model?.contextWindow,
      model: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined,
      piPolicy: piCompactionPolicy(ctx),
      config: autoCompactTargetConfig(),
    });
    return {
      contextUsage: {
        tokens: usage.tokens,
        contextWindow: usage.contextWindow,
        percent: usage.percent,
      },
      compact: {
        enabled: trigger.enabled,
        triggerTokens: trigger.triggerTokens,
        candidates: trigger.candidates.map((candidate) => ({
          source: candidate.source,
          tokens: candidate.tokens,
        })),
      },
    };
  };

  /**
   * Push the telemetry as a `summary_update` event.
   *
   * It travels on the event stream — not inside the snapshot — because the value
   * changes every turn while a snapshot is only rebuilt at connect / resync /
   * tree / fork. That mismatch is why the dashboard showed a context count frozen
   * at whatever the session happened to have when it last reconnected (0 for a
   * fresh session). The registry patches its copy of the summary from this event,
   * so the number the browser renders is always the current one.
   */
  const publishContextTelemetry = (ctx: ExtensionContext): void => {
    const status = statusNow();
    publishedStatus = status;
    const telemetry = contextTelemetry(ctx);
    publish("summary_update", { ...(telemetry ?? {}), status }, ctx);
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
   * `LiveSessionSummary.capabilities`). Additive: no protocol version bump.
   *
   * - `session_tree`: the `/ls-navigate` and `/ls-fork` commands below are registered.
   * - `session_clear`: this session really has a working “start a new session”
   *   command. The dashboard's 「清空」 rides the plain input channel as `/clear`,
   *   which is registered by the **`session-aliases` extension, not by pi**, so it
   *   can vanish without a trace (a stale extension list pointing at deleted files
   *   was enough: pi skips the missing path silently). pi then hands `/clear` to the
   *   model as ordinary text — a click that burns a turn and clears nothing, which
   *   is exactly the kind of silent lie this flag exists to prevent. `getCommands()`
   *   reads the live command registry, so the claim is checked, not assumed.
   */
  const liveSessionCapabilities = (): readonly string[] => {
    const capabilities: string[] = ["session_tree"];
    try {
      if (pi.getCommands().some((command) => command.name === "clear")) capabilities.push("session_clear");
    } catch {
      // Older pi without `getCommands()`: advertise nothing extra rather than lie.
    }
    return capabilities;
  };

  const summary = (): LiveSessionSummaryBase => {
    const ctx = currentContext;
    if (!ctx) throw new Error("Live Session context is unavailable");
    const usage = ctx.getContextUsage();
    const claim = lease.snapshot();
    const mode: LiveSessionMode = ctx.mode === "rpc" ? "rpc" : "tui";
    const status = statusNow();
    publishedStatus = status;
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
      status,
      claim: claim.state === "claimed"
        ? { state: "claimed", leaseId: claim.leaseId, expiresAt: claim.expiresAt }
        : { state: "unclaimed" },
      startedAt: identity.startedAt,
      lastActivityAt,
      capabilities: liveSessionCapabilities(),
      ...(usage
        ? {
            contextUsage: {
              tokens: usage.tokens,
              contextWindow: usage.contextWindow,
              percent: usage.percent,
            },
          }
        : {}),
      ...((): { compact?: LiveSessionSummaryBase["compact"] } => {
        const telemetry = contextTelemetry(ctx);
        const compact = telemetry?.compact as LiveSessionSummaryBase["compact"] | undefined;
        return compact ? { compact } : {};
      })(),
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
      if (command.type === "resync") {
        // Replay unanswered dialogs so a client that just (re)connected can answer
        // a request pi is still waiting on instead of leaving the agent stuck.
        for (const payload of pendingUi.values()) publish("extension_ui", payload, ctx);
        return { ok: true, result: { resynced: true, pendingUi: pendingUi.size } };
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
    if (!leaseId) return "该会话已被某个浏览器接管：请先在 Dashboard「获取控制」（或刷新页面）后重试。";
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

  /**
   * Report the outcome of a `/ls-*` tree action to every viewer.
   *
   * The terminal `notify` is **invisible on the dashboard**, so a refusal (busy
   * session, stale entry id, expired lease) or a fork that pi defers to disk
   * looked exactly like "the button did nothing". Publishing the same message
   * as an event is the only way the graph page can show the real reason.
   *
   * Delivery is retried because a fork replaces the live client: the fresh
   * client may still be connecting when the command returns.
   */
  /** Send the pending outcome once the client is connected AND has sent its snapshot. */
  let treeActionRetry: ReturnType<typeof setTimeout> | undefined;
  /**
   * Send the pending outcome once the client is connected AND has sent its
   * snapshot.
   *
   * A fork briefly drops the live connection (measured: ready can go false again
   * right after the new session starts, i.e. AFTER the last `onConnected`), so
   * waiting for a connection event alone can leave the outcome parked forever —
   * which is exactly how “分叉后没有创建新会话” stays unexplained. Retry with a
   * bound instead.
   */
  const flushTreeAction = (attempt = 0): void => {
    const payload = pendingTreeAction;
    if (!payload) return;
    if (clientIsReady()) {
      pendingTreeAction = undefined;
      publish("tree_action", payload);
      return;
    }
    if (attempt >= 120 || treeActionRetry) return;
    treeActionRetry = setTimeout(() => {
      treeActionRetry = undefined;
      flushTreeAction(attempt + 1);
    }, 1_000);
    treeActionRetry.unref?.();
  };

  /**
   * @param ctx Context to notify on. Post-fork this MUST be the `withSession`
   * context: pi marks a captured command ctx stale after a session replacement
   * and throws when it is touched (“This extension ctx is stale after session
   * replacement”), which previously swallowed the outcome before it was sent.
   */
  const reportTreeAction = (outcome: Omit<TreeActionOutcome, "at">, ctx?: ExtensionCommandContext): void => {
    const payload: TreeActionOutcome = { ...outcome, at: Date.now() };
    pendingTreeAction = payload;
    try {
      (ctx ?? currentContext)?.ui.notify(payload.message, payload.ok ? "info" : "error");
    } catch {
      // The terminal notice is best-effort; the dashboard event is the contract.
    }
    // Never pass a ctx here: `publish` would adopt it as `currentContext`, and a
    // stale fork ctx must not become the live context.
    flushTreeAction();
  };

  pi.registerCommand("ls-navigate", {
    description: "切换到会话树的指定节点（pi-dashboard 图谱页调用）",
    handler: async (args, ctx) => {
      const { targetId, leaseId } = parseTreeArgs(args);
      if (!targetId) {
        reportTreeAction({ action: "navigate", ok: false, entryId: "", message: "用法：/ls-navigate <entry-id> [leaseId]" });
        return;
      }
      const denial = treeActionDenial(leaseId);
      if (denial) {
        reportTreeAction({ action: "navigate", ok: false, entryId: targetId, message: denial });
        return;
      }
      if (!ctx.isIdle()) {
        reportTreeAction({ action: "navigate", ok: false, entryId: targetId, message: "会话正在运行，请等当前回合结束后再切换分支。" });
        return;
      }
      try {
        const result = await ctx.navigateTree(targetId);
        const sessionFile = currentContext?.sessionManager.getSessionFile();
        reportTreeAction({
          action: "navigate",
          ok: true,
          entryId: targetId,
          ...(sessionFile ? { sessionFile } : {}),
          message: result.cancelled ? "已取消分支切换。" : `已切换到 ${targetId}。`,
        });
      } catch (error) {
        reportTreeAction({
          action: "navigate",
          ok: false,
          entryId: targetId,
          message: `切换分支失败：${error instanceof Error ? error.message : String(error)}`,
        });
      }
    },
  });

  pi.registerCommand("ls-fork", {
    description: "从会话树的指定节点分叉出新会话（pi-dashboard 图谱页调用）",
    handler: async (args, ctx) => {
      const { targetId, leaseId } = parseTreeArgs(args);
      if (!targetId) {
        reportTreeAction({ action: "fork", ok: false, entryId: "", message: "用法：/ls-fork <entry-id> [leaseId]" });
        return;
      }
      const denial = treeActionDenial(leaseId);
      if (denial) {
        reportTreeAction({ action: "fork", ok: false, entryId: targetId, message: denial });
        return;
      }
      if (!ctx.isIdle()) {
        reportTreeAction({ action: "fork", ok: false, entryId: targetId, message: "会话正在运行，请等当前回合结束后再分叉。" });
        return;
      }
      try {
        const result = await ctx.fork(targetId, {
          position: "at",
          // Everything after a fork belongs in `withSession`: pi replaces the
          // session and the captured command ctx goes stale (touching it throws),
          // so the outcome must be computed and reported with THIS ctx.
          withSession: async (next) => {
            // pi defers the new file when the forked path has no assistant
            // message yet: `createBranchedSession` writes the file immediately
            // only if the path contains an assistant message, otherwise it
            // appears together with the first reply. Say so explicitly — the
            // dashboard reads the graph from disk, so a deferred file looks
            // like "no new session".
            const sessionFile = next.sessionManager.getSessionFile();
            const filePending = Boolean(sessionFile) && !existsSync(sessionFile as string);
            reportTreeAction({
              action: "fork",
              ok: true,
              entryId: targetId,
              ...(sessionFile ? { sessionFile } : {}),
              filePending,
              message: filePending
                ? `已从 ${targetId} 分叉出新会话，但 pi 还没把它写入磁盘（该文件会随新会话的第一条回复生成）。`
                : `已从 ${targetId} 分叉出新会话。`,
            }, next);
            projector?.markChanged();
            client?.sendSnapshot();
          },
        });
        if (result.cancelled) {
          reportTreeAction({ action: "fork", ok: false, entryId: targetId, message: "已取消分叉。" });
        }
      } catch (error) {
        reportTreeAction({
          action: "fork",
          ok: false,
          entryId: targetId,
          message: `分叉失败：${error instanceof Error ? error.message : String(error)}`,
        });
      }
    },
  });

  pi.on("session_start", async (event, ctx) => {
    currentContext = ctx;
    running = !ctx.isIdle();
    reconnecting = false;
    lastActivityAt = Date.now();
    if (!isLiveSessionActive(ctx)) return;
    const mode: LiveSessionMode = ctx.mode;

    const rebuildProjector = (): void => {
      projector = new SnapshotProjector({
        processInstanceId: identity.processInstanceId,
        snapshotEntryLimit: options.snapshotEntryLimit,
        getSummary: summary,
        getBranch: () => currentContext?.sessionManager.getBranch() ?? [],
      });
    };

    // `/ls-fork` keeps the SAME pi process and broker connection — only the
    // session file changes. Tearing the live client down here costs ~1.5 minutes
    // of reconnect backoff, during which the dashboard sees nothing at all
    // (no snapshot, no events), which is reported as “分叉后没有创建新会话”.
    // Re-point the existing connection and push the new snapshot immediately.
    if (event.reason === "fork" && client && clientIsReady()) {
      clearFeaturePublishQueue();
      clearInputQueue();
      lease.release(undefined, "session_switch");
      rebuildProjector();
      featureCleanup?.();
      featureCleanup = subscribeLiveFeatures((feature, snapshot) => {
        queueFeatureSnapshot(feature, snapshot, ctx);
      });
      // New projector starts its sequence at 0; the snapshot below is what
      // re-aligns the broker's expected sequence.
      client.sendSnapshot();
      queueMicrotask(flushTreeAction);
      return;
    }

    client?.stop("session_switch");
    featureCleanup?.();
    featureCleanup = undefined;
    clearFeaturePublishQueue();
    clearInputQueue();
    lease.release(undefined, "session_switch");
    rebuildProjector();
    client = createClient({
      processInstanceId: identity.processInstanceId,
      // A fork replaces the runtime and drops the live connection for a moment.
      // The default backoff climbs to 30s, which leaves the dashboard blind for
      // over a minute right after “从此分叉”; keep the early retries tight.
      reconnectDelaysMs: [250, 500, 1_000, 2_000, 5_000, 10_000, 30_000],
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
        // `onConnected` runs just BEFORE `sendSnapshot()`, so defer to a microtask
        // to stay sequence-contiguous.
        queueMicrotask(flushTreeAction);
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
    startStatusHeartbeat();
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
    publishContextTelemetry(ctx);
    publish("agent_settled", {}, ctx);
  });
  // Compaction rewrites the context: publish immediately so the dashboard does
  // not keep showing the pre-compaction size until the next turn.
  pi.on("session_compact", (_event, ctx) => publishContextTelemetry(ctx));
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
  /**
   * Resolve the session-entry id of a message pi has just persisted.
   *
   * `message_end` is emitted BEFORE `SessionManager.appendMessage`, so the entry
   * does not exist yet when the handler runs and the id has to be read on a later
   * macrotask. `appendMessage` stores the very same message object, so an identity
   * lookup is exact rather than a guess.
   *
   * It is published as a follow-up `message_entry` (never folded into
   * `message_end`, which would reorder the transcript past tool events) and the
   * dashboard binds it back by proximity. Without it, live transcript bubbles
   * carry no entry id, so per-step actions like 「从此分叉」 cannot target one.
   */
  const publishMessageEntry = (ctx: ExtensionContext, message: unknown): void => {
    const timer = setTimeout(() => {
      try {
        const manager = ctx.sessionManager as unknown as { getEntries?: () => unknown[] };
        const entries = typeof manager.getEntries === "function" ? manager.getEntries() : [];
        const entry = [...entries].reverse().find((candidate) => {
          const record = candidate as Record<string, unknown> | undefined;
          return !!record
            && record.type === "message"
            && record.message === message
            && typeof record.id === "string";
        }) as Record<string, unknown> | undefined;
        if (typeof entry?.id !== "string") return;
        // No ctx: the session may have been replaced in the meantime and a stale
        // context must not overwrite the live one.
        publish("message_entry", { entryId: entry.id });
      } catch {
        // Session replaced or torn down; there is nothing to bind.
      }
    }, 0);
    timer.unref?.();
  };

  pi.on("message_end", (event, ctx) => {
    if (!isVisibleMessage(event.message)) return;
    const record = event.message as unknown as Record<string, unknown>;
    const completedInput = record.role === "user" ? activeInput : undefined;
    const entries = typeof ctx.sessionManager.getEntries === "function" ? ctx.sessionManager.getEntries() : [];
    const entryId = record.role === "user" ? undefined : [...entries].reverse().find(entry => {
      const candidate = entry as unknown as Record<string, unknown>;
      return candidate.type === "message" && candidate.message === event.message && typeof candidate.id === "string";
    }) as unknown as Record<string, unknown> | undefined;
    // Published BEFORE `message_end` on purpose: the transcript binds a
    // message's session-entry id to the nearest PRECEDING `message_end`, so
    // `message_end` must stay adjacent to the deferred `message_entry`.
    publishContextTelemetry(ctx);
    publish("message_end", {
      message: event.message,
      ...(completedInput ? { channel: completedInput.channel } : {}),
      ...(entryId?.id ? { entryId: entryId.id } : {}),
    }, ctx);
    publishMessageEntry(ctx, event.message);
  });
  pi.on("tool_execution_start", (event, ctx) => publish("tool_execution_start", event, ctx));
  pi.on("tool_execution_update", (event, ctx) => publish("tool_execution_update", event, ctx));
  pi.on("tool_execution_end", (event, ctx) => publish("tool_execution_end", event, ctx));
  pi.on("model_select", (event, ctx) => {
    publish("model_select", {
      model: { provider: event.model.provider, id: event.model.id },
      previousModel: event.previousModel
        ? { provider: event.previousModel.provider, id: event.previousModel.id }
        : null,
      source: event.source,
    }, ctx);
    // After the event: the window (and therefore the compaction trigger) changed
    // with the model, and `ctx.model` is only the new one once pi emitted this.
    publishContextTelemetry(ctx);
  });
  pi.on("thinking_level_select", (event, ctx) => publish("thinking_level_select", {
    level: event.level,
    previousLevel: event.previousLevel,
  }, ctx));

  pi.on("extension_ui", (event, ctx) => {
    if (event.closed) {
      pendingUi.delete(event.id);
      publish("extension_ui_closed", { id: event.id }, ctx);
      return;
    }
    const payload: JsonObject = {
      id: event.id,
      method: event.method,
      title: event.title,
      ...(event.message !== undefined ? { message: event.message } : {}),
      ...(event.options !== undefined ? { options: event.options } : {}),
      ...(event.placeholder !== undefined ? { placeholder: event.placeholder } : {}),
      ...(event.prefill !== undefined ? { prefill: event.prefill } : {}),
    };
    pendingUi.set(event.id, payload);
    publish("extension_ui", payload, ctx);
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
    stopStatusHeartbeat();
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
