export const LIVE_SESSION_PROTOCOL_VERSION = 2 as const;

export const MAX_EVENT_BYTES = 8 * 1024 * 1024;
export const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;
export const MAX_COMMAND_BYTES = 8 * 1024 * 1024;
export const MAX_CONNECTION_BUFFER_BYTES = 16 * 1024 * 1024;
export const MAX_PROMPT_BYTES = 128 * 1024;
export const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
export const MAX_IMAGES = 4;
export const MAX_IMAGE_TOTAL_BYTES = 6 * 1024 * 1024;
export const MAX_TOOL_OUTPUT_BYTES = 256 * 1024;
export const REQUEST_CACHE_SIZE = 256;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { readonly [key: string]: JsonValue };

export type LiveSessionMode = "tui" | "rpc";
export type LiveSessionStatus = "idle" | "running" | "reconnecting";

export interface LiveSessionSummary {
  readonly processInstanceId: string;
  readonly sessionId: string;
  readonly role?: "main" | "subagent";
  readonly parentSessionId?: string;
  readonly parentToolCallId?: string;
  readonly subagentWorkId?: string;
  readonly sessionFile?: string;
  readonly sessionName?: string;
  readonly pid: number;
  readonly cwd: string;
  readonly canonicalCwd: string;
  readonly mode: LiveSessionMode;
  readonly model?: { readonly provider: string; readonly id: string };
  readonly thinkingLevel?: string;
  readonly status: LiveSessionStatus;
  readonly claim: {
    readonly state: "unclaimed" | "claimed";
    readonly leaseId?: string;
    readonly expiresAt?: number;
  };
  readonly startedAt: number;
  readonly lastActivityAt: number;
  readonly revision: number;
  readonly eventSequence: number;
  readonly contextUsage?: {
    readonly tokens: number | null;
    readonly contextWindow: number;
    readonly percent: number | null;
  };
}

export type LiveSessionSummaryBase = Omit<LiveSessionSummary, "revision" | "eventSequence">;

export type ProjectedSessionEntry = JsonObject & {
  readonly type: string;
  readonly id?: string;
  readonly timestamp?: string;
  readonly truncated?: boolean;
};

export type LiveSessionEvent = JsonObject & {
  readonly type: string;
  readonly data: JsonObject;
  readonly truncated?: boolean;
};

export type LiveSessionInputChannel = "web" | "terminal" | "chatapp" | "mobile";

export interface LiveSessionImage {
  readonly type: "image";
  readonly data: string;
  readonly mimeType: string;
}

export type LiveSessionCommand =
  | { readonly type: "resync" }
  | { readonly type: "claim"; readonly browserClientId: string; readonly requestedLeaseMs: number }
  | { readonly type: "renew"; readonly leaseId: string }
  | { readonly type: "release"; readonly leaseId: string }
  | {
      readonly type: "input";
      readonly text: string;
      readonly images?: readonly LiveSessionImage[];
      readonly channel: LiveSessionInputChannel;
      readonly deliverAs?: "steer" | "followUp";
    }
  | { readonly type: "abort"; readonly leaseId: string }
  | { readonly type: "set_session_name"; readonly name: string }
  | { readonly type: "get_models" }
  | { readonly type: "set_model"; readonly provider: string; readonly modelId: string }
  | { readonly type: "compact"; readonly leaseId: string }
  | { readonly type: "reload" }
  | {
      readonly type: "feature_command";
      readonly leaseId: string;
      readonly feature: "btw";
      readonly command: { readonly type: "open" | "close" };
    }
  | {
      readonly type: "answer_ui";
      readonly id: string;
      readonly value?: string;
      readonly cancelled?: boolean;
    };

export interface HelloMessage {
  readonly type: "hello";
  readonly protocolVersion: typeof LIVE_SESSION_PROTOCOL_VERSION;
  readonly brokerToken: string;
  readonly processInstanceId: string;
  readonly pid: number;
  readonly cwd: string;
  readonly mode: LiveSessionMode;
  readonly sessionId: string;
}

