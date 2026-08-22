import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface MemoryConfig {
  schemaVersion: 1;
  warnings: string[];
  dataDir: string;
  capture: {
    enabled: boolean;
    strategy: "rules";
    candidateRetentionDays: number;
    reviewCandidates: boolean;
    reviewPromptTimeoutMs: number;
    reviewer: {
      enabled: boolean;
      model: string;
      timeoutMs: number;
      maxInputChars: number;
    };
  };
  recall: {
    enabled: boolean;
    maxItems: number;
    maxTokens: number;
    minScore: number;
    timeoutMs: number;
  };
  privacy: {
    storeEvidenceSummary: boolean;
    remoteProcessing: boolean;
  };
  knowledge: {
    bridge: "auto";
    combinedContextBudget: number;
  };
}

const defaults: Omit<MemoryConfig, "dataDir" | "warnings"> = {
  schemaVersion: 1,
  capture: {
    enabled: true,
    strategy: "rules",
    candidateRetentionDays: 30,
    reviewCandidates: true,
    reviewPromptTimeoutMs: 15_000,
    reviewer: { enabled: true, model: "openai-codex/gpt-5.6-luna", timeoutMs: 15_000, maxInputChars: 2_000 },
  },
  recall: { enabled: true, maxItems: 6, maxTokens: 1000, minScore: 0.62, timeoutMs: 150 },
  privacy: { storeEvidenceSummary: false, remoteProcessing: false },
  knowledge: { bridge: "auto", combinedContextBudget: 1400 },
};

function integerEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

function booleanEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.toLowerCase();
  if (raw === "true") return true;
  if (raw === "false") return false;
  return fallback;
}

export function defaultDataDir(): string {
  return process.env.PI_TSIEN_MEMORY_DIR?.trim() || join(homedir(), ".pi", "tsien-memory");
}

export function defaultConfig(): MemoryConfig {
  return {
    ...defaults,
    warnings: [],
    dataDir: defaultDataDir(),
    capture: {
      ...defaults.capture,
      enabled: booleanEnv("PI_TSIEN_MEMORY_CAPTURE", defaults.capture.enabled),
      reviewCandidates: booleanEnv("PI_TSIEN_MEMORY_REVIEW_CANDIDATES", defaults.capture.reviewCandidates),
      reviewPromptTimeoutMs: integerEnv("PI_TSIEN_MEMORY_REVIEW_TIMEOUT_MS", defaults.capture.reviewPromptTimeoutMs, 1_000, 120_000),
      reviewer: {
        ...defaults.capture.reviewer,
        enabled: booleanEnv("PI_TSIEN_MEMORY_REVIEWER", defaults.capture.reviewer.enabled),
        model: process.env.PI_TSIEN_MEMORY_REVIEW_MODEL?.trim() || defaults.capture.reviewer.model,
        timeoutMs: integerEnv("PI_TSIEN_MEMORY_REVIEWER_TIMEOUT_MS", defaults.capture.reviewer.timeoutMs, 1_000, 120_000),
        maxInputChars: integerEnv("PI_TSIEN_MEMORY_REVIEWER_MAX_INPUT_CHARS", defaults.capture.reviewer.maxInputChars, 200, 8_000),
      },
    },
    recall: {
      ...defaults.recall,
      enabled: booleanEnv("PI_TSIEN_MEMORY_RECALL", defaults.recall.enabled),
      maxItems: integerEnv("PI_TSIEN_MEMORY_MAX_ITEMS", defaults.recall.maxItems, 1, 20),
      maxTokens: integerEnv("PI_TSIEN_MEMORY_MAX_TOKENS", defaults.recall.maxTokens, 100, 4000),
      minScore: parseScore(process.env.PI_TSIEN_MEMORY_MIN_SCORE, defaults.recall.minScore),
      timeoutMs: integerEnv("PI_TSIEN_MEMORY_TIMEOUT_MS", defaults.recall.timeoutMs, 20, 1000),
    },
  };
}

