import {
  MAX_EVENT_BYTES,
  MAX_SNAPSHOT_BYTES,
  MAX_TOOL_OUTPUT_BYTES,
  type EventMessage,
  type JsonObject,
  type JsonValue,
  type LiveSessionEvent,
  type LiveSessionSummaryBase,
  type ProjectedSessionEntry,
  type SnapshotMessage,
  encodedBytes,
} from "./protocol.ts";

const REDACTED = "[redacted]";
const SENSITIVE_KEY = /(^|_)(api[_-]?key|authorization|credential|env|environment|password|secret|token)($|_)/i;
const DEFAULT_STRING_LIMIT_BYTES = 512 * 1024;

interface SanitizeState {
  readonly seen: WeakSet<object>;
  readonly maxStringBytes: number;
  truncated: boolean;
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  return `${Buffer.from(value, "utf8").subarray(0, Math.max(0, maxBytes - 32)).toString("utf8")}\n…[truncated]`;
}

function sanitize(value: unknown, state: SanitizeState, key?: string): JsonValue {
  if (key && SENSITIVE_KEY.test(key)) return REDACTED;
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    if (typeof value !== "string") return value;
    const result = truncateUtf8(value, state.maxStringBytes);
    if (result !== value) state.truncated = true;
    return result;
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol") return null;
  if (state.seen.has(value)) {
    state.truncated = true;
    return "[circular]";
  }
  state.seen.add(value);
  if (Array.isArray(value)) return value.map((item) => sanitize(item, state));

  const result: Record<string, JsonValue> = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    if (typeof childValue === "undefined" || typeof childValue === "function" || typeof childValue === "symbol") continue;
    result[childKey] = sanitize(childValue, state, childKey);
  }
  return result;
}

export function sanitizeJson(
  value: unknown,
  maxStringBytes = DEFAULT_STRING_LIMIT_BYTES,
): { readonly value: JsonValue; readonly truncated: boolean } {
  const state: SanitizeState = { seen: new WeakSet(), maxStringBytes, truncated: false };
  return { value: sanitize(value, state), truncated: state.truncated };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function projectedEntry(entry: unknown): ProjectedSessionEntry | undefined {
  const source = record(entry);
  if (!source || typeof source.type !== "string") return undefined;

  if (source.type === "message") {
    const message = record(source.message);
    if (!message || (message.role !== "user" && message.role !== "assistant" && message.role !== "toolResult")) {
      return undefined;
    }
    const maxBytes = message.role === "toolResult" ? MAX_TOOL_OUTPUT_BYTES : DEFAULT_STRING_LIMIT_BYTES;
    const projected = sanitizeJson(message, maxBytes);
    const output: Record<string, JsonValue> = {
      type: "message",
      message: projected.value,
    };
    if (typeof source.id === "string") output.id = source.id;
    if (typeof source.parentId === "string" || source.parentId === null) output.parentId = source.parentId;
    if (typeof source.timestamp === "string") output.timestamp = source.timestamp;
    if (projected.truncated) output.truncated = true;
    return output as ProjectedSessionEntry;
  }

  if (source.type === "custom_message" && source.display === true) {
    const projected = sanitizeJson({
      customType: source.customType,
      content: source.content,
      display: true,
      details: source.details,
    });
    const output: Record<string, JsonValue> = {
      type: "custom_message",
      data: projected.value,
    };
    if (typeof source.id === "string") output.id = source.id;
    if (typeof source.timestamp === "string") output.timestamp = source.timestamp;
    if (projected.truncated) output.truncated = true;
    return output as ProjectedSessionEntry;
  }

  return undefined;
}

export function projectBranchEntries(entries: readonly unknown[], entryLimit: number): ProjectedSessionEntry[] {
  const projected = entries
    .map(projectedEntry)
    .filter((entry): entry is ProjectedSessionEntry => entry !== undefined);
  return projected.slice(-Math.max(0, entryLimit));
}

export interface SnapshotProjectorOptions {
  readonly processInstanceId: string;
  readonly snapshotEntryLimit?: number;
  readonly getSummary: () => LiveSessionSummaryBase;
  readonly getBranch: () => readonly unknown[];
}

export class SnapshotProjector {
  private readonly processInstanceId: string;
  private readonly snapshotEntryLimit: number;
  private readonly getSummary: () => LiveSessionSummaryBase;
  private readonly getBranch: () => readonly unknown[];
  private revision = 1;
  private sequence = 0;

  constructor(options: SnapshotProjectorOptions) {
    this.processInstanceId = options.processInstanceId;
    this.snapshotEntryLimit = Math.max(20, Math.min(500, options.snapshotEntryLimit ?? 200));
    this.getSummary = options.getSummary;
    this.getBranch = options.getBranch;
  }

  markChanged(): void {
    this.revision += 1;
  }

  createSnapshot(): SnapshotMessage {
    const summary = {
      ...this.getSummary(),
      revision: this.revision,
      eventSequence: this.sequence,
    };
    const entries = projectBranchEntries(this.getBranch(), this.snapshotEntryLimit);
    let snapshot: SnapshotMessage = {
      type: "snapshot",
      processInstanceId: this.processInstanceId,
      revision: this.revision,
      sequence: this.sequence,
      summary,
      entries,
    };
    while (snapshot.entries.length > 0 && encodedBytes(snapshot) > MAX_SNAPSHOT_BYTES) {
      snapshot = { ...snapshot, entries: snapshot.entries.slice(1) };
    }
    if (encodedBytes(snapshot) > MAX_SNAPSHOT_BYTES) {
      snapshot = { ...snapshot, entries: [] };
    }
    return snapshot;
  }

  createEvent(type: string, data: unknown): EventMessage {
    this.sequence += 1;
    this.revision += 1;
    const sanitized = sanitizeJson(data, MAX_TOOL_OUTPUT_BYTES);
    const eventData = record(sanitized.value) as JsonObject | undefined;
    let event: LiveSessionEvent = {
      type,
      data: eventData ?? { value: sanitized.value },
      ...(sanitized.truncated ? { truncated: true } : {}),
    };
    let message: EventMessage = {
      type: "event",
      processInstanceId: this.processInstanceId,
      sequence: this.sequence,
      event,
    };
    if (encodedBytes(message) > MAX_EVENT_BYTES) {
      event = {
        type,
        data: { truncated: true, originalBytes: encodedBytes(message) },
        truncated: true,
      };
      message = { ...message, event };
    }
    return message;
  }
}
