import { readFileSync } from "node:fs";

export type PolicyMode = "readOnly" | "full";
export type ResultKind = "object" | "array";

export type ExpectedInteger = {
  key: string;
  value: number;
};

export type ExpectedArrayLength = {
  key: string;
  length: number;
};

export type ResultContract = {
  kind?: ResultKind;
  requiredKeys?: string[];
  exactKeys?: boolean;
  expectedIntegers?: ExpectedInteger[];
  expectedArrayLengths?: ExpectedArrayLength[];
};

export type PtcPolicy = {
  modelKey: string;
  source: "configured" | "fallback";
  mode: PolicyMode;
  maxOuterRunCodeCalls: number;
  maxRunComputeTimeMs: number;
  maxRunWallTimeMs: number;
  maxAssistantOutputTokens: number;
  maxTotalSubCalls?: number;
  maxNestedWrites?: number;
  maxNestedRuns?: number;
  normalizeJsonFence: boolean;
};

export type PtcBudgetState = {
  policy: PtcPolicy;
  outerRunCodeCalls: number;
  totalSubCalls: number;
  nestedWrites: number;
  nestedRuns: number;
  assistantOutputTokens: number;
  lastRunComputeTimeMs?: number;
  totalRunComputeTimeMs: number;
  lastRunWallTimeMs?: number;
  totalRunWallTimeMs: number;
  violation?: PtcPolicyError;
};

type RecommendedPolicy = {
  maxEstimatedSubCalls?: number;
  maxTotalSubCalls?: number;
  maxOuterRunCodeCalls?: number;
  maxRunWallTimeMs?: number;
  /** Legacy v1 field; read for compatibility with older generated configs. */
  maxWallTimeMs?: number;
  maxTotalTokens?: number;
  maxNestedWrites?: number;
  maxNestedRuns?: number;
  normalizeJsonFence?: boolean;
};

type PolicyConfig = {
  common?: { maxRunComputeTimeMs?: number };
  models?: Record<string, { recommended?: RecommendedPolicy }>;
};

function readConfig(url: URL): PolicyConfig {
  try {
    return JSON.parse(readFileSync(url, "utf8")) as PolicyConfig;
  } catch {
    return {};
  }
}

const readOnlyConfig = readConfig(new URL("../../docs/ptc-model-complexity-config.json", import.meta.url));
const fullConfig = readConfig(new URL("../../docs/ptc-full-tool-config.json", import.meta.url));

function positiveInteger(value: unknown, fallback: number): number {
  return Number.isSafeInteger(value) && (value as number) > 0 ? value as number : fallback;
}

export function modelKey(model: { provider?: string; id?: string } | undefined): string {
  if (!model?.provider || !model.id) return "unknown";
  return `${model.provider}/${model.id}`;
}

function modelKeyCandidates(key: string): string[] {
  const slash = key.lastIndexOf("/");
  if (slash < 0) return [key];
  const provider = key.slice(0, slash + 1);
  const id = key.slice(slash + 1);
  // Strip a trailing version/date suffix like "-0813" so a pinned model
  // such as dashscope/deepseek-v4-pro-0813 matches its base policy key.
  const baseId = id.replace(/-[A-Za-z0-9]+$/, "");
  if (!baseId || baseId === id) return [key];
  return [key, `${provider}${baseId}`];
}

function resolveRecommended(
  models: Record<string, { recommended?: RecommendedPolicy }> | undefined,
  key: string,
): RecommendedPolicy | undefined {
  if (!models) return undefined;
  for (const candidate of modelKeyCandidates(key)) {
    const recommended = models[candidate]?.recommended;
    if (recommended) return recommended;
  }
  return undefined;
}

export function resolvePtcPolicy(
  mode: PolicyMode,
  model: { provider?: string; id?: string } | undefined,
): PtcPolicy {
  const key = modelKey(model);
  const modeConfig = mode === "full" ? fullConfig : readOnlyConfig;
  const readRecommended = resolveRecommended(readOnlyConfig.models, key);
  const modeRecommended = mode === "full"
    ? resolveRecommended(fullConfig.models, key)
    : readRecommended;
  const configured = modeRecommended !== undefined;

  return {
    modelKey: key,
    source: configured ? "configured" : "fallback",
    mode,
    maxOuterRunCodeCalls: positiveInteger(modeRecommended?.maxOuterRunCodeCalls, 4),
    maxRunComputeTimeMs: positiveInteger(modeConfig.common?.maxRunComputeTimeMs, 15_000),
    maxRunWallTimeMs: positiveInteger(
      modeRecommended?.maxRunWallTimeMs ?? modeRecommended?.maxWallTimeMs,
      90_000,
    ),
    // Keep reading the benchmark config's legacy maxTotalTokens field, but enforce it
    // only against newly generated assistant output. Input already present in a long
    // session is not PTC workload and must not consume this per-task budget.
    maxAssistantOutputTokens: positiveInteger(modeRecommended?.maxTotalTokens, 60_000),
    maxTotalSubCalls: mode === "readOnly"
      ? positiveInteger(
          modeRecommended?.maxTotalSubCalls,
          Math.ceil(positiveInteger(modeRecommended?.maxEstimatedSubCalls, 56) * 1.15),
        )
      : undefined,
    maxNestedWrites: mode === "full"
      ? positiveInteger(modeRecommended?.maxNestedWrites, 32)
      : undefined,
    maxNestedRuns: mode === "full"
      ? positiveInteger(modeRecommended?.maxNestedRuns, 3)
      : undefined,
    normalizeJsonFence: readRecommended?.normalizeJsonFence === true,
  };
}