export function loadConfig(cwd = process.cwd(), trustedProject = false): MemoryConfig {
  const base = defaultConfig();
  const warnings: string[] = [];
  const parsed = mergeConfigFiles([
    join(homedir(), ".pi", "tsien-memory", "config.json"),
    ...(trustedProject ? [join(cwd, ".pi", "tsien-memory.json")] : []),
  ], warnings);
  const merged = {
    ...base,
    ...parsed,
    warnings,
    dataDir: base.dataDir,
    capture: { ...base.capture, ...(isRecord(parsed.capture) ? parsed.capture : {}) },
    recall: { ...base.recall, ...(isRecord(parsed.recall) ? parsed.recall : {}) },
    privacy: { ...base.privacy, ...(isRecord(parsed.privacy) ? parsed.privacy : {}) },
    knowledge: { ...base.knowledge, ...(isRecord(parsed.knowledge) ? parsed.knowledge : {}) },
  } as MemoryConfig;
  merged.recall.maxItems = clampInteger(merged.recall.maxItems, 1, 20, base.recall.maxItems);
  merged.recall.maxTokens = clampInteger(merged.recall.maxTokens, 100, 4000, base.recall.maxTokens);
  merged.recall.timeoutMs = clampInteger(merged.recall.timeoutMs, 20, 1000, base.recall.timeoutMs);
  merged.recall.minScore = typeof merged.recall.minScore === "number" && merged.recall.minScore >= 0 && merged.recall.minScore <= 1 ? merged.recall.minScore : base.recall.minScore;
  merged.knowledge.combinedContextBudget = clampInteger(merged.knowledge.combinedContextBudget, 400, 4000, base.knowledge.combinedContextBudget);
  merged.capture.enabled = merged.capture.enabled !== false;
  merged.capture.reviewCandidates = merged.capture.reviewCandidates !== false;
  merged.capture.reviewPromptTimeoutMs = clampInteger(merged.capture.reviewPromptTimeoutMs, 1_000, 120_000, base.capture.reviewPromptTimeoutMs);
  merged.capture.reviewer = { ...base.capture.reviewer, ...(isRecord(merged.capture.reviewer) ? merged.capture.reviewer : {}) } as MemoryConfig["capture"]["reviewer"];
  merged.capture.reviewer.enabled = merged.capture.reviewer.enabled !== false;
  merged.capture.reviewer.model = typeof merged.capture.reviewer.model === "string" && merged.capture.reviewer.model.trim() ? merged.capture.reviewer.model.trim() : base.capture.reviewer.model;
  merged.capture.reviewer.timeoutMs = clampInteger(merged.capture.reviewer.timeoutMs, 1_000, 120_000, base.capture.reviewer.timeoutMs);
  merged.capture.reviewer.maxInputChars = clampInteger(merged.capture.reviewer.maxInputChars, 200, 8_000, base.capture.reviewer.maxInputChars);
  merged.recall.enabled = merged.recall.enabled !== false;
  merged.privacy.remoteProcessing = merged.privacy.remoteProcessing === true;
  return merged;
}

function parseScore(value: string | undefined, fallback: number): number {
  const parsed = value === undefined ? Number.NaN : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : fallback;
}

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergeConfigFiles(paths: string[], warnings: string[]): Partial<MemoryConfig> {
  let merged: Partial<MemoryConfig> = {};
  for (const path of paths) {
    try {
      const value: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (!isRecord(value)) { warnings.push(`ignored non-object config: ${path.split(/[\\/]/u).pop() ?? "config"}`); continue; }
      const allowed = new Set(["schemaVersion", "capture", "recall", "privacy", "knowledge"]);
      for (const key of Object.keys(value)) if (!allowed.has(key)) warnings.push(`ignored unknown config field: ${key}`);
      merged = { ...merged, ...value, capture: { ...(isRecord(merged.capture) ? merged.capture : {}), ...(isRecord(value.capture) ? value.capture : {}) }, recall: { ...(isRecord(merged.recall) ? merged.recall : {}), ...(isRecord(value.recall) ? value.recall : {}) }, privacy: { ...(isRecord(merged.privacy) ? merged.privacy : {}), ...(isRecord(value.privacy) ? value.privacy : {}) }, knowledge: { ...(isRecord(merged.knowledge) ? merged.knowledge : {}), ...(isRecord(value.knowledge) ? value.knowledge : {}) } } as Partial<MemoryConfig>;
    } catch (error) {
      if (error instanceof SyntaxError) warnings.push(`ignored invalid JSON config: ${path.split(/[\\/]/u).pop() ?? "config"}`);
    }
  }
  return merged;
}
