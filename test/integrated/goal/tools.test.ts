import { describe, expect, it, vi } from "vitest";
import {
	completeGoalParams,
	createGoalParams,
	executeCompleteGoal,
	executePauseGoal,
	executeCreateGoal,
	executeGetGoal,
	executeProposeGoalDraft,
	executeUpdateGoalGraph,
	executeUpdateGoalProgress,
	executeUpdateGoal,
	formatCompleteGoalToolResult,
	formatGoalToolCall,
	formatGoalToolResult,
	formatProposeGoalDraftToolCall,
	formatUpdateGoalProgressToolCall,
	getGoalParams,
	proposeGoalDraftParams,
	proposeGoalDraftPromptGuidelines,
	proposeGoalDraftPromptSnippet,
	pauseGoalParams,
	registerGoalTools,
	updateGoalGraphParams,
	updateGoalProgressParams,
	updateGoalParams,
} from "pi-tsien-goal/src/tools.ts";
import { saveGoalState } from "pi-tsien-goal/src/state.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { GoalStateEntry } from "pi-tsien-goal/src/types.ts";

function createHarness() {
	const branch: Array<{ type: string; customType?: string; data?: unknown }> = [];
	const tools = new Map<
		string,
		{
			name: string;
			parameters: unknown;
			description?: string;
			promptSnippet?: string;
			promptGuidelines?: string[];
			execute: (...args: never[]) => Promise<unknown>;
			renderCall?: (
				args: Record<string, unknown>,
				theme?: { fg: (token: string, text: string) => string; bold: (text: string) => string },
			) => { render(width: number): string[] };
			renderResult?: (
				result: Record<string, unknown>,
				options?: Record<string, unknown>,
				theme?: { fg: (token: string, text: string) => string; bold: (text: string) => string },
			) => { render(width: number): string[] };
		}
	>();
	const pi = {
		registerTool: vi.fn((tool) => tools.set(tool.name, tool)),
		appendEntry: vi.fn((customType: string, data: unknown) =>
			branch.push({ type: "custom", customType, data }),
		),
	} as unknown as ExtensionAPI;
	const ui = {
		notify: vi.fn(),
		confirm: vi.fn(async () => true),
		select: vi.fn(async () => "Start"),
		editor: vi.fn(),
		setStatus: vi.fn(),
		setWidget: vi.fn(),
	};
	const ctx = { hasUI: true, sessionManager: { getBranch: vi.fn(() => branch) }, ui };
	return { branch, tools, pi, ctx, ui };
}

function latestGoalEntry(branch: Array<{ data?: unknown }>): GoalStateEntry {
	return branch.at(-1)?.data as GoalStateEntry;
}

describe("goal tool schemas and registration", () => {
	it("defines narrow schemas and registers all goal tools", () => {
		expect((getGoalParams as { additionalProperties?: boolean }).additionalProperties).toBe(false);
		expect(Object.keys(createGoalParams.properties)).toEqual([
			"objective",
			"explicit_request",
			"source_paths",
			"acceptance_criteria",
		]);
		expect(Object.keys(completeGoalParams.properties)).toEqual(["evidence"]);
		expect(Object.keys(pauseGoalParams.properties)).toEqual(["reason"]);
		expect(Object.keys(updateGoalProgressParams.properties)).toEqual([
			"done",
			"current",
			"blocked",
			"summary",
			"checkpoint",
		]);
		expect(Object.keys(updateGoalGraphParams.properties)).toEqual(["workItems", "blockers", "attempt"]);
		expect(Object.keys(updateGoalParams.properties)).toEqual([
			"objective",
			"acceptance_criteria",
			"constraints",
			"source_paths",
			"reason",
		]);

		const { pi, tools } = createHarness();
		registerGoalTools(pi);
		expect(Object.keys(proposeGoalDraftParams.properties)).toEqual([
			"objective",
			"description",
			"acceptanceCriteria",
			"constraints",
			"optimization",
			"milestones",
			"sourcePaths",
			"startImmediately",
			"autoApprove",
			"replan",
			"draftId",
			"commandId",
		]);
		expect([...tools.keys()]).toEqual([
			"get_goal",
			"create_goal",
			"propose_goal_draft",
			"update_goal",
			"complete_goal",
			"pause_goal",
			"update_goal_graph",
			"update_goal_progress",
		]);
		expect(pi.registerTool).toHaveBeenCalledTimes(8);
	});

	it("documents propose_goal_draft as the review-only drafting path separate from create_goal", () => {
		expect(proposeGoalDraftPromptSnippet).toContain("Use propose_goal_draft");
		expect(proposeGoalDraftPromptSnippet).toContain("do not persist");
		expect(proposeGoalDraftPromptGuidelines).toEqual(
			expect.arrayContaining([
				expect.stringContaining("Preserve the user's meaning and boundaries"),
				expect.stringContaining("verifiable end state"),
				expect.stringContaining("acceptanceCriteria are outcome checks"),
				expect.stringContaining("Do not leave acceptanceCriteria empty"),
				expect.stringContaining("Use create_goal only for an already-authorized new goal"),
			]),
		);

		const { pi, tools } = createHarness();
		registerGoalTools(pi);
		const createGoalGuidance = tools.get("create_goal")?.description ?? "";
		expect(createGoalGuidance).toContain("For drafts use propose_goal_draft");
		expect(createGoalGuidance).toContain("never rewrite an existing goal");

		for (const toolName of [
			"get_goal",
			"create_goal",
			"propose_goal_draft",
			"complete_goal",
			"pause_goal",
			"update_goal_graph",
			"update_goal_progress",
		]) {
			const tool = tools.get(toolName);
			expect(tool?.promptSnippet).toContain(toolName);
		}
	});

	it("keeps the goal driving through external waits instead of pausing", () => {
		const { pi, tools } = createHarness();
		registerGoalTools(pi);
		const pauseGuidance = tools.get("pause_goal")?.description ?? "";
		expect(pauseGuidance).toContain("only when the user asked to stop it or continuing would be unsafe");
		expect(pauseGuidance).toContain("keep the goal active");
		expect(tools.get("pause_goal")?.promptSnippet ?? "").toContain("keep the goal active");
	});

	it("asks for a workaround attempt before a blocker is marked needs_user or external_wait", () => {
		const { pi, tools } = createHarness();
		registerGoalTools(pi);
		const graphGuidance = tools.get("update_goal_graph")?.description ?? "";
		expect(graphGuidance).toContain("Try the ladder first");
		expect(graphGuidance).toContain("record each attempt with evidence");
		expect(graphGuidance).toContain("only mark a blocker needs_user or external_wait after that");
	});
});

