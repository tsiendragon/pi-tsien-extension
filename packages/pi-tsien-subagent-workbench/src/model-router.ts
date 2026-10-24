import { readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { AgentThinkingLevel } from "./subagent-service.ts";

export const TIERS = ["light", "medium", "heavy", "ultra"] as const;
export type Tier = (typeof TIERS)[number];
export type RouterRole = "read_only" | "code" | "research";
export type ExhaustedAction = "wait" | "wait_then_escalate" | "escalate" | "fail";

export type ErrorClass =
  | "rate_limited"
  | "quota_exhausted"
  | "overloaded"
  | "network"
  | "context_overflow"
  | "not_found"
  | "auth"
  | "content_refused"
  | "budget"
  | "timeout"
  | "cancelled"
  | "unknown";

export interface CandidateConfig {
  readonly model: string;
  readonly thinking?: AgentThinkingLevel;
  readonly maxConcurrency?: number;
  readonly quotaGroup?: string;
}

export interface TierConfig {
  readonly candidates: readonly CandidateConfig[];
  readonly spillover: boolean;
  readonly onExhausted: {
    readonly action: ExhaustedAction;
    readonly maxWaitMs: number;
    readonly escalateTo?: Tier;
  };
}

export interface RouterConfig {
  readonly defaultTier: Tier;
  readonly roles: Readonly<Record<RouterRole, Tier>>;
  readonly allowInherit: boolean;
  readonly tiers: Readonly<Record<Tier, TierConfig>>;
  readonly workHardMs: number;
  readonly workHardMaxMs: number;
  readonly maxModelCallsPerTask: number;
  readonly legacy: boolean;
}

export const DEFAULT_WORK_HARD_MS = 72 * 60 * 60_000;
export const DEFAULT_WORK_HARD_MAX_MS = 14 * 24 * 60 * 60_000;
export const DEFAULT_MAX_MODEL_CALLS = 2_000;
export const MAX_SWITCHES_PER_TASK = 3;
const DEFAULT_MAX_CONCURRENCY = 4;
const AUTO_ESCALATION_TIERS: readonly Tier[] = ["light", "medium"];
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const MODEL_REF = /^[^/\s]+\/\S+$/;

const COOLDOWN_MS: Partial<Record<ErrorClass, number>> = {
  rate_limited: 60_000,
  quota_exhausted: 30 * 60_000,
  overloaded: 30_000,
  network: 30_000,
};

/** Error classes that justify trying another candidate in the same tier. */
const SWITCHABLE: ReadonlySet<ErrorClass> = new Set([
  "rate_limited",
  "quota_exhausted",
  "overloaded",
  "network",
  "not_found",
  "auth",
  "unknown",
]);

/** Classes that are configuration problems: the candidate stays disabled until config reload. */
const DISABLING: ReadonlySet<ErrorClass> = new Set(["not_found", "auth"]);

/** Errors raised before the child could do any work; safe to restart even for writing roles. */
export const STARTUP_CLASSES: ReadonlySet<ErrorClass> = DISABLING;

const PATTERNS: readonly (readonly [ErrorClass, RegExp])[] = [
  ["cancelled", /run interrupted|interrupted by user|cancelled by user|workbench controller is disposed/i],
  ["budget", /model_call_budget|model call budget/i],
  ["timeout", /run_wall_timeout|exceeded hard wall time/i],
  ["quota_exhausted", /insufficient_quota|quota|usage limit|billing|credit balance|余额|额度/i],
  ["rate_limited", /\b429\b|rate.?limit|too many requests|requests per minute|tpm limit|rpm limit/i],
  ["context_overflow", /context.?length|maximum context|context window|prompt is too long|too many tokens/i],
  ["not_found", /model .* not found|unknown model|model_not_found|does not exist|no such model/i],
  ["auth", /\b401\b|\b403\b|unauthori[sz]ed|forbidden|invalid.?api.?key|authentication|no api key/i],
  ["content_refused", /content.?filter|content_policy|safety system|responsibleai/i],
  ["overloaded", /\b5(?:00|02|03|04|29)\b|overloaded|service unavailable|internal server error|bad gateway/i],
  ["network", /econnreset|etimedout|econnrefused|socket hang up|network|fetch failed|terminated|aborted/i],
];

export function classifyError(message: string | undefined): {
  readonly errorClass: ErrorClass;
  readonly retryAfterMs?: number;
} {
  const text = message ?? "";
  const errorClass = PATTERNS.find(([, pattern]) => pattern.test(text))?.[0] ?? "unknown";
  const retry = /retry[- ]?after\D{0,10}(\d+(?:\.\d+)?)\s*(ms|s|sec|seconds)?/i.exec(text);
  if (!retry) return { errorClass };
  const value = Number(retry[1]);
  return { errorClass, retryAfterMs: retry[2]?.toLowerCase() === "ms" ? value : value * 1000 };
}

export function isSwitchable(errorClass: ErrorClass): boolean {
  return SWITCHABLE.has(errorClass);
}

export function defaultConfigPath(environment: NodeJS.ProcessEnv = process.env): string {
  const explicit = environment.PI_SUBAGENT_MODEL_CONFIG?.trim();
  if (explicit) return explicit;
  const agentDir = environment.PI_CODING_AGENT_DIR?.trim() || path.join(os.homedir(), ".pi", "agent");
  return path.join(agentDir, "subagent-models.json");
}

function isTier(value: unknown): value is Tier {
  return typeof value === "string" && (TIERS as readonly string[]).includes(value);
}

function positive(value: unknown, field: string, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${field} must be a positive integer.`);
  }
  return value;
}

function objectAt(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object.`);
  }
  return value as Record<string, unknown>;
}

