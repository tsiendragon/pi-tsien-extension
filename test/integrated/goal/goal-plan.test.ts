import { describe, expect, it } from "vitest";
import {
	normalizeGoalPlanDraft,
	planFromWorkItems,
	validateGoalPlanDraft,
	workItemsFromPlan,
} from "pi-tsien-goal/src/goal-plan.ts";

const plan = {
	milestones: [
		{
			title: "Evidence closed",
			doneWhen: ["evidence matrix has no gaps"],
			actions: ["Build the evidence matrix"],
		},
		{ title: "Independent review", doneWhen: ["two reviews have no P0/P1"] },
	],
};

describe("goal plan", () => {
	it("normalizes a draft plan and rejects malformed shapes", () => {
		expect(normalizeGoalPlanDraft(plan)).toEqual(plan);
		expect(normalizeGoalPlanDraft({ milestones: [] })).toBeUndefined();
		expect(normalizeGoalPlanDraft({ milestones: "bad" })).toBeUndefined();
		expect(
			normalizeGoalPlanDraft({
				milestones: [
					{ title: " M1 ", doneWhen: [" check ", "check"], actions: [" S1 ", "S1"] },
					{ title: "M2", doneWhen: ["check"] },
				],
			}),
		).toEqual({
			milestones: [
				{ title: "M1", doneWhen: ["check"], actions: ["S1"] },
				{ title: "M2", doneWhen: ["check"] },
			],
		});
	});

	it("validates milestone count, doneWhen and the first action", () => {
		expect(validateGoalPlanDraft(plan)).toEqual([]);
		expect(validateGoalPlanDraft(undefined)).toHaveLength(1);
		expect(validateGoalPlanDraft({ milestones: [] })).toEqual(
			expect.arrayContaining(["The plan needs at least 2 milestones."]),
		);
		expect(
			validateGoalPlanDraft({
				milestones: [
					{ title: "M1", doneWhen: [] },
					{ title: "M2", doneWhen: ["check"], actions: ["S1"] },
				],
			}),
		).toEqual(
			expect.arrayContaining([
				"Milestone 1 needs at least one doneWhen check.",
				"The first milestone needs at least one action that can run now.",
			]),
		);
	});

	it("converts a plan to ordered milestones and parented actions", () => {
		const items = workItemsFromPlan(plan, "g1", 10);
		expect(items).toEqual([
			expect.objectContaining({
				id: "m1",
				horizon: "mid",
				state: "todo",
				dependsOn: [],
				doneWhen: ["evidence matrix has no gaps"],
			}),
			expect.objectContaining({
				id: "m2",
				horizon: "mid",
				dependsOn: ["m1"],
				doneWhen: ["two reviews have no P0/P1"],
			}),
			expect.objectContaining({
				id: "s1",
				horizon: "short",
				parentId: "m1",
				title: "Build the evidence matrix",
			}),
		]);
		expect(planFromWorkItems(items)).toEqual(plan);
	});
});
