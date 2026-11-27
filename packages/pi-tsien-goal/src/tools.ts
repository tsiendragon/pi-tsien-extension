import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import {
	confirmGoalReplacement,
	reviewGoalProposal,
	saveReviewedGoalAndOfferStart,
	type GoalStartAPI,
	type GoalWorkflowContext,
} from "./commands.ts";
import { normalizeResearchFeedback } from "./research-feedback.ts";
import { loadGoalState, saveGoalState, validateObjective } from "./state.ts";
import { clearDraftIntent, pendingDraftIntent } from "./draft-intent.ts";
import { applyGoalUi, renderGoalStatus } from "./ui.ts";

import { auditGoalDraft, formatGoalQualityIssues, hasBlockingGoalQualityIssues } from "./goal-quality.ts";
import {
	normalizeGoalOptimizationDraft,
	optimizationCriterion,
	optimizationObjective,
	OPTIMIZATION_METHOD_FREEDOM,
	validateGoalOptimizationDraft,
} from "./goal-optimization.ts";
import { normalizeGoalPlanDraft } from "./goal-plan.ts";
import type { GoalDraftProposal } from "./goal-prep.ts";
import type {
	GoalBlocker,
	GoalBlockerAttempt,
	GoalProgress,
	GoalSourceDoc,
	GoalState,
	WorkItem,
} from "./types.ts";

