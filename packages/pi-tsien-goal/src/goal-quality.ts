/**
 * Deterministic quality gate for a goal draft.
 *
 * The goal is an outcome contract, not a list of working habits. A draft may
 * keep process rules (record, report, independent review, do not submit), but
 * those belong in `constraints`; they must never be the only acceptance
 * criteria. This module is intentionally lexical: it catches the failure modes
 * we saw in real drafts (vague process objectives, process-only criteria,
 * escape clauses, unbounded "exploration") without pretending to judge whether
 * a theorem is true.
 */

import { validateGoalOptimizationDraft, type GoalOptimizationDraft } from "./goal-optimization.ts";
import { validateGoalPlanDraft, type GoalPlanDraft } from "./goal-plan.ts";

export type GoalQualitySeverity = "error" | "warning";
export type GoalQualityField = "objective" | "acceptanceCriteria" | "constraints" | "plan";

export interface GoalQualityIssue {
	code: string;
	severity: GoalQualitySeverity;
	field: GoalQualityField;
	/** Zero-based index for a criterion or constraint. */
	index?: number;
	/** Exact tool input path (zero-based), when the issue is nested. */
	path?: string;
	message: string;
}

export interface GoalQualityInput {
	objective: string;
	acceptanceCriteria: string[];
	constraints?: string[];
	plan?: GoalPlanDraft;
	optimization?: GoalOptimizationDraft;
	/** Unattended drafts must include a 2-4 milestone plan with a ready first action. */
	requirePlan?: boolean;
}

/** A state of the world that can be checked: proof, metric, artifact, quality bar. */
const CONCRETE_OUTCOME =
	/(证明|证毕|反证|反例|定理|命题|引理|不等式|猜想|proved|disproved|达到|降至|降低到|提高到|不超过|至少|至多|收敛|构建成功|构建通过|生成|交付|发布|合并|复现|排名|精度|误差|耗时|复杂度|benchmark|指标|qps|延迟|内存|成功率|覆盖率|质量|影响力|顶刊|顶会|顶级|突破|解决|厘清|确定|判定|验证|检验|量化|刻画|识别|给出|通过.{0,24}(?:测试|评审|审计)|机器认证|独立复核)/i;

const ARTIFACT = /(论文|稿件|代码|报告|证书|文件|数据集|项目|实现)/i;
const ARTIFACT_DONE = /(完成|交付|提交|达到|通过|生成|发布|合并|修复|产出)/;
const METRIC =
	/(\d+(?:\.\d+)?\s*(?:%|倍|毫秒|秒|分钟|小时|次|轮|页|行|个|项)|benchmark|指标|基线|阈值|精度|误差|耗时|复杂度|延迟|内存|成功率|覆盖率|排名|qps)/i;

/** Working habits and process requirements. They are constraints, not outcomes. */
const PROCESS =
	/(记录|汇报|注明|按.{0,16}(?:规范|流程|要求)|遵循.{0,16}(?:规范|流程)|独立评审|提交.{0,12}评审|审计|更新.{0,16}(?:文档|status|roadmap)|同步.{0,16}(?:文档|稿件)|保留.{0,12}(?:证据|记录|存档)|留下.{0,8}记录|不.{0,12}(?:投稿|宣称|代表|代替|承诺))/i;

const ESCAPE_CLAUSE =
	/(若|如果|如).{0,40}(?:未|不|失败|不足|无法).{0,40}(?:则|就|可|仍).{0,40}(?:记录|保留|列出|不宣称|不算|视为|结案|完成|停止)|(即使|哪怕).{0,40}(?:也|仍)/;

const BATCH_LANGUAGE = /(这一批|本轮|本次|第一阶段|当前阶段|当前批次|第一个阶段)/;
const VAGUE_START = /^(继续|持续|自动|系统|努力|尽力|争取|力争|推进|优化|提升|改进|完善|探索|研究|完成当前)/;
const VAGUE_ASPIRATION = /(尽可能|尽量|充分|不断|持续|努力|争取|力争|尽力|有影响力|高质量|顶刊|顶会)/;
const OPTIMIZATION = /(优化|提高|提升|降低|加速|改进|缩减)(?!领域|方向|理论|方法)/;
const EXPLORATION = /(探索|寻找|尝试|调查|扫描)/;
const QUALITY_BAR = /(质量|影响力|顶刊|顶会|顶级|突破|解决|显著|阈值|标准|评审|证明|反例|benchmark|指标|目标)/i;
const EVIDENCE = /(文件|路径|命令|输出|测试|证书|报告|论文|代码|benchmark|数据集|日志|截图|url|https?:|\.(?:md|tex|json|csv|pdf|txt|py|ts|lean))/i;