export interface SnapshotMessage {
  readonly type: "snapshot";
  readonly processInstanceId: string;
  readonly revision: number;
  readonly sequence: number;
  readonly summary: LiveSessionSummary;
  readonly entries: readonly ProjectedSessionEntry[];
}

export interface EventMessage {
  readonly type: "event";
  readonly processInstanceId: string;
  readonly sequence: number;
  readonly event: LiveSessionEvent;
}

export interface CommandError {
  readonly code: string;
  readonly message: string;
}

export type CommandResultMessage =
  | { readonly type: "command_result"; readonly requestId: string; readonly ok: true; readonly result: JsonValue }
  | { readonly type: "command_result"; readonly requestId: string; readonly ok: false; readonly error: CommandError };

export interface HeartbeatMessage {
  readonly type: "heartbeat";
  readonly processInstanceId: string;
  readonly at: number;
}

export interface GoodbyeMessage {
  readonly type: "goodbye";
  readonly processInstanceId: string;
  readonly reason: string;
}

export type ExtensionToBrokerMessage =
  | HelloMessage
  | SnapshotMessage
  | EventMessage
  | CommandResultMessage
  | HeartbeatMessage
  | GoodbyeMessage;

export interface WelcomeMessage {
  readonly type: "welcome";
  readonly protocolVersion: typeof LIVE_SESSION_PROTOCOL_VERSION;
  readonly heartbeatMs: number;
}

export interface RejectMessage {
  readonly type: "reject";
  readonly code: string;
  readonly message: string;
}

export interface CommandEnvelope {
  readonly type: "command";
  readonly requestId: string;
  readonly processInstanceId: string;
  readonly command: LiveSessionCommand;
}

export type BrokerToExtensionMessage = WelcomeMessage | RejectMessage | CommandEnvelope;

export type CommandExecutionResult =
  | { readonly ok: true; readonly result: JsonValue }
  | { readonly ok: false; readonly error: CommandError };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => allowed.has(key));
}

function parseImages(value: unknown): LiveSessionImage[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_IMAGES) return undefined;
  let totalBytes = 0;
  const images: LiveSessionImage[] = [];
  for (const item of value) {
    if (!isRecord(item) || !hasOnlyKeys(item, ["type", "data", "mimeType"])
      || item.type !== "image"
      || !isBoundedString(item.data, MAX_IMAGE_BYTES)
      || typeof item.mimeType !== "string"
      || !/^image\/[a-z0-9.+-]+$/i.test(item.mimeType)
      || Buffer.byteLength(item.data, "utf8") > MAX_IMAGE_BYTES) return undefined;
    totalBytes += Buffer.byteLength(item.data, "utf8");
    if (totalBytes > MAX_IMAGE_TOTAL_BYTES) return undefined;
    images.push({ type: "image", data: item.data, mimeType: item.mimeType });
  }
  return images;
}

function isBoundedString(value: unknown, maxBytes = 4096): value is string {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= maxBytes;
}