export const getGoalParams = Type.Object({}, { additionalProperties: false });
export const createGoalParams = Type.Object(
	{
		objective: Type.String({ description: "The concrete user-approved objective to start pursuing." }),
		explicit_request: Type.Boolean({
			description:
				"Must be true only when the user or system/developer instructions explicitly requested a goal.",
		}),
		source_paths: Type.Optional(
			Type.Array(Type.String(), {
				description: "Optional source paths the user explicitly associated with this goal.",
			}),
		),
		acceptance_criteria: Type.Optional(
			Type.Array(Type.String(), {
				description: "Optional acceptance criteria explicitly provided by the user/system.",
			}),
		),
	},
	{ additionalProperties: false },
);
const optimizationDraftSchema = Type.Object(
	{
		metric: Type.String({
			description: "The one quantity to optimize, including the workload or benchmark it is measured on.",
		}),
		baseline: Type.String({ description: "The named comparator, implementation, version, or measured baseline." }),
		target: Type.String({
			description: "A measurable target with a number or factor, e.g. 降低 ≥20%, 误差 ≤0.05, 吞吐 ≥1.5×.",
		}),
		guardrails: Type.Optional(
			Type.Array(Type.String(), {
				maxItems: 5,
				description: "Invariants that must not regress, e.g. same certificate, same accuracy, all costs counted.",
			}),
		),
	},
	{ additionalProperties: false },
);
const milestoneDraftSchema = Type.Object(
	{
		title: Type.String({ description: "Milestone outcome, not a working rule." }),
		doneWhen: Type.Array(Type.String(), {
			minItems: 1,
			description: "Observable checks that make this milestone done.",
		}),
		actions: Type.Optional(
			Type.Array(Type.String(), {
				maxItems: 3,
				description: "Concrete actions under this milestone. The first milestone needs 1-3; later ones may be added when reached.",
			}),
		),
	},
	{ additionalProperties: false },
);
export const proposeGoalDraftParams = Type.Object(
	{
		objective: Type.String({ description: "The concise objective for the proposed /goal draft." }),
		description: Type.Optional(
			Type.String({
				description:
					"Optional short context summary for result metadata; not persisted unless folded into objective or acceptance criteria.",
			}),
		),
		acceptanceCriteria: Type.Array(Type.String(), {
			description:
				"Verifiable end-state checks: proof, metric target, test result, or concrete artifact. Process rules belong in constraints.",
			minItems: 1,
		}),
		constraints: Type.Optional(
			Type.Array(Type.String(), {
				description:
					"Working rules and boundaries (recording, reporting, independent review, do not submit). Not acceptance criteria.",
			}),
		),
		optimization: Type.Optional(optimizationDraftSchema),
		milestones: Type.Optional(
			Type.Array(milestoneDraftSchema, {
				minItems: 2,
				maxItems: 4,
				description: "2-4 ordered milestones, each with its own actions. The first milestone needs 1-3 actions.",
			}),
		),
		sourcePaths: Type.Optional(
			Type.Array(Type.String(), {
				description: "Optional source paths explicitly associated with this goal draft.",
			}),
		),
		startImmediately: Type.Optional(
			Type.Boolean({ description: "True when the draft should offer Start as the intended action." }),
		),
		autoApprove: Type.Optional(
			Type.Boolean({
				description:
					"Unattended /goal command drafts only: save and start the goal without the review dialog. Set true only when the command context explicitly requests unattended creation.",
			}),
		),
		replan: Type.Optional(
			Type.Boolean({
				description:
					"In-place /goal replan only: update the objective and criteria, preserve the goal ID and existing work items. Set only when the command context asks for a replan.",
			}),
		),
		draftId: Type.Optional(Type.String({ description: "Optional model-generated draft correlation id." })),
		commandId: Type.Optional(Type.String({ description: "Optional /goal drafting command correlation id." })),
	},
	{ additionalProperties: false },
);
export const completeGoalParams = Type.Object(
	{
		evidence: Type.Optional(Type.String({ description: "Evidence that the goal is complete." })),
	},
	{ additionalProperties: false },
);
export const pauseGoalParams = Type.Object(
	{
		reason: Type.String({ description: "Concrete reason the agent cannot safely continue the active goal." }),
	},
	{ additionalProperties: false },
);
export const updateGoalProgressParams = Type.Object(
	{
		done: Type.Optional(Type.Array(Type.String(), { description: "Completed progress items." })),
		current: Type.Optional(Type.String({ description: "Current work item." })),
		blocked: Type.Optional(
			Type.Array(Type.String(), {
				description: "Legacy plain-text blockers; prefer update_goal_graph for structured blockers.",
			}),
		),
		summary: Type.Optional(Type.String({ description: "Short progress summary." })),
		checkpoint: Type.Optional(Type.Object({
			kind: Type.Union([Type.Literal("gate_decision"), Type.Literal("replication"), Type.Literal("resource_frontier")]),
			evidence: Type.String({ minLength: 1, maxLength: 300, description: "Stable artifact path, run ID or result digest; reuse it for the same evidence." }),
			decision: Type.String({ minLength: 1, maxLength: 500, description: "What changed and the next bounded action; for reinforce, name the preset gate met." }),
			feedback: Type.Optional(Type.Object({
				method: Type.String({ minLength: 1, maxLength: 120 }),
				scope: Type.String({ minLength: 1, maxLength: 280 }),
				outcome: Type.Union([Type.Literal("reinforce"), Type.Literal("falsified"), Type.Literal("proof_gap"), Type.Literal("resource_limit"), Type.Literal("inconclusive")]),
				gate: Type.Optional(Type.String({ minLength: 1, maxLength: 300, description: "Preset success criterion that the evidence met." })),
				independentCheck: Type.Optional(Type.String({ minLength: 1, maxLength: 300 })),
				challenge: Type.Optional(Type.String({ minLength: 1, maxLength: 300 })),
			}, { additionalProperties: false, description: "Scoped route feedback. Reinforce requires the preset success gate, an independent check reference and a complementary challenge." })),
		}, { additionalProperties: false })),
	},
	{ additionalProperties: false, minProperties: 1 },
);
export const updateGoalParams = Type.Object(
	{
		objective: Type.Optional(
			Type.String({
				description:
					"Refined objective text that keeps the user's meaning; omit to keep the current objective.",
			}),
		),
		acceptance_criteria: Type.Optional(
			Type.Array(Type.String(), {
				description: "Replacement acceptance criteria (non-empty); omit to keep the current list.",
			}),
		),
		constraints: Type.Optional(
			Type.Array(Type.String(), { description: "Replacement constraints list; omit to keep the current constraints." }),
		),
		source_paths: Type.Optional(
			Type.Array(Type.String(), {
				description: "Replacement source document paths; omit to keep the current source docs.",
			}),
		),
		reason: Type.String({
			description: "Short reason this edit keeps the goal accurate; recorded as the audit reason.",
		}),
	},
	{ additionalProperties: false },
);
const workItemSchema = Type.Object(
	{
		id: Type.String(),
		state: Type.Union([
			Type.Literal("todo"),
			Type.Literal("in_progress"),
			Type.Literal("done"),
			Type.Literal("blocked"),
			Type.Literal("deferred"),
		]),
		goalId: Type.Optional(Type.String()),
		title: Type.Optional(Type.String()),
		description: Type.Optional(Type.String()),
		horizon: Type.Optional(Type.Union([Type.Literal("mid"), Type.Literal("short")])),
		parentId: Type.Optional(Type.String()),
		doneWhen: Type.Optional(Type.Array(Type.String())),
		evidence: Type.Optional(Type.Array(Type.String())),
		dependsOn: Type.Optional(Type.Array(Type.String())),
		acceptanceCriteriaIds: Type.Optional(Type.Array(Type.String())),
		updatedAt: Type.Optional(Type.Number()),
	},
	{ additionalProperties: false },
);
const blockerSchema = Type.Object(
	{
		id: Type.String(),
		goalId: Type.String(),
		title: Type.String(),
		reason: Type.String(),
		kind: Type.Union([
			Type.Literal("technical"),
			Type.Literal("dependency"),
			Type.Literal("external_wait"),
			Type.Literal("permission_or_credential"),
			Type.Literal("user_decision"),
			Type.Literal("policy_or_safety"),
			Type.Literal("scope_unclear"),
		]),
		disposition: Type.Union([
			Type.Literal("agent_can_try"),
			Type.Literal("needs_user"),
			Type.Literal("external_wait"),
		]),
		state: Type.Union([Type.Literal("open"), Type.Literal("resolved"), Type.Literal("superseded")]),
		workItemIds: Type.Array(Type.String()),
		evidence: Type.Optional(Type.String()),
		proposedResolution: Type.Optional(Type.String()),
		owner: Type.Union([Type.Literal("agent"), Type.Literal("user"), Type.Literal("external")]),
		createdAt: Type.Number(),
		updatedAt: Type.Number(),
	},
	{ additionalProperties: false },
);
const blockerAttemptSchema = Type.Object(
	{
		id: Type.String(),
		goalId: Type.String(),
		blockerId: Type.String(),
		hypothesis: Type.String(),
		action: Type.String(),
		result: Type.String(),
		evidence: Type.Optional(Type.String()),
		createdAt: Type.Number(),
	},
	{ additionalProperties: false },
);
export const updateGoalGraphParams = Type.Object(
	{
		workItems: Type.Optional(
			Type.Array(workItemSchema, {
				description:
					"Full replacement snapshot of goal work items. Only id and state are required; omitted fields inherit the current item.",
			}),
		),
		blockers: Type.Optional(
			Type.Array(blockerSchema, { description: "Full replacement snapshot of structured blockers." }),
		),
		attempt: Type.Optional(blockerAttemptSchema),
	},
	{ additionalProperties: false },
);

export const proposeGoalDraftPromptSnippet =
	"Use propose_goal_draft to draft a /goal proposal; do not persist it directly.";

export const proposeGoalDraftPromptGuidelines = [
	"Preserve the user's meaning and boundaries; do not invent unrelated scope or silently drop constraints.",
	"The objective must be a verifiable end state: a concrete fix or deliverable, a proved/disproved statement, a metric target with baseline, or an exploration quality bar.",
	"Provide 2-4 ordered milestones with doneWhen checks. Put 1-3 concrete actions under the first milestone; later milestones stay locked. Actions are concrete steps, not outcome checks; doneWhen checks are outcomes.",
	"acceptanceCriteria are outcome checks, not working rules. Move recording, reporting, independent review, audit, and do-not-submit rules to constraints.",
	"For a measurable optimization request, set optimization {metric, baseline, target, guardrails}. For other goals omit optimization entirely; no numeric metric is required.",
	"Do not add escape clauses that let the goal close when the result is not achieved.",
	"Do not leave acceptanceCriteria empty; if details are uncertain, state the uncertainty rather than creating unrelated checks.",
	"Submit the draft instead of describing it in prose. If unattended validation rejects it, revise and retry at most once without changing scope. Ask the user if essential information is missing or the retry fails. Use create_goal only for an already-authorized new goal.",
] as const;

