import { describe, expect, it } from "vitest";
import {
	GOAL_CONTEXT_CUSTOM_TYPE,
	renderCompactGoalSummary,
	renderGoalAgentDraftingPrompt,
	renderGoalContext,
	GOAL_EXECUTION_SYSTEM_PROMPT,
	renderGoalStartPrompt,
	renderContinuationPrompt,
} from "pi-tsien-goal/src/prompts.ts";
import { createGoalContextMessage, filterGoalContextMessages } from "pi-tsien-goal/src/runtime.ts";

import type { GoalState } from "pi-tsien-goal/src/types.ts";

function goal(overrides: Partial<GoalState> = {}): GoalState {
	return {
		version: 1,
		goalId: "goal-1",
		objective: "Ship <runtime> & preserve context",
		status: "active",
		sourceDocs: [
			{
				path: "docs/prd.md",
				kind: "prd",
				brief: "Use <brief> & criteria safely",
				extractedAt: 1,
			},
		],
		constraints: [],
		acceptanceCriteria: ["Escape <xml> & do not rewrite scope"],
		progress: {
			done: ["state"],
			current: "runtime hooks",
			blocked: ["none <really>"],
			lastSummary: "Implementing & testing hidden context",
		},
		createdAt: 1,
		updatedAt: 2,
		owner: "user",
		...overrides,
	};
}

