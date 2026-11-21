import type { WorkItem } from "./types.ts";

/**
 * Draft-time plan shape.
 *
 * The long-term outcome stays in `objective` + `acceptanceCriteria`. A plan
 * adds 2-4 ordered milestones. Actions live under the milestone they advance,
 * so the model never has to cross-reference a separate index. Later
 * milestones stay locked until the previous one is done.
 */

export interface GoalMilestoneDraft {
	title: string;
	doneWhen: string[];
	/** Short-term actions under this milestone. The first milestone needs 1-3. */
	actions?: string[];
}

export interface GoalPlanDraft {
	milestones: GoalMilestoneDraft[];
}

export function normalizeGoalPlanDraft(value: unknown): GoalPlanDraft | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	const milestones = Array.isArray(record.milestones)
		? record.milestones.flatMap((item) => {
				if (!item || typeof item !== "object" || Array.isArray(item)) return [];
				const milestone = item as Record<string, unknown>;
				if (typeof milestone.title !== "string") return [];
				const doneWhen = Array.isArray(milestone.doneWhen)
					? milestone.doneWhen.filter((entry): entry is string => typeof entry === "string")
					: [];
				const actions = Array.isArray(milestone.actions)
					? milestone.actions.filter((entry): entry is string => typeof entry === "string")
					: [];
				const title = milestone.title.trim();
				const normalizedDoneWhen = unique(doneWhen.map((entry) => entry.trim()).filter(Boolean));
				const normalizedActions = unique(actions.map((entry) => entry.trim()).filter(Boolean));
				return title
					? [{
							title,
							doneWhen: normalizedDoneWhen,
							...(normalizedActions.length > 0 ? { actions: normalizedActions } : {}),
						}]
					: [];
			})
		: [];
	if (milestones.length === 0) return undefined;
	return { milestones };
}

export function validateGoalPlanDraft(plan: GoalPlanDraft | undefined): string[] {
	const errors: string[] = [];
	if (!plan) return ["A plan with 2-4 milestones is required for an unattended goal."];
	if (plan.milestones.length < 2) errors.push("The plan needs at least 2 milestones.");
	if (plan.milestones.length > 4) errors.push("The plan supports at most 4 milestones.");

	plan.milestones.forEach((milestone, index) => {
		if (!milestone.title) errors.push(`Milestone ${index + 1} needs a title.`);
		if (milestone.doneWhen.length === 0) errors.push(`Milestone ${index + 1} needs at least one doneWhen check.`);
		const actions = milestone.actions ?? [];
		if (index === 0 && actions.length === 0) {
			errors.push("The first milestone needs at least one action that can run now.");
		}
		if (actions.length > 3) {
			errors.push(`Milestone ${index + 1} supports at most 3 actions.`);
		}
	});
	return errors;
}

export interface WorkItemPlanOptions {
	/** Prefix for generated IDs, used when appending a replanned plan to preserved history. */
	idPrefix?: string;
	/** Extra dependencies for the first generated milestone, e.g. the last preserved milestone. */
	firstDependsOn?: string[];
}

export function workItemsFromPlan(
	plan: GoalPlanDraft,
	goalId: string,
	now: number,
	options: WorkItemPlanOptions = {},
): WorkItem[] {
	if (plan.milestones.length === 0) return [];
	const prefix = options.idPrefix ?? "";
	const milestones: WorkItem[] = plan.milestones.map((milestone, index) => ({
		id: `${prefix}m${index + 1}`,
		goalId,
		title: milestone.title,
		description: `Milestone ${index + 1}`,
		horizon: "mid",
		doneWhen: [...milestone.doneWhen],
		state: "todo",
		dependsOn:
			index > 0
				? [`${prefix}m${index}`]
				: [...(options.firstDependsOn ?? [])],
		acceptanceCriteriaIds: [],
		updatedAt: now,
	}));
	const actions: WorkItem[] = [];
	plan.milestones.forEach((milestone, index) => {
		for (const title of milestone.actions ?? []) {
			actions.push({
				id: `${prefix}s${actions.length + 1}`,
				goalId,
				title,
				description: `Next action for milestone ${index + 1}`,
				horizon: "short",
				parentId: `${prefix}m${index + 1}`,
				evidence: [],
				state: "todo",
				dependsOn: [],
				acceptanceCriteriaIds: [],
				updatedAt: now,
			});
		}
	});
	return [...milestones, ...actions];
}

/**
 * Replan merge: keep completed/deferred history, replace the open frontier.
 * Flat goals from older sessions are promoted to completed milestones so they
 * stay visible in the hierarchical view. New plan IDs use a fresh `rN-` prefix.
 */
export function mergeReplannedWorkItems(
	currentItems: readonly WorkItem[] | undefined,
	plan: GoalPlanDraft,
	goalId: string,
	now: number,
): WorkItem[] {
	const current = currentItems ?? [];
	const preservedMilestoneIds = new Set(
		current
			.filter((item) => item.horizon === "mid" && (item.state === "done" || item.state === "deferred"))
			.map((item) => item.id),
	);
	const preserved: WorkItem[] = [];
	for (const item of current) {
		if (!item.horizon) {
			if (item.state === "done" || item.state === "deferred") {
				preserved.push({
					...item,
					horizon: "mid",
					doneWhen: item.doneWhen?.length ? [...item.doneWhen] : [item.title],
				});
			}
			continue;
		}
		if (item.horizon === "mid" && (item.state === "done" || item.state === "deferred")) {
			preserved.push(item);
			continue;
		}
		if (item.horizon === "short" && item.parentId && preservedMilestoneIds.has(item.parentId)) {
			preserved.push(item);
		}
	}
	const lastMilestone = [...preserved].reverse().find((item) => item.horizon === "mid");
	const prefix = nextReplanPrefix(current);
	return [
		...preserved,
		...workItemsFromPlan(plan, goalId, now, {
			idPrefix: prefix,
			firstDependsOn: lastMilestone ? [lastMilestone.id] : [],
		}),
	];
}

function nextReplanPrefix(items: readonly WorkItem[]): string {
	const ids = new Set(items.map((item) => item.id));
	for (let index = 1; ; index++) {
		const prefix = `r${index}-`;
		if (![...ids].some((id) => id.startsWith(prefix))) return prefix;
	}
}

export function planFromWorkItems(items: readonly WorkItem[] | undefined): GoalPlanDraft | undefined {
	if (!items || items.length === 0) return undefined;
	const milestones = items.filter((item) => item.horizon === "mid");
	const actions = items.filter((item) => item.horizon === "short");
	if (milestones.length === 0) return undefined;
	const byParent = new Map<string, string[]>();
	for (const action of actions) {
		const parent = milestones.some((milestone) => milestone.id === action.parentId)
			? action.parentId!
			: milestones[0].id;
		const group = byParent.get(parent) ?? [];
		group.push(action.title);
		byParent.set(parent, group);
	}
	return {
		milestones: milestones.map((milestone) => {
			const titles = byParent.get(milestone.id) ?? [];
			return {
				title: milestone.title,
				doneWhen: [...(milestone.doneWhen ?? [])],
				...(titles.length > 0 ? { actions: titles } : {}),
			};
		}),
	};
}

function unique(values: string[]): string[] {
	return [...new Set(values)];
}