export type CreateGoalToolInput = Static<typeof createGoalParams>;
export type ProposeGoalDraftToolInput = Static<typeof proposeGoalDraftParams>;
export type CompleteGoalToolInput = Static<typeof completeGoalParams>;
export type PauseGoalToolInput = Static<typeof pauseGoalParams>;
export type UpdateGoalProgressToolInput = Static<typeof updateGoalProgressParams>;
export type UpdateGoalGraphToolInput = Static<typeof updateGoalGraphParams>;
export type UpdateGoalToolInput = Static<typeof updateGoalParams>;

interface GoalToolContext extends Partial<GoalWorkflowContext> {
	sessionManager: {
		getBranch(): Array<{ type: string; customType?: string; data?: unknown }>;
		getSessionId?: () => string;
	};
}

export type GoalToolResult = {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown> | undefined;
	terminate?: boolean;
};

export type GoalTheme = {
	fg?: (token: "toolTitle" | "toolOutput" | "success" | "error" | "muted", text: string) => string;
	bold?: (text: string) => string;
};

export function registerGoalTools(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "get_goal",
		label: "Get Goal",
		description: "Get the current long-running goal state and source paths.",
		promptSnippet:
			"Use get_goal to read the current /goal state, status, progress, acceptance criteria, and source paths.",
		parameters: getGoalParams,
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			return executeGetGoal(ctx as GoalToolContext);
		},
		renderCall: (_args, theme) => new Text(formatGoalToolCall("get_goal", undefined, theme), 0, 0),
		renderResult: (result, _options, theme) =>
			new Text(formatGoalToolResult(result as GoalToolResult, theme), 0, 0),
	});

	pi.registerTool({
		name: "create_goal",
		label: "Create Goal",
		description:
			"Create a goal only when explicitly requested by the user or system/developer instructions. Refuses if a goal exists. For drafts use propose_goal_draft; never rewrite an existing goal.",
		promptSnippet: "Use create_goal to persist a user-approved /goal only when no goal exists.",
		parameters: createGoalParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return executeCreateGoal(params as CreateGoalToolInput, ctx as GoalToolContext, pi);
		},
		renderCall: (args, theme) =>
			new Text(
				formatGoalToolCall(
					"create_goal",
					(args as Partial<CreateGoalToolInput> | undefined)?.objective,
					theme,
				),
				0,
				0,
			),
		renderResult: (result, _options, theme) =>
			new Text(formatGoalToolResult(result as GoalToolResult, theme), 0, 0),
	});

	pi.registerTool({
		name: "propose_goal_draft",
		label: "Propose Goal Draft",
		description:
			"Open a structured /goal draft for user review. Saves only after the user chooses Start in the review UI, " +
			"or saves and starts immediately when an unattended /goal command drafts it (autoApprove: true). " +
			proposeGoalDraftPromptGuidelines.join(" "),
		promptSnippet: proposeGoalDraftPromptSnippet,
		parameters: proposeGoalDraftParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return executeProposeGoalDraft(params as ProposeGoalDraftToolInput, ctx as GoalToolContext, pi);
		},
		renderCall: (args, theme) =>
			new Text(formatProposeGoalDraftToolCall(args as ProposeGoalDraftToolInput, theme), 0, 0),
		renderResult: (result, _options, theme) =>
			new Text(formatGoalToolResult(result as GoalToolResult, theme), 0, 0),
	});

	pi.registerTool({
		name: "update_goal",
		label: "Update Goal",
		description:
			"Update the active goal's objective, acceptance criteria, constraints, or source docs in place, with a reason. " +
			"Keep the user's meaning exactly: refine wording, or record detail the user already implied; never add or remove scope, deliverables, or boundaries without the user asking. " +
			"Mirror significant acceptance-criteria changes into work items with update_goal_graph.",
		promptSnippet:
			"Use update_goal to keep the objective, acceptance criteria, constraints, or source docs accurate (with a reason) without changing the user's scope.",
		parameters: updateGoalParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return executeUpdateGoal(params as UpdateGoalToolInput, ctx as GoalToolContext, pi);
		},
		renderCall: (args, theme) =>
			new Text(formatGoalToolCall("update_goal", (args as UpdateGoalToolInput | undefined)?.reason, theme), 0, 0),
		renderResult: (result, _options, theme) =>
			new Text(formatGoalToolResult(result as GoalToolResult, theme), 0, 0),
	});

	pi.registerTool({
		name: "complete_goal",
		label: "Complete Goal",
		description:
			"Mark the active goal complete only when the objective's verifiable end state is achieved and no required work remains. A finished batch, report, review, or process checklist is not completion. It cannot pause, resume, or rewrite the objective.",
		promptSnippet: "Use complete_goal to mark the current /goal complete with evidence.",
		parameters: completeGoalParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return executeCompleteGoal(params as CompleteGoalToolInput, ctx as GoalToolContext, pi);
		},
		renderCall: (args, theme) =>
			new Text(
				formatGoalToolCall(
					"complete_goal",
					(args as Partial<CompleteGoalToolInput> | undefined)?.evidence,
					theme,
				),
				0,
				0,
			),
		renderResult: (result, _options, theme) =>
			new Text(formatCompleteGoalToolResult(result as GoalToolResult, theme), 0, 0),
	});

	pi.registerTool({
		name: "pause_goal",
		label: "Pause Goal",
		description:
			"Pause the active goal only when the user asked to stop it or continuing would be unsafe. For missing permissions, external data, or pending user decisions, record a structured blocker and keep the goal active so continuation keeps re-checking; include a concrete reason when pausing.",
		promptSnippet:
			"Use pause_goal only when the user asked to stop the goal or continuing is unsafe; for external waits, record blockers and keep the goal active.",
		parameters: pauseGoalParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return executePauseGoal(params as PauseGoalToolInput, ctx as GoalToolContext, pi);
		},
		renderCall: (args, theme) =>
			new Text(formatGoalToolCall("pause_goal", (args as PauseGoalToolInput | undefined)?.reason, theme), 0, 0),
		renderResult: (result, _options, theme) =>
			new Text(formatGoalToolResult(result as GoalToolResult, theme), 0, 0),
	});

	pi.registerTool({
		name: "update_goal_graph",
		label: "Update Goal Work Graph",
		description:
			"Update work items and structured blockers for the active goal. Send every work item; each item only needs id and state, and omitted fields inherit the current value. A milestone can be marked done only after its short actions are done/deferred and it has evidence that the doneWhen checks passed. Attempts are append-only audit records. Try the ladder first — a way around the blocker, a self-service path, then other advanceable work — record each attempt with evidence, and only mark a blocker needs_user or external_wait after that; credentials, permissions, irreversible actions, product decisions, and policy limits need user/external waiting.",
		promptSnippet:
			"Use update_goal_graph to record work-item state, structured blockers, and blocker attempts.",
		parameters: updateGoalGraphParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return executeUpdateGoalGraph(params as UpdateGoalGraphToolInput, ctx as GoalToolContext, pi);
		},
		renderCall: (_args, theme) =>
			new Text(formatGoalToolCall("update_goal_graph", "Update work graph", theme), 0, 0),
		renderResult: (result, _options, theme) =>
			new Text(formatGoalToolResult(result as GoalToolResult, theme), 0, 0),
	});

	pi.registerTool({
		name: "update_goal_progress",
		label: "Update Goal Progress",
		description:
			"Update execution progress for the active goal without changing objective, source docs, or criteria. It cannot rewrite objective, source docs, or acceptance criteria.",
		promptSnippet: "Use update_goal_progress to record a research checkpoint only when durable evidence changes a gate, replication conclusion, or resource decision; do not count routine batches or paraphrases.",
		parameters: updateGoalProgressParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return executeUpdateGoalProgress(params as UpdateGoalProgressToolInput, ctx as GoalToolContext, pi);
		},
		renderCall: (args, theme) =>
			new Text(formatUpdateGoalProgressToolCall(args as UpdateGoalProgressToolInput, theme), 0, 0),
		renderResult: (result, _options, theme) =>
			new Text(formatGoalToolResult(result as GoalToolResult, theme), 0, 0),
	});
}

