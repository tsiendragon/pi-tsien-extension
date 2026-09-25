import {
  defineTool,
  formatSize,
  type SessionEntry,
  truncateHead,
  truncateLine,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export const SESSION_HISTORY_TOOL_NAME = "session_history";

const DEFAULT_LIMIT = 12;
const MAX_LIMIT = 30;
const MAX_RECORD_BYTES = 6_000;
const MAX_RECORD_LINES = 120;
const MAX_LINE_CHARS = 1_000;
const MAX_OUTPUT_BYTES = 48 * 1024;
const MAX_OUTPUT_LINES = 1_200;
const OUTPUT_METADATA_RESERVE_BYTES = 2_048;
const OUTPUT_METADATA_RESERVE_LINES = 12;

export type SessionHistorySnapshot = {
  entries: SessionEntry[];
};

type HistoryRecord = {
  branchIndex: number;
  id: string;
  timestamp: string;
  role: string;
  text: string;
};

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const lines: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const block = part as {
      type?: string;
      text?: string;
      name?: string;
      arguments?: unknown;
    };
    if (block.type === "text" && typeof block.text === "string") {
      lines.push(block.text);
    } else if (block.type === "toolCall" && typeof block.name === "string") {
      lines.push(`[tool call: ${block.name}] ${stringify(block.arguments ?? {})}`);
    }
  }
  return lines.join("\n");
}

function entryToRecord(entry: SessionEntry, branchIndex: number): HistoryRecord | undefined {
  if (entry.type === "message") {
    const message = entry.message as unknown as {
      role?: string;
      content?: unknown;
      command?: string;
      output?: string;
      toolName?: string;
    };
    let text = contentText(message.content);
    if (message.role === "bashExecution") {
      text = `$ ${message.command ?? ""}\n${message.output ?? ""}`.trim();
    }
    if (!text.trim()) return undefined;
    const role = message.role === "toolResult" && message.toolName
      ? `toolResult:${message.toolName}`
      : (message.role ?? "message");
    return {
      branchIndex,
      id: entry.id,
      timestamp: entry.timestamp,
      role,
      text,
    };
  }

  if (entry.type === "custom_message") {
    const text = contentText(entry.content);
    if (!text.trim()) return undefined;
    return {
      branchIndex,
      id: entry.id,
      timestamp: entry.timestamp,
      role: `custom:${entry.customType}`,
      text,
    };
  }

  if (entry.type === "compaction") {
    return {
      branchIndex,
      id: entry.id,
      timestamp: entry.timestamp,
      role: "compactionSummary",
      text: entry.summary,
    };
  }

  if (entry.type === "branch_summary") {
    return {
      branchIndex,
      id: entry.id,
      timestamp: entry.timestamp,
      role: "branchSummary",
      text: entry.summary,
    };
  }

  return undefined;
}

function recordSearchText(record: HistoryRecord): string {
  return `${record.role}\n${record.text}`.toLocaleLowerCase();
}