export class PtcPolicyError extends Error {
  readonly code: "PTC_BUDGET_EXCEEDED" | "PTC_RESULT_VALIDATION_FAILED";
  readonly details: Record<string, unknown>;

  constructor(
    code: "PTC_BUDGET_EXCEEDED" | "PTC_RESULT_VALIDATION_FAILED",
    details: Record<string, unknown>,
  ) {
    super(JSON.stringify({
      error: {
        code,
        ...details,
        suggestedAction: code === "PTC_BUDGET_EXCEEDED"
          ? details.budget === "runComputeTimeMs" || details.budget === "runWallTimeMs"
            ? "Reduce this program, split it across run_code calls, or switch to ordinary tools with /ptc off."
            : "Reduce the workload, split it into a new user turn, or switch to ordinary tools with /ptc off."
          : "Return JSON matching resultContract, or correct the expected count/checksum values.",
      },
    }));
    this.name = "PtcPolicyError";
    this.code = code;
    this.details = details;
  }
}

export function createBudgetState(policy: PtcPolicy): PtcBudgetState {
  return {
    policy,
    outerRunCodeCalls: 0,
    totalSubCalls: 0,
    nestedWrites: 0,
    nestedRuns: 0,
    assistantOutputTokens: 0,
    totalRunComputeTimeMs: 0,
    totalRunWallTimeMs: 0,
  };
}

export function retargetBudgetState(state: PtcBudgetState, policy: PtcPolicy): PtcBudgetState {
  return { ...state, policy };
}

function budgetError(
  state: PtcBudgetState,
  budget: string,
  used: number,
  limit: number,
): PtcPolicyError {
  const error = new PtcPolicyError("PTC_BUDGET_EXCEEDED", {
    model: state.policy.modelKey,
    mode: state.policy.mode,
    budget,
    used,
    limit,
  });
  state.violation = error;
  return error;
}

export function createRunBudgetError(
  state: PtcBudgetState,
  budget: "runComputeTimeMs" | "runWallTimeMs",
  used: number,
  limit: number,
): PtcPolicyError {
  return new PtcPolicyError("PTC_BUDGET_EXCEEDED", {
    model: state.policy.modelKey,
    mode: state.policy.mode,
    budget,
    used,
    limit,
  });
}

export function assertBudgetAvailable(state: PtcBudgetState): void {
  if (state.violation) throw state.violation;
  if (state.assistantOutputTokens > state.policy.maxAssistantOutputTokens) {
    throw budgetError(
      state,
      "assistantOutputTokens",
      state.assistantOutputTokens,
      state.policy.maxAssistantOutputTokens,
    );
  }
}

export function reserveOuterRunCode(state: PtcBudgetState): void {
  assertBudgetAvailable(state);
  state.outerRunCodeCalls += 1;
  if (state.outerRunCodeCalls > state.policy.maxOuterRunCodeCalls) {
    throw budgetError(
      state,
      "outerRunCodeCalls",
      state.outerRunCodeCalls,
      state.policy.maxOuterRunCodeCalls,
    );
  }
}

export function reserveNestedCall(state: PtcBudgetState, name: string): void {
  assertBudgetAvailable(state);
  state.totalSubCalls += 1;
  if (state.policy.maxTotalSubCalls !== undefined && state.totalSubCalls > state.policy.maxTotalSubCalls) {
    throw budgetError(state, "totalSubCalls", state.totalSubCalls, state.policy.maxTotalSubCalls);
  }
  if (name === "write") {
    state.nestedWrites += 1;
    if (state.policy.maxNestedWrites !== undefined && state.nestedWrites > state.policy.maxNestedWrites) {
      throw budgetError(state, "nestedWrites", state.nestedWrites, state.policy.maxNestedWrites);
    }
  }
  if (name === "run") {
    state.nestedRuns += 1;
    if (state.policy.maxNestedRuns !== undefined && state.nestedRuns > state.policy.maxNestedRuns) {
      throw budgetError(state, "nestedRuns", state.nestedRuns, state.policy.maxNestedRuns);
    }
  }
}

export function recordAssistantTokens(state: PtcBudgetState | undefined, outputTokens: unknown): void {
  if (!state || !Number.isFinite(outputTokens) || (outputTokens as number) < 0) return;
  state.assistantOutputTokens += Math.round(outputTokens as number);
}