describe("goal tool execution", () => {
	it("registered execute callbacks dispatch complete and progress tools", async () => {
		const { pi, ctx, tools } = createHarness();
		registerGoalTools(pi);
		executeCreateGoal({ objective: "Dispatch callbacks", explicit_request: true }, ctx, pi);

		const progress = await tools
			.get("update_goal_progress")
			?.execute(
				"call-1" as never,
				{ summary: "callback progress" } as never,
				undefined as never,
				undefined as never,
				ctx as never,
			);
		expect(progress).toMatchObject({ details: { progress: { lastSummary: "callback progress" } } });

		const graph = await tools
			.get("update_goal_graph")
			?.execute("call-graph" as never, {} as never, undefined as never, undefined as never, ctx as never);
		expect(graph).toMatchObject({ content: [{ text: "Goal work graph updated" }] });

		const complete = await tools
			.get("complete_goal")
			?.execute(
				"call-2" as never,
				{ evidence: "callback complete" } as never,
				undefined as never,
				undefined as never,
				ctx as never,
			);
		expect(complete).toMatchObject({ details: { evidence: "callback complete" } });
	});

	it("get_goal returns no-goal and current state details including source paths", () => {
		const { pi, ctx, branch } = createHarness();
		expect(executeGetGoal(ctx)).toMatchObject({ details: { goal: null } });

		executeCreateGoal(
			{
				objective: "Ship tools",
				explicit_request: true,
				source_paths: ["docs/prd.md"],
				acceptance_criteria: ["tools pass"],
			},
			ctx,
			pi,
		);
		const result = executeGetGoal(ctx);
		expect(result.content[0].text).toContain("Goal: Ship tools");
		expect(result.details).toMatchObject({ sourcePaths: ["docs/prd.md"] });
		expect(latestGoalEntry(branch).state?.acceptanceCriteria).toEqual(["tools pass"]);
	});

	it("create_goal soft-refuses without explicit authorization and when a goal exists", () => {
		const { pi, ctx, branch, ui } = createHarness();
		const denied = executeCreateGoal({ objective: "No permission", explicit_request: false }, ctx, pi);
		expect(denied).toMatchObject({ details: { status: "refused", reason: "permission_denied" } });
		expect(denied).not.toHaveProperty("isError");
		expect(branch).toHaveLength(0);

		const created = executeCreateGoal({ objective: "Allowed", explicit_request: true }, ctx, pi);
		expect(created).not.toHaveProperty("isError");
		expect(latestGoalEntry(branch).action).toBe("create");
		expect(ui.setStatus).toHaveBeenCalledWith("goal", undefined);
		expect(ui.setWidget).toHaveBeenCalledWith(
			"goal",
			expect.arrayContaining(["Goal · Active · AC: 0 · 🎯 0/1 · ▶1 · Allowed"]),
		);

		const duplicate = executeCreateGoal({ objective: "Rewrite", explicit_request: true }, ctx, pi);
		expect(duplicate).toMatchObject({ details: { status: "refused", reason: "goal_exists" } });
		expect(duplicate).not.toHaveProperty("isError");
		expect(latestGoalEntry(branch).state?.objective).toBe("Allowed");
	});

	it("pauses an active goal with a durable reason", () => {
		const { pi, ctx } = createHarness();
		executeCreateGoal({ objective: "Pause safely", explicit_request: true }, ctx, pi);

		const result = executePauseGoal({ reason: "Waiting for the required credential" }, ctx, pi);
		expect(result).toMatchObject({ details: { reason: "Waiting for the required credential" } });
		expect(executeGetGoal(ctx).details).toMatchObject({
			goal: { status: "paused", pausedReason: "Waiting for the required credential" },
		});
		expect(executePauseGoal({ reason: "again" }, ctx, pi)).toMatchObject({
			details: { status: "refused", reason: "goal_inactive" },
		});
	});

	it("propose_goal_draft saves and starts only after Start review", async () => {
		const { pi, ctx, branch, ui } = createHarness();
		const sendUserMessage = vi.fn();
		const result = await executeProposeGoalDraft(
			{
				objective: " Ship reviewed goal ",
				acceptanceCriteria: [" done ", "done", " tests pass "],
				sourcePaths: [" docs/prd.md "],
				draftId: " draft-1 ",
				commandId: " command-1 ",
			},
			ctx,
			{ ...pi, sendUserMessage },
		);

		expect(ui.select).toHaveBeenCalledWith("Review generated goal proposal", ["Start", "Edit", "Cancel"]);
		expect(latestGoalEntry(branch).action).toBe("create");
		expect(latestGoalEntry(branch).state).toMatchObject({
			objective: "Ship reviewed goal",
			acceptanceCriteria: ["done", "tests pass"],
			sourceDocs: [expect.objectContaining({ path: "docs/prd.md" })],
		});
		expect(sendUserMessage).toHaveBeenCalledOnce();
		expect(sendUserMessage).toHaveBeenCalledWith("Start working toward the active goal now.", {
			deliverAs: "followUp",
		});
		expect(result).toMatchObject({
			terminate: true,
			details: {
				status: "saved",
				action: "create",
				started: true,
				draftId: "draft-1",
				commandId: "command-1",
			},
		});
	});

	it("propose_goal_draft supports Edit review and retries invalid edits", async () => {
		const { pi, ctx, branch, ui } = createHarness();
		const sendUserMessage = vi.fn();
		ui.select.mockResolvedValueOnce("Edit").mockResolvedValueOnce("Edit").mockResolvedValueOnce("Start");
		ui.editor
			.mockResolvedValueOnce("# Acceptance criteria\n- missing objective")
			.mockResolvedValueOnce("# Objective\nEdited goal\n\n# Acceptance criteria\n- edited criterion");

		const result = await executeProposeGoalDraft(
			{ objective: "Initial", acceptanceCriteria: ["initial criterion"] },
			ctx,
			{ ...pi, sendUserMessage },
		);

		expect(ui.notify).toHaveBeenCalledWith("Goal draft must include a non-empty Objective section.", "error");
		expect(ui.editor).toHaveBeenCalledTimes(2);
		expect(latestGoalEntry(branch).state).toMatchObject({
			objective: "Edited goal",
			acceptanceCriteria: ["edited criterion"],
		});
		expect(sendUserMessage).toHaveBeenCalledWith("Start working toward the active goal now.", {
			deliverAs: "followUp",
		});
		expect(result.details).toMatchObject({ status: "saved", started: true });
	});

	it("propose_goal_draft cancellation and no-UI policy do not save", async () => {
		const cancelled = createHarness();
		cancelled.ui.select.mockResolvedValueOnce("Cancel");
		const cancelResult = await executeProposeGoalDraft(
			{ objective: "Cancel me", acceptanceCriteria: ["criterion"] },
			cancelled.ctx,
			cancelled.pi,
		);
		expect(cancelled.branch).toHaveLength(0);
		expect(cancelResult).toMatchObject({
			terminate: true,
			details: { status: "cancelled", reason: "user_cancelled" },
		});

		const noUi = createHarness();
		const noUiCtx = { ...noUi.ctx, hasUI: false };
		const noUiResult = await executeProposeGoalDraft(
			{ objective: "No UI", acceptanceCriteria: ["criterion"] },
			noUiCtx,
			noUi.pi,
		);
		expect(noUi.branch).toHaveLength(0);
		expect(noUiResult).toMatchObject({
			terminate: true,
			details: { status: "cancelled", reason: "review_ui_unavailable" },
		});
	});

	it("propose_goal_draft confirms existing goal replacement and rejects stale state", async () => {
		const denied = createHarness();
		denied.ui.confirm.mockResolvedValueOnce(false);
		executeCreateGoal({ objective: "Old goal", explicit_request: true }, denied.ctx, denied.pi);
		const deniedResult = await executeProposeGoalDraft(
			{ objective: "Denied replacement", acceptanceCriteria: ["new criterion"] },
			denied.ctx,
			{ ...denied.pi, sendUserMessage: vi.fn() },
		);
		expect(denied.branch).toHaveLength(1);
		expect(latestGoalEntry(denied.branch).state?.objective).toBe("Old goal");
		expect(deniedResult).toMatchObject({
			terminate: true,
			details: { status: "cancelled", reason: "replacement_not_confirmed" },
		});

		const replace = createHarness();
		executeCreateGoal({ objective: "Old goal", explicit_request: true }, replace.ctx, replace.pi);
		const replacement = await executeProposeGoalDraft(
			{ objective: "New goal", acceptanceCriteria: ["new criterion"] },
			replace.ctx,
			{ ...replace.pi, sendUserMessage: vi.fn() },
		);
		expect(replace.ui.confirm).toHaveBeenCalledWith(
			"Replace current goal?",
			expect.stringContaining("Old goal"),
		);
		expect(latestGoalEntry(replace.branch).action).toBe("replace");
		expect(latestGoalEntry(replace.branch).state?.objective).toBe("New goal");
		expect(replacement.details).toMatchObject({ status: "saved", action: "replace" });

		const stale = createHarness();
		stale.ui.select.mockImplementationOnce(async () => {
			executeCreateGoal({ objective: "Concurrent goal", explicit_request: true }, stale.ctx, stale.pi);
			return "Start";
		});
		await expect(
			executeProposeGoalDraft({ objective: "Stale draft", acceptanceCriteria: ["criterion"] }, stale.ctx, {
				...stale.pi,
				sendUserMessage: vi.fn(),
			}),
		).rejects.toMatchObject({
			message: "Goal changed before saving. No goal was saved.",
			code: "stale_goal",
		});
		expect(latestGoalEntry(stale.branch).state?.objective).toBe("Concurrent goal");
	});

	it("propose_goal_draft autoApprove saves and starts without any dialog", async () => {
		const { pi, ctx, branch, ui } = createHarness();
		const sendUserMessage = vi.fn();
		const result = await executeProposeGoalDraft(
			{
				objective: "Unattended goal",
				acceptanceCriteria: ["criterion"],
				milestones: [
					{ title: "First milestone", doneWhen: ["first check passes"], actions: ["Run the first check"] },
					{ title: "Second milestone", doneWhen: ["second check passes"] },
				],
				autoApprove: true,
				startImmediately: true,
			},
			ctx,
			{ ...pi, sendUserMessage },
		);
		expect(ui.select).not.toHaveBeenCalled();
		expect(ui.confirm).not.toHaveBeenCalled();
		expect(latestGoalEntry(branch).action).toBe("create");
		expect(latestGoalEntry(branch).state?.objective).toBe("Unattended goal");
		expect(sendUserMessage).toHaveBeenCalledWith("Start working toward the active goal now.", {
			deliverAs: "followUp",
		});
		expect(result.details).toMatchObject({ status: "saved", action: "create", started: true });

		const replacing = createHarness();
		executeCreateGoal({ objective: "Existing goal", explicit_request: true }, replacing.ctx, replacing.pi);
		const replaced = await executeProposeGoalDraft(
			{
				objective: "Replacement goal",
				acceptanceCriteria: ["criterion"],
				milestones: [
					{ title: "First milestone", doneWhen: ["first check passes"], actions: ["Run the first check"] },
					{ title: "Second milestone", doneWhen: ["second check passes"] },
				],
				autoApprove: true,
			},
			replacing.ctx,
			{ ...replacing.pi, sendUserMessage: vi.fn() },
		);
		expect(replacing.ui.confirm).not.toHaveBeenCalled();
		expect(replacing.ui.select).not.toHaveBeenCalled();
		expect(latestGoalEntry(replacing.branch).action).toBe("replace");
		expect(replaced.details).toMatchObject({ status: "saved", action: "replace", started: true });

		const noUi = createHarness();
		const noUiResult = await executeProposeGoalDraft(
			{
				objective: "Headless unattended",
				acceptanceCriteria: ["criterion"],
				milestones: [
					{ title: "First milestone", doneWhen: ["first check passes"], actions: ["Run the first check"] },
					{ title: "Second milestone", doneWhen: ["second check passes"] },
				],
				autoApprove: true,
			},
			{ ...noUi.ctx, hasUI: false },
			{ ...noUi.pi, sendUserMessage: vi.fn() },
		);
		expect(noUiResult.details).toMatchObject({ status: "saved", started: true });
	});

	it("propose_goal_draft replans in place and preserves completed history", async () => {
		const { pi, ctx, branch } = createHarness();
		await executeProposeGoalDraft(
			{
				objective: "First objective",
				acceptanceCriteria: ["criterion"],
				milestones: [
					{ title: "First milestone", doneWhen: ["check one"], actions: ["do one"] },
					{ title: "Second milestone", doneWhen: ["check two"] },
				],
				autoApprove: true,
			},
			ctx,
			{ ...pi, sendUserMessage: vi.fn() },
		);
		const initial = latestGoalEntry(branch).state!;
		executeUpdateGoalGraph(
			{
				workItems: initial.workItems?.map((item) =>
					item.id === "m1"
						? { ...item, state: "done" as const, evidence: ["reports/first.md"] }
						: item.id === "s1"
							? { ...item, state: "done" as const }
							: item,
				),
			},
			ctx,
			pi,
		);
		const before = latestGoalEntry(branch).state!;
		const sendUserMessage = vi.fn();
		const result = await executeProposeGoalDraft(
			{
				objective: "Replanned objective",
				acceptanceCriteria: ["criterion"],
				milestones: [
					{ title: "Replanned next", doneWhen: ["check three"], actions: ["do three"] },
					{ title: "Replanned final", doneWhen: ["check four"] },
				],
				replan: true,
				autoApprove: true,
				startImmediately: true,
			},
			ctx,
			{ ...pi, sendUserMessage },
		);

		const after = latestGoalEntry(branch).state!;
		expect(result.details).toMatchObject({ status: "saved", action: "replan", started: true });
		expect(latestGoalEntry(branch).action).toBe("edit");
		expect(after.goalId).toBe(before.goalId);
		expect(after.objective).toBe("Replanned objective");
		expect(after.workItems).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "m1", state: "done", evidence: ["reports/first.md"] }),
				expect.objectContaining({ id: "s1", state: "done" }),
				expect.objectContaining({ id: "r1-m1", state: "todo", dependsOn: ["m1"] }),
				expect.objectContaining({ id: "r1-m2", state: "todo", dependsOn: ["r1-m1"] }),
			]),
		);
		expect(after.workItems?.find((item) => item.id === "m2")).toBeUndefined();
		expect(sendUserMessage).toHaveBeenCalledWith("Start working toward the active goal now.", {
			deliverAs: "followUp",
		});
	});

	it("propose_goal_draft renders an optimization contract and allows any method", async () => {
		const { pi, ctx, branch } = createHarness();
		const result = await executeProposeGoalDraft(
			{
				objective: "优化 Frank–Wolfe 的总 matvec 成本",
				acceptanceCriteria: ["报告列出每个基线的总 matvec 和证书口径"],
				optimization: {
					metric: "总 matvec 数（含证书与重启）",
					baseline: "最强 cold-start 基线",
					target: "降低 ≥20%",
					guardrails: ["同一有效 FW gap 证书", "所有成本计入"],
				},
				milestones: [
					{ title: "基线测量可复现", doneWhen: ["baseline.json 生成"], actions: ["跑基线"] },
					{ title: "达到指标目标", doneWhen: ["target.json 显示降低 ≥20%"] },
				],
				autoApprove: true,
			},
			ctx,
			{ ...pi, sendUserMessage: vi.fn() },
		);
		expect(result.details).toMatchObject({ status: "saved", started: true });
		const state = latestGoalEntry(branch).state!;
		expect(state.objective).toContain("优化合同");
		expect(state.objective).toContain("降低 ≥20%");
		expect(state.acceptanceCriteria[0]).toContain("测量脚本、原始输出和汇总可复核");
		expect(state.constraints).toContain(
			"允许尝试任意算法、实现、超参数或系统优化路线；只固定指标、基线、目标值和 guardrails。",
		);
	});

	it("propose_goal_draft rejects an optimization target without a number", async () => {
		const { pi, ctx } = createHarness();
		await expect(
			executeProposeGoalDraft(
				{
					objective: "优化算法",
					acceptanceCriteria: ["criterion"],
					optimization: {
						metric: "runtime",
						baseline: "current",
						target: "明显更快",
					},
					milestones: [
						{ title: "M1", doneWhen: ["check one"], actions: ["act"] },
						{ title: "M2", doneWhen: ["check two"] },
					],
					autoApprove: true,
				},
				ctx,
				{ ...pi, sendUserMessage: vi.fn() },
			),
		).rejects.toMatchObject({ code: "invalid_optimization" });
	});

	it("propose_goal_draft persists constraints separately from acceptance criteria", async () => {
		const { pi, ctx, branch } = createHarness();
		await executeProposeGoalDraft(
			{
				objective: "证明定理 T。",
				acceptanceCriteria: ["proofs/t.lean 中 T 的证明被 Lean 接受，目标状态为 proved"],
				constraints: ["按 pi-matrix 流程记录并独立评审", "不代替人工对齐"],
				milestones: [
					{ title: "引理闭合", doneWhen: ["所有引理有 review 记录"], actions: ["整理引理依赖并补缺口"] },
					{ title: "目标证明完成", doneWhen: ["proofs/t.lean 通过 Lean 检查"] },
				],
				autoApprove: true,
			},
			ctx,
			{ ...pi, sendUserMessage: vi.fn() },
		);
		expect(latestGoalEntry(branch).state).toMatchObject({
			objective: "证明定理 T。",
			acceptanceCriteria: ["proofs/t.lean 中 T 的证明被 Lean 接受，目标状态为 proved"],
			constraints: ["按 pi-matrix 流程记录并独立评审", "不代替人工对齐"],
		});
	});

	it("propose_goal_draft persists a milestone plan with nested actions", async () => {
		const { pi, ctx, branch } = createHarness();
		const result = await executeProposeGoalDraft(
			{
				objective: "证明定理 T。",
				acceptanceCriteria: ["proofs/t.lean 中 T 的证明被 Lean 接受，目标状态为 proved"],
				milestones: [
					{ title: "引理闭合", doneWhen: ["所有引理有独立 review 记录"], actions: ["补齐引理依赖"] },
					{ title: "目标证明完成", doneWhen: ["proofs/t.lean 通过 Lean 检查"] },
				],
				autoApprove: true,
			},
			ctx,
			{ ...pi, sendUserMessage: vi.fn() },
		);
		expect(result.details).toMatchObject({ status: "saved", started: true });
		expect(latestGoalEntry(branch).state?.workItems).toEqual([
			expect.objectContaining({
				id: "m1",
				horizon: "mid",
				state: "todo",
				doneWhen: ["所有引理有独立 review 记录"],
				dependsOn: [],
			}),
			expect.objectContaining({
				id: "m2",
				horizon: "mid",
				state: "todo",
				doneWhen: ["proofs/t.lean 通过 Lean 检查"],
				dependsOn: ["m1"],
			}),
			expect.objectContaining({
				id: "s1",
				horizon: "short",
				parentId: "m1",
				title: "补齐引理依赖",
			}),
		]);
	});

	it("complete_goal refuses open milestones and accepts a fully reconciled plan", async () => {
		const { pi, ctx, branch } = createHarness();
		await executeProposeGoalDraft(
			{
				objective: "证明定理 T。",
				acceptanceCriteria: ["proofs/t.lean 中 T 的证明被 Lean 接受，目标状态为 proved"],
				milestones: [
					{ title: "引理闭合", doneWhen: ["所有引理有独立 review 记录"], actions: ["补齐引理依赖"] },
					{ title: "目标证明完成", doneWhen: ["proofs/t.lean 通过 Lean 检查"] },
				],
				autoApprove: true,
			},
			ctx,
			{ ...pi, sendUserMessage: vi.fn() },
		);
		expect(executeCompleteGoal({ evidence: "batch done" }, ctx, pi)).toMatchObject({
			details: { status: "refused", reason: "open_milestones" },
		});

		const goal = latestGoalEntry(branch).state;
		expect(goal?.workItems).toHaveLength(3);
		executeUpdateGoalGraph(
			{
				workItems: goal?.workItems?.map((item) =>
					item.horizon === "mid"
						? { ...item, state: "done" as const, evidence: ["proofs/t.lean"] }
						: { ...item, state: "done" as const },
				),
			},
			ctx,
			pi,
		);
		const completed = executeCompleteGoal({ evidence: "proofs/t.lean 通过 Lean 检查" }, ctx, pi);
		expect(completed.details).toMatchObject({ goal: { status: "complete" } });
	});

	it("update_goal_graph refuses to close a milestone with open actions or no evidence", async () => {
		const { pi, ctx, branch } = createHarness();
		await executeProposeGoalDraft(
			{
				objective: "证明定理 T。",
				acceptanceCriteria: ["proofs/t.lean 中 T 的证明被 Lean 接受，目标状态为 proved"],
				milestones: [
					{ title: "引理闭合", doneWhen: ["所有引理有独立 review 记录"], actions: ["补齐引理依赖"] },
					{ title: "目标证明完成", doneWhen: ["proofs/t.lean 通过 Lean 检查"] },
				],
				autoApprove: true,
			},
			ctx,
			{ ...pi, sendUserMessage: vi.fn() },
		);
		const goal = latestGoalEntry(branch).state;
		const items = goal?.workItems ?? [];
		const closeFirstWithoutActions = executeUpdateGoalGraph(
			{
				workItems: items.map((item) => item.id === "m1" ? { ...item, state: "done" as const } : item),
			},
			ctx,
			pi,
		);
		expect(closeFirstWithoutActions).toMatchObject({
			details: { status: "refused", reason: "milestone_not_ready" },
		});

		const actionDone = items.map((item) => item.id === "s1" ? { ...item, state: "done" as const } : item);
		const closeWithoutEvidence = executeUpdateGoalGraph(
			{ workItems: actionDone.map((item) => item.id === "m1" ? { ...item, state: "done" as const } : item) },
			ctx,
			pi,
		);
		expect(closeWithoutEvidence).toMatchObject({
			details: { status: "refused", reason: "milestone_evidence_required" },
		});

		const closeWithEvidence = executeUpdateGoalGraph(
			{
				workItems: actionDone.map((item) =>
					item.id === "m1" ? { ...item, state: "done" as const, evidence: ["reports/deps.md"] } : item,
				),
			},
			ctx,
			pi,
		);
		expect(closeWithEvidence).toMatchObject({ details: { goal: { workItems: expect.any(Array) } } });
	});

	it("update_goal_graph accepts a partial patch and inherits the remaining fields", async () => {
		const { pi, ctx, branch } = createHarness();
		await executeProposeGoalDraft(
			{
				objective: "证明定理 T。",
				acceptanceCriteria: ["proofs/t.lean 中 T 的证明被 Lean 接受，目标状态为 proved"],
				milestones: [
					{ title: "引理闭合", doneWhen: ["所有引理有独立 review 记录"], actions: ["补齐引理依赖"] },
					{ title: "目标证明完成", doneWhen: ["proofs/t.lean 通过 Lean 检查"] },
				],
				autoApprove: true,
			},
			ctx,
			{ ...pi, sendUserMessage: vi.fn() },
		);
		executeUpdateGoalGraph(
			{ workItems: [{ id: "s1", state: "done" as const }] },
			ctx,
			pi,
		);
		const updated = latestGoalEntry(branch).state?.workItems?.find((item) => item.id === "s1");
		expect(updated).toMatchObject({
			id: "s1",
			title: "补齐引理依赖",
			parentId: "m1",
			horizon: "short",
			state: "done",
		});
	});

	it("propose_goal_draft rejects an unattended draft that is only a process plan", async () => {
		const { pi, ctx, branch, ui } = createHarness();
		const result = await executeProposeGoalDraft(
			{
				objective: "按规范持续推进这个项目，并定期汇报进展。",
				acceptanceCriteria: ["记录每轮进展", "更新 STATUS 文档"],
				autoApprove: true,
			},
			ctx,
			{ ...pi, sendUserMessage: vi.fn() },
		);
		expect(branch).toHaveLength(0);
		expect(ui.select).not.toHaveBeenCalled();
		expect(result).toMatchObject({
			terminate: true,
			details: { status: "rejected", reason: "goal_quality" },
		});
		expect(result.content?.[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining("outcome quality gate"),
		});
	});

	it("propose_goal_draft throws for invalid model-provided draft shape before review", async () => {
		const { pi, ctx, branch, ui } = createHarness();
		await expect(
			executeProposeGoalDraft({ objective: "   ", acceptanceCriteria: [" "] }, ctx, pi),
		).rejects.toMatchObject({ message: "Goal draft objective is required.", code: "invalid_objective" });
		expect(branch).toHaveLength(0);
		expect(ui.select).not.toHaveBeenCalled();
	});

	it("complete_goal handles no-goal cases and persists evidence without rewriting scope", () => {
		const empty = createHarness();
		expect(executeCompleteGoal({ evidence: "done" }, empty.ctx, empty.pi)).toMatchObject({
			details: { status: "refused", reason: "no_goal" },
		});

		const { pi, ctx, branch, ui } = createHarness();
		executeCreateGoal(
			{ objective: "Complete me", explicit_request: true, acceptance_criteria: ["criterion"] },
			ctx,
			pi,
		);
		const result = executeCompleteGoal({ evidence: "all criteria passed" }, ctx, pi);

		expect(ui.setStatus).toHaveBeenCalledWith("goal", undefined);
		expect(ui.setWidget).toHaveBeenCalledWith("goal", undefined);
		expect(result.content[0].text).toContain("Evidence: all criteria passed");
		expect(latestGoalEntry(branch).action).toBe("complete");
		expect(latestGoalEntry(branch).reason).toContain("all criteria passed");
		expect(latestGoalEntry(branch).state).toMatchObject({
			objective: "Complete me",
			acceptanceCriteria: ["criterion"],
			status: "complete",
		});
	});

	it("update_goal edits the objective and criteria in place with an audit reason", () => {
		const { pi, ctx, branch } = createHarness();
		executeCreateGoal(
			{ objective: "Original objective", explicit_request: true, acceptance_criteria: ["old criterion"] },
			ctx,
			pi,
		);
		const goalId = latestGoalEntry(branch).state?.goalId;

		const result = executeUpdateGoal(
			{
				objective: "Refined objective",
				acceptance_criteria: ["new criterion", "second criterion"],
				constraints: ["No regressions"],
				source_paths: ["docs/prd.md"],
				reason: "Scope clarified while reading the PRD",
			},
			ctx,
			pi,
		);

		expect(latestGoalEntry(branch).action).toBe("edit");
		expect(latestGoalEntry(branch).reason).toContain("Scope clarified while reading the PRD");
		// In-place edit: the same goal keeps its identity and history.
		expect(latestGoalEntry(branch).state).toMatchObject({
			goalId,
			status: "active",
			objective: "Refined objective",
			acceptanceCriteria: ["new criterion", "second criterion"],
			constraints: ["No regressions"],
		});
		expect(latestGoalEntry(branch).state?.sourceDocs).toMatchObject([{ path: "docs/prd.md" }]);
		expect(result.details).toMatchObject({ reason: "Scope clarified while reading the PRD" });
		expect(result.content[0].text).toContain("Goal updated: Scope clarified while reading the PRD");
	});

	it("update_goal refuses empty updates, empty criteria, missing reason, and inactive goals", () => {
		const { pi, ctx, branch } = createHarness();
		expect(executeUpdateGoal({ objective: "x", reason: "no goal yet" }, ctx, pi)).toMatchObject({
			details: { status: "refused", reason: "no_goal" },
		});

		executeCreateGoal(
			{ objective: "Keep me", explicit_request: true, acceptance_criteria: ["criterion"] },
			ctx,
			pi,
		);
		expect(executeUpdateGoal({ reason: "nothing to change" }, ctx, pi)).toMatchObject({
			details: { status: "refused", reason: "empty_update" },
		});
		expect(
			executeUpdateGoal({ acceptance_criteria: ["  "], reason: "blank criteria" }, ctx, pi),
		).toMatchObject({ details: { status: "refused", reason: "empty_acceptance_criteria" } });
		expect(executeUpdateGoal({ objective: "Renamed", reason: "   " }, ctx, pi)).toMatchObject({
			details: { status: "refused", reason: "empty_reason" },
		});

		executePauseGoal({ reason: "user asked to stop" }, ctx, pi);
		expect(executeUpdateGoal({ objective: "While paused", reason: "nope" }, ctx, pi)).toMatchObject({
			details: { status: "refused", reason: "goal_inactive" },
		});
		expect(latestGoalEntry(branch).state?.objective).toBe("Keep me");
	});

	it("records a decision checkpoint once per evidence reference without completing the goal", () => {
		const { pi, ctx, branch } = createHarness();
		executeCreateGoal({ objective: "Track experiment", explicit_request: true, acceptance_criteria: ["Compare at matched budget"] }, ctx, pi);
		const checkpoint = { kind: "gate_decision" as const, evidence: "./experiments/result.json", decision: "Drop the candidate after it misses the frozen gate" };
		expect(executeUpdateGoalProgress({ checkpoint }, ctx, pi)).toMatchObject({ details: { goal: { progress: { researchCheckpoints: [{ ...checkpoint, evidence: "experiments/result.json" }] } } } });
		const length = branch.length;
		executeUpdateGoalProgress({ checkpoint: { ...checkpoint, evidence: "experiments/result.json", decision: "Paraphrased decision" } }, ctx, pi);
		expect(branch).toHaveLength(length);
		executeUpdateGoalProgress({ summary: "Candidate ruled out" }, ctx, pi);
		expect(latestGoalEntry(branch).state).toMatchObject({ status: "active", progress: { researchCheckpoints: [{ decision: checkpoint.decision }] } });
	});

	it("update_goal_progress only mutates progress fields", () => {
		const { pi, ctx, branch, ui } = createHarness();
		executeCreateGoal(
			{
				objective: "Track me",
				explicit_request: true,
				source_paths: ["docs/a.md"],
				acceptance_criteria: ["a"],
			},
			ctx,
			pi,
		);
		const result = executeUpdateGoalProgress(
			{ done: ["one"], current: "two", blocked: ["three"], summary: "progress summary" },
			ctx,
			pi,
		);

		expect(result.content[0].text).toBe("Goal progress updated");
		expect(formatGoalToolResult(result)).toBe("Goal progress updated");
		expect(ui.setStatus).toHaveBeenLastCalledWith("goal-progress", undefined);
		expect(ui.setWidget).toHaveBeenLastCalledWith(
			"goal",
			expect.arrayContaining([
				"Goal · Active · AC: 1 · 🎯 0/1 · ▶1 · Blocked: 1 · ✓ 1 · Track me",
				"Now · two",
			]),
		);
		expect(latestGoalEntry(branch).action).toBe("progress");
		expect(latestGoalEntry(branch).state).toMatchObject({
			objective: "Track me",
			acceptanceCriteria: ["a"],
			sourceDocs: [expect.objectContaining({ path: "docs/a.md" })],
			progress: { done: ["one"], current: "two", blocked: ["three"], lastSummary: "progress summary" },
		});
	});

	it("update_goal_graph records work items and rejects unsafe automatic blockers", () => {
		const { pi, ctx, branch } = createHarness();
		executeCreateGoal({ objective: "Track graph", explicit_request: true }, ctx, pi);
		const goalId = latestGoalEntry(branch).state!.goalId;
		const result = executeUpdateGoalGraph(
			{
				workItems: [
					{
						id: "item-1",
						goalId,
						title: "Implement",
						state: "in_progress",
						dependsOn: [],
						acceptanceCriteriaIds: [],
						updatedAt: 2,
					},
				],
				blockers: [
					{
						id: "block-1",
						goalId,
						title: "Need token",
						reason: "No auth",
						kind: "permission_or_credential",
						disposition: "needs_user",
						state: "open",
						workItemIds: ["item-1"],
						owner: "user",
						createdAt: 2,
						updatedAt: 2,
					},
				],
				attempt: {
					id: "attempt-1",
					goalId,
					blockerId: "block-1",
					hypothesis: "Read-only access exists",
					action: "Inspect config",
					result: "No access",
					createdAt: 2,
				},
			},
			ctx,
			pi,
		);
		expect(result.content[0]?.text).toBe("Goal work graph updated");
		expect(latestGoalEntry(branch).state).toMatchObject({
			workItems: [{ id: "item-1" }],
			blockers: [{ id: "block-1" }],
			blockerAttempts: [{ id: "attempt-1" }],
		});
		expect(
			executeUpdateGoalGraph(
				{
					blockers: [
						{
							id: "unsafe",
							goalId,
							title: "Bypass",
							reason: "x",
							kind: "user_decision",
							disposition: "agent_can_try",
							state: "open",
							workItemIds: [],
							owner: "agent",
							createdAt: 3,
							updatedAt: 3,
						},
					],
				},
				ctx,
				pi,
			),
		).toMatchObject({ details: { reason: "policy_boundary" } });
	});

	it("complete_goal and update_goal_progress reject paused goals", () => {
		const { pi, ctx, branch } = createHarness();
		executeCreateGoal({ objective: "Paused", explicit_request: true }, ctx, pi);
		saveGoalState(
			pi,
			{ action: "pause", goalId: latestGoalEntry(branch).state?.goalId ?? "", now: Date.now() },
			latestGoalEntry(branch).state,
		);

		expect(executeCompleteGoal({ evidence: "done" }, ctx, pi)).toMatchObject({
			details: { status: "refused", reason: "goal_inactive" },
		});
		expect(executeUpdateGoalProgress({ summary: "late" }, ctx, pi)).toMatchObject({
			details: { status: "refused", reason: "goal_inactive" },
		});
		expect(latestGoalEntry(branch).state?.status).toBe("paused");
	});

	it("rejects empty progress updates without changing state", () => {
		const { pi, ctx, branch } = createHarness();
		executeCreateGoal({ objective: "Progress", explicit_request: true }, ctx, pi);
		const before = branch.length;

		expect(executeUpdateGoalProgress({}, ctx, pi)).toMatchObject({
			details: { status: "refused", reason: "empty_progress" },
		});
		expect(branch).toHaveLength(before);
	});

	it("update_goal_progress fails with no goal or complete goal", () => {
		const empty = createHarness();
		expect(executeUpdateGoalProgress({ summary: "x" }, empty.ctx, empty.pi)).toMatchObject({
			details: { status: "refused", reason: "no_goal" },
		});

		const { pi, ctx } = createHarness();
		executeCreateGoal({ objective: "Done", explicit_request: true }, ctx, pi);
		executeCompleteGoal({ evidence: "done" }, ctx, pi);
		expect(executeUpdateGoalProgress({ summary: "late" }, ctx, pi)).toMatchObject({
			details: { status: "refused", reason: "already_complete" },
		});
	});
});

