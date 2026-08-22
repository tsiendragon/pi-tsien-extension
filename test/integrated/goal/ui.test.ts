import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import {
	applyGoalUi,
	createGoalWidgetFactory,
	createGoalWidgetPresentation,
	getGoalSymbols,
	GOAL_USAGE,
	noGoalMessage,
	nonInteractiveConfirmationMessage,
	renderGoalStatus,
	renderGoalSummary,
	renderGoalWidget,
	renderGoalWidgetPresentation,
	showGoalBlockers,
} from "../../../extensions/goal/src/ui.ts";
import { registerGoalRuntime } from "../../../extensions/goal/src/runtime.ts";
import { saveGoalState } from "../../../extensions/goal/src/state.ts";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { GoalState, GoalStateEntry, GoalStateEvent } from "../../../extensions/goal/src/types.ts";

function goal(overrides: Partial<GoalState> = {}): GoalState {
	return {
		version: 1,
		goalId: "goal-1",
		objective: "Ship polished goal UI with helpful summaries",
		status: "active",
		sourceDocs: [
			{ path: "docs/prd.md", kind: "prd", brief: "PRD brief", extractedAt: 1 },
			{ path: "docs/ux.md", kind: "doc", brief: "UX brief", extractedAt: 1 },
			{ path: "docs/extra.md", kind: "doc", brief: "Extra brief", extractedAt: 1 },
		],
		constraints: ["Keep output concise"],
		acceptanceCriteria: ["Status command reflects state", "Widget shows progress"],
		progress: {
			done: ["state wired"],
			current: "polishing widgets",
			blocked: ["manual TUI smoke pending"],
			lastSummary: "UI helpers implemented",
		},
		createdAt: 1,
		updatedAt: 2,
		owner: "user",
		...overrides,
	};
}

function persist(event: GoalStateEvent, current: GoalState | null) {
	const appendEntry = vi.fn();
	const state = saveGoalState({ appendEntry }, event, current);
	return { entry: appendEntry.mock.calls[0][1] as GoalStateEntry, state };
}

function customEntry(data: GoalStateEntry) {
	return { type: "custom", customType: "goal-state", data };
}