export function recordRunUsage(
  state: PtcBudgetState,
  usage: { computeTimeMs?: number; wallTimeMs: number },
): void {
  const wallTimeMs = Math.max(0, Math.round(usage.wallTimeMs));
  state.lastRunWallTimeMs = wallTimeMs;
  state.totalRunWallTimeMs += wallTimeMs;
  if (usage.computeTimeMs !== undefined && Number.isFinite(usage.computeTimeMs)) {
    const computeTimeMs = Math.max(0, Math.round(usage.computeTimeMs));
    state.lastRunComputeTimeMs = computeTimeMs;
    state.totalRunComputeTimeMs += computeTimeMs;
  } else {
    state.lastRunComputeTimeMs = undefined;
  }
}

export function budgetSnapshot(state: PtcBudgetState | undefined): Record<string, unknown> | undefined {
  if (!state) return undefined;
  return {
    model: state.policy.modelKey,
    policySource: state.policy.source,
    mode: state.policy.mode,
    outerRunCodeCalls: { used: state.outerRunCodeCalls, limit: state.policy.maxOuterRunCodeCalls },
    runComputeTimeMs: {
      lastUsed: state.lastRunComputeTimeMs ?? null,
      totalUsed: state.totalRunComputeTimeMs,
      limitPerRun: state.policy.maxRunComputeTimeMs,
    },
    runWallTimeMs: {
      lastUsed: state.lastRunWallTimeMs ?? null,
      totalUsed: state.totalRunWallTimeMs,
      limitPerRun: state.policy.maxRunWallTimeMs,
    },
    assistantOutputTokens: {
      used: state.assistantOutputTokens,
      limit: state.policy.maxAssistantOutputTokens,
    },
    totalSubCalls: { used: state.totalSubCalls, limit: state.policy.maxTotalSubCalls ?? null },
    nestedWrites: { used: state.nestedWrites, limit: state.policy.maxNestedWrites ?? null },
    nestedRuns: { used: state.nestedRuns, limit: state.policy.maxNestedRuns ?? null },
    violated: state.violation?.details ?? null,
  };
}

function parseJsonString(value: string, allowFence: boolean): { value: unknown; normalized: boolean } | undefined {
  try {
    return { value: JSON.parse(value), normalized: true };
  } catch {
    if (!allowFence) return undefined;
  }
  const fence = value.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (!fence) return undefined;
  try {
    return { value: JSON.parse(fence[1]), normalized: true };
  } catch {
    return undefined;
  }
}

function assertObject(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PtcPolicyError("PTC_RESULT_VALIDATION_FAILED", {
      reason: "Expected an object result",
    });
  }
}

export function normalizeAndValidateResult(
  value: unknown,
  normalizeFence: boolean,
  contract?: ResultContract,
): { value: unknown; normalized: boolean; contractApplied: boolean } {
  let normalized = false;
  if (typeof value === "string") {
    const parsed = parseJsonString(value, normalizeFence || contract !== undefined);
    if (parsed) {
      value = parsed.value;
      normalized = parsed.normalized;
    }
  }
  if (!contract) return { value, normalized, contractApplied: false };

  if (contract.kind === "array") {
    if (!Array.isArray(value)) {
      throw new PtcPolicyError("PTC_RESULT_VALIDATION_FAILED", { reason: "Expected an array result" });
    }
    return { value, normalized, contractApplied: true };
  }

  assertObject(value);
  const requiredKeys = contract.requiredKeys ?? [];
  for (const key of requiredKeys) {
    if (!Object.hasOwn(value, key)) {
      throw new PtcPolicyError("PTC_RESULT_VALIDATION_FAILED", { reason: "Missing required result key", key });
    }
  }
  if (contract.exactKeys) {
    const actual = Object.keys(value).sort();
    const expected = [...new Set(requiredKeys)].sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new PtcPolicyError("PTC_RESULT_VALIDATION_FAILED", {
        reason: "Result keys do not exactly match requiredKeys",
        expected,
        actual,
      });
    }
  }
  for (const expected of contract.expectedIntegers ?? []) {
    if (value[expected.key] !== expected.value || !Number.isSafeInteger(value[expected.key])) {
      throw new PtcPolicyError("PTC_RESULT_VALIDATION_FAILED", {
        reason: "Integer result value mismatch",
        key: expected.key,
        expected: expected.value,
        actual: value[expected.key],
      });
    }
  }
  for (const expected of contract.expectedArrayLengths ?? []) {
    const actual = value[expected.key];
    if (!Array.isArray(actual) || actual.length !== expected.length) {
      throw new PtcPolicyError("PTC_RESULT_VALIDATION_FAILED", {
        reason: "Array result length mismatch",
        key: expected.key,
        expected: expected.length,
        actual: Array.isArray(actual) ? actual.length : typeof actual,
      });
    }
  }
  return { value, normalized, contractApplied: true };
}

export function normalizeFencedJsonText(text: string): string | undefined {
  const parsed = parseJsonString(text, true);
  if (!parsed || !parsed.normalized || typeof parsed.value !== "object" || parsed.value === null) return undefined;
  return JSON.stringify(parsed.value);
}
