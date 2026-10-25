import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { request } from "node:http";
import { isAbsolute } from "node:path";
import { Type, type TSchema } from "typebox";
import { Value } from "typebox/value";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const RPC_TIMEOUT_MS = 15_000;
export const MAX_RESULT_BYTES = 2 * 1024 * 1024;

export interface SupervisorCredentials {
  socketPath: string;
  token: string;
  revision: string | number;
  allowedTools: string[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export async function readCredentials(filePath: string): Promise<SupervisorCredentials> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    // File-system and JSON errors can contain the credential path or its contents.
    throw new Error("Supervisor credentials could not be read.");
  }
  if (
    !isObject(value) ||
    typeof value.socketPath !== "string" || !isAbsolute(value.socketPath) ||
    value.socketPath.includes("\0") ||
    typeof value.token !== "string" || !value.token.trim() || /[\r\n]/.test(value.token) ||
    !(typeof value.revision === "string" && value.revision.trim() ||
      typeof value.revision === "number" && Number.isSafeInteger(value.revision) && value.revision >= 0) ||
    !Array.isArray(value.allowedTools) ||
    !value.allowedTools.every((name: unknown) => typeof name === "string" && name.length > 0) ||
    new Set(value.allowedTools).size !== value.allowedTools.length
  ) {
    throw new Error("Supervisor credentials are invalid.");
  }
  return {
    socketPath: value.socketPath,
    token: value.token,
    revision: value.revision,
    allowedTools: [...value.allowedTools] as string[],
  };
}

/** Redact literal and JSON-escaped credential values before returning gateway data. */
function redact(text: string, secrets: readonly string[]): string {
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    if (!secret) continue;
    for (const variant of new Set([secret, JSON.stringify(secret).slice(1, -1)])) {
      text = text.split(variant).join("[redacted]");
    }
  }
  return text;
}

export interface GatewayOptions {
  includeImages?: boolean;
  signal?: AbortSignal;
  /** Tests may shorten this deadline; production uses RPC_TIMEOUT_MS. */
  timeoutMs?: number;
}

export class SupervisorGateway {
  constructor(
    private readonly credentials: SupervisorCredentials,
    private readonly credentialPath: string,
  ) {}

  async call(
    endpoint: "/execute" | "/health" | "/loaded",
    body?: unknown,
    options: GatewayOptions = {},
  ): Promise<unknown> {
    const secrets = [this.credentials.token, this.credentials.socketPath, this.credentialPath];
    return new Promise((resolve, reject) => {
      if (options.signal?.aborted) {
        reject(new Error("Supervisor gateway request cancelled."));
        return;
      }
      let payload: string | undefined;
      try {
        payload = body === undefined ? undefined : JSON.stringify(body);
      } catch {
        reject(new Error("Supervisor gateway request is not JSON serializable."));
        return;
      }
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (error?: Error, value?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
        if (error) reject(error);
        else resolve(value);
      };
      const abort = () => {
        finish(new Error("Supervisor gateway request cancelled."));
        req.destroy();
      };
      // No TCP URL, proxy, redirects, retry, or unauthenticated fallback.
      let req: ReturnType<typeof request>;
      try {
        req = request({
          socketPath: this.credentials.socketPath,
          method: endpoint === "/health" ? "GET" : "POST",
          path: endpoint,
          agent: false,
          headers: {
            Authorization: `Bearer ${this.credentials.token}`,
            Accept: "application/json",
            ...(payload === undefined ? {} : {
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(payload),
            }),
          },
        }, (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on("data", (chunk: Buffer) => {
            if (settled) return;
            size += chunk.length;
            if (size > (options.includeImages ? 9 * 1024 * 1024 : MAX_RESULT_BYTES)) {
              finish(new Error("Supervisor gateway response exceeds 2 MiB."));
              res.destroy();
              req.destroy();
              return;
            }
            chunks.push(chunk);
          });
          res.on("error", () => finish(new Error("Supervisor gateway response interrupted.")));
          res.on("aborted", () => finish(new Error("Supervisor gateway response interrupted.")));
          res.on("end", () => {
            if (settled) return;
            const status = res.statusCode ?? 0;
            const raw = Buffer.concat(chunks).toString("utf8");
            let result: unknown;
            try {
              result = raw.length ? JSON.parse(raw) : null;
            } catch {
              finish(new Error(status >= 200 && status < 300
                ? "Supervisor gateway returned invalid JSON."
                : `Supervisor gateway HTTP ${status}.`));
              return;
            }
            const failed = isObject(result) && (result.ok === false || result.error != null);
            if (status < 200 || status >= 300 || failed) {
              const error = isObject(result) ? result.error : undefined;
              const message = typeof error === "string" ? error
                : isObject(error) && typeof error.message === "string" ? error.message : "";
              const safeMessage = redact(message, secrets).slice(0, 512);
              finish(new Error(`Supervisor gateway HTTP ${status}${safeMessage ? `: ${safeMessage}` : ": request rejected."}`));
              return;
            }
            if (endpoint === "/execute" && result === null) {
              finish(new Error("Supervisor gateway returned no execution result."));
              return;
            }
            // Redact decoded strings and keys, not JSON syntax or numeric values.
            try {
              const safe = (value: unknown): unknown => {
                if (typeof value === "string") return redact(value, secrets);
                if (Array.isArray(value)) return value.map(safe);
                if (isObject(value)) return Object.fromEntries(Object.entries(value)
                  .map(([key, item]) => [redact(key, secrets), safe(item)]));
                return value;
              };
              finish(undefined, safe(result));
            } catch {
              finish(new Error("Supervisor gateway response could not be processed."));
            }
          });
        });
      } catch {
        finish(new Error("Supervisor gateway connection failed."));
        return;
      }
      req.on("error", () => finish(new Error("Supervisor gateway connection failed.")));
      timer = setTimeout(() => {
        finish(new Error("Supervisor gateway request timed out."));
        req.destroy();
      }, options.timeoutMs ?? RPC_TIMEOUT_MS);
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.signal?.aborted) abort();
      else req.end(payload);
    });
  }
}

