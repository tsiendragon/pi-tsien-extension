import { createHash } from "node:crypto";
import type { GoalBlocker, GoalBlockerAttempt, GoalReport, GoalState, WorkItem } from "./types.ts";

export interface GoalWorkOverview {
	done: number;
	total: number;
	openBlockers: number;
	ready: WorkItem[];
	blocked: WorkItem[];
	/** Present for hierarchical goals; long-term outcome stays on the goal. */
	milestonesDone?: number;
	milestonesTotal?: number;
}

export function initialWorkItems(goalId: string, acceptanceCriteria: string[], now: number): WorkItem[] {
	const criteria = acceptanceCriteria.length > 0 ? acceptanceCriteria : ["Complete the goal objective"];
	return criteria.map((title, index) => ({
		id: `criterion-${index + 1}`,
		goalId,
		title,
		description: `Acceptance criterion ${index + 1}`,
		state: "todo",
		dependsOn: [],
		acceptanceCriteriaIds: [String(index + 1)],
		updatedAt: now,
	}));
}

export function getWorkItems(goal: GoalState): WorkItem[] {
	return (
		goal.workItems?.map((item) => ({
			...item,
			...(item.doneWhen ? { doneWhen: [...item.doneWhen] } : {}),
			...(item.evidence ? { evidence: [...item.evidence] } : {}),
			dependsOn: [...item.dependsOn],
			acceptanceCriteriaIds: [...item.acceptanceCriteriaIds],
		})) ?? initialWorkItems(goal.goalId, goal.acceptanceCriteria, goal.createdAt)
	);
}

export function isHierarchicalGoal(goal: GoalState): boolean {
	return (goal.workItems ?? []).some((item) => item.horizon !== undefined);
}

export function milestonesOf(goal: GoalState): WorkItem[] {
	return getWorkItems(goal).filter((item) => item.horizon === "mid");
}

export function actionsOf(goal: GoalState): WorkItem[] {
	return getWorkItems(goal).filter((item) => item.horizon === "short");
}

/**
 * The single milestone whose actions may run now: first unfinished milestone
 * whose dependencies are done. Later milestones stay locked even if their own
 * dependencies happen to be satisfied early.
 */
export function currentMilestone(goal: GoalState): WorkItem | undefined {
	const milestones = milestonesOf(goal);
	if (milestones.length === 0) return undefined;
	const byId = new Map(milestones.map((item) => [item.id, item]));
	return milestones.find(
		(item) =>
			item.state !== "done" &&
			item.state !== "deferred" &&
			item.dependsOn.every((dependency) => {
				const parent = byId.get(dependency);
				return parent?.state === "done" || parent?.state === "deferred";
			}),
	);
}

export function getOpenBlockers(goal: GoalState): GoalBlocker[] {
	return (goal.blockers ?? [])
		.filter((blocker) => blocker.state === "open")
		.map((blocker) => ({ ...blocker, workItemIds: [...blocker.workItemIds] }));
}

export function isHardBlocker(blocker: GoalBlocker): boolean {
	return blocker.disposition !== "agent_can_try";
}

export function readyWorkItems(goal: GoalState): WorkItem[] {
	const items = getWorkItems(goal);
	const byId = new Map(items.map((item) => [item.id, item]));
	const hardBlocked = new Set(
		getOpenBlockers(goal)
			.filter(isHardBlocker)
			.flatMap((blocker) => blocker.workItemIds),
	);
	if (isHierarchicalGoal(goal)) {
		const current = currentMilestone(goal);
		if (!current) return [];
		return items.filter(
			(item) =>
				item.horizon === "short" &&
				item.parentId === current.id &&
				(item.state === "todo" || item.state === "in_progress") &&
				item.dependsOn.every((dependency) => byId.get(dependency)?.state === "done") &&
				!hardBlocked.has(item.id),
		);
	}
	return items.filter(
		(item) =>
			(item.state === "todo" || item.state === "in_progress") &&
			item.dependsOn.every((dependency) => byId.get(dependency)?.state === "done") &&
			!hardBlocked.has(item.id),
	);
}

export function blockedWorkItems(goal: GoalState): WorkItem[] {
	const items = getWorkItems(goal);
	const ready = new Set(readyWorkItems(goal).map((item) => item.id));
	return items.filter((item) => item.state !== "done" && item.state !== "deferred" && !ready.has(item.id));
}

export function goalWorkOverview(goal: GoalState): GoalWorkOverview {
	const items = getWorkItems(goal);
	const milestones = items.filter((item) => item.horizon === "mid");
	const actions = items.filter((item) => item.horizon === "short");
	const countable = actions.length > 0 ? actions : items;
	return {
		done: countable.filter((item) => item.state === "done").length,
		total: countable.length,
		openBlockers: getOpenBlockers(goal).length,
		ready: readyWorkItems(goal),
		blocked: blockedWorkItems(goal),
		...(milestones.length > 0
			? {
					milestonesDone: milestones.filter((item) => item.state === "done").length,
					milestonesTotal: milestones.length,
				}
			: {}),
	};
}