const DEFAULT_EXHAUSTED: Readonly<Record<Tier, TierConfig["onExhausted"]>> = {
  light: { action: "wait_then_escalate", maxWaitMs: 120_000, escalateTo: "medium" },
  medium: { action: "wait", maxWaitMs: 600_000 },
  heavy: { action: "fail", maxWaitMs: 0 },
  ultra: { action: "fail", maxWaitMs: 0 },
};

/** Validate the user config file. Throws a readable TypeError on the first problem. */
export function parseRouterConfig(raw: unknown): RouterConfig {
  const root = objectAt(raw, "config");
  if (root.version !== 1) throw new TypeError("config.version must be 1.");
  const rawTiers = objectAt(root.tiers ?? {}, "config.tiers");
  const seen = new Set<string>();
  const tiers = {} as Record<Tier, TierConfig>;
  for (const tier of TIERS) {
    const entry = rawTiers[tier] === undefined ? {} : objectAt(rawTiers[tier], `tiers.${tier}`);
    const candidatesRaw = entry.candidates ?? [];
    if (!Array.isArray(candidatesRaw)) throw new TypeError(`tiers.${tier}.candidates must be an array.`);
    const candidates = candidatesRaw.map((item, index): CandidateConfig => {
      const field = `tiers.${tier}.candidates[${index}]`;
      const candidate = objectAt(item, field);
      const model = candidate.model;
      if (typeof model !== "string" || !MODEL_REF.test(model)) {
        throw new TypeError(`${field}.model must be an exact provider/model reference.`);
      }
      if (seen.has(model)) throw new TypeError(`Model ${model} appears in more than one place.`);
      seen.add(model);
      if (candidate.thinking !== undefined && !THINKING_LEVELS.includes(String(candidate.thinking))) {
        throw new TypeError(`${field}.thinking is not a valid thinking level.`);
      }
      if (candidate.quotaGroup !== undefined && typeof candidate.quotaGroup !== "string") {
        throw new TypeError(`${field}.quotaGroup must be a string.`);
      }
      return Object.freeze({
        model,
        ...(candidate.thinking === undefined ? {} : { thinking: candidate.thinking as AgentThinkingLevel }),
        maxConcurrency: positive(candidate.maxConcurrency, `${field}.maxConcurrency`, DEFAULT_MAX_CONCURRENCY),
        quotaGroup: (candidate.quotaGroup as string | undefined) ?? model.split("/")[0]!,
      });
    });
    const exhaustedRaw =
      entry.onExhausted === undefined ? undefined : objectAt(entry.onExhausted, `tiers.${tier}.onExhausted`);
    const fallback = DEFAULT_EXHAUSTED[tier];
    const action = (exhaustedRaw?.action ?? fallback.action) as ExhaustedAction;
    if (!["wait", "wait_then_escalate", "escalate", "fail"].includes(action)) {
      throw new TypeError(`tiers.${tier}.onExhausted.action is invalid.`);
    }
    const escalateTo = exhaustedRaw?.escalateTo ?? (action === fallback.action ? fallback.escalateTo : undefined);
    if (action === "wait_then_escalate" || action === "escalate") {
      if (!isTier(escalateTo) || !AUTO_ESCALATION_TIERS.includes(escalateTo) || escalateTo === tier) {
        throw new TypeError(`tiers.${tier}.onExhausted.escalateTo must be light or medium and differ from ${tier}; heavy and ultra are never reached automatically.`);
      }
    }
    const maxWaitMs =
      exhaustedRaw?.maxWaitMs === undefined
        ? fallback.maxWaitMs
        : positive(exhaustedRaw.maxWaitMs, `tiers.${tier}.onExhausted.maxWaitMs`, 0);
    tiers[tier] = Object.freeze({
      candidates: Object.freeze(candidates),
      spillover: entry.spillover === undefined ? true : entry.spillover === true,
      onExhausted: Object.freeze({
        action,
        maxWaitMs,
        ...(isTier(escalateTo) && action !== "wait" && action !== "fail" ? { escalateTo } : {}),
      }),
    });
  }
  const defaultTier = root.defaultTier ?? "medium";
  if (!isTier(defaultTier)) throw new TypeError("config.defaultTier is invalid.");
  const rolesRaw = root.roles === undefined ? {} : objectAt(root.roles, "config.roles");
  const roles = {} as Record<RouterRole, Tier>;
  for (const role of ["read_only", "research", "code"] as const) {
    const value = rolesRaw[role] ?? defaultTier;
    if (!isTier(value)) throw new TypeError(`config.roles.${role} is invalid.`);
    roles[role] = value;
  }
  const timeouts = root.timeouts === undefined ? {} : objectAt(root.timeouts, "config.timeouts");
  const budgets = root.budgets === undefined ? {} : objectAt(root.budgets, "config.budgets");
  // setTimeout cannot schedule beyond 2^31-1 ms (~24.8 days).
  const workHardMaxMs = Math.min(
    positive(timeouts.workHardMaxMs, "timeouts.workHardMaxMs", DEFAULT_WORK_HARD_MAX_MS),
    2_147_483_647,
  );
  const workHardMs = Math.min(positive(timeouts.workHardMs, "timeouts.workHardMs", DEFAULT_WORK_HARD_MS), workHardMaxMs);
  return Object.freeze({
    defaultTier,
    roles: Object.freeze(roles),
    allowInherit: root.allowInherit === true,
    tiers: Object.freeze(tiers),
    workHardMs,
    workHardMaxMs,
    maxModelCallsPerTask: positive(budgets.maxModelCallsPerTask, "budgets.maxModelCallsPerTask", DEFAULT_MAX_MODEL_CALLS),
    legacy: false,
  });
}