export function auditGoalDraft(input: GoalQualityInput): GoalQualityIssue[] {
	const issues: GoalQualityIssue[] = [];
	const objective = input.objective.trim();
	const criteria = input.acceptanceCriteria.map((item) => item.trim()).filter(Boolean);
	const constraints = (input.constraints ?? []).map((item) => item.trim()).filter(Boolean);

	if (!objective) {
		issues.push(error("empty_objective", "objective", "The goal objective is empty."));
	} else {
		issues.push(...auditObjective(objective));
	}

	issues.push(
		...validateGoalOptimizationDraft(input.optimization).map((message) =>
			error("invalid_optimization", "objective", message),
		),
	);

	if (input.requirePlan || input.plan) {
		const planErrors = validateGoalPlanDraft(input.plan);
		issues.push(...planErrors.map((message) => error("invalid_plan", "plan", message)));
		input.plan?.milestones.forEach((milestone, index) => {
			milestone.doneWhen.forEach((check, checkIndex) => {
				for (const issue of auditCriterion(check, checkIndex)) {
					if (issue.severity === "error") {
						issues.push({ ...error(issue.code, "plan", issue.message), path: `milestones[${index}].doneWhen[${checkIndex}]` });
					}
				}
			});
		});
	}

	if (criteria.length === 0) {
		issues.push(
			error(
				"missing_acceptance_criteria",
				"acceptanceCriteria",
				"Add at least one acceptance criterion that states the verifiable end result.",
			),
		);
	}
	if (criteria.length > 5) {
		issues.push(
			warning(
				"too_many_criteria",
				"acceptanceCriteria",
				`${criteria.length} criteria is too many for one outcome; keep 1-4 end-state checks.`,
			),
		);
	}

	criteria.forEach((criterion, index) => issues.push(...auditCriterion(criterion, index)));

	const processOnlyCriteria = criteria.filter((criterion) => PROCESS.test(criterion) && !hasConcreteOutcome(criterion));
	if (processOnlyCriteria.length > 0 && constraints.length === 0) {
		issues.push(
			warning(
				"process_without_constraints",
				"constraints",
				"Process rules were rejected as criteria but no constraints were provided; put recording/reporting/review rules under constraints.",
			),
		);
	}
	constraints.forEach((constraint, index) => {
		if (hasConcreteOutcome(constraint) && !PROCESS.test(constraint)) {
			issues.push(
				warning(
					"constraint_looks_like_outcome",
					"constraints",
					"This reads like an acceptance check. Keep constraints for boundaries and working rules.",
					index,
				),
			);
		}
	});

	return issues.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1));
}

export function hasBlockingGoalQualityIssues(issues: readonly GoalQualityIssue[]): boolean {
	return issues.some((issue) => issue.severity === "error");
}

export function formatGoalQualityIssues(issues: readonly GoalQualityIssue[]): string {
	if (issues.length === 0) return "Goal quality check passed.";
	return issues
		.map((issue) => {
			const location =
				issue.path ?? (issue.index === undefined ? issue.field : `${issue.field}[${issue.index}]`);
			return `- [${issue.severity}] ${location}: ${issue.message}`;
		})
		.join("\n");
}

