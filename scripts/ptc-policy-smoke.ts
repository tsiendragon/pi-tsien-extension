import {
  assertBudgetAvailable,
  budgetSnapshot,
  createBudgetState,
  createRunBudgetError,
  normalizeAndValidateResult,
  normalizeFencedJsonText,
  recordAssistantTokens,
  recordRunUsage,
  reserveNestedCall,
  reserveOuterRunCode,
  resolvePtcPolicy,
  retargetBudgetState,
} from "pi-tsien-code-mode/src/policy.ts";

function expectPolicyError(action: () => unknown, code: string): void {
  try {
    action();
  } catch (error) {
    if (error instanceof Error && error.message.includes(code)) return;
    throw error;
  }
  throw new Error(`Expected policy error: ${code}`);
}

const readPolicy = resolvePtcPolicy("readOnly", {
  provider: "dashscope",
  id: "deepseek-v4-flash",
});
if (
  readPolicy.source !== "configured"
  || readPolicy.maxOuterRunCodeCalls !== 5
  || readPolicy.maxTotalSubCalls !== 40
  || readPolicy.maxRunComputeTimeMs !== 15_000
  || readPolicy.maxRunWallTimeMs !== 120_000
  || readPolicy.normalizeJsonFence !== true
) {
  throw new Error(`Unexpected read-only policy: ${JSON.stringify(readPolicy)}`);
}

// A version-pinned model must resolve to the same base policy, not fallback.
const baseProRead = resolvePtcPolicy("readOnly", { provider: "dashscope", id: "deepseek-v4-pro" });
const pinnedProRead = resolvePtcPolicy("readOnly", { provider: "dashscope", id: "deepseek-v4-pro-0813" });
if (
  pinnedProRead.source !== "configured"
  || pinnedProRead.maxRunWallTimeMs !== baseProRead.maxRunWallTimeMs
  || pinnedProRead.maxAssistantOutputTokens !== baseProRead.maxAssistantOutputTokens
  || pinnedProRead.maxTotalSubCalls !== baseProRead.maxTotalSubCalls
  || pinnedProRead.normalizeJsonFence !== baseProRead.normalizeJsonFence
) {
  throw new Error(`Version-suffixed model did not resolve to base policy: ${JSON.stringify(pinnedProRead)}`);
}

// An unconfigured reasoning model defaults fence normalization on; a plain
// unconfigured model keeps it off.
const fallbackReasoning = resolvePtcPolicy("readOnly", { provider: "dashscope", id: "deepseek-r1-0528" });
const fallbackPlain = resolvePtcPolicy("readOnly", { provider: "anthropic", id: "claude-sonnet-4-5" });
if (fallbackReasoning.source !== "fallback" || fallbackReasoning.normalizeJsonFence !== true) {
  throw new Error(`Fallback reasoning model should enable fence normalization: ${JSON.stringify(fallbackReasoning)}`);
}
if (fallbackPlain.source !== "fallback" || fallbackPlain.normalizeJsonFence !== false) {
  throw new Error(`Fallback plain model should keep fence normalization off: ${JSON.stringify(fallbackPlain)}`);
}

const outerBudget = createBudgetState(readPolicy);
for (let index = 0; index < readPolicy.maxOuterRunCodeCalls; index += 1) reserveOuterRunCode(outerBudget);
expectPolicyError(() => reserveOuterRunCode(outerBudget), "PTC_BUDGET_EXCEEDED");

const tokenBudget = createBudgetState(readPolicy);
recordAssistantTokens(tokenBudget, readPolicy.maxAssistantOutputTokens + 1);
expectPolicyError(() => assertBudgetAvailable(tokenBudget), "PTC_BUDGET_EXCEEDED");

const runBudgetState = createBudgetState(readPolicy);
recordRunUsage(runBudgetState, { computeTimeMs: 7.6, wallTimeMs: 42.4 });
const runSnapshot = budgetSnapshot(runBudgetState) as any;
if (
  runSnapshot.runComputeTimeMs.lastUsed !== 8
  || runSnapshot.runComputeTimeMs.totalUsed !== 8
  || runSnapshot.runComputeTimeMs.limitPerRun !== 15_000
  || runSnapshot.runWallTimeMs.lastUsed !== 42
  || runSnapshot.runWallTimeMs.totalUsed !== 42
  || runSnapshot.runWallTimeMs.limitPerRun !== 120_000
) {
  throw new Error(`Unexpected per-run budget accounting: ${JSON.stringify(runSnapshot)}`);
}
const runTimeout = createRunBudgetError(runBudgetState, "runWallTimeMs", 120_001, 120_000);
if (!runTimeout.message.includes("runWallTimeMs") || runBudgetState.violation) {
  throw new Error("A per-run timeout should fail only that execution without poisoning task budget");
}
assertBudgetAvailable(runBudgetState);

const lunaPolicy = resolvePtcPolicy("readOnly", { provider: "openai-codex", id: "gpt-5.6-luna" });
reserveOuterRunCode(runBudgetState);
const retargeted = retargetBudgetState(runBudgetState, lunaPolicy);
if (retargeted.policy.modelKey !== "openai-codex/gpt-5.6-luna" || retargeted.outerRunCodeCalls !== 1) {
  throw new Error(`Model retargeting lost usage: ${JSON.stringify(budgetSnapshot(retargeted))}`);
}

const fullPolicy = resolvePtcPolicy("full", {
  provider: "openai-codex",
  id: "gpt-5.6-luna",
});
const writeBudget = createBudgetState(fullPolicy);
for (let index = 0; index < (fullPolicy.maxNestedWrites ?? 0); index += 1) reserveNestedCall(writeBudget, "write");
expectPolicyError(() => reserveNestedCall(writeBudget, "write"), "PTC_BUDGET_EXCEEDED");

const runBudget = createBudgetState(fullPolicy);
for (let index = 0; index < (fullPolicy.maxNestedRuns ?? 0); index += 1) reserveNestedCall(runBudget, "run");
expectPolicyError(() => reserveNestedCall(runBudget, "run"), "PTC_BUDGET_EXCEEDED");

const validated = normalizeAndValidateResult(
  "```json\n{\"count\":2,\"checksum\":42,\"ids\":[\"a\",\"b\"]}\n```",
  true,
  {
    kind: "object",
    requiredKeys: ["count", "checksum", "ids"],
    exactKeys: true,
    expectedIntegers: [{ key: "count", value: 2 }, { key: "checksum", value: 42 }],
    expectedArrayLengths: [{ key: "ids", length: 2 }],
  },
);
if (!validated.normalized || !validated.contractApplied) {
  throw new Error(`Result was not normalized and validated: ${JSON.stringify(validated)}`);
}
expectPolicyError(() => normalizeAndValidateResult(
  { count: 2, checksum: 41, ids: ["a", "b"] },
  false,
  {
    kind: "object",
    requiredKeys: ["count", "checksum", "ids"],
    expectedIntegers: [{ key: "checksum", value: 42 }],
  },
), "PTC_RESULT_VALIDATION_FAILED");

const normalizedFinal = normalizeFencedJsonText("说明：\n```json\n{\"ok\":true}\n```");
if (normalizedFinal !== '{"ok":true}') throw new Error(`Unexpected final normalization: ${normalizedFinal}`);

console.log("PTC policy smoke test passed");