export function executeGetGoal(ctx: GoalToolContext): GoalToolResult {
	const current = loadGoalState(ctx);
	if (!current) {
		return { content: [{ type: "text", text: "No goal is currently set." }], details: { goal: null } };
	}
	return {
		content: [{ type: "text", text: renderGoalStatus(current) }],
		details: { goal: current, sourcePaths: current.sourceDocs.map((doc) => doc.path) },
	};
}

export function executeCreateGoal(
	params: CreateGoalToolInput,
	ctx: GoalToolContext,
	pi: Pick<ExtensionAPI, "appendEntry">,
): GoalToolResult {
	if (!params.explicit_request) {
		return refusalResult(
			"create_goal requires explicit user or system/developer authorization.",
			"permission_denied",
		);
	}
	const current = loadGoalState(ctx);
	if (current) {
		return refusalResult(
			"A goal already exists. Use user-owned /goal replacement flow instead.",
			"goal_exists",
			current,
		);
	}
	const next = saveGoalState(
		pi,
		{
			action: "create",
			goalId: crypto.randomUUID(),
			objective: params.objective,
			now: Date.now(),
			owner: "model",
			sourceDocs: sourceDocsFromPaths(params.source_paths),
			acceptanceCriteria: params.acceptance_criteria,
			reason: "Created by create_goal after explicit authorization.",
		},
		current,
	);
	applyGoalUi(ctx, next);
	return {
		content: [{ type: "text", text: `Created goal: ${next?.objective ?? params.objective}` }],
		details: { goal: next, sourcePaths: next?.sourceDocs.map((doc) => doc.path) ?? [] },
	};
}

export const GOAL_DRAFT_REVIEW_TIMEOUT_MS = 10 * 60_000;

const DRAFT_REVIEW_TIMEOUT = Symbol("goal-draft-review-timeout");

/**
 * A draft review waits on a terminal dialog. Without a deadline a turn whose draft
 * was not explicitly unattended can stay running forever — the tool never returns,
 * so the whole session sits in "running" and repaints an animation loop (observed:
 * a 36 MB session pinned one core for hours while the UI showed the draft tool).
 */
