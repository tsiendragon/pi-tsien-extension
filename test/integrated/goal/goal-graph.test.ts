import { describe, expect, it } from "vitest";
import {
	allPathsBlocked,
	chooseExplorableBlocker,
	currentMilestone,
	goalWorkOverview,
	readyWorkItems,
	renderBlockerReport,
} from "pi-tsien-goal/src/goal-graph.ts";

import type { GoalState } from "pi-tsien-goal/src/types.ts";

function goal(overrides: Partial<GoalState> = {}): GoalState {
	return {
		version: 2,
		goalId: "goal-1",
		objective: "Ship the graph scheduler",
		status: "active",
		sourceDocs: [],
		constraints: [],
		acceptanceCriteria: ["A", "B", "C"],
		progress: { done: [], blocked: [], lastSummary: "" },
		workItems: [
			{
				id: "a",
				goalId: "goal-1",
				title: "A",
				state: "done",
				dependsOn: [],
				acceptanceCriteriaIds: ["1"],
				updatedAt: 1,
			},
			{
				id: "b",
				goalId: "goal-1",
				title: "B",
				state: "todo",
				dependsOn: ["a"],
				acceptanceCriteriaIds: ["2"],
				updatedAt: 1,
			},
			{
				id: "c",
				goalId: "goal-1",
				title: "C",
				state: "todo",
				dependsOn: [],
				acceptanceCriteriaIds: ["3"],
				updatedAt: 1,
			},
		],
		blockers: [],
		blockerAttempts: [],
		reports: [],
		createdAt: 1,
		updatedAt: 1,
		owner: "user",
		...overrides,
	};
}

describe("goal work graph", () => {
	it("keeps independent ready work available when another item has a hard blocker", () => {
		const state = goal({
			blockers: [
				{
					id: "block-b",
					goalId: "goal-1",
					title: "Need decision",
					reason: "Choose API",
					kind: "user_decision",
					disposition: "needs_user",
					state: "open",
					workItemIds: ["b"],
					owner: "user",
					createdAt: 2,
					updatedAt: 2,
				},
			],
		});
		expect(readyWorkItems(state).map((item) => item.id)).toEqual(["c"]);
		expect(goalWorkOverview(state)).toMatchObject({ done: 1, total: 3, openBlockers: 1 });
	});

	it("recognizes all paths blocked and renders auditable reports", () => {
		const state = goal({
			workItems: [
				{
					id: "a",
					goalId: "goal-1",
					title: "A",
					state: "todo",
					dependsOn: [],
					acceptanceCriteriaIds: ["1"],
					updatedAt: 1,
				},
			],
			blockers: [
				{
					id: "block-a",
					goalId: "goal-1",
					title: "Credential required",
					reason: "No token",
					kind: "permission_or_credential",
					disposition: "needs_user",
					state: "open",
					workItemIds: ["a"],
					evidence: "403",
					proposedResolution: "Provide a scoped token",
					owner: "user",
					createdAt: 2,
					updatedAt: 2,
				},
			],
			blockerAttempts: [
				{
					id: "attempt-1",
					goalId: "goal-1",
					blockerId: "block-a",
					hypothesis: "Existing auth may work",
					action: "Read config",
					result: "No credential available",
					evidence: "config absent",
					createdAt: 3,
				},
			],
		});
		expect(allPathsBlocked(state)).toBe(true);
		const report = renderBlockerReport(state, "all_paths_blocked", 4);
		expect(report.markdown).toContain("Credential required");
		expect(report.markdown).toContain("Existing auth may work");
		expect(report.checksum).toHaveLength(64);
	});

	it("runs only the current milestone's actions and unlocks the next milestone", () => {
		const state = goal({
			acceptanceCriteria: ["Outcome verified"],
			workItems: [
				{
					id: "m1",
					goalId: "goal-1",
					title: "Evidence closed",
					horizon: "mid",
					doneWhen: ["evidence matrix has no gaps"],
					state: "todo",
					dependsOn: [],
					acceptanceCriteriaIds: [],
					updatedAt: 1,
				},
				{
					id: "m2",
					goalId: "goal-1",
					title: "Independent review",
					horizon: "mid",
					doneWhen: ["two reviews have no P0/P1"],
					state: "todo",
					dependsOn: ["m1"],
					acceptanceCriteriaIds: [],
					updatedAt: 1,
				},
				{
					id: "s1",
					goalId: "goal-1",
					title: "Build evidence matrix",
					horizon: "short",
					parentId: "m1",
					state: "todo",
					dependsOn: [],
					acceptanceCriteriaIds: [],
					updatedAt: 1,
				},
				{
					id: "s2",
					goalId: "goal-1",
					title: "Commission two reviews",
					horizon: "short",
					parentId: "m2",
					state: "todo",
					dependsOn: [],
					acceptanceCriteriaIds: [],
					updatedAt: 1,
				},
			],
		});
		expect(currentMilestone(state)?.id).toBe("m1");
		expect(readyWorkItems(state).map((item) => item.id)).toEqual(["s1"]);
		expect(goalWorkOverview(state)).toMatchObject({
			done: 0,
			total: 2,
			milestonesDone: 0,
			milestonesTotal: 2,
		});

		const advanced = goal({
			...state,
			workItems: state.workItems?.map((item) =>
				item.id === "m1" || item.id === "s1" ? { ...item, state: "done" as const } : item,
			),
		});
		expect(currentMilestone(advanced)?.id).toBe("m2");
		expect(readyWorkItems(advanced).map((item) => item.id)).toEqual(["s2"]);
		expect(goalWorkOverview(advanced)).toMatchObject({ done: 1, total: 2, milestonesDone: 1 });
	});

	it("treats a current milestone without actions as unplanned, not blocked", () => {
		const state = goal({
			workItems: [
				{
					id: "m1",
					goalId: "goal-1",
					title: "Evidence closed",
					horizon: "mid",
					doneWhen: ["evidence matrix has no gaps"],
					state: "todo",
					dependsOn: [],
					acceptanceCriteriaIds: [],
					updatedAt: 1,
				},
				{
					id: "m2",
					goalId: "goal-1",
					title: "Independent review",
					horizon: "mid",
					doneWhen: ["two reviews have no P0/P1"],
					state: "todo",
					dependsOn: ["m1"],
					acceptanceCriteriaIds: [],
					updatedAt: 1,
				},
			],
		});
		expect(readyWorkItems(state)).toEqual([]);
		expect(allPathsBlocked(state)).toBe(false);
	});

	it("permits only agent-eligible blockers as exploration candidates", () => {
		const state = goal({
			blockers: [
				{
					id: "try",
					goalId: "goal-1",
					title: "Investigate",
					reason: "Unknown format",
					kind: "technical",
					disposition: "agent_can_try",
					state: "open",
					workItemIds: ["b"],
					owner: "agent",
					createdAt: 1,
					updatedAt: 1,
				},
			],
		});
		expect(chooseExplorableBlocker(state)?.id).toBe("try");
	});
});