/** Config used when no file exists: an optional single legacy model, explicit models allowed as-is. */
export function legacyRouterConfig(environment: NodeJS.ProcessEnv = process.env): RouterConfig {
  const model = environment.PI_SUBAGENT_EXECUTION_MODEL?.trim();
  const empty = (tier: Tier): TierConfig => ({
    candidates: model && tier === "medium" ? [{ model, maxConcurrency: Number.MAX_SAFE_INTEGER, quotaGroup: model }] : [],
    spillover: true,
    onExhausted: { action: "fail", maxWaitMs: 0 },
  });
  return Object.freeze({
    defaultTier: "medium",
    roles: { read_only: "medium" as Tier, research: "medium" as Tier, code: "medium" as Tier },
    allowInherit: true,
    tiers: { light: empty("light"), medium: empty("medium"), heavy: empty("heavy"), ultra: empty("ultra") },
    workHardMs: DEFAULT_WORK_HARD_MS,
    workHardMaxMs: DEFAULT_WORK_HARD_MAX_MS,
    maxModelCallsPerTask: DEFAULT_MAX_MODEL_CALLS,
    legacy: true,
  });
}

export interface ModelCatalog {
  /** Every model known to the Pi registry, as provider/id. */
  readonly known: ReadonlySet<string>;
  /** Models whose provider authentication is configured. */
  readonly available: ReadonlySet<string>;
}

export interface RoutingInput {
  readonly tier?: Tier;
  readonly role?: RouterRole;
  readonly model?: string;
  readonly allowFallback?: boolean;
  readonly inheritModel?: boolean;
  readonly parentModel?: string;
  readonly thinking?: AgentThinkingLevel;
}