/**
 * The dashboard tags its own automatic patrol prompts with this string. Any other prompt is a real
 * user turn (typed in the pane, the session page or the main-agent dialog), so writes need no marker.
 */
export const AUTO_PATROL_TAG = "[supervisor-auto-patrol]";

/** A record can hold at most 4 attachments; do not archive more than the record could keep. */
export const MAX_TURN_IMAGES = 4;

/**
 * Bare "go ahead" replies. A user typing one of these in the chat answers the question the agent just
 * asked, so the pending write does not need the popup — but it must match that exact pending request.
 */
const CONFIRM_PATTERN = /^(?:确认|确认一下|确认执行|确认继续|确认提交|同意|允许|可以|没问题|好|好的|行|是|对|继续|执行吧|就这样|ok|okay|yes|y)$/i;
const REFUSAL_PATTERN = /^(?:不|不要|不用|别|取消|算了|停止|先不|no|nope|cancel)$/i;

/** Drop the envelopes the dashboard adds around a forwarded turn before reading the user's own words. */
export function userWords(prompt: string): string {
  return prompt
    .split("\n")
    .filter(line => !/^\s*\[supervisor-(?:user-grant|auto-patrol)[^\]]*\]/.test(line))
    .filter(line => !/^\s*浏览上下文（仅供参考）：/.test(line))
    .filter(line => !/^\s*用户提交的已保存截图 attachmentIds：/.test(line))
    .join("\n").trim();
}

function shortReply(text: string, pattern: RegExp): boolean {
  const value = text.trim().replace(/[。！!~，,、\s]+$/g, "");
  return value.length > 0 && value.length <= 12 && pattern.test(value);
}

/** True when the turn is just "确认/可以/同意" — authorization for the pending request, nothing more. */
export function isPlainConfirmation(prompt: string): boolean {
  return shortReply(userWords(prompt), CONFIRM_PATTERN);
}

/** True when the turn clearly says no, so a previously asked question must not stay armed. */
export function isPlainRefusal(prompt: string): boolean {
  return shortReply(userWords(prompt), REFUSAL_PATTERN);
}

/**
 * Identity of the object a confirmation is about.
 *
 * A bare 「确认」 must answer the request the user actually saw. Matching the whole payload failed in
 * practice: the model re-words a record's description between attempts, so the same write came back
 * as a brand new request and the confirmation was silently lost. Operation + target stays stable
 * across re-wording, and the write that finally runs is the payload the user was shown.
 */