async function withDraftReviewTimeout<T>(pending: Promise<T>): Promise<T | typeof DRAFT_REVIEW_TIMEOUT> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			pending,
			new Promise<typeof DRAFT_REVIEW_TIMEOUT>((resolve) => {
				timer = setTimeout(() => resolve(DRAFT_REVIEW_TIMEOUT), GOAL_DRAFT_REVIEW_TIMEOUT_MS);
				timer.unref?.();
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

/** Interactive review needs a terminal: rpc/json/print modes cannot show the dialog. */
function canReviewGoalDraft(ctx: GoalToolContext): boolean {
	if (!ctx.hasUI || !ctx.ui?.select || !ctx.ui.editor) return false;
	return ctx.mode === undefined || ctx.mode === "tui";
}

export async function executeProposeGoalDraft(
	params: ProposeGoalDraftToolInput,
	ctx: GoalToolContext,
	pi: Pick<ExtensionAPI, "appendEntry"> & Partial<GoalStartAPI>,
): Promise<GoalToolResult> {
	const normalized = normalizeGoalDraftParams(params);
	if (!normalized.ok) throw goalToolError(normalized.message, normalized.code);

	// Unattended /goal command drafts save and start without dialogs. The model
	// only sets autoApprove when the command drafting prompt asked for it, so the
	// command's recorded intent is honored as well — a single omitted flag must not
	// leave the draft waiting for a review dialog nobody is watching.
	const intent = pendingDraftIntent(ctx);
	const autoApprove = params.autoApprove === true || intent !== undefined;
	const replan = params.replan === true || intent?.replan === true;
	const qualityIssues = auditGoalDraft({ ...normalized.proposal, requirePlan: autoApprove });
	if (hasBlockingGoalQualityIssues(qualityIssues) && autoApprove) {
		return {
			content: [
				{
					type: "text",
					text: [
						"Goal draft rejected by the outcome quality gate. No goal was saved.",
						formatGoalQualityIssues(qualityIssues),
						"Fix the flagged fields and retry at most once without changing scope or command flags. If essential information is missing or this was already a retry, ask the user instead.",
					].join("\n"),
				},
			],
			details: { status: "rejected", reason: "goal_quality", issues: qualityIssues, goal: null },
		};
	}
	if (!autoApprove && qualityIssues.length > 0) {
		ctx.ui?.notify(formatGoalQualityIssues(qualityIssues), "warning");
	}

	if (!autoApprove && !canReviewGoalDraft(ctx)) {
		return {
			content: [
				{
					type: "text",
					text: "Goal draft requires interactive review before saving. No goal was saved.",
				},
			],
			details: { status: "cancelled", reason: "review_ui_unavailable", goal: null },
			terminate: true,
		};
	}

	const current = loadGoalState(ctx);
	if (replan && !current) {
		return {
			content: [{ type: "text", text: "No goal exists to replan. No goal was saved." }],
			details: { status: "cancelled", reason: "no_goal", goal: null },
			terminate: true,
		};
	}
	if (replan && current?.status === "complete") {
		return {
			content: [{ type: "text", text: "Cannot replan a complete goal. Start a new goal instead." }],
			details: { status: "cancelled", reason: "goal_complete", goal: current },
			terminate: true,
		};
	}
	let action: "create" | "replace" | "replan";
	if (replan) {
		action = "replan";
	} else if (autoApprove) {
		action = current ? "replace" : "create";
	} else {
		const confirmed = await confirmGoalReplacement(
			ctx as GoalWorkflowContext,
			current,
			false,
			normalized.proposal.objective,
		);
		if (!confirmed) {
			return {
				content: [{ type: "text", text: "Goal draft cancelled. No goal was saved." }],
				details: { status: "cancelled", reason: "replacement_not_confirmed", goal: current },
				terminate: true,
			};
		}
		action = confirmed;
	}

	const review = autoApprove
		? { proposal: normalized.proposal, start: true }
		: await withDraftReviewTimeout(reviewGoalProposal(ctx as GoalWorkflowContext, normalized.proposal));
	if (review === DRAFT_REVIEW_TIMEOUT) {
		const minutes = Math.round(GOAL_DRAFT_REVIEW_TIMEOUT_MS / 60_000);
		ctx.ui?.notify(`Goal draft review timed out after ${minutes} min; no goal was saved.`, "warning");
		return {
			content: [{ type: "text", text: `Goal draft review timed out after ${minutes} min. No goal was saved.` }],
			details: { status: "cancelled", reason: "review_timeout", goal: current },
			terminate: true,
		};
	}
	if (!review) {
		return {
			content: [{ type: "text", text: "Goal draft cancelled. No goal was saved." }],
			details: { status: "cancelled", reason: "user_cancelled", goal: current },
			terminate: true,
		};
	}

	const reviewed = normalizeReviewedProposal(review.proposal);
	if (!reviewed.ok) throw goalToolError(reviewed.message, reviewed.code);

	const start = replan ? current?.status === "active" : true;
	const next = await saveReviewedGoalAndOfferStart(
		pi as ExtensionAPI & Partial<GoalStartAPI>,
		ctx as GoalWorkflowContext,
		{
			current,
			proposal: reviewed.proposal,
			action,
			start,
			sourceDocs: replan ? undefined : sourceDocsFromPaths(normalized.sourcePaths),
			successMessage:
				action === "replan"
					? "Goal replanned; existing work items preserved."
					: action === "replace"
						? "Goal draft accepted and replaced."
						: "Goal draft accepted and saved.",
			staleMessage: "Goal changed before saving. Re-run /goal draft for the current goal.",
		},
	);
	if (!next) {
		throw goalToolError("Goal changed before saving. No goal was saved.", "stale_goal");
	}
	clearDraftIntent(ctx);

	return {
		content: [{ type: "text", text: `Saved goal draft and queued Start: ${next.objective}` }],
		details: {
			status: "saved",
			action,
			approvedBy: params.autoApprove === true ? "draft-flag" : intent ? "command-intent" : "review",
			started: next.status === "active",
			goal: next,
			draftId: normalized.draftId,
			commandId: normalized.commandId,
		},
		terminate: true,
	};
}

export function executeCompleteGoal(
	params: CompleteGoalToolInput,
	ctx: GoalToolContext,
	pi: Pick<ExtensionAPI, "appendEntry">,
): GoalToolResult {
	const current = loadGoalState(ctx);
	if (!current) return refusalResult("No active goal exists to complete.", "no_goal");
	if (current.status === "complete")
		return refusalResult("The current goal is already complete.", "already_complete", current);
	if (current.status !== "active")
		return refusalResult("Only active goals can be completed.", "goal_inactive", current);

	const evidence = params.evidence?.trim();
	const items = current.workItems ?? [];
	const milestones = items.filter((item) => item.horizon === "mid");
	if (milestones.length > 0) {
		const openMilestones = milestones.filter((item) => item.state !== "done" && item.state !== "deferred");
		if (openMilestones.length > 0) {
			return refusalResult(
				`Cannot complete: ${openMilestones.length} milestone(s) are still open (${openMilestones
					.map((item) => item.title)
					.join("; ")}). Mark each milestone done with evidence, or defer it explicitly.`,
				"open_milestones",
				current,
			);
		}
		const milestoneById = new Map(milestones.map((item) => [item.id, item]));
		const openActions = items.filter((item) => {
			if (item.horizon !== "short" || item.state === "done" || item.state === "deferred") return false;
			const parent = item.parentId ? milestoneById.get(item.parentId) : undefined;
			return parent?.state !== "done" && parent?.state !== "deferred";
		});
		if (openActions.length > 0) {
			return refusalResult(
				`Cannot complete: ${openActions.length} next action(s) are still open (${openActions
					.map((item) => item.title)
					.join("; ")}).`,
				"open_actions",
				current,
			);
		}
		if (!evidence) {
			return refusalResult(
				"A hierarchical goal needs completion evidence that covers the acceptance criteria.",
				"missing_evidence",
				current,
			);
		}
	}
	const next = saveGoalState(
		pi,
		{
			action: "complete",
			goalId: current.goalId,
			now: Date.now(),
			reason: evidence ? `Completed with evidence: ${evidence}` : "Completed by complete_goal.",
		},
		current,
	);
	applyGoalUi(ctx, next);
	return {
		content: [{ type: "text", text: evidence ? `Goal complete. Evidence: ${evidence}` : "Goal complete." }],
		details: { goal: next, evidence },
	};
}

export function executePauseGoal(
	params: PauseGoalToolInput,
	ctx: GoalToolContext,
	pi: Pick<ExtensionAPI, "appendEntry">,
): GoalToolResult {
	const current = loadGoalState(ctx);
	if (!current) return refusalResult("No active goal exists to pause.", "no_goal");
	if (current.status !== "active") return refusalResult("Only active goals can be paused.", "goal_inactive", current);
	const reason = params.reason.trim();
	if (!reason) return refusalResult("pause_goal requires a concrete reason.", "empty_reason", current);
	const next = saveGoalState(
		pi,
		{ action: "pause", goalId: current.goalId, now: Date.now(), reason },
		current,
	);
	applyGoalUi(ctx, next);
	return {
		content: [{ type: "text", text: `Goal paused. Reason: ${reason}` }],
		details: { goal: next, reason },
	};
}

export function executeUpdateGoalGraph(
	params: UpdateGoalGraphToolInput,
	ctx: GoalToolContext,
	pi: Pick<ExtensionAPI, "appendEntry">,
): GoalToolResult {
	const current = loadGoalState(ctx);
	if (!current) return refusalResult("No active goal exists to update.", "no_goal");
	if (current.status !== "active")
		return refusalResult("Only active goals can receive work-graph updates.", "goal_inactive", current);
	if (
		params.workItems?.some((item) => item.goalId !== undefined && item.goalId !== current.goalId) ||
		params.blockers?.some((blocker) => blocker.goalId !== current.goalId) ||
		(params.attempt?.goalId !== undefined && params.attempt.goalId !== current.goalId)
	) {
		return refusalResult("Work graph records must belong to the active goal.", "stale_goal", current);
	}
	const now = Date.now();
	const workItems = normalizeWorkItemSnapshot(current, params.workItems, now);
	const unsafe = params.blockers?.find(
		(blocker) =>
			(blocker.kind === "permission_or_credential" ||
				blocker.kind === "policy_or_safety" ||
				blocker.kind === "user_decision" ||
				blocker.kind === "external_wait") &&
			blocker.disposition === "agent_can_try",
	);
	if (unsafe)
		return refusalResult(`${unsafe.kind} blockers cannot be agent_can_try.`, "policy_boundary", current);
	if (workItems) {
		const milestoneError = validateMilestoneTransitions(current, workItems);
		if (milestoneError) return refusalResult(milestoneError.message, milestoneError.code, current);
	}
	const next = saveGoalState(
		pi,
		{
			action: "graph",
			goalId: current.goalId,
			now,
			workItems,
			blockers: params.blockers as GoalBlocker[] | undefined,
			attempt: params.attempt as GoalBlockerAttempt | undefined,
			reason: "Updated by update_goal_graph.",
		},
		current,
	);
	applyGoalUi(ctx, next);
	return { content: [{ type: "text", text: "Goal work graph updated" }], details: { goal: next } };
}

function normalizeWorkItemSnapshot(
	current: GoalState,
	patches: UpdateGoalGraphToolInput["workItems"],
	now: number,
): WorkItem[] | undefined {
	if (!patches) return undefined;
	const previousById = new Map((current.workItems ?? []).map((item) => [item.id, item]));
	return patches.map((patch) => {
		const previous = previousById.get(patch.id);
		const description = patch.description ?? previous?.description;
		const horizon = patch.horizon ?? previous?.horizon;
		const parentId = patch.parentId ?? previous?.parentId;
		const doneWhen = patch.doneWhen ?? previous?.doneWhen;
		const evidence = patch.evidence ?? previous?.evidence;
		return {
			id: patch.id,
			goalId: current.goalId,
			title: patch.title?.trim() || previous?.title || patch.id,
			...(description !== undefined ? { description } : {}),
			...(horizon !== undefined ? { horizon } : {}),
			...(parentId !== undefined ? { parentId } : {}),
			...(doneWhen !== undefined ? { doneWhen: [...doneWhen] } : {}),
			...(evidence !== undefined ? { evidence: [...evidence] } : {}),
			state: patch.state,
			dependsOn: [...(patch.dependsOn ?? previous?.dependsOn ?? [])],
			acceptanceCriteriaIds: [...(patch.acceptanceCriteriaIds ?? previous?.acceptanceCriteriaIds ?? [])],
			updatedAt: patch.updatedAt ?? now,
		};
	});
}

function validateMilestoneTransitions(
	current: GoalState,
	nextItems: WorkItem[],
): { code: string; message: string } | undefined {
	const previous = new Map((current.workItems ?? []).map((item) => [item.id, item]));
	for (const item of nextItems) {
		if (item.horizon !== "mid" || item.state !== "done" || previous.get(item.id)?.state === "done") continue;
		const openActions = nextItems.filter(
			(action) =>
				action.horizon === "short" &&
				action.parentId === item.id &&
				action.state !== "done" &&
				action.state !== "deferred",
		);
		if (openActions.length > 0) {
			return {
				code: "milestone_not_ready",
				message: `Cannot mark milestone "${item.title}" done: ${openActions.length} action(s) are still open (${openActions
					.map((action) => action.title)
					.join("; ")}).`,
			};
		}
		if (!(item.evidence ?? []).some((entry) => entry.trim())) {
			return {
				code: "milestone_evidence_required",
				message: `Cannot mark milestone "${item.title}" done without evidence that its doneWhen checks passed.`,
			};
		}
	}
	return undefined;
}

export function executeUpdateGoalProgress(
	params: UpdateGoalProgressToolInput,
	ctx: GoalToolContext,
	pi: Pick<ExtensionAPI, "appendEntry">,
): GoalToolResult {
	const current = loadGoalState(ctx);
	if (!current) return refusalResult("No active goal exists to update.", "no_goal");
	if (current.status === "complete")
		return refusalResult("Cannot update progress for a complete goal.", "already_complete", current);
	if (current.status !== "active")
		return refusalResult("Only active goals can receive progress updates.", "goal_inactive", current);
	if (
		params.done === undefined &&
		params.current === undefined &&
		params.blocked === undefined &&
		params.summary === undefined &&
		params.checkpoint === undefined
	)
		return refusalResult(
			"Provide at least one progress field: done, current, blocked, summary, or checkpoint.",
			"empty_progress",
			current,
		);

	const checkpoints = current.progress.researchCheckpoints ?? [];
	let researchCheckpoints: GoalProgress["researchCheckpoints"];
	if (params.checkpoint) {
		const { kind } = params.checkpoint;
		const evidence = params.checkpoint.evidence.trim().replace(/^(?:\.\/)+/u, "");
		const decision = params.checkpoint.decision.trim();
		if (!["gate_decision", "replication", "resource_frontier"].includes(kind) || !evidence || evidence.length > 300 || /[\r\n]/u.test(evidence) || !decision || decision.length > 500)
			return refusalResult("Provide a stable evidence reference and a concrete decision.", "invalid_checkpoint", current);
		const feedback = normalizeResearchFeedback(params.checkpoint.feedback);
		if (params.checkpoint.feedback !== undefined && !feedback) return refusalResult("Invalid route feedback; reinforcement requires the preset success gate, an independent check and a complementary challenge.", "invalid_feedback", current);
		if (!checkpoints.some(checkpoint => checkpoint.evidence === evidence)) {
			if (checkpoints.length >= 128) return refusalResult("This goal has reached its recorded checkpoint limit; use the work graph for further progress.", "checkpoint_limit", current);
			researchCheckpoints = [...checkpoints, { kind, evidence, decision, ...(feedback ? { feedback } : {}) }];
		} else if (params.done === undefined && params.current === undefined && params.blocked === undefined && params.summary === undefined) {
			return { content: [{ type: "text", text: "Research checkpoint already recorded; no new progress." }], details: { goal: current, progress: current.progress } };
		}
	}
	const progress: Partial<GoalProgress> = {
		researchCheckpoints,
		done: params.done,
		current: params.current,
		blocked: params.blocked,
		lastSummary: params.summary,
	};
	const next = saveGoalState(
		pi,
		{
			action: "progress",
			goalId: current.goalId,
			now: Date.now(),
			progress,
			reason: "Updated by update_goal_progress.",
		},
		current,
	);
	applyGoalUi(ctx, next);
	return {
		content: [{ type: "text", text: "Goal progress updated" }],
		details: { goal: next, progress: next?.progress },
	};
}

export function executeUpdateGoal(
	params: UpdateGoalToolInput,
	ctx: GoalToolContext,
	pi: Pick<ExtensionAPI, "appendEntry">,
): GoalToolResult {
	const current = loadGoalState(ctx);
	if (!current) return refusalResult("No active goal exists to update.", "no_goal");
	if (current.status !== "active")
		return refusalResult("Only active goals can be edited; resume the goal first.", "goal_inactive", current);
	const reason = params.reason.trim();
	if (!reason) return refusalResult("update_goal requires a reason.", "empty_reason", current);

	const objective = params.objective === undefined ? undefined : validateObjective(params.objective);
	const acceptanceCriteria =
		params.acceptance_criteria === undefined ? undefined : normalizeStringList(params.acceptance_criteria);
	if (acceptanceCriteria && acceptanceCriteria.length === 0)
		return refusalResult(
			"acceptance_criteria must be a non-empty list; omit it to keep the current criteria.",
			"empty_acceptance_criteria",
			current,
		);
	const constraints = params.constraints === undefined ? undefined : normalizeStringList(params.constraints);
	const sourceDocs =
		params.source_paths === undefined ? undefined : sourceDocsFromPaths(normalizeStringList(params.source_paths));

	if (
		objective === undefined &&
		acceptanceCriteria === undefined &&
		constraints === undefined &&
		sourceDocs === undefined
	)
		return refusalResult(
			"Provide at least one field to change: objective, acceptance_criteria, constraints, or source_paths.",
			"empty_update",
			current,
		);

	const next = saveGoalState(
		pi,
		{
			action: "edit",
			goalId: current.goalId,
			now: Date.now(),
			...(objective !== undefined ? { objective } : {}),
			...(acceptanceCriteria !== undefined ? { acceptanceCriteria } : {}),
			...(constraints !== undefined ? { constraints } : {}),
			...(sourceDocs !== undefined ? { sourceDocs } : {}),
			reason: `Updated by update_goal: ${reason}`,
		},
		current,
	);
	applyGoalUi(ctx, next);
	return {
		content: [{ type: "text", text: `Goal updated: ${reason}` }],
		details: { goal: next, reason },
	};
}

export function formatGoalToolCall(toolName: string, body?: string, theme?: GoalTheme): string {
	const title = styleTheme(theme, "toolTitle", goalToolTitle(toolName), { bold: true });
	const normalizedBody = body?.trim();
	return normalizedBody ? `${title}\n${styleTheme(theme, "muted", normalizedBody)}` : title;
}

export function formatProposeGoalDraftToolCall(input: ProposeGoalDraftToolInput, theme?: GoalTheme): string {
	const lines = [`Objective: ${input.objective}`];
	if (input.milestones?.length) {
		const actionCount = input.milestones.reduce((total, milestone) => total + (milestone.actions?.length ?? 0), 0);
		lines.push(`Plan: ${input.milestones.length} milestones · ${actionCount} actions`);
	}
	const criteria = normalizeStringList(input.acceptanceCriteria);
	if (criteria.length > 0) {
		lines.push("Acceptance criteria:", ...criteria.map((item) => `- ${item}`));
	}
	return formatGoalToolCall("propose_goal_draft", lines.join("\n"), theme);
}

export function formatUpdateGoalProgressToolCall(
	input?: Partial<UpdateGoalProgressToolInput>,
	theme?: GoalTheme,
): string {
	return formatGoalToolCall("update_goal_progress", formatGoalProgressCallBody(input), theme);
}

export function formatGoalToolResult(
	result: GoalToolResult & { isError?: boolean },
	theme?: GoalTheme,
): string {
	const text = result.content.find((block) => block.type === "text")?.text ?? "";
	if (result.isError) return styleTheme(theme, "error", `Error: ${text}`);
	const token = isSuccessfulGoalToolText(text) ? "success" : "toolOutput";
	return styleTheme(theme, token, text);
}

export function formatCompleteGoalToolResult(
	result: GoalToolResult & { isError?: boolean },
	theme?: GoalTheme,
): string {
	return result.isError ? formatGoalToolResult(result, theme) : "";
}

function refusalResult(message: string, code: string, goal?: GoalState): GoalToolResult {
	return {
		content: [{ type: "text", text: message }],
		details: { status: "refused", reason: code, goal },
	};
}

function goalToolError(message: string, code: string): Error {
	return Object.assign(new Error(message), { code });
}

function isSuccessfulGoalToolText(text: string): boolean {
	return /^(Created goal:|Saved goal draft|Goal updated:|Goal progress updated|Goal work graph updated|Goal complete\.|Goal paused\.)/.test(
		text,
	);
}

function styleTheme(
	theme: GoalTheme | undefined,
	token: "toolTitle" | "toolOutput" | "success" | "error" | "muted",
	text: string,
	options: { bold?: boolean } = {},
): string {
	const styledText = options.bold ? (theme?.bold?.(text) ?? text) : text;
	return theme?.fg?.(token, styledText) ?? styledText;
}

function goalToolTitle(toolName: string): string {
	switch (toolName) {
		case "get_goal":
			return "Get goal";
		case "create_goal":
			return "Create goal";
		case "propose_goal_draft":
			return "Propose goal draft";
		case "complete_goal":
			return "✓ Complete goal";
		case "pause_goal":
			return "Pause goal";
		case "update_goal":
			return "Update goal";
		case "update_goal_graph":
			return "Update goal work graph";
		case "update_goal_progress":
			return "Update goal progress";
		default:
			return toolName;
	}
}

function formatGoalProgressCallBody(input?: Partial<UpdateGoalProgressToolInput>): string | undefined {
	const summary = input?.summary?.trim();
	if (summary) return summary;
	const current = input?.current?.trim();
	if (current) return current;
	const done = normalizeStringList(input?.done);
	if (done.length > 0) return `Done: ${done.join("; ")}`;
	const blocked = normalizeStringList(input?.blocked);
	if (blocked.length > 0) return `Blocked: ${blocked.join("; ")}`;
	return undefined;
}

function normalizeGoalDraftParams(
	params: ProposeGoalDraftToolInput,
):
	| { ok: true; proposal: GoalDraftProposal; sourcePaths?: string[]; draftId?: string; commandId?: string }
	| { ok: false; code: string; message: string } {
	const objective = safeValidateObjective(params.objective);
	if (!objective)
		return { ok: false, code: "invalid_objective", message: "Goal draft objective is required." };
	const acceptanceCriteria = normalizeStringList(params.acceptanceCriteria);
	if (acceptanceCriteria.length === 0) {
		return {
			ok: false,
			code: "invalid_acceptance_criteria",
			message: "Goal draft must include at least one non-empty acceptance criterion.",
		};
	}
	const constraints = normalizeStringList(params.constraints);
	const optimization = normalizeGoalOptimizationDraft(params.optimization);
	if (optimization) {
		const optimizationErrors = validateGoalOptimizationDraft(optimization);
		if (optimizationErrors.length > 0) {
			return { ok: false, code: "invalid_optimization", message: optimizationErrors.join(" ") };
		}
	}
	const plan = normalizeGoalPlanDraft({ milestones: params.milestones });
	const finalObjective = optimization ? optimizationObjective(optimization) : objective;
	const finalCriteria = optimization
		? normalizeStringList([optimizationCriterion(optimization), ...acceptanceCriteria])
		: acceptanceCriteria;
	const finalConstraints = normalizeStringList([
		...(optimization ? [OPTIMIZATION_METHOD_FREEDOM] : []),
		...constraints,
	]);
	return {
		ok: true,
		proposal: {
			objective: finalObjective,
			acceptanceCriteria: finalCriteria,
			...(finalConstraints.length > 0 ? { constraints: finalConstraints } : {}),
			...(plan ? { plan } : {}),
			...(optimization ? { optimization } : {}),
		},
		sourcePaths: normalizeStringList(params.sourcePaths),
		draftId: params.draftId?.trim() || undefined,
		commandId: params.commandId?.trim() || undefined,
	};
}

function normalizeReviewedProposal(
	proposal: GoalDraftProposal,
): { ok: true; proposal: GoalDraftProposal } | { ok: false; code: string; message: string } {
	const objective = safeValidateObjective(proposal.objective);
	if (!objective)
		return { ok: false, code: "invalid_objective", message: "Edited goal objective is required." };
	const acceptanceCriteria = normalizeStringList(proposal.acceptanceCriteria);
	if (acceptanceCriteria.length === 0) {
		return {
			ok: false,
			code: "invalid_acceptance_criteria",
			message: "Edited goal draft must include at least one acceptance criterion.",
		};
	}
	const constraints = normalizeStringList(proposal.constraints);
	return {
		ok: true,
		proposal: {
			objective,
			acceptanceCriteria,
			...(constraints.length > 0 ? { constraints } : {}),
			...(proposal.plan ? { plan: proposal.plan } : {}),
		},
	};
}

function normalizeStringList(values?: string[]): string[] {
	return [...new Set((values ?? []).map((item) => item.trim()).filter((item) => item.length > 0))];
}

function safeValidateObjective(value: string): string | null {
	try {
		return validateObjective(value);
	} catch {
		return null;
	}
}

function sourceDocsFromPaths(paths?: string[]): GoalSourceDoc[] {
	return (paths ?? []).map((path) => ({
		path,
		kind: "manual",
		brief: "Source path explicitly provided when creating the goal.",
		extractedAt: Date.now(),
	}));
}