export interface RoutingPlan {
  readonly tier: Tier | "pinned";
  readonly pinned?: CandidateConfig;
  readonly preferred?: string;
  readonly thinking?: AgentThinkingLevel;
}

export interface RouteLease {
  readonly model: string;
  readonly tier: Tier | "pinned";
  readonly thinking?: AgentThinkingLevel;
  release(): void;
}

export class RouterExhaustedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RouterExhaustedError";
  }
}

interface CandidateState {
  inFlight: number;
  cooldownUntil: number;
  disabledReason?: string;
  lastError?: string;
  switches: number;
}

export interface CandidateSnapshot {
  readonly tier: Tier;
  readonly model: string;
  readonly status: "available" | "cooldown" | "disabled" | "busy";
  readonly inFlight: number;
  readonly maxConcurrency: number;
  readonly cooldownRemainingMs?: number;
  readonly reason?: string;
  readonly switches: number;
}

export interface ModelRouterOptions {
  readonly configPath?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly now?: () => number;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly catalog?: () => ModelCatalog | undefined;
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error("aborted"));
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

const POLL_MS = 1_000;

export class ModelRouter {
  readonly configPath: string;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly catalog: (() => ModelCatalog | undefined) | undefined;
  private cached: { mtimeMs: number; config: RouterConfig } | undefined;
  private loadWarning: string | undefined;
  private readonly states = new Map<string, CandidateState>();
  private readonly groupCooldown = new Map<string, number>();

  constructor(options: ModelRouterOptions = {}) {
    this.environment = options.environment ?? process.env;
    this.configPath = options.configPath ?? defaultConfigPath(this.environment);
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? abortableSleep;
    this.catalog = options.catalog;
  }

  /** Current config; reloads when the file changes and keeps the last good version on parse errors. */
  config(): RouterConfig {
    let mtimeMs: number;
    try {
      mtimeMs = statSync(this.configPath).mtimeMs;
    } catch {
      this.cached = undefined;
      this.loadWarning = undefined;
      return legacyRouterConfig(this.environment);
    }
    if (this.cached?.mtimeMs === mtimeMs) return this.cached.config;
    try {
      const config = parseRouterConfig(JSON.parse(readFileSync(this.configPath, "utf8")));
      const previous = this.cached;
      this.cached = { mtimeMs, config };
      this.loadWarning = undefined;
      if (previous) this.resetDisabled();
      return config;
    } catch (error) {
      this.loadWarning = `Invalid ${this.configPath}: ${error instanceof Error ? error.message : String(error)}`;
      if (this.cached) return this.cached.config;
      throw new TypeError(`${this.loadWarning}. Fix the file; subagents will not fall back to a built-in model.`);
    }
  }

  warning(): string | undefined {
    return this.loadWarning;
  }

  private resetDisabled(): void {
    for (const state of this.states.values()) {
      state.disabledReason = undefined;
    }
  }

  private state(model: string): CandidateState {
    let state = this.states.get(model);
    if (!state) {
      state = { inFlight: 0, cooldownUntil: 0, switches: 0 };
      this.states.set(model, state);
    }
    return state;
  }

  private findCandidate(config: RouterConfig, model: string): { tier: Tier; candidate: CandidateConfig } | undefined {
    for (const tier of TIERS) {
      const candidate = config.tiers[tier].candidates.find((entry) => entry.model === model);
      if (candidate) return { tier, candidate };
    }
    return undefined;
  }

  plan(input: RoutingInput): RoutingPlan {
    const config = this.config();
    const thinking = input.thinking;
    if (input.inheritModel) {
      if (!config.allowInherit) {
        throw new TypeError("inheritModel is disabled by subagent-models.json (allowInherit=false); choose a tier instead.");
      }
      if (!input.parentModel) throw new TypeError("inheritModel requires an active parent model.");
      return { tier: "pinned", pinned: { model: input.parentModel, quotaGroup: input.parentModel, maxConcurrency: Number.MAX_SAFE_INTEGER }, ...(thinking ? { thinking } : {}) };
    }
    if (input.model) {
      if (!MODEL_REF.test(input.model)) throw new TypeError("model must be an exact provider/model reference.");
      const found = this.findCandidate(config, input.model);
      if (!found) {
        if (config.legacy) {
          return { tier: "pinned", pinned: { model: input.model, quotaGroup: input.model, maxConcurrency: Number.MAX_SAFE_INTEGER }, ...(thinking ? { thinking } : {}) };
        }
        throw new TypeError(`Model ${input.model} is not configured in ${this.configPath}; choose a tier or add it to a tier first.`);
      }
      if (!input.allowFallback) return { tier: "pinned", pinned: found.candidate, ...(thinking ? { thinking } : {}) };
      return { tier: found.tier, preferred: input.model, ...(thinking ? { thinking } : {}) };
    }
    const tier = input.tier ?? (input.role ? config.roles[input.role] : config.defaultTier);
    if (!isTier(tier)) throw new TypeError(`Unknown tier ${String(tier)}.`);
    if (config.legacy && config.tiers[tier].candidates.length === 0 && config.tiers.medium.candidates.length > 0) {
      return { tier: "medium", ...(thinking ? { thinking } : {}) };
    }
    return { tier, ...(thinking ? { thinking } : {}) };
  }