export function allPathsBlocked(goal: GoalState): boolean {
	const unfinished = getWorkItems(goal).filter((item) => item.state !== "done" && item.state !== "deferred");
	if (!unfinished.length || readyWorkItems(goal).length > 0) return false;

	// Propagate only from real hard blockers on unfinished work. A finished
	// prerequisite cannot block a milestone, even when it has no ready actions.
	const unfinishedIds = new Set(unfinished.map((item) => item.id));
	const blocked = new Set(
		getOpenBlockers(goal)
			.filter(isHardBlocker)
			.flatMap((blocker) => blocker.workItemIds)
			.filter((id) => unfinishedIds.has(id)),
	);
	const dependents = new Map<string, string[]>();
	for (const item of unfinished) {
		for (const dependency of item.dependsOn) {
			const list = dependents.get(dependency);
			if (list) list.push(item.id);
			else dependents.set(dependency, [item.id]);
		}
	}
	const pending = [...blocked];
	for (let i = 0; i < pending.length; i++) {
		// All prerequisites are required, so any blocked prerequisite suffices.
		for (const id of dependents.get(pending[i]) ?? []) {
			if (blocked.has(id)) continue;
			blocked.add(id);
			pending.push(id);
		}
	}
	return blocked.size === unfinished.length;
}

export function chooseExplorableBlocker(goal: GoalState): GoalBlocker | undefined {
	return getOpenBlockers(goal).find((blocker) => blocker.disposition === "agent_can_try");
}

export function renderBlockerReport(goal: GoalState, trigger: string, now: number): GoalReport {
	const overview = goalWorkOverview(goal);
	const blockers = getOpenBlockers(goal);
	const attempts = goal.blockerAttempts ?? [];
	const lines = [
		"# Goal blocker report",
		"",
		`- Goal: ${goal.objective}`,
		`- Goal ID: ${goal.goalId}`,
		`- Trigger: ${trigger}`,
		`- Completion: ${overview.done}/${overview.total}`,
		"",
		"## Blocked work",
		...formatBlockedWork(overview.blocked, getWorkItems(goal)),
		"",
		"## Open blockers",
		...(blockers.length === 0
			? ["- none recorded"]
			: blockers.flatMap((blocker) => formatBlocker(blocker, attempts))),
		"",
		"## Recommended next steps",
		...recommendedSteps(blockers),
	];
	const markdown = lines.join("\n");
	return {
		id: crypto.randomUUID(),
		goalId: goal.goalId,
		revision: (goal.reports?.length ?? 0) + 1,
		trigger,
		markdown,
		checksum: createHash("sha256").update(markdown).digest("hex"),
		createdAt: now,
	};
}

export function renderBlockersMarkdown(goal: GoalState): string {
	const latest = goal.reports?.at(-1);
	return latest?.markdown ?? renderBlockerReport(goal, "status", Date.now()).markdown;
}

function formatBlockedWork(items: WorkItem[], allItems: WorkItem[]): string[] {
	if (items.length === 0) return ["- none"];
	const byId = new Map(allItems.map((item) => [item.id, item]));
	return items.map((item) => {
		const dependencies = item.dependsOn.map((id) => byId.get(id)?.title ?? id);
		return `- ${item.title}${dependencies.length > 0 ? ` (waiting for: ${dependencies.join(", ")})` : ""}`;
	});
}

function formatBlocker(blocker: GoalBlocker, attempts: GoalBlockerAttempt[]): string[] {
	const relatedAttempts = attempts.filter((attempt) => attempt.blockerId === blocker.id);
	return [
		`### ${blocker.title}`,
		`- Type: ${blocker.kind}; disposition: ${blocker.disposition}; owner: ${blocker.owner}`,
		`- Impacted work: ${blocker.workItemIds.length > 0 ? blocker.workItemIds.join(", ") : "all/unspecified"}`,
		`- Reason: ${blocker.reason}`,
		...(blocker.evidence ? [`- Evidence: ${blocker.evidence}`] : []),
		...(blocker.proposedResolution ? [`- Proposed resolution: ${blocker.proposedResolution}`] : []),
		...(relatedAttempts.length > 0
			? [
					"- Attempts:",
					...relatedAttempts.map(
						(attempt) =>
							`  - ${attempt.hypothesis}: ${attempt.action} → ${attempt.result}${attempt.evidence ? ` (${attempt.evidence})` : ""}`,
					),
				]
			: ["- Attempts: none recorded"]),
	];
}

function recommendedSteps(blockers: GoalBlocker[]): string[] {
	if (blockers.length === 0) return ["- Recompute ready work items and continue the next eligible item."];
	return blockers.map((blocker) => {
		if (blocker.disposition === "needs_user")
			return `- User: ${blocker.proposedResolution ?? `resolve ${blocker.title}`}`;
		if (blocker.disposition === "external_wait")
			return `- External dependency: ${blocker.proposedResolution ?? `wait for ${blocker.title}`}`;
		return `- Agent may try within the authorized scope: ${blocker.proposedResolution ?? blocker.title}`;
	});
}