function selectRecords(
  records: HistoryRecord[],
  query: string | undefined,
): HistoryRecord[] {
  const terms = (query ?? "")
    .toLocaleLowerCase()
    .split(/\s+/u)
    .map((term) => term.trim())
    .filter(Boolean);

  if (terms.length === 0) return [...records].reverse();

  return records
    .map((record) => {
      const text = recordSearchText(record);
      const score = terms.reduce((total, term) => total + (text.includes(term) ? 1 : 0), 0);
      return { record, score };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || b.record.branchIndex - a.record.branchIndex)
    .map(({ record }) => record);
}

function formatRecord(record: HistoryRecord): string {
  const lines = record.text.split("\n");
  const lineLimited = lines
    .slice(0, MAX_RECORD_LINES)
    .map((line) => truncateLine(line, MAX_LINE_CHARS).text)
    .join("\n");
  const clipped = truncateHead(lineLimited, {
    maxBytes: MAX_RECORD_BYTES,
    maxLines: MAX_RECORD_LINES,
  });
  const wasTruncated = lines.length > MAX_RECORD_LINES || clipped.truncated || lineLimited !== record.text;
  const text = `${clipped.content}${wasTruncated ? "\n[message truncated]" : ""}`;
  return `[${record.branchIndex}] ${record.timestamp} ${record.role} id=${record.id}\n${text}`;
}

export function snapshotSessionHistory(entries: SessionEntry[]): SessionHistorySnapshot {
  return { entries: structuredClone(entries) };
}

export function createSessionHistoryTool(snapshot: SessionHistorySnapshot) {
  return defineTool({
    name: SESSION_HISTORY_TOOL_NAME,
    label: "Session History",
    description:
      "Read the parent session's complete active-branch history snapshot, including messages omitted from the current context by compaction. Use only when the user's question requires older details. Search by keywords or omit query to page backward from the newest records. This tool is read-only and never changes the parent session.",
    parameters: Type.Object({
      query: Type.Optional(Type.String({
        description: "Keywords to search for in message roles and text. Omit to browse newest records first.",
      })),
      offset: Type.Optional(Type.Integer({
        minimum: 0,
        description: "Number of matching records to skip for pagination. Defaults to 0.",
      })),
      limit: Type.Optional(Type.Integer({
        minimum: 1,
        maximum: MAX_LIMIT,
        description: `Maximum records to return. Defaults to ${DEFAULT_LIMIT}, maximum ${MAX_LIMIT}.`,
      })),
    }),
    async execute(_toolCallId, params, signal) {
      signal?.throwIfAborted();
      const records = snapshot.entries
        .map((entry, index) => entryToRecord(entry, index))
        .filter((record): record is HistoryRecord => record !== undefined);
      const matches = selectRecords(records, params.query);
      const offset = params.offset ?? 0;
      const limit = params.limit ?? DEFAULT_LIMIT;
      const candidates = matches.slice(offset, offset + limit);
      const bodyParts: string[] = [];
      for (const record of candidates) {
        const nextParts = [...bodyParts, formatRecord(record)];
        const trial = truncateHead(nextParts.join("\n\n---\n\n"), {
          maxBytes: MAX_OUTPUT_BYTES - OUTPUT_METADATA_RESERVE_BYTES,
          maxLines: MAX_OUTPUT_LINES - OUTPUT_METADATA_RESERVE_LINES,
        });
        if (trial.truncated) break;
        bodyParts.push(nextParts.at(-1) ?? "");
      }

      const returned = bodyParts.length;
      const outputLimited = returned < candidates.length;
      const heading = [
        `Session history snapshot: ${records.length} readable records on the active branch.`,
        params.query ? `Search: ${params.query}` : "Order: newest first.",
        `Matches: ${matches.length}; returning ${returned} from offset ${offset}.`,
      ].join("\n");
      const body = returned > 0
        ? bodyParts.join("\n\n---\n\n")
        : "No matching history records.";
      let text = `${heading}\n\n${body}`;
      if (outputLimited) {
        text += "\n\n[Output limited in memory. Narrow the query or reduce limit. No file was written.]";
      }
      const nextOffset = offset + returned;
      if (nextOffset < matches.length) {
        text += `\n\nMore matches are available; call again with offset=${nextOffset}.`;
      }

      const finalOutput = truncateHead(text, {
        maxBytes: MAX_OUTPUT_BYTES,
        maxLines: MAX_OUTPUT_LINES,
      });
      if (finalOutput.truncated) {
        throw new Error(
          `Session history output budget error (${formatSize(finalOutput.outputBytes)} of ${formatSize(finalOutput.totalBytes)})`,
        );
      }

      return {
        content: [{ type: "text", text: finalOutput.content }],
        details: {
          totalRecords: records.length,
          totalMatches: matches.length,
          offset,
          returned,
          truncated: outputLimited,
        },
      };
    },
  });
}