function auditObjective(objective: string): GoalQualityIssue[] {
	const issues: GoalQualityIssue[] = [];
	if (objective.length > 300) {
		issues.push(
			warning(
				"long_objective",
				"objective",
				"Keep the objective to one outcome sentence; move detail into acceptance criteria or constraints.",
			),
		);
	}
	if (ESCAPE_CLAUSE.test(objective)) {
		issues.push(
			error(
				"escape_clause",
				"objective",
				"The objective contains an escape clause that would let the goal close without the outcome.",
			),
		);
	}
	if (BATCH_LANGUAGE.test(objective)) {
		issues.push(
			warning(
				"batch_objective",
				"objective",
				"This reads like a batch or phase. Name the long-term outcome, or explicitly label this as a sprint goal.",
			),
		);
	}

	const concrete = hasConcreteOutcome(objective);
	if (!concrete) {
		if (VAGUE_START.test(objective) || VAGUE_ASPIRATION.test(objective)) {
			issues.push(
				error(
					"process_objective",
					"objective",
					"The objective is a process or aspiration, not a verifiable end state. State what must be true when the goal is done.",
				),
			);
		} else {
			issues.push(
				warning(
					"unverifiable_objective",
					"objective",
					"Add an observable end state (a proved statement, a metric target, or a concrete deliverable).",
				),
			);
		}
	}

	if (OPTIMIZATION.test(objective) && !METRIC.test(objective)) {
		issues.push(
			warning(
				"optimization_without_target",
				"objective",
				"If the request is for measurable optimization, provide optimization with a metric, baseline, and target. Otherwise use a checkable qualitative outcome.",
			),
		);
	}
	if (EXPLORATION.test(objective) && !QUALITY_BAR.test(objective)) {
		issues.push(
			error(
				"exploration_without_quality_bar",
				"objective",
				"Open-ended exploration needs a quality or impact bar that says when to stop (e.g. a solved problem, a top-venue result, an independent review standard).",
			),
		);
	}
	if (PROCESS.test(objective) && !concrete) {
		issues.push(
			error(
				"process_objective",
				"objective",
				"Move recording/reporting/review rules to constraints; the objective must name the result.",
			),
		);
	}
	return issues;
}

function auditCriterion(criterion: string, index: number): GoalQualityIssue[] {
	const issues: GoalQualityIssue[] = [];
	if (criterion.length > 120) {
		issues.push(
			warning(
				"long_criterion",
				"acceptanceCriteria",
				"This criterion is long; split it into independent, individually checkable outcomes.",
				index,
			),
		);
	}
	if ((criterion.match(/；/g)?.length ?? 0) >= 2 || (criterion.match(/，/g)?.length ?? 0) >= 4) {
		issues.push(
			warning(
				"compound_criterion",
				"acceptanceCriteria",
				"This criterion bundles several obligations; split it so partial completion is visible.",
				index,
			),
		);
	}
	if (ESCAPE_CLAUSE.test(criterion)) {
		issues.push(
			error(
				"escape_clause",
				"acceptanceCriteria",
				"This criterion lets the goal close without the outcome. Move the fallback to a constraint or remove it.",
				index,
			),
		);
	}

	const concrete = hasConcreteOutcome(criterion);
	const process = PROCESS.test(criterion);
	if (process && !concrete) {
		issues.push(
			error(
				"process_only_criterion",
				"acceptanceCriteria",
				"This is a working rule, not an outcome. Move it to constraints and state the result it should produce.",
				index,
			),
		);
	} else if (process) {
		issues.push(
			warning(
				"mixed_process_criterion",
				"acceptanceCriteria",
				"This mixes a process rule with an outcome; keep the outcome here and move the process part to constraints.",
				index,
			),
		);
	} else if (!concrete) {
		issues.push(
			warning(
				"unverifiable_criterion",
				"acceptanceCriteria",
				"Name a result that can be checked: a proof, a metric value, a command/test, or a concrete artifact.",
				index,
			),
		);
	}

	if (!EVIDENCE.test(criterion)) {
		issues.push(
			warning(
				"no_evidence_carrier",
				"acceptanceCriteria",
				"Name where the evidence will live (file, command, test, certificate, benchmark output).",
				index,
			),
		);
	}
	return issues;
}

function hasConcreteOutcome(text: string): boolean {
	return (
		CONCRETE_OUTCOME.test(text) ||
		METRIC.test(text) ||
		(ARTIFACT.test(text) && ARTIFACT_DONE.test(text))
	);
}

function error(code: string, field: GoalQualityField, message: string, index?: number): GoalQualityIssue {
	return { code, severity: "error", field, ...(index === undefined ? {} : { index }), message };
}

function warning(code: string, field: GoalQualityField, message: string, index?: number): GoalQualityIssue {
	return { code, severity: "warning", field, ...(index === undefined ? {} : { index }), message };
}
