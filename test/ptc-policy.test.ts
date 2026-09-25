import assert from "node:assert/strict";
import test from "node:test";

import {
	createBudgetState,
	PTC_UNLIMITED,
	reserveOuterRunCode,
	resolvePtcPolicy,
} from "pi-tsien-code-mode/src/policy.ts";

test("removed run_code limits resolve to the unlimited sentinel", () => {
	for (const model of [
		{ provider: "dashscope", id: "deepseek-v4.1-flash" }, // fallback (no configured policy)
		{ provider: "dashscope", id: "deepseek-v4-flash" }, // configured policy
		{ provider: "openai-codex", id: "gpt-5.6-sol" }, // configured policy
	]) {
		const policy = resolvePtcPolicy("full", model);
		assert.equal(policy.maxOuterRunCodeCalls, PTC_UNLIMITED, `outer ${model.id}`);
		assert.equal(policy.maxRunComputeTimeMs, PTC_UNLIMITED, `compute ${model.id}`);
		assert.equal(policy.maxRunWallTimeMs, PTC_UNLIMITED, `wall ${model.id}`);
	}
});

test("many outer run_code calls are never blocked", () => {
	const state = createBudgetState(
		resolvePtcPolicy("full", { provider: "dashscope", id: "deepseek-v4.1-flash" }),
	);
	for (let index = 0; index < 50; index += 1) reserveOuterRunCode(state);
	assert.equal(state.outerRunCodeCalls, 50);
});

test("unlimited sentinel stays within Node timer and vm timeout safety", () => {
	assert.ok(PTC_UNLIMITED <= 2 ** 31 - 1);
});