export function confirmationTarget(operation: string, args: Record<string, unknown>): string {
  const parts = [operation];
  for (const field of ["objectRef", "uid", "id", "path", "type"] as const) {
    const value = args[field];
    if (typeof value === "string" && value) parts.push(`${field}=${value}`);
  }
  // Creating a task IS creating that title, so a different task is a different request.
  if (operation === "task_create") parts.push(`title=${String(args.title ?? "")}`);
  return parts.join("|");
}

/**
 * Compact machine-readable trailer so a dashboard page can show a pending write next to the object it
 * targets, instead of covering the whole screen with a modal. pi's UI request only carries text, so the
 * target rides along in the message; the dashboard strips this line before showing it to the user.
 */
export function confirmationMarker(operation: string, args: Record<string, unknown>, question: string): string {
  const ref = [args.objectRef, args.uid, args.id].find((value): value is string => typeof value === "string" && value.length > 0);
  return `\n[supervisor-confirm]${JSON.stringify({ op: operation, ...(ref ? { ref } : {}), sum: confirmationSummary(operation, args, question) })}`;
}

/**
 * One line a dashboard page can show as the headline of the pending write.
 *
 * It must name the thing being written (the record's title, the task, the event) — the confirmation
 * question's own first line is boilerplate and tells the reader nothing.
 */
export function confirmationSummary(operation: string, args: Record<string, unknown>, question: string): string {
  const text = (value: unknown): string => typeof value === "string" ? value.trim() : "";
  const title = text(args.title);
  if (operation === "record") return title || text(args.description).slice(0, 140) || "记录一条事件";
  if (operation === "correct") return `更正事件 ${text(args.id)}`.trim();
  if (operation === "task_update") return `任务 ${text(args.uid)} → ${text(args.status) || "更新"}`.replace(/\s+/g, " ").trim();
  if (operation === "task_create") return title ? `新建任务「${title}」` : "新建任务";
  if (operation === "action") return `待办 ${text(args.id)} → ${text(args.state) || "更新"}`.replace(/\s+/g, " ").trim();
  return question.split("\n").map(line => line.trim()).filter(Boolean)[0]?.slice(0, 140) || operation;
}

/** The per-call requestId is transport bookkeeping; it never identifies which write was confirmed. */
function withoutRequestId(args: Record<string, unknown>): Record<string, unknown> {
  const { requestId: _requestId, ...rest } = args;
  return rest;
}

/** Only a single UUID marker in this turn is eligible; never inherit a prior grant. */
export function grantFromPrompt(prompt: string): string | undefined {
  const markers = [...prompt.matchAll(/\[supervisor-user-grant:([^\]]*)\]/g)];
  if (markers.length !== 1) return undefined;
  const value = markers[0][1];
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
    ? value : undefined;
}

