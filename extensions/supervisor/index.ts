import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { request } from "node:http";
import { isAbsolute } from "node:path";
import { Type, type TSchema } from "typebox";
import { Value } from "typebox/value";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

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
 * Drop the envelopes the dashboard adds around a forwarded turn before reading the user's own words.
 */
export function userWords(prompt: string): string {
  return prompt
    .split("\n")
    .filter(line => !/^\s*\[supervisor-(?:user-grant|auto-patrol)[^\]]*\]/.test(line))
    .filter(line => !/^\s*浏览上下文（仅供参考）：/.test(line))
    .filter(line => !/^\s*用户提交的已保存截图 attachmentIds：/.test(line))
    .join("\n").trim();
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
    description: "Correct an event and keep the revision history; the gateway enforces authorization.",
    parameters: object({ id: text("Event ID to correct."), expectedVersion: Type.Integer({ minimum: 1 }), patch: object(eventFields), reason: text("Reason for correction.") }),
  },
  {
    name: "supervisor_task_create", operation: "task_create",
    description: "Create a supervisor task through the gateway.",
    parameters: object({ title: text("Task title."), description: optionalText("Task objective and acceptance checks."), kind: Type.Optional(Type.String({ enum: ["task", "epic", "todo", "item"] })), parentUid: optionalText("Parent Epic UID."), tags: Type.Optional(Type.Array(Type.String())) }),
  },
  {
    name: "supervisor_task_update", operation: "task_update",
    description: "Change the task itself (title, description, status) when the user explicitly asks, and say so in the reply; it is a user-visible change. Records belong in event_append instead. Status changes require completion evidence.",
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
    description: "Send an assistant coordination message to an explicitly authorized target. Automatic mode is limited and backend-gated, never user impersonation.",
    parameters: object({ sessionId: text("Explicitly authorized target session ID."), text: Type.String({ description: "Assistant suggestion, not new user authorization.", minLength: 1, maxLength: 1024 }), kind: Type.String({ enum: ["clarification", "continue", "correction"] }), sourceRefs: Type.Array(text("Accessible event ID or approved file inspection sourceRef."), { minItems: 1 }) }),
  },
] as const;

export const SUPERVISOR_TOOL_NAMES = tools.map((tool) => tool.name);

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
        // No confirmation step: the gateway decides whether this turn may write, and the user asked for
        // zero popups. A user turn writes directly; an automatic patrol turn is refused by the backend.
        if (signal?.aborted) throw new Error("Supervisor gateway request cancelled.");
        if (turn !== activeTurn || gateway !== activeGateway) throw new Error("Supervisor turn changed; request cancelled.");
        const payload = () => ({ request: { operation, args }, ...(activeGrant ? { grantRef: activeGrant } : {}), ...(activeUserTurn ? { userTurn: true, ...(activeUserPrompt ? { userPrompt: activeUserPrompt } : {}) } : {}) });
        const result: unknown = await activeGateway.call("/execute", payload(), { signal, includeImages: name === "event_get" && args.includeImages === true });
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