  private checkCatalog(model: string): string | undefined {
    const catalog = this.catalog?.();
    if (!catalog) return undefined;
    if (!catalog.known.has(model)) return "model is not registered in Pi (models.json)";
    if (!catalog.available.has(model)) return "provider authentication is not configured";
    return undefined;
  }

  private cooldownRemaining(candidate: CandidateConfig, at: number): number {
    const own = this.state(candidate.model).cooldownUntil;
    const group = this.groupCooldown.get(candidate.quotaGroup ?? candidate.model) ?? 0;
    return Math.max(0, Math.max(own, group) - at);
  }

  private orderedCandidates(config: RouterConfig, plan: RoutingPlan, tier: Tier): readonly CandidateConfig[] {
    const candidates = config.tiers[tier].candidates;
    if (!plan.preferred) return candidates;
    const preferred = candidates.filter((entry) => entry.model === plan.preferred);
    return [...preferred, ...candidates.filter((entry) => entry.model !== plan.preferred)];
  }

  private lease(model: string, tier: Tier | "pinned", thinking: AgentThinkingLevel | undefined): RouteLease {
    const state = this.state(model);
    state.inFlight += 1;
    let released = false;
    return {
      model,
      tier,
      ...(thinking ? { thinking } : {}),
      release: () => {
        if (released) return;
        released = true;
        state.inFlight = Math.max(0, state.inFlight - 1);
      },
    };
  }

  /**
   * Pick the first usable candidate in order. Waits, escalates, or fails according to the tier's
   * onExhausted rule when every candidate is cooling down, busy, disabled, or already failed for this task.
   */
  async acquire(plan: RoutingPlan, excluded: ReadonlySet<string>, signal?: AbortSignal): Promise<RouteLease> {
    if (plan.pinned) {
      if (excluded.has(plan.pinned.model)) {
        throw new RouterExhaustedError(`Pinned model ${plan.pinned.model} failed and fallback was not allowed.`);
      }
      const reason = this.state(plan.pinned.model).disabledReason ?? this.checkCatalog(plan.pinned.model);
      if (reason) throw new RouterExhaustedError(`Pinned model ${plan.pinned.model} is unavailable: ${reason}.`);
      return this.lease(plan.pinned.model, "pinned", plan.thinking ?? plan.pinned.thinking);
    }
    let tier = plan.tier as Tier;
    let waitStarted = this.now();
    for (;;) {
      if (signal?.aborted) throw signal.reason ?? new Error("aborted");
      const config = this.config();
      const tierConfig = config.tiers[tier];
      const at = this.now();
      let earliestCooldown = Number.POSITIVE_INFINITY;
      let busy = false;
      let usable = 0;
      for (const candidate of this.orderedCandidates(config, plan, tier)) {
        if (excluded.has(candidate.model)) continue;
        const state = this.state(candidate.model);
        if (state.disabledReason ?? this.checkCatalog(candidate.model)) continue;
        usable += 1;
        const remaining = this.cooldownRemaining(candidate, at);
        if (remaining > 0) {
          earliestCooldown = Math.min(earliestCooldown, remaining);
          continue;
        }
        if (state.inFlight >= (candidate.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY)) {
          busy = true;
          if (tierConfig.spillover) continue;
          break;
        }
        return this.lease(candidate.model, tier, plan.thinking ?? candidate.thinking);
      }
      const rule = tierConfig.onExhausted;
      const waited = this.now() - waitStarted;
      const canWait = (usable > 0) && (busy || Number.isFinite(earliestCooldown));
      const describe = (): string =>
        `No ${tier} subagent model is usable (${tierConfig.candidates.length} configured, ${usable} enabled${busy ? ", some at max concurrency" : ""}${Number.isFinite(earliestCooldown) ? `, next cooldown ends in ${Math.ceil(earliestCooldown / 1000)}s` : ""}).`;
      if ((rule.action === "wait" || rule.action === "wait_then_escalate") && canWait && waited < rule.maxWaitMs) {
        await this.sleep(Math.min(POLL_MS, Number.isFinite(earliestCooldown) ? earliestCooldown : POLL_MS, rule.maxWaitMs - waited), signal);
        continue;
      }
      if ((rule.action === "escalate" || rule.action === "wait_then_escalate") && rule.escalateTo) {
        tier = rule.escalateTo;
        waitStarted = this.now();
        continue;
      }
      throw new RouterExhaustedError(describe());
    }
  }