describe("goal UI renderers", () => {
	it("renders compact active widgets with semantic data, symbols, and optional blocked/current lines", () => {
		const presentation = createGoalWidgetPresentation(goal());
		expect(presentation).toMatchObject({
			status: "active",
			acceptanceCount: 2,
			doneCount: 0,
			totalCount: 2,
			readyCount: 2,
			openBlockerCount: 0,
			blockedCount: 1,
			completedCount: 1,
			current: "polishing widgets",
		});
		expect(renderGoalWidget(goal())).toEqual([
			"Goal · Active · AC: 2 · 🎯 0/2 · ▶2 · Blocked: 1 · ✓ 1 · Ship polished goal UI with helpful summaries",
			"Now · polishing widgets",
		]);

		expect(
			renderGoalWidget(
				goal({
					acceptanceCriteria: [],
					progress: { done: [], current: "", blocked: [], lastSummary: "UI helpers implemented" },
				}),
			),
		).toEqual(["Goal · Active · AC: 0 · 🎯 0/1 · ▶1 · Ship polished goal UI with helpful summaries"]);
		expect(
			renderGoalWidgetPresentation(createGoalWidgetPresentation(goal())!, {
				symbols: getGoalSymbols({ ascii: true }),
			}),
		).toEqual([
			"Goal - Active - AC: 2 - 🎯 0/2 - ▶2 - Blocked: 1 - [x] 1 - Ship polished goal UI with helpful summaries",
			"Now - polishing widgets",
		]);
		expect(renderGoalWidget(goal({ status: "paused" }))).toBeUndefined();
		expect(renderGoalWidget(goal({ status: "complete" }))).toBeUndefined();
	});

	it("renders readable summaries and expanded status", () => {
		const summary = renderGoalSummary(goal());
		expect(summary).toContain("Goal: Ship polished goal UI");
		expect(summary).toContain("Status: active");
		expect(summary).toContain("Next actions: /goal status, /goal pause, /goal complete, /goal clear");

		const status = renderGoalStatus(goal());
		expect(status).toContain("Acceptance criteria:\n- Status command reflects state");
		expect(status).toContain("Progress done:\n✓ state wired");
		expect(status).toContain("Current work:\n- polishing widgets");
		expect(status).toContain("Source docs:\n- docs/prd.md (prd): PRD brief");
		expect(status).toContain("Commands:");

		const emptyCriteriaStatus = renderGoalStatus(goal({ acceptanceCriteria: [] }));
		expect(emptyCriteriaStatus).toContain(
			"No acceptance criteria were specified for this goal; use the objective as the source of truth.",
		);
		expect(emptyCriteriaStatus).not.toContain("Acceptance criteria:\n- none");
	});

	it("clears footer status while applying widgets and no-ops without UI methods", () => {
		const ctx = { ui: { setStatus: vi.fn(), setWidget: vi.fn() } };
		applyGoalUi(ctx, goal());
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("goal-progress", undefined);
		expect(ctx.ui.setWidget).toHaveBeenLastCalledWith(
			"goal",
			expect.arrayContaining([
				"Goal · Active · AC: 2 · 🎯 0/2 · ▶2 · Blocked: 1 · ✓ 1 · Ship polished goal UI with helpful summaries",
			]),
		);

		applyGoalUi(ctx, goal({ status: "complete" }));
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("goal-progress", undefined);
		expect(ctx.ui.setWidget).toHaveBeenLastCalledWith("goal", undefined);

		applyGoalUi(ctx, null);
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("goal-progress", undefined);
		expect(ctx.ui.setWidget).toHaveBeenLastCalledWith("goal", undefined);
		expect(() => applyGoalUi({}, goal())).not.toThrow();
	});

	it("renders themed widget components with width-safe output and invalidation support", () => {
		const presentation = createGoalWidgetPresentation(goal())!;
		const fg = vi.fn((_token: string, text: string) => text);
		const bold = vi.fn((text: string) => text);
		const component = createGoalWidgetFactory(presentation)({}, { fg, bold });
		const lines = component.render(42);

		expect(fg).toHaveBeenCalledWith("customMessageLabel", "Goal");
		expect(fg).toHaveBeenCalledWith("success", "Active");
		expect(fg).toHaveBeenCalledWith("muted", "AC: 2");
		expect(fg).toHaveBeenCalledWith("muted", "🎯 0/2 · ▶2");
		expect(fg).toHaveBeenCalledWith("warning", "Blocked: 1");
		expect(fg).toHaveBeenCalledWith("success", "✓ 1");
		expect(fg).toHaveBeenCalledWith("accent", "Now");
		expect(lines.every((line) => visibleWidth(line) <= 42)).toBe(true);
		expect(() => component.invalidate()).not.toThrow();
	});

	it("uses themed widget path only in TUI and legacy string fallback elsewhere", () => {
		const tuiCtx = { mode: "tui" as const, ui: { setStatus: vi.fn(), setWidget: vi.fn() } };
		applyGoalUi(tuiCtx, goal());
		expect(tuiCtx.ui.setWidget).toHaveBeenLastCalledWith("goal", expect.any(Function));

		const rpcCtx = { mode: "rpc" as const, ui: { setStatus: vi.fn(), setWidget: vi.fn() } };
		applyGoalUi(rpcCtx, goal());
		expect(rpcCtx.ui.setWidget).toHaveBeenLastCalledWith("goal", expect.any(Array));
	});

	it("shows a filterable read-only blocker overlay and degrades without TUI", async () => {
		let component: { render(width: number): string[]; handleInput(data: string): void } | undefined;
		const done = vi.fn();
		const requestRender = vi.fn();
		const fg = vi.fn((_token: string, value: string) => value);
		const context = {
			mode: "tui" as const,
			ui: {
				custom: vi.fn(async (factory) => {
					component = factory({ requestRender }, { bold: (value: string) => value, fg }, undefined, done);
					return undefined;
				}),
			},
		};
		await expect(
			showGoalBlockers(
				context as never,
				goal({
					blockers: Array.from({ length: 4 }, (_, index) => ({
						id: `b-${index}`,
						goalId: "goal-1",
						title: `Need approval ${index + 1}`,
						reason: "Scope choice",
						kind: "user_decision" as const,
						disposition: "needs_user" as const,
						state: "open" as const,
						workItemIds: ["criterion-1"],
						owner: "user" as const,
						createdAt: 1,
						updatedAt: 1,
					})),
				}),
			),
		).resolves.toBe(true);
		const rendered = component?.render(80).join("\n") ?? "";
		expect(rendered).toContain("Goal blockers");
		expect(rendered).toContain("Open 4");
		expect(rendered).toContain("Need approval 1");
		expect(rendered).toContain("Why: Scope choice");
		expect(rendered).toContain("Next: Provide the required decision or approval.");
		expect(rendered).toContain("1-11 / 19 rows · 4 blockers");
		expect(rendered).toContain("[esc]");
		expect(rendered).not.toContain("# Goal blocker report");
		expect(component?.render(28).every((line) => visibleWidth(line) <= 28)).toBe(true);
		expect(fg).toHaveBeenCalledWith("warning", "Needs you");
		component?.handleInput("\t");
		expect(requestRender).toHaveBeenCalledOnce();
		expect(component?.render(80).join("\n")).toContain("Filter: Needs you");
		component?.handleInput("\u001b[6~");
		expect(requestRender).toHaveBeenCalledTimes(2);
		expect(component?.render(80).join("\n")).toContain("9-19 / 19 rows · 4 blockers");
		component?.handleInput("\u001b");
		expect(done).toHaveBeenCalledWith(undefined);
		await expect(showGoalBlockers({ mode: "print" }, goal())).resolves.toBe(false);
	});

	it("uses actionable usage and error copy", () => {
		expect(GOAL_USAGE).toContain("/goal start");
		expect(GOAL_USAGE).toContain("/goal import <path> [--yes]");
		expect(GOAL_USAGE).toContain("interactive UI can edit before start");
		expect(GOAL_USAGE).toContain("review, edit, or cancel the drafted objective and acceptance criteria");
		expect(GOAL_USAGE).toContain("Non-interactive mode");
		expect(noGoalMessage("pause")).toContain("Start one with /goal <objective>");
		expect(nonInteractiveConfirmationMessage("/goal clear")).toContain("requires --yes");
	});

	it("clears footer status and refreshes widget from branch state on runtime session_start and session_tree", async () => {
		const created = persist({ action: "create", goalId: "goal-1", objective: "Runtime UI", now: 1 }, null);
		const branch = [customEntry(created.entry)];
		const handlers = new Map<string, (event: unknown, ctx?: unknown) => Promise<unknown>>();
		const pi = {
			registerFlag: vi.fn(),
			on: vi.fn((event: string, handler) => handlers.set(event, handler)),
			appendEntry: vi.fn(),
			sendUserMessage: vi.fn(),
			getFlag: vi.fn(() => false),
		} as unknown as ExtensionAPI;
		const ctx = {
			sessionManager: { getBranch: vi.fn(() => branch) },
			ui: { setStatus: vi.fn(), setWidget: vi.fn() },
		};
		registerGoalRuntime(pi);

		await handlers.get("session_start")?.({}, ctx);
		expect(ctx.ui.setStatus).toHaveBeenCalledWith("goal", undefined);
		expect(ctx.ui.setWidget).toHaveBeenCalledWith(
			"goal",
			expect.arrayContaining(["Goal · Active · AC: 0 · 🎯 0/1 · ▶1 · Runtime UI"]),
		);

		const clear = persist({ action: "clear", goalId: "goal-1", now: 2 }, created.state);
		branch.push(customEntry(clear.entry));
		await handlers.get("session_tree")?.({}, ctx);
		expect(ctx.ui.setStatus).toHaveBeenCalledWith("goal", undefined);
		expect(ctx.ui.setWidget).toHaveBeenCalledWith("goal", undefined);
	});
});
