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
import { loadGoalState, saveGoalState, validateObjective } from "./state.ts";
import { applyGoalUi, renderGoalStatus } from "./ui.ts";

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
			description: "Concrete, editable completion checks directly implied by the user's request.",
			minItems: 1,
		}),
		sourcePaths: Type.Optional(
			Type.Array(Type.String(), {
				description: "Optional source paths explicitly associated with this goal draft.",
			}),
		),
		startImmediately: Type.Optional(
			Type.Boolean({ description: "True when the draft should offer Start as the intended action." }),
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
	},
	{ additionalProperties: false, minProperties: 1 },
);
const workItemSchema = Type.Object(
	{
		id: Type.String(),
		goalId: Type.String(),
		title: Type.String(),
		description: Type.Optional(Type.String()),
		state: Type.Union([
			Type.Literal("todo"),
			Type.Literal("in_progress"),
			Type.Literal("done"),
			Type.Literal("blocked"),
			Type.Literal("deferred"),
		]),
		dependsOn: Type.Array(Type.String()),
		acceptanceCriteriaIds: Type.Array(Type.String()),
		updatedAt: Type.Number(),
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
			Type.Array(workItemSchema, { description: "Full replacement snapshot of goal work items." }),
		),
		blockers: Type.Optional(
			Type.Array(blockerSchema, { description: "Full replacement snapshot of structured blockers." }),
		),
		attempt: Type.Optional(blockerAttemptSchema),
	},
	{ additionalProperties: false },
);

export const proposeGoalDraftPromptSnippet =
	"Use propose_goal_draft to draft a reviewable /goal proposal exactly once; do not persist it directly.";

export const proposeGoalDraftPromptGuidelines = [
	"Preserve the user's meaning and boundaries; do not invent unrelated scope or silently drop constraints.",
	"Provide objective, editable acceptanceCriteria with concrete completion checks implied by the request; description is optional non-persisted context.",
	"Do not leave acceptanceCriteria empty; if details are uncertain, state the uncertainty rather than creating unrelated checks.",
	"Call it once instead of replying with the draft in prose. Use create_goal only for an already-authorized new goal.",
] as const;

export type CreateGoalToolInput = Static<typeof createGoalParams>;
export type ProposeGoalDraftToolInput = Static<typeof proposeGoalDraftParams>;
export type CompleteGoalToolInput = Static<typeof completeGoalParams>;
export type PauseGoalToolInput = Static<typeof pauseGoalParams>;
export type UpdateGoalProgressToolInput = Static<typeof updateGoalProgressParams>;
export type UpdateGoalGraphToolInput = Static<typeof updateGoalGraphParams>;