const text = (description: string) => Type.String({ description, minLength: 1 });
const optionalText = (description: string) => Type.Optional(text(description));
const limit = Type.Optional(Type.Integer({ description: "Maximum items to return.", minimum: 1, maximum: 200 }));
const object = (properties: Parameters<typeof Type.Object>[0]) => Type.Object(properties, { additionalProperties: false });
const eventFields = {
  objectRef: optionalText("Stable Task/Epic UID from supervisor_context."),
  title: optionalText("Short factual event title."),
  description: Type.Optional(Type.String({ description: "User description, kept separate from the original reply." })),
  type: optionalText("Event category from the configured vocabulary: progress, reply, blocked, resumed, decision or result. Other values are rejected by the gateway."),
  occurredAt: Type.Optional(Type.Union([Type.String({ description: "Actual occurrence time with timezone; omit or null if unknown." }), Type.Null()])),
  participants: Type.Optional(Type.Array(Type.String())),
  sourceKind: Type.Optional(Type.String({ enum: ["user", "relay"], description: "user=first-person observation; relay=user relaying a collaborator reply, not independently verified." })),
  originalReply: Type.Optional(Type.String()), nextStep: Type.Optional(Type.String()), stage: Type.Optional(Type.String()),
  attachmentIds: Type.Optional(Type.Array(text("Previously uploaded attachment ID."))),
  interval: Type.Optional(object({ kind: Type.String({ enum: ["wait", "stage", "effort"] }), startEventId: text("Explicit start event ID in the same task."), durationMinutes: Type.Optional(Type.Number({ minimum: 0 })) })),
};
const tools = [
  {
    name: "supervisor_context", operation: "context",
    description: "Read current supervisor context from the gateway. The embedded events list is summarized and truncated (default 50, newest first) and reports eventsTotal/eventsTruncated; use event_query for filtered lists and event_get for full text or screenshots.",
    parameters: object({ scope: optionalText("Context scope to request."), objectRef: optionalText("Filter by stable Task UID."), includeChildren: Type.Optional(Type.Boolean()), limit, order: Type.Optional(Type.String({ enum: ["asc", "desc"] })), types: Type.Optional(Type.Array(text("Event category to include."))), since: optionalText("Inclusive lower bound on occurrence time."), until: optionalText("Inclusive upper bound."), view: Type.Optional(Type.String({ enum: ["summary", "full"] })), sessionId: optionalText("Read an allowed session's recent bounded context; not its complete history.") }),
  },
  {
    name: "event_objects", operation: "context",
    description: "Read objects in supervisor context.",
    parameters: object({ query: optionalText("Object search terms."), limit }),
  },
  {
    name: "event_list", operation: "events",
    description: "List supervisor events.",
    parameters: object({ objectRef: optionalText("Filter by stable Task/Epic UID."), includeChildren: Type.Optional(Type.Boolean()), limit }),
  },
  {
    name: "event_query", operation: "query",
    description: "Query supervisor events with a constant result shape {events, total, truncated, excludedWithoutTime}. Defaults to newest first with summaries only; use event_get for full text or screenshots.",
    parameters: object({
      objectRef: optionalText("Filter by stable Task/Epic UID."),
      includeChildren: Type.Optional(Type.Boolean()),
      limit,
      order: Type.Optional(Type.String({ enum: ["asc", "desc"], description: "desc returns the most recent items; events without a known time stay last either way." })),
      types: Type.Optional(Type.Array(text("Event category to include; unknown categories are rejected."))),
      since: optionalText("Inclusive lower bound on occurrence time: ISO date or timestamp with timezone."),
      until: optionalText("Inclusive upper bound; a date-only value covers that whole day."),
      view: Type.Optional(Type.String({ enum: ["summary", "full"], description: "summary omits description, original reply and revision history." })),
    }),
  },
  {
    name: "event_get", operation: "events",
    description: "Read one supervisor event by ID.",
    parameters: object({ id: text("Event ID to read."), includeImages: Type.Optional(Type.Boolean({ description: "Read persisted screenshots as image content for visual review; at most four images and 6 MiB." })) }),
  },
  {
    name: "event_append", operation: "record",
    description: "Append one event to the shared event ledger (the object's timeline). Records never edit a task description, a task title or any repository file; do not claim to be the user.",
    parameters: object({ ...eventFields, objectRef: text("Stable Task/Epic UID."), title: text("Factual title."), type: text("Event category from the configured vocabulary; unrecognized values are rejected.") }),
  },
  {
    name: "event_correct", operation: "correct",
    description: "Correct an event after UI confirmation; the gateway enforces authorization.",
    parameters: object({ id: text("Event ID to correct."), expectedVersion: Type.Integer({ minimum: 1 }), patch: object(eventFields), reason: text("Reason for correction.") }),
  },
  {
    name: "supervisor_task_create", operation: "task_create",
    description: "Create a supervisor task through the gateway.",
    parameters: object({ title: text("Task title."), description: optionalText("Task objective and acceptance checks."), kind: Type.Optional(Type.String({ enum: ["task", "epic", "todo", "item"] })), parentUid: optionalText("Parent Epic UID."), tags: Type.Optional(Type.Array(Type.String())) }),
  },
  {
    name: "supervisor_task_update", operation: "task_update",
    description: "Change the task itself (title, description, status) when the user explicitly asks, and say so in the reply; it is a user-visible change. Records belong in event_append instead. Status changes require UI confirmation and completion evidence.",
    parameters: object({ uid: text("Stable Task UID."), status: Type.Optional(Type.String({ enum: ["todo", "doing", "paused", "done"] })), title: optionalText("Updated title."), description: optionalText("Updated description."), evidence: optionalText("Observable evidence required for done.") }),
  },
  {
    name: "supervisor_working_state", operation: "working_state",
    description: "Update explicitly user-confirmed local observation state, never the provider's formal task status. Read current state before replacing it.",
    parameters: object({ objectRef: text("Stable Task UID."), description: text("User's actual observation or relayed statement."), originalReply: optionalText("Exact collaborator reply if supplied; do not replace it with a summary."), stage: optionalText("Current observed stage."), nextStep: optionalText("Next step."), waitingFor: Type.Optional(Type.String({ description: "Person or dependency being waited on; empty text clears it." })), sourceKind: Type.Optional(Type.Union([Type.Literal("user"), Type.Literal("relay")])), expectedEventId: optionalText("Current working state's sourceEventId; omit for first observation."), expectedVersion: Type.Optional(Type.Integer({ minimum: 1 })) }),
  },
  {
    name: "supervisor_action", operation: "action",
    description: "Request a named backend-approved action, not a shell command.",
    parameters: object({ id: optionalText("Existing action ID for an update."), expectedVersion: Type.Optional(Type.Integer({ minimum: 1 })), objectRef: optionalText("Related Task UID."), title: optionalText("Action title required when creating."), reason: optionalText("Reason and suggested next action."), state: Type.Optional(Type.String({ enum: ["suggested", "open", "done", "dismissed"] })), sourceRefs: Type.Optional(Type.Array(Type.String())) }),
  },
  {
    name: "supervisor_analyze", operation: "analyze",
    description: "Analyze supervisor facts through the gateway.",
    parameters: object({ objectRef: optionalText("Related Task/Epic UID."), includeChildren: Type.Optional(Type.Boolean()) }),
  },
  {
    name: "supervisor_report", operation: "report",
    description: "Generate a supervisor report through the gateway.",
    parameters: object({ kind: Type.String({ enum: ["summary", "review", "retrospective"] }), objectRef: optionalText("Related Task UID."), content: text("Conclusions with evidence and unverified items."), sourceRefs: Type.Array(Type.String()), coverage: text("Actual reviewed scope."), missing: Type.Array(Type.String()) }),
  },
  {
    name: "supervisor_inspect", operation: "inspect",
    description: "Inspect an explicit approved absolute path; backend path authorization is mandatory.",
    parameters: object({ path: text("Explicit approved absolute path."), query: optionalText("What to inspect at that path.") }),
  },
  {
    name: "supervisor_coordinate", operation: "coordinate",
    description: "Send an assistant coordination message. Interactive mode requires UI confirmation; automatic mode is limited and backend-gated, never user impersonation.",
    parameters: object({ sessionId: text("Explicitly authorized target session ID."), text: Type.String({ description: "Assistant suggestion, not new user authorization.", minLength: 1, maxLength: 1024 }), kind: Type.String({ enum: ["clarification", "continue", "correction"] }), sourceRefs: Type.Array(text("Accessible event ID or approved file inspection sourceRef."), { minItems: 1 }) }),
  },
] as const;

