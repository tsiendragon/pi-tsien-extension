import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type TranscriptWindowConfig = {
  enabled: boolean;
  recentTurns: number;
  hideHistoricalTools: boolean;
  hideHistoricalThinking: boolean;
};

export const DEFAULT_TRANSCRIPT_WINDOW: TranscriptWindowConfig = {
  enabled: true,
  recentTurns: 20,
  hideHistoricalTools: true,
  hideHistoricalThinking: true,
};

export const MIN_RECENT_TURNS = 1;
export const MAX_RECENT_TURNS = 200;

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJsonRecord(path: string): JsonRecord {
  try {
    if (!existsSync(path)) return {};
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function transcriptWindowRecord(settings: unknown): JsonRecord {
  if (!isRecord(settings) || !isRecord(settings.transcriptWindow)) return {};
  return settings.transcriptWindow;
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function readRecentTurns(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value < MIN_RECENT_TURNS ||
    value > MAX_RECENT_TURNS
  ) {
    return DEFAULT_TRANSCRIPT_WINDOW.recentTurns;
  }
  return value;
}

/** Resolve settings with project fields taking precedence over global fields. */
export function resolveTranscriptWindowConfig(
  globalSettings: unknown,
  projectSettings: unknown,
): TranscriptWindowConfig {
  const merged = {
    ...transcriptWindowRecord(globalSettings),
    ...transcriptWindowRecord(projectSettings),
  };

  return {
    enabled: readBoolean(merged.enabled, DEFAULT_TRANSCRIPT_WINDOW.enabled),
    recentTurns: readRecentTurns(merged.recentTurns),
    hideHistoricalTools: readBoolean(
      merged.hideHistoricalTools,
      DEFAULT_TRANSCRIPT_WINDOW.hideHistoricalTools,
    ),
    hideHistoricalThinking: readBoolean(
      merged.hideHistoricalThinking,
      DEFAULT_TRANSCRIPT_WINDOW.hideHistoricalThinking,
    ),
  };
}

/** Read Pi's global and project settings without mutating either file. */
export function readTranscriptWindowConfig(cwd: string): TranscriptWindowConfig {
  const agentDirectory = process.env.PI_CODING_AGENT_DIR ?? homedir();
  const globalPath = join(agentDirectory, ".pi", "agent", "settings.json");
  const projectPath = join(cwd, ".pi", "settings.json");

  return resolveTranscriptWindowConfig(
    readJsonRecord(globalPath),
    readJsonRecord(projectPath),
  );
}