interface GoalToolContext extends Partial<GoalWorkflowContext> {
	sessionManager: { getBranch(): Array<{ type: string; customType?: string; data?: unknown }> };
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
			"Open a structured /goal draft for user review. Saves only after the user chooses Start in the review UI. " +
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
		name: "complete_goal",
		label: "Complete Goal",
		description:
			"Mark the active goal complete only when the objective is achieved and no required work remains. It cannot pause, resume, or rewrite the objective.",
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
			"Pause the active goal only when a concrete problem prevents safe progress. Include the reason so the user can resolve it before resuming.",
		promptSnippet: "Use pause_goal with a concrete reason when a problem prevents safe progress on the active goal.",
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
			"Update work items and structured blockers for the active goal; attempts are append-only audit records. Only credentials, permissions, irreversible actions, product decisions, and policy limits need user/external waiting; record each agent-can-try attempt with evidence.",
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
		promptSnippet: "Use update_goal_progress to update /goal progress fields only.",
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

export async function executeProposeGoalDraft(
	params: ProposeGoalDraftToolInput,
	ctx: GoalToolContext,
	pi: Pick<ExtensionAPI, "appendEntry"> & Partial<GoalStartAPI>,
): Promise<GoalToolResult> {
	const normalized = normalizeGoalDraftParams(params);
	if (!normalized.ok) throw goalToolError(normalized.message, normalized.code);

	if (!ctx.hasUI || !ctx.ui?.select || !ctx.ui.editor) {
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
	const action = await confirmGoalReplacement(
		ctx as GoalWorkflowContext,
		current,
		false,
		normalized.proposal.objective,
	);
	if (!action) {
		return {
			content: [{ type: "text", text: "Goal draft cancelled. No goal was saved." }],
			details: { status: "cancelled", reason: "replacement_not_confirmed", goal: current },
			terminate: true,
		};
	}

	const review = await reviewGoalProposal(ctx as GoalWorkflowContext, normalized.proposal);
	if (!review) {
		return {
			content: [{ type: "text", text: "Goal draft cancelled. No goal was saved." }],
			details: { status: "cancelled", reason: "user_cancelled", goal: current },
			terminate: true,
		};
	}

	const reviewed = normalizeReviewedProposal(review.proposal);
	if (!reviewed.ok) throw goalToolError(reviewed.message, reviewed.code);

	const next = await saveReviewedGoalAndOfferStart(
		pi as ExtensionAPI & Partial<GoalStartAPI>,
		ctx as GoalWorkflowContext,
		{
			current,
			proposal: reviewed.proposal,
			action,
			start: true,
			sourceDocs: sourceDocsFromPaths(normalized.sourcePaths),
			successMessage:
				action === "replace" ? "Goal draft accepted and replaced." : "Goal draft accepted and saved.",
			staleMessage: "Goal changed before saving. Re-run /goal draft for the current goal.",
		},
	);
	if (!next) {
		throw goalToolError("Goal changed before saving. No goal was saved.", "stale_goal");
	}

	return {
		content: [{ type: "text", text: `Saved goal draft and queued Start: ${next.objective}` }],
		details: {
			status: "saved",
			action,
			started: true,
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
		params.workItems?.some((item) => item.goalId !== current.goalId) ||
		params.blockers?.some((blocker) => blocker.goalId !== current.goalId) ||
		(params.attempt?.goalId !== undefined && params.attempt.goalId !== current.goalId)
	) {
		return refusalResult("Work graph records must belong to the active goal.", "stale_goal", current);
	}
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
	const next = saveGoalState(
		pi,
		{
			action: "graph",
			goalId: current.goalId,
			now: Date.now(),
			workItems: params.workItems as WorkItem[] | undefined,
			blockers: params.blockers as GoalBlocker[] | undefined,
			attempt: params.attempt as GoalBlockerAttempt | undefined,
			reason: "Updated by update_goal_graph.",
		},
		current,
	);
	applyGoalUi(ctx, next);
	return { content: [{ type: "text", text: "Goal work graph updated" }], details: { goal: next } };
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
		params.summary === undefined
	)
		return refusalResult(
			"Provide at least one progress field: done, current, blocked, or summary.",
			"empty_progress",
			current,
		);

	const progress: Partial<GoalProgress> = {
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

export function formatGoalToolCall(toolName: string, body?: string, theme?: GoalTheme): string {
	const title = styleTheme(theme, "toolTitle", goalToolTitle(toolName), { bold: true });
	const normalizedBody = body?.trim();
	return normalizedBody ? `${title}\n${styleTheme(theme, "muted", normalizedBody)}` : title;
}

export function formatProposeGoalDraftToolCall(input: ProposeGoalDraftToolInput, theme?: GoalTheme): string {
	const lines = [`Objective: ${input.objective}`];
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
	return /^(Created goal:|Saved goal draft|Goal progress updated|Goal work graph updated|Goal complete\.|Goal paused\.)/.test(
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
	return {
		ok: true,
		proposal: { objective, acceptanceCriteria },
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
	return { ok: true, proposal: { objective, acceptanceCriteria } };
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