export const SUPERVISOR_TOOL_NAMES = tools.map((tool) => tool.name);

function confirmationFor(operation: string, args: Record<string, unknown>): string | undefined {
  // Conservatively treat all corrections as destructive and gate all task status changes.
  if (operation === "correct" && Object.keys(isObject(args.patch) ? args.patch : {}).some(field => !["occurredAt", "participants", "nextStep", "stage"].includes(field))) {
    return `更正事件 ${args.id}？将保留修订历史。\n修改内容：${JSON.stringify(args.patch)}\n原因：${args.reason}`;
  }
  if (operation === "task_update" && args.status === "done") {
    return `将任务 ${args.uid} 标记为已完成？请核对验收标准。\n证据：${args.evidence ?? "尚未提供"}`;
  }
  if (operation === "action" && args.state === "done") return `确认待办 ${args.id} 已处理完成？`;
  return undefined;
}

export default function supervisorExtension(pi: ExtensionAPI): void {
  pi.registerFlag("supervisor-credentials", {
    type: "string",
    description: "Dashboard supervisor credential configuration file (explicit profile only).",
  });
  let credentials: SupervisorCredentials | undefined;
  let gateway: SupervisorGateway | undefined;
  let grantRef: string | undefined;
  let credentialPath: string | undefined;
  /** True while the running turn came from a real user message (not an automatic patrol). */
  let userTurn = false;
  /** The user's own words for this turn, forwarded so the gateway can keep negation/question safeguards. */
  let userPrompt = "";
  /** Attachment ids archived for this turn's pasted screenshots, told to the model so records can reference them. */
  let archivedAttachments: string[] = [];
  let turn = 0;
  /**
   * The one write the agent asked the user to confirm, kept with the exact payload they were shown,
   * so a later bare "确认" answers that request (and runs that payload) and nothing else.
   */
  let pendingConfirmation: { turn: number; operation: string; target: string; args: Record<string, unknown> } | undefined;
  /** True while the current turn's text is a bare confirmation for whatever is pending. */
  let confirmedByText = false;

  pi.registerCommand("supervisor-clear", {
    description: "清空主助手聊天上下文并自动重新加载，保留任务、事件与截图",
    handler: async (_args, ctx) => {
      if (!credentials || !gateway) throw new Error("Supervisor gateway is not ready.");
      if (!ctx.isIdle()) throw new Error("主助手正在工作，请完成后再清空。");
      const result = await ctx.newSession();
      if (result.cancelled) throw new Error("清空会话已取消，未建立新会话。");
    },
  });

  for (const tool of tools) {
    register(tool.name, tool.operation, tool.description, tool.parameters);
  }

  function register(name: string, operation: string, description: string, parameters: TSchema) {
    pi.registerTool({
      name,
      label: name,
      description,
      parameters,
      async execute(toolCallId, params, signal, _onUpdate, ctx) {
        const activeCredentials = credentials;
        const activeGateway = gateway;
        if (!activeCredentials || !activeGateway) throw new Error("Supervisor gateway is not ready.");
        if (!activeCredentials.allowedTools.includes(name)) throw new Error("Supervisor tool is not allowed by this profile.");
        if (!isObject(params) || !Value.Check(parameters, params)) throw new Error("Supervisor tool arguments are invalid.");
        // Reject model-supplied authorization and unknown fields, even on direct execution.
        const args = { ...params, requestId: createHash("sha256").update(`${ctx.sessionManager.getSessionId()}:${operation}:${toolCallId}`).digest("hex") } as Record<string, unknown>;
        if (operation === "inspect" && (typeof args.path !== "string" || !isAbsolute(args.path) || args.path.includes("\0"))) {
          throw new Error("Supervisor inspect requires an approved absolute path.");
        }
        if (operation === "task_update" && args.status === "done" &&
          (typeof args.evidence !== "string" || !args.evidence.trim())) {
          throw new Error("Task completion requires observable evidence.");
        }
        const activeTurn = turn;
        const activeGrant = grantRef;
        const activeUserTurn = userTurn;
        const activeUserPrompt = userPrompt;
        let confirmed = false;
        // The payload that actually runs. When a typed "确认" settles the request, this becomes the
        // payload the user was shown, never a re-worded version the model produced afterwards.
        let callArgs = args;
        const question = confirmationFor(operation, args);
        if (question) {
          if (!activeGrant && !activeUserTurn) throw new Error("Supervisor mutation requires a current user turn; automatic patrol cannot open formal confirmations.");
          if (!ctx.hasUI) throw new Error("Supervisor operation requires UI confirmation.");
          const typed = takeTextConfirmation(operation, args);
          if (typed) { callArgs = { ...typed, requestId: args.requestId }; confirmed = true; }
          else confirmed = await askConfirmation(ctx, signal, question,
            [activeCredentials.token, activeCredentials.socketPath, credentialPath ?? ""], operation, args);
        }
        if (signal?.aborted) throw new Error("Supervisor gateway request cancelled.");
        if (turn !== activeTurn || gateway !== activeGateway) throw new Error("Supervisor turn changed; request cancelled.");
        const payload = () => ({ request: { operation, args: callArgs }, ...(activeGrant ? { grantRef: activeGrant } : {}), ...(activeUserTurn ? { userTurn: true, ...(activeUserPrompt ? { userPrompt: activeUserPrompt } : {}) } : {}), ...(confirmed ? { confirmed: true } : {}) });
        let result: unknown;
        try { result = await activeGateway.call("/execute", payload(), { signal, includeImages: name === "event_get" && args.includeImages === true }); }
        catch (error) {
          const needsConfirmation = error instanceof Error && /HTTP 403: explicit_operation_confirmation_required$/.test(error.message);
          if (!needsConfirmation || confirmed || (!activeGrant && !activeUserTurn) || !["record", "correct", "task_create", "task_update", "working_state", "action"].includes(operation)) throw error;
          const typed = takeTextConfirmation(operation, args);
          if (typed) { callArgs = { ...typed, requestId: args.requestId }; confirmed = true; }
          else confirmed = await askConfirmation(ctx, signal,
            `当前消息未明确授权这项操作，请核对目标与内容：\n${redact(JSON.stringify({ operation, args: withoutRequestId(args) }, null, 2), [activeCredentials.token, activeCredentials.socketPath, credentialPath ?? ""])}`,
            [activeCredentials.token, activeCredentials.socketPath, credentialPath ?? ""], operation, args);
          if (signal?.aborted || turn !== activeTurn || gateway !== activeGateway) throw new Error("Supervisor turn changed; request cancelled.");
          result = await activeGateway.call("/execute", payload(), { signal });
        }
        if (name === "event_get" && args.includeImages === true && result && typeof result === "object") {
          const envelope = result as { ok: boolean; result: { event: unknown; images: { attachmentId: string; mimeType: string; data: string }[] } };
          if (!envelope.ok || !Array.isArray(envelope.result?.images)) throw new Error("Supervisor screenshot response is invalid.");
          return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true, result: { event: envelope.result.event, attachments: envelope.result.images.map(image => ({ attachmentId: image.attachmentId, mimeType: image.mimeType })) } }) }, ...envelope.result.images.map(image => ({ type: "image" as const, data: image.data, mimeType: image.mimeType }))], details: {} };
        }
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: {} };
      },
    });
  }

  /**
   * Spend the user's typed "确认" on the pending request: same operation and same target is enough.
   * The returned payload is the one the user was shown, so a re-worded retry cannot smuggle new text
   * into a confirmation the user already gave. One confirmation authorizes one write.
   */
  function takeTextConfirmation(operation: string, args: Record<string, unknown>): Record<string, unknown> | undefined {
    const pending = pendingConfirmation;
    if (!confirmedByText || !pending || pending.turn >= turn) return undefined;
    if (pending.operation !== operation || pending.target !== confirmationTarget(operation, args)) return undefined;
    pendingConfirmation = undefined;
    confirmedByText = false;
    return pending.args;
  }

  /**
   * Ask for one write's confirmation. A chat reply such as "确认" that directly follows the agent's own
   * question answers exactly that pending request, so the popup is skipped; otherwise the popup is the
   * fallback and its dismissal keeps the request armed for a later typed confirmation.
   */
  async function askConfirmation(ctx: ExtensionContext, signal: AbortSignal | undefined, question: string, secrets: string[], operation: string, args: Record<string, unknown>): Promise<boolean> {
    if (!ctx.hasUI) throw new Error("Supervisor operation requires UI confirmation.");
    const safeQuestion = redact(question, secrets);
    const answer = await ctx.ui.confirm("主 Agent 操作确认", `${safeQuestion}\n\n也可以直接在对话里回复「确认」来允许这次操作。${confirmationMarker(operation, args, safeQuestion)}`, { signal });
    if (answer === true) { pendingConfirmation = undefined; return true; }
    // pi 只回一个布尔值，区分不了「点了不允许」和「弹窗被关掉」，所以不要写成用户取消。
    // The request stays armed with the payload the user was shown, so a later 「确认」 runs exactly it.
    pendingConfirmation = { turn, operation, target: confirmationTarget(operation, args), args: withoutRequestId(args) };
    throw new Error("主 Agent 操作确认未通过（确认窗口被关掉或选择了不允许），本次没有做任何修改。可以重发同一操作并附一句「确认」；只回复「确认」也有效。");
  }

  /**
   * Screenshots pasted into the pane reach the model but have no stored id, so a record could never show them.
   * Archive each one through the gateway and hand the ids back for `event_append` / `event_correct`.
   */
  async function archiveImages(images: ReadonlyArray<{ data?: string; mimeType?: string }>, activeGateway: SupervisorGateway): Promise<string[]> {
    const ids: string[] = []
    for (const image of images.slice(0, MAX_TURN_IMAGES)) {
      if (typeof image?.data !== "string" || !image.data) continue;
      try {
        const response = await activeGateway.call("/execute", {
          request: { operation: "attachment_put", args: { name: "用户粘贴的截图 " + new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-") + ".png", mime: String(image.mimeType || ""), data: image.data } },
          userTurn: true,
        }) as { ok?: boolean; result?: { attachmentId?: string } };
        const id = response?.result?.attachmentId;
        if (response?.ok && typeof id === "string") ids.push(id);
      } catch { /* An image that cannot be archived must not break the user's turn. */ }
    }
    return ids;
  }

  function allowedTools(config: SupervisorCredentials): string[] {
    const available = new Set(pi.getAllTools().map((tool) => tool.name));
    if (config.allowedTools.some((name) => !available.has(name))) {
      pi.setActiveTools([]);
      throw new Error("Supervisor profile contains unavailable tools.");
    }
    return [...config.allowedTools];
  }

  pi.on("session_start", async (_event, ctx) => {
    gateway = undefined;
    credentials = undefined;
    credentialPath = undefined;
    grantRef = undefined;
    userTurn = false;
    userPrompt = "";
    pendingConfirmation = undefined;
    confirmedByText = false;
    turn++;
    pi.setActiveTools([]);
    const filePath = pi.getFlag("supervisor-credentials");
    if (typeof filePath !== "string" || !filePath.trim()) {
      throw new Error("Supervisor credential flag is required for this explicit profile.");
    }
    const config = await readCredentials(filePath);
    const names = allowedTools(config);
    const candidate = new SupervisorGateway(config, filePath);
    await candidate.call("/health");
    const sessionId = ctx.sessionManager.getSessionId();
    await candidate.call("/loaded", {
      revision: config.revision,
      ...(sessionId ? { sessionId } : {}),
      tools: names,
    });
    credentials = config;
    credentialPath = filePath;
    gateway = candidate;
    pi.setActiveTools(names);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    grantRef = grantFromPrompt(event.prompt);
    // Automatic patrol is tagged by the dashboard; every untagged prompt is a real user turn, so a plain
    // instruction typed anywhere authorizes that turn's writes without any marker.
    userTurn = !event.prompt.includes(AUTO_PATROL_TAG);
    userPrompt = userTurn ? event.prompt.slice(0, 4000) : "";
    turn++;
    // A bare "确认" answers the question the agent just asked; an explicit no disarms it. Neither one
    // creates new authority: only the exact pending request can be confirmed this way.
    confirmedByText = userTurn && isPlainConfirmation(userPrompt);
    if (userTurn && isPlainRefusal(userPrompt)) pendingConfirmation = undefined;
    pi.setActiveTools(credentials && gateway ? allowedTools(credentials) : []);
    archivedAttachments = [];
    if (!userTurn || !event.images?.length || !gateway || !credentials?.allowedTools.includes("event_append")) return;
    // The dashboard dialog already uploads its own attachments and states their ids; do not archive those twice.
    if (/用户提交的已保存截图 attachmentIds：/.test(event.prompt)) return;
    archivedAttachments = await archiveImages(event.images, gateway);
    if (!archivedAttachments.length) {
      ctx.ui.notify("本轮截图未能存档，记录里不会有图片；可在主 Agent 弹窗用附件重发。", "warning");
      return;
    }
    return {
      message: {
        customType: "supervisor-attachments",
        content: "本轮用户消息附带 " + archivedAttachments.length + " 张截图，已存档：attachmentIds=[" + archivedAttachments.map(id => JSON.stringify(id)).join(", ") + "]。"
          + "用 event_append 或 event_correct 记录时必须把这些 id 原样放进 attachmentIds（一条记录最多 4 张），不要编造 id，也不要在正文里贴 base64。",
        display: true,
      },
    };
  });

  pi.on("tool_call", (event) => {
    if (!credentials || !gateway || !credentials.allowedTools.includes(event.toolName)) {
      return { block: true, reason: "Tool is not authorized by the supervisor profile." };
    }
  });

  pi.on("session_shutdown", () => {
    gateway = undefined;
    credentials = undefined;
    credentialPath = undefined;
    grantRef = undefined;
    userTurn = false;
    userPrompt = "";
    turn++;
  });
}