describe("goal tool renderers", () => {
	it("registered renderers use semantic theme tokens while preserving readable text", () => {
		const { pi, tools } = createHarness();
		registerGoalTools(pi);
		const tokens: string[] = [];
		const theme = {
			fg: (token: string, text: string) => {
				tokens.push(token);
				return text;
			},
			bold: (text: string) => text,
		};

		const callRendered = tools
			.get("create_goal")
			?.renderCall?.({ objective: "Ship themed tools" }, theme)
			.render(120)
			.map((line) => line.trim())
			.filter(Boolean);
		const successRendered = tools
			.get("update_goal_progress")
			?.renderResult?.(
				{ content: [{ type: "text", text: "Goal progress updated" }], details: { progress: {} } },
				{},
				theme,
			)
			.render(120)
			.map((line) => line.trim())
			.filter(Boolean);
		const outputRendered = tools
			.get("get_goal")
			?.renderResult?.(
				{ content: [{ type: "text", text: "No goal is currently set." }], details: {} },
				{},
				theme,
			)
			.render(120)
			.map((line) => line.trim())
			.filter(Boolean);
		formatGoalToolResult(
			{ content: [{ type: "text", text: "Denied" }], details: undefined, isError: true },
			theme,
		);

		expect(callRendered).toEqual(["Create goal", "Ship themed tools"]);
		expect(successRendered).toEqual(["Goal progress updated"]);
		expect(outputRendered).toEqual(["No goal is currently set."]);
		expect(tokens).toEqual(expect.arrayContaining(["toolTitle", "muted", "success", "toolOutput", "error"]));
	});

	it("formats tool calls as human-readable title/body displays", () => {
		expect(formatGoalToolCall("create_goal", "Ship it")).toBe("Create goal\nShip it");
		expect(formatGoalToolCall("get_goal")).toBe("Get goal");
		expect(formatGoalToolCall("unknown_goal_tool")).toBe("unknown_goal_tool");
		expect(formatGoalToolCall("complete_goal", "all checks passed")).toBe(
			"✓ Complete goal\nall checks passed",
		);
		expect(
			formatProposeGoalDraftToolCall({
				objective: "Review branch",
				acceptanceCriteria: ["Review the diff", "Report risks"],
				milestones: [
					{ title: "Findings ready", doneWhen: ["findings.md exists"], actions: ["Inspect the diff"] },
					{ title: "Review closed", doneWhen: ["no open P0/P1"] },
				],
			}),
		).toBe(
			"Propose goal draft\nObjective: Review branch\nPlan: 2 milestones · 1 actions\nAcceptance criteria:\n- Review the diff\n- Report risks",
		);
		expect(
			formatUpdateGoalProgressToolCall({
				summary:
					"Core implementation is complete; one integration test still expects the previous widget format.",
				current: "Fix renderer test",
			}),
		).toBe(
			"Update goal progress\nCore implementation is complete; one integration test still expects the previous widget format.",
		);
		expect(formatUpdateGoalProgressToolCall({ current: "Fix renderer test" })).toBe(
			"Update goal progress\nFix renderer test",
		);
		expect(formatUpdateGoalProgressToolCall({ done: ["implementation", "tests"] })).toBe(
			"Update goal progress\nDone: implementation; tests",
		);
		expect(formatUpdateGoalProgressToolCall({ blocked: ["live TUI unavailable"] })).toBe(
			"Update goal progress\nBlocked: live TUI unavailable",
		);
		expect(formatUpdateGoalProgressToolCall({})).toBe("Update goal progress");
	});

	it("registered update_goal_progress renderCall includes summary args without legacy prefix", () => {
		const { pi, tools } = createHarness();
		registerGoalTools(pi);

		const rendered = tools
			.get("update_goal_progress")
			?.renderCall?.({
				summary:
					"Core implementation is complete; one integration test still expects the previous widget format.",
			})
			.render(120)
			.map((line) => line.trim())
			.filter(Boolean);

		expect(rendered).toEqual([
			"Update goal progress",
			"Core implementation is complete; one integration test still expects the previous widget format.",
		]);
		expect(rendered?.join("\n")).not.toContain("Updated goal progress:");
	});

	it("registered complete_goal renderers show evidence once in the call display", () => {
		const { pi, tools } = createHarness();
		registerGoalTools(pi);

		const callRendered = tools
			.get("complete_goal")
			?.renderCall?.({ evidence: "Reviewed branch compact-goal-widget-ui against likely base main." })
			.render(120)
			.map((line) => line.trim())
			.filter(Boolean);
		const resultRendered = tools
			.get("complete_goal")
			?.renderResult?.({
				content: [
					{
						type: "text",
						text: "Goal complete. Evidence: Reviewed branch compact-goal-widget-ui against likely base main.",
					},
				],
				details: { evidence: "Reviewed branch compact-goal-widget-ui against likely base main." },
			})
			.render(120)
			.map((line) => line.trim())
			.filter(Boolean);

		expect(callRendered).toEqual([
			"✓ Complete goal",
			"Reviewed branch compact-goal-widget-ui against likely base main.",
		]);
		expect(resultRendered).toEqual([]);
	});

	it("formats tool results concisely", () => {
		expect(
			formatCompleteGoalToolResult({
				content: [{ type: "text", text: "Goal complete. Evidence: all checks passed" }],
				details: { evidence: "all checks passed" },
			}),
		).toBe("");
		expect(
			formatCompleteGoalToolResult({
				content: [{ type: "text", text: "No active goal exists to complete." }],
				details: { error: "no_goal" },
				isError: true,
			}),
		).toBe("Error: No active goal exists to complete.");
		expect(
			formatGoalToolResult({
				content: [{ type: "text", text: "Goal progress updated" }],
				details: { progress: { lastSummary: "already shown in the action body" } },
			}),
		).toBe("Goal progress updated");
		expect(
			formatGoalToolResult({
				content: [{ type: "text", text: "Denied" }],
				details: undefined,
				isError: true,
			}),
		).toBe("Error: Denied");
	});
});