  reportFailure(model: string, errorClass: ErrorClass, message: string, retryAfterMs?: number): void {
    const state = this.state(model);
    state.lastError = `${errorClass}: ${message.slice(0, 300)}`;
    state.switches += 1;
    if (DISABLING.has(errorClass)) {
      state.disabledReason = state.lastError;
      return;
    }
    const cooldown = retryAfterMs ?? COOLDOWN_MS[errorClass];
    if (!cooldown) return;
    const until = this.now() + cooldown;
    state.cooldownUntil = Math.max(state.cooldownUntil, until);
    if (errorClass === "quota_exhausted") {
      const config = this.config();
      const group = this.findCandidate(config, model)?.candidate.quotaGroup ?? model.split("/")[0]!;
      this.groupCooldown.set(group, Math.max(this.groupCooldown.get(group) ?? 0, until));
    }
  }

  reportSuccess(model: string): void {
    const state = this.state(model);
    state.lastError = undefined;
  }

  enable(model: string): boolean {
    const state = this.states.get(model);
    if (!state) return false;
    state.disabledReason = undefined;
    state.cooldownUntil = 0;
    return true;
  }

  snapshot(): readonly CandidateSnapshot[] {
    const config = this.config();
    const at = this.now();
    const rows: CandidateSnapshot[] = [];
    for (const tier of TIERS) {
      for (const candidate of config.tiers[tier].candidates) {
        const state = this.state(candidate.model);
        const catalogReason = this.checkCatalog(candidate.model);
        const reason = state.disabledReason ?? catalogReason;
        const remaining = this.cooldownRemaining(candidate, at);
        const maxConcurrency = candidate.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
        rows.push({
          tier,
          model: candidate.model,
          status: reason ? "disabled" : remaining > 0 ? "cooldown" : state.inFlight >= maxConcurrency ? "busy" : "available",
          inFlight: state.inFlight,
          maxConcurrency,
          ...(remaining > 0 ? { cooldownRemainingMs: remaining } : {}),
          ...(reason ?? state.lastError ? { reason: reason ?? state.lastError } : {}),
          switches: state.switches,
        });
      }
    }
    return rows;
  }
}

export function formatRouterSnapshot(router: ModelRouter): string {
  const config = router.config();
  const label: Record<Tier, string> = { light: "轻量", medium: "普通", heavy: "强", ultra: "超强" };
  const lines = [
    config.legacy ? `配置文件不存在：${router.configPath}（旧模式：只用 PI_SUBAGENT_EXECUTION_MODEL 或显式 model）` : `配置文件：${router.configPath}`,
  ];
  const warning = router.warning();
  if (warning) lines.push(`⚠ ${warning}（继续使用上一版有效配置）`);
  for (const tier of TIERS) {
    const rows = router.snapshot().filter((row) => row.tier === tier);
    lines.push(`${label[tier]}（${tier}）：${rows.length ? "" : "无候选"}`);
    rows.forEach((row, index) => {
      const status = {
        available: "可用",
        busy: `已满 ${row.inFlight}/${row.maxConcurrency}`,
        cooldown: `冷却 ${Math.ceil((row.cooldownRemainingMs ?? 0) / 1000)}s`,
        disabled: "停用",
      }[row.status];
      lines.push(`  ${index + 1}. ${row.model} — ${status}${row.status === "available" && row.inFlight ? `（运行中 ${row.inFlight}）` : ""}${row.reason ? `；${row.reason}` : ""}`);
    });
  }
  return lines.join("\n");
}