describe("goal prompt rendering", () => {
	it("renders agent drafting prompt with unattended propose_goal_draft instructions", () => {
		const prompt = renderGoalAgentDraftingPrompt("Review the deep branch and flag risks, no fixes yet");

		expect(prompt).toContain("revise and retry at most once");
		expect(prompt).toContain("For other goals omit optimization entirely");
		expect(prompt).toContain("If essential information is missing or the retry fails");
		expect(prompt).toContain("Do not call create_goal for this drafting flow");
		expect(prompt).toContain("This drafting turn is unattended");
		expect(prompt).toContain("pass autoApprove: true and startImmediately: true");
		expect(prompt).not.toContain("opens user review");
		expect(prompt).toContain("Review the deep branch and flag risks, no fixes yet");
	});

	it("renders agent drafting prompt with meaning-preservation and acceptance criteria guardrails", () => {
		const prompt = renderGoalAgentDraftingPrompt("Audit src/auth for regressions <only>");

		expect(prompt).toContain("Preserve the user's meaning and boundaries exactly");
		expect(prompt).toContain("do not add unrelated scope");
		expect(prompt).toContain("acceptanceCriteria");
		expect(prompt).toContain("verifiable end state");
		expect(prompt).toContain("Put working rules and boundaries in constraints");
		expect(prompt).toContain("Never add an escape clause");
		expect(prompt).toContain("Audit src/auth for regressions &lt;only&gt;");
		expect(prompt).not.toContain("return an empty acceptanceCriteria array");
		expect(prompt).not.toContain("criteria-free goal");
	});

	it("renders escaped concise hidden goal_context", () => {
		const context = renderGoalContext(goal());

		expect(context).toContain('<goal_context goal_id="goal-1">');
		expect(context).toContain("Objective: Ship &lt;runtime&gt; &amp; preserve context");
		expect(context).toContain("- Escape &lt;xml&gt; &amp; do not rewrite scope");
		expect(context).toContain("docs/prd.md (prd): Use &lt;brief&gt; &amp; criteria safely");
		expect(context).not.toContain("complete_goal with evidence");
		expect(context).not.toContain("<runtime>");
	});

	it("keeps the goal active and re-checks blockers instead of pausing on external waits", () => {
		const context = GOAL_EXECUTION_SYSTEM_PROMPT;

		expect(context).toContain("try the ladder before treating it as blocked");
		expect(context).toContain("a self-service path you can act on yourself");
		expect(context).toContain("Record a structured blocker only for what stays unresolved");
		expect(context).toContain("re-check open blockers first");
		expect(context).toContain("never pause the goal for external waits");
	});

	it("requires execution after checkpoints without overriding status requests or real stops", () => {
		for (const prompt of [GOAL_EXECUTION_SYSTEM_PROMPT]) {
			expect(prompt).toContain('including "继续目标", as a request to execute');
			expect(prompt).toContain("take the next authorized, actionable step in this turn");
			expect(prompt).toContain("If the user only asks for status or another task, answer that request instead");
			expect(prompt).toContain("a verified hard limit or safety constraint");
			expect(prompt).toContain("Do not bypass required human decisions or approvals");
			expect(prompt).toContain("Proof jobs report completion automatically");
			expect(prompt).toContain("Do not schedule a generic goal continuation");
		}
	});

	it("documents update_goal guardrails in the goal context rules", () => {
		const context = GOAL_EXECUTION_SYSTEM_PROMPT;

		expect(context).toContain("Keep the anchor accurate with update_goal");
		expect(context).toContain("never add or remove scope");
		expect(context).toContain("without the user asking");
	});

	it("creates hidden messages only for active goals", () => {
		expect(createGoalContextMessage(goal())).toMatchObject({
			customType: GOAL_CONTEXT_CUSTOM_TYPE,
			display: false,
			details: { goalId: "goal-1" },
		});
		expect(createGoalContextMessage(goal({ status: "paused" }))).toBeUndefined();
		expect(createGoalContextMessage(goal({ status: "complete" }))).toBeUndefined();
	});

	it("filters stale and duplicate hidden goal contexts", () => {
		const current = goal({ goalId: "goal-2" });
		const stale = { role: "custom", customType: GOAL_CONTEXT_CUSTOM_TYPE, content: 'old goal_id="goal-1"' };
		const duplicate = {
			role: "custom",
			customType: GOAL_CONTEXT_CUSTOM_TYPE,
			content: 'first goal_id="goal-2"',
		};
		const fresh = {
			role: "custom",
			customType: GOAL_CONTEXT_CUSTOM_TYPE,
			content: 'latest goal_id="goal-2"',
		};
		const ordinary = { role: "user", content: "hello" };

		expect(filterGoalContextMessages([stale, duplicate, ordinary, fresh], current)).toEqual([
			ordinary,
			fresh,
		]);
		expect(filterGoalContextMessages([fresh, ordinary], goal({ status: "paused" }))).toEqual([ordinary]);
		expect(filterGoalContextMessages([fresh, ordinary], null)).toEqual([ordinary]);
	});

	it("renders a continuation prompt within 10 characters", () => {
		const prompt = renderContinuationPrompt(goal());

		expect(prompt).toBe("继续目标");
		expect([...prompt]).toHaveLength(4);
	});

	it("uses a short start trigger and keeps criteria and constraints in the context", () => {
		const state = goal({ acceptanceCriteria: ["Build the thing", "Tests prove the behavior"], constraints: ["Do not publish"] });
		expect(renderGoalStartPrompt(state)).toBe("Start working toward the active goal now.");
		const context = renderGoalContext(state);
		expect(context).toContain("Acceptance criteria (long-term definition of done):\n- Build the thing\n- Tests prove the behavior");
		expect(context).toContain("Constraints:\n- Do not publish");
		expect(context).not.toContain("after each checkpoint");
		expect(GOAL_EXECUTION_SYSTEM_PROMPT).toContain("[goal-prompt:v2]");
	});

	it("renders the current milestone and only its ready actions", () => {
		const state = goal({
			workItems: [
				{
					id: "m1", goalId: "goal-1", title: "Evidence closed", horizon: "mid", state: "done",
					doneWhen: ["no gaps"], dependsOn: [], acceptanceCriteriaIds: [], updatedAt: 1,
				},
				{
					id: "m2", goalId: "goal-1", title: "Independent review", horizon: "mid", state: "todo",
					doneWhen: ["two reviews clean"], dependsOn: ["m1"], acceptanceCriteriaIds: [], updatedAt: 1,
				},
				{
					id: "s1", goalId: "goal-1", title: "Build matrix", horizon: "short", parentId: "m1",
					state: "done", dependsOn: [], acceptanceCriteriaIds: [], updatedAt: 1,
				},
				{
					id: "s2", goalId: "goal-1", title: "Commission reviews", horizon: "short", parentId: "m2",
					state: "todo", dependsOn: [], acceptanceCriteriaIds: [], updatedAt: 1,
				},
			],
		});
		const context = renderGoalContext(state);
		expect(context).toContain("Current milestone:\n- [todo] Independent review (m2; done when: two reviews clean)");
		expect(context).toContain("Ready next actions:\n- [todo; ready] Commission reviews (s2; parent m2)");
		expect(context).toContain("- [todo; current] Independent review (m2; depends on: m1)");
		expect(context).toContain("Locked actions:\n- none");
	});

	it("renders intentional empty acceptance criteria copy in prompts", () => {
		const emptyGoal = goal({ acceptanceCriteria: [] });
		const startPrompt = renderGoalStartPrompt(emptyGoal);
		const context = renderGoalContext(emptyGoal);
		const summary = renderCompactGoalSummary(emptyGoal);

		for (const rendered of [context, summary]) {
			expect(rendered).toContain(
				"No acceptance criteria were specified for this goal; use the objective as the source of truth.",
			);
		}
		expect(startPrompt).not.toContain("Acceptance criteria:\n- none");
		expect(context).not.toContain("Acceptance criteria:\n- none");
		expect(summary).not.toContain("Acceptance criteria:\n- none");
	});

	it("renders compact goal summaries with objective, criteria, source brief, and progress", () => {
		const summary = renderCompactGoalSummary(goal());

		expect(summary).toContain("## Active goal");
		expect(summary).toContain("Objective: Ship <runtime> & preserve context");
		expect(summary).toContain("- Escape <xml> & do not rewrite scope");
		expect(summary).toContain("docs/prd.md: Use <brief> & criteria safely");
		expect(summary).toContain("- Summary: Implementing & testing hidden context");
		expect(summary).toContain("- Done: state");
	});
});
