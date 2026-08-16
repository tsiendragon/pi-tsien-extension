import {
  assertBudgetAvailable,
  createBudgetState,
  normalizeAndValidateResult,
  normalizeFencedJsonText,
  recordAssistantTokens,
  reserveNestedCall,
  reserveOuterRunCode,
  resolvePtcPolicy,
  stopBudgetState,
} from "../extensions/ptc/policy.ts";

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
  || readPolicy.normalizeJsonFence !== true
) {
  throw new Error(`Unexpected read-only policy: ${JSON.stringify(readPolicy)}`);
}

const outerBudget = createBudgetState(readPolicy);
for (let index = 0; index < readPolicy.maxOuterRunCodeCalls; index += 1) reserveOuterRunCode(outerBudget);
expectPolicyError(() => reserveOuterRunCode(outerBudget), "PTC_BUDGET_EXCEEDED");

const tokenBudget = createBudgetState(readPolicy);
recordAssistantTokens(tokenBudget, readPolicy.maxAssistantOutputTokens + 1);
expectPolicyError(() => assertBudgetAvailable(tokenBudget), "PTC_BUDGET_EXCEEDED");

const wallBudget = createBudgetState({ ...readPolicy, maxActiveWallTimeMs: 1 }, true);
wallBudget.startedAt -= 10;
expectPolicyError(() => assertBudgetAvailable(wallBudget), "PTC_BUDGET_EXCEEDED");
const frozenBudget = createBudgetState(readPolicy, true);
stopBudgetState(frozenBudget);
if (frozenBudget.running || frozenBudget.endedAt === undefined) throw new Error("Budget wall time did not freeze");

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
