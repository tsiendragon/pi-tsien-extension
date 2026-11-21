import { describe, expect, it } from "vitest";
import {
	normalizeGoalOptimizationDraft,
	optimizationCriterion,
	optimizationObjective,
	validateGoalOptimizationDraft,
} from "pi-tsien-goal/src/goal-optimization.ts";

describe("goal optimization contract", () => {
	it("normalizes a metric/baseline/target contract", () => {
		expect(
			normalizeGoalOptimizationDraft({
				metric: " 总 matvec 数（含证书与重启） ",
				baseline: " 最强 cold-start 基线 ",
				target: " 降低 ≥20% ",
				guardrails: [" 同一有效 FW gap 证书 ", "所有成本计入", "所有成本计入"],
			}),
		).toEqual({
			metric: "总 matvec 数（含证书与重启）",
			baseline: "最强 cold-start 基线",
			target: "降低 ≥20%",
			guardrails: ["同一有效 FW gap 证书", "所有成本计入"],
		});
	});

	it("rejects a target without a number or explicit factor", () => {
		expect(
			validateGoalOptimizationDraft({
				metric: "end-to-end runtime",
				baseline: "current implementation",
				target: "明显更快",
			}),
		).toEqual([expect.stringContaining("number or an explicit factor")]);
		expect(
			validateGoalOptimizationDraft({
				metric: "throughput",
				baseline: "baseline",
				target: "翻倍",
			}),
		).toEqual([]);
	});

	it("renders one objective and one measurable criterion", () => {
		const optimization = {
			metric: "总 matvec 数（含证书与重启）",
			baseline: "最强 cold-start 基线",
			target: "降低 ≥20%",
			guardrails: ["同一有效 FW gap 证书"],
		};
		const objective = optimizationObjective(optimization);
		expect(objective).toContain("优化合同");
		expect(objective).toContain("降低 ≥20%");
		expect(objective).toContain("允许尝试任意算法");
		expect(optimizationCriterion(optimization)).toContain("测量脚本、原始输出和汇总可复核");
	});
});
