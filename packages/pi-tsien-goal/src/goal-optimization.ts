/**
 * A small, explicit optimization contract.
 *
 * Algorithm goals should optimize one measurable quantity against a named
 * baseline. The contract is intentionally separate from the plan: the plan says
 * how to search, while these fields say what "better" means. The goal state
 * persists the rendered objective/criteria/constraints, so no new fields are
 * needed in older sessions or the dashboard.
 */

export interface GoalOptimizationDraft {
	/** The single quantity to optimize, including its benchmark or workload. */
	metric: string;
	/** The named comparator, implementation, version, or measured baseline. */
	baseline: string;
	/** A measurable target, e.g. "降低 ≥20%", "误差 ≤0.05", "吞吐 ≥1.5×". */
	target: string;
	/** Invariants that must not regress while optimizing. */
	guardrails?: string[];
}

export const OPTIMIZATION_METHOD_FREEDOM =
	"允许尝试任意算法、实现、超参数或系统优化路线；只固定指标、基线、目标值和 guardrails。";

export function normalizeGoalOptimizationDraft(value: unknown): GoalOptimizationDraft | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	if (typeof record.metric !== "string" || typeof record.baseline !== "string" || typeof record.target !== "string") {
		return undefined;
	}
	const metric = record.metric.trim();
	const baseline = record.baseline.trim();
	const target = record.target.trim();
	const guardrails = Array.isArray(record.guardrails)
		? unique(record.guardrails.filter((entry): entry is string => typeof entry === "string").map((entry) => entry.trim()).filter(Boolean))
		: [];
	if (!metric && !baseline && !target && guardrails.length === 0) return undefined;
	return {
		metric,
		baseline,
		target,
		...(guardrails.length > 0 ? { guardrails } : {}),
	};
}

export function validateGoalOptimizationDraft(optimization: GoalOptimizationDraft | undefined): string[] {
	if (!optimization) return [];
	const errors: string[] = [];
	if (!optimization.metric) errors.push("Optimization goal needs a metric.");
	if (!optimization.baseline) errors.push("Optimization goal needs a baseline or comparator.");
	if (!optimization.target) {
		errors.push("Optimization goal needs a target value.");
	} else if (!/\d|翻倍|减半/.test(optimization.target)) {
		errors.push("Optimization target needs a number or an explicit factor (e.g. 20%, 2x, 翻倍, 减半).");
	}
	return errors;
}

export function optimizationObjective(optimization: GoalOptimizationDraft): string {
	const guardrails = optimization.guardrails?.length
		? ` Guardrails：${optimization.guardrails.map(trimEnd).join("；")}。`
		: "";
	return `优化合同：唯一主指标为「${trimEnd(optimization.metric)}」；对照基线为「${trimEnd(optimization.baseline)}」；目标为「${trimEnd(optimization.target)}」。${guardrails}${OPTIMIZATION_METHOD_FREEDOM}`;
}

export function optimizationCriterion(optimization: GoalOptimizationDraft): string {
	const guardrails = optimization.guardrails?.length
		? ` Guardrails：${optimization.guardrails.map(trimEnd).join("；")}。`
		: "";
	return `复现实验测量「${trimEnd(optimization.metric)}」，以「${trimEnd(optimization.baseline)}」为基线，验证「${trimEnd(optimization.target)}」。${guardrails}测量脚本、原始输出和汇总可复核。`;
}

function trimEnd(value: string): string {
	return value.trim().replace(/[。；;.\s]+$/u, "");
}

function unique(values: string[]): string[] {
	return [...new Set(values)];
}
