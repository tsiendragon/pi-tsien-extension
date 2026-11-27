import { describe, expect, it } from "vitest";
import {
	auditGoalDraft,
	formatGoalQualityIssues,
	hasBlockingGoalQualityIssues,
} from "../../../packages/pi-tsien-goal/src/goal-quality.ts";

function codes(objective: string, acceptanceCriteria: string[], constraints?: string[]) {
	return auditGoalDraft({ objective, acceptanceCriteria, constraints }).map((issue) => issue.code);
}

describe("goal outcome quality gate", () => {
	it("accepts a proof goal with a concrete statement and evidence carrier", () => {
		const issues = auditGoalDraft({
			objective: "证明或反驳目标 T：所有 k>=2 的 Werner C34 不等式成立。",
			acceptanceCriteria: [
				"proofs/werner-c34.lean 通过 proof_audit，目标 T 显示 proved 或 disproved",
			],
			constraints: ["按 pi-matrix 流程记录并独立评审；不代替人工对齐"],
		});
		expect(hasBlockingGoalQualityIssues(issues)).toBe(false);
	});

	it("accepts an optimization goal with metric, baseline and target", () => {
		const issues = auditGoalDraft({
			objective: "在 benchmark B 上把算法 A 的 matvec 次数降低至少 20%，且精度不低于 1e-8。",
			acceptanceCriteria: ["out/benchmark.json 报告相对强冷启动基线至少 20% 的 matvec 节省，精度 >= 1e-8"],
			constraints: ["不修改 benchmark B 的停止标准"],
		});
		expect(hasBlockingGoalQualityIssues(issues)).toBe(false);
	});

	it("accepts exploration when it names a quality bar", () => {
		const issues = auditGoalDraft({
			objective: "探索可分性新方向，直到得到通过独立评审、达到 Quantum 投稿标准的实质结果。",
			acceptanceCriteria: ["reports/review.md 记录至少一个通过独立评审的新结果，或证据充分的反例"],
			constraints: ["未验证线索不得写入稿件", "不实际投稿"],
		});
		expect(hasBlockingGoalQualityIssues(issues)).toBe(false);
	});

	it("rejects process objectives and process-only criteria", () => {
		const issues = auditGoalDraft({
			objective: "按 pi-matrix 规范持续推进 Werner C34 项目，并定期汇报进展。",
			acceptanceCriteria: ["记录每轮进展并更新 STATUS 文档", "区分草稿与已证结果"],
		});
		expect(hasBlockingGoalQualityIssues(issues)).toBe(true);
		expect(codes("按规范持续推进项目", ["记录并汇报进展"])).toEqual(
			expect.arrayContaining(["process_objective", "process_only_criterion"]),
		);
	});

	it("does not infer a required optimization contract from a keyword in a qualitative goal", () => {
		const issues = auditGoalDraft({
			objective: "改进启动提示：缺少必要配置时给出配置项名称。",
			acceptanceCriteria: ["缺少配置时，错误消息列出缺失的配置项，相关回归测试通过。"],
		});
		expect(hasBlockingGoalQualityIssues(issues)).toBe(false);
		expect(issues).toContainEqual(expect.objectContaining({ code: "optimization_without_target", severity: "warning" }));
	});

	it("rejects open-ended exploration without a quality bar", () => {
		const issues = codes("探索可分性的新线索。", ["留下可复查的记录"]);
		expect(issues).toContain("exploration_without_quality_bar");
	});

	it("rejects an escape clause that lets a failed route close the goal", () => {
		const issues = codes("形成达到顶刊标准的论文贡献。", [
			"若贡献不足，则保留负结果并列出缺口，不宣称达到顶刊标准",
		]);
		expect(issues).toContain("escape_clause");
	});

	it("warns about mixed process criteria and compound criteria without blocking", () => {
		const issues = auditGoalDraft({
			objective: "证明定理 T。",
			acceptanceCriteria: ["proofs/t.lean 通过证明检查，并记录审计结果；更新 STATUS；同步 ROADMAP"],
		});
		expect(hasBlockingGoalQualityIssues(issues)).toBe(false);
		expect(issues.map((issue) => issue.code)).toEqual(
			expect.arrayContaining(["mixed_process_criterion", "compound_criterion"]),
		);
	});

	it("rejects process-only milestone doneWhen checks", () => {
		const issues = auditGoalDraft({
			objective: "证明定理 T。",
			acceptanceCriteria: ["proofs/t.lean 被 Lean 接受，状态为 proved"],
			plan: {
				milestones: [
					{ title: "M1", doneWhen: ["记录每轮进展并汇报"], actions: ["S1"] },
					{ title: "M2", doneWhen: ["proofs/t.lean 通过检查"] },
				],
			},
		});
		expect(issues).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					severity: "error",
					field: "plan",
					code: "process_only_criterion",
					path: "milestones[0].doneWhen[0]",
				}),
			]),
		);
	});

	it("formats issues with field and index", () => {
		const issues = auditGoalDraft({ objective: "", acceptanceCriteria: [] });
		const text = formatGoalQualityIssues(issues);
		expect(text).toContain("[error] objective");
		expect(text).toContain("[error] acceptanceCriteria");
		expect(formatGoalQualityIssues([])).toBe("Goal quality check passed.");
	});
});