function parseCommand(value: unknown): LiveSessionCommand | undefined {
  if (!isRecord(value) || typeof value.type !== "string") return undefined;

  if (value.type === "resync" && hasOnlyKeys(value, ["type"])) return { type: "resync" };

  if (value.type === "claim" && hasOnlyKeys(value, ["type", "browserClientId", "requestedLeaseMs"])) {
    if (!isBoundedString(value.browserClientId, 256)
      || !Number.isInteger(value.requestedLeaseMs)
      || Number(value.requestedLeaseMs) < 10_000
      || Number(value.requestedLeaseMs) > 120_000) return undefined;
    return {
      type: "claim",
      browserClientId: value.browserClientId,
      requestedLeaseMs: Number(value.requestedLeaseMs),
    };
  }

  if ((value.type === "renew" || value.type === "release" || value.type === "abort")
    && hasOnlyKeys(value, ["type", "leaseId"])) {
    if (!isBoundedString(value.leaseId, 256)) return undefined;
    return { type: value.type, leaseId: value.leaseId };
  }

  if (value.type === "set_session_name" && hasOnlyKeys(value, ["type", "name"])) {
    if (!isBoundedString(value.name, 160)) return undefined;
    return { type: "set_session_name", name: value.name };
  }

  if (value.type === "get_models" && hasOnlyKeys(value, ["type"])) return { type: "get_models" };

  if (value.type === "set_model" && hasOnlyKeys(value, ["type", "provider", "modelId"])) {
    if (!isBoundedString(value.provider, 512) || !isBoundedString(value.modelId, 1024)) return undefined;
    return { type: "set_model", provider: value.provider, modelId: value.modelId };
  }

  if (value.type === "compact" && hasOnlyKeys(value, ["type", "leaseId"])) {
    if (!isBoundedString(value.leaseId, 256)) return undefined;
    return { type: "compact", leaseId: value.leaseId };
  }

  if (value.type === "reload" && hasOnlyKeys(value, ["type"])) return { type: "reload" };

  if (value.type === "feature_command"
    && hasOnlyKeys(value, ["type", "leaseId", "feature", "command"])) {
    if (!isBoundedString(value.leaseId, 256) || value.feature !== "btw" || !isRecord(value.command)
      || !hasOnlyKeys(value.command, ["type"])
      || (value.command.type !== "open" && value.command.type !== "close")) return undefined;
    return { type: "feature_command", leaseId: value.leaseId, feature: "btw", command: { type: value.command.type } };
  }

  if (value.type === "input"
    && hasOnlyKeys(value, ["type", "text", "channel"], ["deliverAs", "images"])) {
    const hasImages = Object.hasOwn(value, "images");
    const images = parseImages(value.images);
    if ((hasImages && !images) || typeof value.text !== "string"
      || Buffer.byteLength(value.text, "utf8") > MAX_PROMPT_BYTES
      || (!value.text.trim() && !images?.length)
      || (value.deliverAs !== undefined && value.deliverAs !== "steer" && value.deliverAs !== "followUp")
      || (value.channel !== "web" && value.channel !== "terminal" && value.channel !== "chatapp" && value.channel !== "mobile")) return undefined;
    return {
      type: "input",
      text: value.text,
      channel: value.channel,
      ...(images ? { images } : {}),
      ...(value.deliverAs === undefined ? {} : { deliverAs: value.deliverAs }),
    };
  }

  return undefined;
}

export function parseBrokerMessage(value: unknown): BrokerToExtensionMessage | undefined {
  if (!isRecord(value) || typeof value.type !== "string") return undefined;

  if (value.type === "welcome" && hasOnlyKeys(value, ["type", "protocolVersion", "heartbeatMs"])) {
    if (value.protocolVersion !== LIVE_SESSION_PROTOCOL_VERSION
      || !Number.isInteger(value.heartbeatMs)
      || Number(value.heartbeatMs) < 1000
      || Number(value.heartbeatMs) > 120_000) return undefined;
    return {
      type: "welcome",
      protocolVersion: LIVE_SESSION_PROTOCOL_VERSION,
      heartbeatMs: Number(value.heartbeatMs),
    };
  }

  if (value.type === "reject" && hasOnlyKeys(value, ["type", "code", "message"])) {
    if (!isBoundedString(value.code, 256) || !isBoundedString(value.message, 4096)) return undefined;
    return { type: "reject", code: value.code, message: value.message };
  }

  if (value.type === "command" && hasOnlyKeys(value, ["type", "requestId", "processInstanceId", "command"])) {
    if (!isBoundedString(value.requestId, 256) || !isBoundedString(value.processInstanceId, 256)) return undefined;
    const command = parseCommand(value.command);
    if (!command) return undefined;
    return {
      type: "command",
      requestId: value.requestId,
      processInstanceId: value.processInstanceId,
      command,
    };
  }

  return undefined;
}

export function encodedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

export function success(requestId: string, result: JsonValue): CommandResultMessage {
  return { type: "command_result", requestId, ok: true, result };
}

export function failure(requestId: string, code: string, message: string): CommandResultMessage {
  return { type: "command_result", requestId, ok: false, error: { code, message } };
}
