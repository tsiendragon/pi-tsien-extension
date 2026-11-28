import { afterEach, describe, expect, it, vi } from "vitest";
import { GOAL_EVALUATOR_RETRY_MS, GOAL_WAIT_RECHECK_MS, registerGoalRuntime } from "pi-tsien-goal/src/runtime.ts";
import { renderGoalStartPrompt } from "pi-tsien-goal/src/prompts.ts";
import { saveGoalState } from "pi-tsien-goal/src/state.ts";
import { PROOF_JOB_EVENT, WORKBENCH_JOB_EVENT } from "pi-tsien-goal/src/evaluator.ts";
import type { GoalState } from "pi-tsien-goal/src/types.ts";

const SESSION = "session-a";

function harness(evaluatorText = '{"decision":"wait","reason":"Waiting on subagent","wake":"w1 finishes"}', globalApproval = false) {
	const branch: unknown[] = [];
	const goal = saveGoalState({ appendEntry(customType, data) { branch.push({ type: "custom", id: `e${branch.length}`, customType, data }); } }, {
		action: "create", goalId: "g", now: 1, objective: "Ship the feature", acceptanceCriteria: ["Tests pass"],
	}, null) as GoalState;
	if (globalApproval) {
		branch.push({ type: "custom", id: "approval", customType: "goal-state", data: { action: "graph", state: { ...goal, blockers: [{ id: "final-approval", goalId: goal.goalId, title: "Release", reason: "Requires confirmation", kind: "user_decision", disposition: "needs_user", state: "open", workItemIds: [], owner: "user", createdAt: 1, updatedAt: 1 }] } } });
	}
	const handlers = new Map<string, Function>();
	const events = new Map<string, Function>();
	const sendUserMessage = vi.fn();
	const appendEntry = vi.fn();
	const stream = vi.fn(() => ({ result: async () => ({ stopReason: "stop", content: [{ type: "text", text: evaluatorText }] }) }));
	let idle = true;
	const ctx = {
		isIdle: () => idle,
		sessionManager: { getBranch: () => branch, getSessionId: () => SESSION, getLeafId: () => "leaf" },
		modelRegistry: { find: () => ({}), getProvider: () => ({ stream }), getApiKeyAndHeaders: async () => ({ ok: true }), getProviderAuth: async () => undefined },
	};
	registerGoalRuntime({
		on: (name: string, handler: Function) => handlers.set(name, handler),
		events: { on: (name: string, handler: Function) => events.set(name, handler) },
		getFlag: (flag: string) => (flag === "goal-evaluator-models" ? "provider/model" : undefined),
		sendUserMessage, appendEntry,
	} as never);
	const on = (name: string, event = {}) => handlers.get(name)!(name === "session_before_compact" ? {
		branchEntries: branch, preparation: { firstKeptEntryId: "leaf", tokensBefore: 100 }, ...event,
	} : event, ctx);
	const job = (event: Record<string, unknown>, kind = WORKBENCH_JOB_EVENT) => events.get(kind)!({ sessionId: SESSION, label: "Review branch", ...event });
	const endTurn = (text = "GOAL_HANDOFF\nReady now: none until w1 finishes", stopReason = "stop") =>
		on("agent_end", { messages: [{ role: "assistant", stopReason, content: [{ type: "text", text }] }] });
	const engage = async () => {
		await on("session_start");
		return on("before_agent_start", { prompt: renderGoalStartPrompt(goal), systemPrompt: "base" });
	};
	const settle = () => new Promise(resolve => setTimeout(resolve, 5));
	return { branch, ctx, on, job, endTurn, engage, settle, goal, sendUserMessage, appendEntry, stream, setIdle: (value: boolean) => { idle = value; } };
}

let active: ReturnType<typeof harness> | undefined;
afterEach(async () => {
	await active?.on("session_shutdown");
	active = undefined;
	vi.useRealTimers();
});

describe("goal recovery after a turn yields", () => {
	it.each([
		'{"decision":"stop","reason":"PTC_BUDGET_EXCEEDED 33/32 in this turn"}',
		'{"decision":"uncertain","reason":"No scheduling recommendation"}',
	])("continues ready work despite an unverified stop or uncertainty: %s", async (reply) => {
		const h = (active = harness(reply));
		await h.engage();
		await h.endTurn("GOAL_HANDOFF\nNext: run the frozen checkpoint in a fresh round.");
		await h.on("agent_settled");
		await vi.waitFor(() => expect(h.sendUserMessage).toHaveBeenCalledWith("继续目标", { deliverAs: "followUp" }));
		expect(h.appendEntry).toHaveBeenCalledWith("goal-evaluation", expect.objectContaining({ fallback: "default-resume" }));
	});

	it("re-engages from a natural language instruction after another request", async () => {
		const h = (active = harness('{"decision":"continue","reason":"The user explicitly wants to proceed","action":"resume existing goal"}'));
		await h.on("session_start");
		const prompt = "好的，就这样，帮我更新goal了。 然后继续推进。";
		await h.on("input", { text: prompt, source: "interactive" });
		const started = await h.on("before_agent_start", { prompt, systemPrompt: "base" });
		expect(started.systemPrompt).toContain("GOAL_HANDOFF");
		expect(h.appendEntry).toHaveBeenCalledWith("goal-input-intent", expect.objectContaining({ decision: "continue", model: "provider/model" }));
	});

	it.each([false, true])("evaluates an exhausted milestone unless a real blocker exists (blocked=%s)", async (blocked) => {
		vi.useFakeTimers();
		const h = (active = harness('{"decision":"continue","reason":"The milestone is not satisfied.","action":"Add a distinct screening action to m2"}'));
		const base = { goalId: h.goal.goalId, acceptanceCriteriaIds: [], updatedAt: 2 };
		const state: GoalState = {
			...h.goal,
			workItems: [
				{ ...base, id: "m1", title: "Set baseline", horizon: "mid", state: "done", dependsOn: [] },
				{ ...base, id: "m2", title: "Find a candidate", horizon: "mid", state: "in_progress", dependsOn: ["m1"] },
				{ ...base, id: "m3", title: "Validate candidate", horizon: "mid", state: "todo", dependsOn: ["m2"] },
				{ ...base, id: "s1", title: "First screening", horizon: "short", parentId: "m2", state: "done", dependsOn: [] },
				{ ...base, id: "s2", title: "Second screening", horizon: "short", parentId: "m2", state: "done", dependsOn: [] },
			],
			blockers: blocked ? [{
				id: "approval", goalId: h.goal.goalId, title: "Approval", reason: "Needs owner approval",
				kind: "user_decision", disposition: "needs_user", state: "open", workItemIds: ["m2"],
				owner: "user", createdAt: 2, updatedAt: 2,
			}] : [],
		};
		h.branch.push({ type: "custom", id: "graph", customType: "goal-state", data: { action: "graph", state } });
		await h.engage();
		await h.endTurn("GOAL_HANDOFF\nAll screening actions finished; m2 is not satisfied.");
		await h.on("agent_settled");
		await vi.advanceTimersByTimeAsync(20);
		expect(h.stream).toHaveBeenCalledTimes(blocked ? 0 : 1);
		expect(h.sendUserMessage).toHaveBeenCalledTimes(blocked ? 0 : 1);
	});

	it("queues 继续目标 immediately and does not repeat that fallback without progress", async () => {
		vi.useFakeTimers();
		const h = (active = harness("invalid response"));
		await h.engage();
		await h.endTurn();
		await h.on("agent_settled");
		await vi.advanceTimersByTimeAsync(10);
		expect(h.stream).toHaveBeenCalledOnce();
		expect(h.appendEntry).toHaveBeenCalledWith("goal-continuation", expect.objectContaining({ source: "evaluator-fallback", action: "queued" }));
		expect(h.sendUserMessage).toHaveBeenCalledWith("继续目标", expect.anything());
		await h.on("input", { source: "extension", text: "继续目标" });
		await h.on("before_agent_start", { prompt: "继续目标", systemPrompt: "base" });
		await h.endTurn();
		await h.on("agent_settled");
		await vi.advanceTimersByTimeAsync(3 * GOAL_EVALUATOR_RETRY_MS);
		expect(h.stream).toHaveBeenCalledTimes(3);
		expect(h.sendUserMessage).toHaveBeenCalledOnce();
		expect(h.appendEntry).toHaveBeenCalledWith("goal-scheduler", expect.objectContaining({ state: "evaluator-unavailable-no-retry", reason: "retry-exhausted" }));
	});

	it("can resume normally when the evaluator returns on its second attempt", async () => {
		vi.useFakeTimers();
		const h = (active = harness('{"decision":"continue","reason":"The next step is ready.","action":"Run the next checkpoint check"}'));
		h.stream.mockImplementationOnce(() => ({ result: async () => ({ stopReason: "stop", content: [{ type: "text", text: "invalid response" }] }) }));
		await h.engage();
		await h.endTurn();
		await h.on("agent_settled");
		await vi.advanceTimersByTimeAsync(10);
		await h.on("input", { source: "extension", text: "继续目标" });
		await h.on("before_agent_start", { prompt: "继续目标", systemPrompt: "base" });
		await h.endTurn();
		await h.on("agent_settled");
		await vi.advanceTimersByTimeAsync(10);
		expect(h.stream).toHaveBeenCalledTimes(2);
		expect(h.appendEntry).toHaveBeenCalledWith("goal-continuation", expect.objectContaining({ action: "queued", source: "evaluator" }));
		expect(h.sendUserMessage).toHaveBeenCalledTimes(2);
	});
	it("wakes on proof completion after Pi successfully retries a provider error", async () => {
		const h = (active = harness());
		await h.engage();
		h.job({ id: "pj-werner", state: "pending" }, PROOF_JOB_EVENT);
		await h.endTurn("provider error", "error");
		await h.endTurn();
		await h.on("agent_settled");
		h.job({ id: "pj-werner", state: "finished" }, PROOF_JOB_EVENT);
		await vi.waitFor(() => expect(h.sendUserMessage).toHaveBeenCalledOnce());
		expect(h.appendEntry).toHaveBeenCalledWith("goal-continuation", expect.objectContaining({ action: "queued", source: "proof-job" }));
		expect(h.appendEntry).not.toHaveBeenCalledWith("goal-scheduler", expect.objectContaining({ state: "provider-backoff" }));
	});

	it("allows one bounded retry for a settled provider failure, then stops retrying", async () => {
		vi.useFakeTimers();
		const h = (active = harness());
		await h.engage();
		await h.endTurn("provider error", "error");
		await h.on("agent_settled");
		await vi.advanceTimersByTimeAsync(31_000);
		expect(h.appendEntry).toHaveBeenCalledWith("goal-continuation", expect.objectContaining({ source: "provider-retry" }));
		await h.on("input", { source: "extension", text: "继续目标" });
		await h.endTurn("provider error again", "error");
		await h.on("agent_settled");
		await vi.advanceTimersByTimeAsync(60_000);
		expect(h.sendUserMessage).toHaveBeenCalledOnce();
	});

	it("does not resume an aborted goal or wake it on a later result", async () => {
		const h = (active = harness());
		await h.engage();
		h.job({ id: "w1", state: "pending" });
		await h.endTurn("", "aborted");
		await h.on("agent_settled");
		h.job({ id: "w1", state: "finished" });
		await h.settle();
		expect(h.sendUserMessage).not.toHaveBeenCalled();
	});

	it("resumes an engaged goal after requested manual compaction exactly once, prioritizing terminal evidence", async () => {
		const h = (active = harness());
		await h.engage();
		h.job({ id: "w1", state: "pending" });
		await h.endTurn();
		await h.on("agent_settled");
		await h.on("session_before_compact", { reason: "manual", willRetry: false });
		h.job({ id: "w1", state: "finished" });
		await h.settle();
		expect(h.sendUserMessage).not.toHaveBeenCalled();
		await h.on("session_compact", { reason: "manual", willRetry: false });
		await vi.waitFor(() => expect(h.sendUserMessage).toHaveBeenCalledOnce());
		expect(h.appendEntry).toHaveBeenCalledWith("goal-continuation", expect.objectContaining({ source: "workbench-job" }));
	});

	it("continues from a manual compression checkpoint without a job, but not outside an engaged goal", async () => {
		const h = (active = harness());
		await h.on("session_start");
		await h.on("session_before_compact");
		await h.on("session_compact", { reason: "manual" });
		await h.settle();
		expect(h.sendUserMessage).not.toHaveBeenCalled();
		await h.engage();
		await h.on("session_before_compact");
		await h.on("session_compact", { reason: "manual" });
		await vi.waitFor(() => expect(h.sendUserMessage).toHaveBeenCalledOnce());
		expect(h.appendEntry).toHaveBeenCalledWith("goal-continuation", expect.objectContaining({ source: "compaction" }));
	});

	it("reconciles a missing terminal notification once, without an unbounded wait loop", async () => {
		vi.useFakeTimers();
		const h = (active = harness());
		await h.engage();
		h.job({ id: "w1", state: "pending" });
		await h.endTurn();
		await h.on("agent_settled");
		await vi.advanceTimersByTimeAsync(GOAL_WAIT_RECHECK_MS + 10);
		expect(h.appendEntry).toHaveBeenCalledWith("goal-continuation", expect.objectContaining({ source: "wait-recheck" }));
		await h.on("input", { source: "extension", text: "继续目标" });
		const next = await h.on("before_agent_start", { prompt: "继续目标" });
		expect(next.message.content).toContain("workbench:w1");
		await h.endTurn();
		await h.on("agent_settled");
		await vi.advanceTimersByTimeAsync(GOAL_WAIT_RECHECK_MS + 10);
		expect(h.sendUserMessage).toHaveBeenCalledOnce();
	});
});

describe("goal start drafting chain", () => {
	it("defers a start prompt queued during the drafting run so before_agent_start engages it", async () => {
		const h = (active = harness());
		await h.on("session_start");
		const start = renderGoalStartPrompt(h.goal);
		h.setIdle(false);
		// propose_goal_draft -> startActiveGoal -> sendUserMessage(followUp) while streaming.
		await expect(h.on("input", { text: start, source: "extension", streamingBehavior: "followUp" })).resolves.toEqual({ action: "handled" });
		await h.endTurn("Saved goal draft", "stop");
		h.setIdle(true);
		await h.on("agent_settled");
		await vi.waitFor(() => expect(h.sendUserMessage).toHaveBeenCalledWith(start));
		expect(h.sendUserMessage).toHaveBeenCalledOnce();
		expect(h.stream).not.toHaveBeenCalled();
		// Idle redelivery takes the normal path: input passes through, then before_agent_start engages.
		await expect(h.on("input", { text: start, source: "extension" })).resolves.toBeUndefined();
		const started = await h.on("before_agent_start", { prompt: start, systemPrompt: "base" });
		expect(started.systemPrompt).toContain("GOAL_HANDOFF");
		await h.endTurn();
		await h.on("agent_settled");
		await vi.waitFor(() => expect(h.sendUserMessage).toHaveBeenCalledTimes(2));
	});

	it("drops a deferred start when the drafting run is aborted and leaves idle starts alone", async () => {
		const h = (active = harness());
		await h.on("session_start");
		const start = renderGoalStartPrompt(h.goal);
		await expect(h.on("input", { text: start, source: "extension" })).resolves.toBeUndefined();
		await h.on("input", { text: start, source: "extension", streamingBehavior: "followUp" });
		await h.endTurn("", "aborted");
		await h.on("agent_settled");
		await h.settle();
		expect(h.sendUserMessage).not.toHaveBeenCalled();
	});
});

describe("goal workbench job lifecycle", () => {
	it("a new research checkpoint reopens evaluation after no-progress turns without completing a criterion", async () => {
		const h = (active = harness());
		await h.engage();
		for (let i = 0; i < 4; i++) await h.endTurn();
		await h.on("agent_settled");
		await h.settle();
		expect(h.stream).not.toHaveBeenCalled();
		const checkpoint = { kind: "replication" as const, evidence: "experiments/heldout.json", decision: "Discontinue the unstable pilot",
			feedback: { method: "Pilot", scope: "Frozen held-out data", outcome: "inconclusive" as const } };
		saveGoalState({ appendEntry(customType, data) { h.branch.push({ type: "custom", id: "checkpoint", customType, data }); } }, {
			action: "progress", goalId: h.goal.goalId, now: 2, progress: { researchCheckpoints: [checkpoint] },
		}, h.goal);
		await h.endTurn();
		await h.on("agent_settled");
		await vi.waitFor(() => expect(h.stream).toHaveBeenCalledOnce());
		const snapshot = JSON.parse((h.stream.mock.calls[0] as unknown as [unknown, { messages: { content: string }[] }])[1].messages[0].content);
		expect(snapshot.researchCheckpoints).toEqual([{ kind: checkpoint.kind, evidence: checkpoint.evidence, decision: checkpoint.decision }]);
		expect(snapshot.researchFeedback).toEqual([checkpoint]);
		const next = await h.on("before_agent_start", { prompt: "继续目标", systemPrompt: "base" });
		expect(next.message.content).toContain("Route feedback (reported, not proof)");
		expect(next.message.content).toContain(checkpoint.feedback.scope);
		expect(snapshot.ready).toHaveLength(1);
	});
	const scheduled = "[定时任务触发：schedule-1 · 一次性任务]\n收取已有评审，不重复投审。";

	it.each([undefined, "followUp"])("keeps tracked jobs across a schedule input (%s)", async (streamingBehavior) => {
		const h = (active = harness());
		await h.engage();
		h.job({ id: "retained-work", state: "pending" });
		h.setIdle(!streamingBehavior);
		await h.on("input", { text: scheduled, source: "extension", streamingBehavior });
		h.setIdle(false);
		await h.on("before_agent_start", { prompt: scheduled, systemPrompt: "base" });
		h.job({ id: "retained-work", state: "finished" });
		await h.endTurn();
		h.setIdle(true);
		await h.on("agent_settled");
		await vi.waitFor(() => expect(h.appendEntry).toHaveBeenCalledWith("goal-continuation", expect.objectContaining({ source: "workbench-job", action: "queued" })));
		await h.on("input", { text: "继续目标", source: "extension" });
		const next = await h.on("before_agent_start", { prompt: "继续目标", systemPrompt: "base" });
		expect(next.message.content).toContain("retained-work");
	});

	it.each(["interactive", "extension"])("does not let a schedule-shaped message widen user authority (%s)", async (source) => {
		const h = (active = harness());
		if (source === "interactive") {
			await h.engage();
			h.job({ id: "w1", state: "pending" });
		} else {
			await h.on("session_start");
		}
		await h.on("input", { text: scheduled, source });
		const result = await h.on("before_agent_start", { prompt: scheduled, systemPrompt: "base" });
		expect(result.systemPrompt).toBeUndefined();
		h.job({ id: "w1", state: "finished" });
		await h.on("agent_settled");
		await h.settle();
		expect(h.sendUserMessage).toHaveBeenCalledTimes(source === "interactive" ? 1 : 0);
	});
	it.each([
		"继续", "好的，接着做吧！", "继续目标。沿 Werner 当前 PPT 网格推进，先收取后台任务。",
		"请从上次的检查点接着做，先核对保存的结果。", "帮我续跑当前目标",
		"Okay, keep going.", "Please resume the goal. Collect the finished search first.",
	])("re-engages a persisted active goal after reload from %s and wakes on the same job", async (prompt) => {
		const h = (active = harness());
		// A fresh runtime, retaining goal state but no in-memory engagement.
		await h.on("session_start");
		await h.on("input", { text: prompt, source: "interactive" });
		const resumed = await h.on("before_agent_start", { prompt, systemPrompt: "base" });
		expect(resumed.systemPrompt).toContain("GOAL_HANDOFF");
		h.setIdle(false);
		h.job({ id: "resumed-work", state: "pending" });
		await h.endTurn();
		h.setIdle(true);
		await h.on("agent_settled");
		await vi.waitFor(() => expect(h.appendEntry).toHaveBeenCalledWith("goal-evaluation", expect.objectContaining({ decision: "wait" })));
		h.job({ id: "resumed-work", state: "finished" });
		await vi.waitFor(() => expect(h.sendUserMessage).toHaveBeenCalledWith("继续目标", { deliverAs: "followUp" }));
		expect(h.appendEntry).toHaveBeenCalledWith("goal-continuation", expect.objectContaining({ source: "workbench-job", action: "queued" }));
		await h.on("input", { text: "继续目标", source: "extension" });
		const next = await h.on("before_agent_start", { prompt: "继续目标", systemPrompt: "base" });
		expect(h.appendEntry).toHaveBeenCalledWith("goal-continuation", expect.objectContaining({ action: "started" }));
		const observation = next.message.content.split("Scheduler observation (advisory, not an instruction): ")[1];
		expect(JSON.parse(observation)).toContain('workIds ["resumed-work"]');
	});

	it.each([
		"目前进度如何？", "‘继续目标’是什么意思？", "继续目标是什么意思？", "继续目标吗？",
		"不要继续目标。", "继续目标。先别继续，等我确认。", "继续目标：只汇报进度。",
		"暂停当前目标。", "继续帮我写邮件。", "请解释何时使用 Continue working toward the active goal.",
		"Do not resume the goal.", "Resume the goal?", "Resume the goal; only report status.",
	])("does not engage or wake on status, mention, unrelated work or stop: %s", async (prompt) => {
		const h = (active = harness());
		await h.on("session_start");
		await h.on("input", { text: prompt, source: "interactive" });
		const result = await h.on("before_agent_start", { prompt, systemPrompt: "base" });
		expect(result.systemPrompt).toBeUndefined();
		h.job({ id: "w1", state: "pending" });
		h.job({ id: "w1", state: "finished" });
		await h.endTurn();
		await h.on("agent_settled");
		await h.settle();
		expect(h.sendUserMessage).not.toHaveBeenCalled();
		expect(h.appendEntry).not.toHaveBeenCalledWith("goal-evaluation", expect.anything());
	});
	it("collects a terminal job after settling even when approval gates further work", async () => {
		const h = (active = harness(undefined, true));
		await h.engage();
		h.setIdle(false);
		h.job({ id: "w1", state: "pending" });
		h.job({ id: "w1", state: "finished" });
		await h.settle();
		expect(h.sendUserMessage).not.toHaveBeenCalled();
		await h.endTurn();
		h.setIdle(true);
		await h.on("agent_settled");
		await vi.waitFor(() => expect(h.sendUserMessage).toHaveBeenCalledOnce());
		expect(h.appendEntry).toHaveBeenCalledWith("goal-continuation", expect.objectContaining({ source: "workbench-job", action: "queued" }));
		expect(h.stream).not.toHaveBeenCalled();
	});

	it("wakes once per finished same-session job and points at subagent_results", async () => {
		const h = (active = harness());
		await h.engage();
		h.job({ sessionId: "other-session", id: "w1", state: "pending" });
		h.job({ id: "w1", state: "pending" });
		await h.endTurn();
		await h.on("agent_settled");
		await vi.waitFor(() => expect(h.appendEntry).toHaveBeenCalledWith("goal-evaluation", expect.objectContaining({ decision: "wait" })));
		expect(h.sendUserMessage).not.toHaveBeenCalled();

		h.job({ sessionId: "other-session", id: "w1", state: "finished" });
		await h.settle();
		expect(h.sendUserMessage).not.toHaveBeenCalled();
		h.job({ id: "w1", state: "finished" });
		h.job({ id: "w1", state: "finished" });
		await vi.waitFor(() => expect(h.sendUserMessage).toHaveBeenCalledOnce());
		expect(h.sendUserMessage).toHaveBeenCalledWith("继续目标", { deliverAs: "followUp" });
		expect(h.appendEntry).toHaveBeenCalledWith("goal-continuation", expect.objectContaining({ action: "queued", source: "workbench-job" }));

		await h.on("input", { text: "继续目标", source: "extension" });
		const next = await h.on("before_agent_start", { prompt: "继续目标", systemPrompt: "base" });
		expect(next.message.content).toContain("subagent_results");
		expect(next.message.content).toContain('[\\"w1\\"]');
		expect(next.message.content).toContain("Review branch; finished");
		h.job({ id: "w1", state: "finished" });
		await h.settle();
		expect(h.sendUserMessage).toHaveBeenCalledOnce();
	});

	it("keeps collecting real job results past the former six-round limit", async () => {
		const h = (active = harness());
		await h.engage();
		for (let round = 1; round <= 8; round++) {
			const id = `review-${round}`;
			h.job({ id, state: "pending" });
			h.job({ id, state: "finished" });
			await vi.waitFor(() => expect(h.sendUserMessage).toHaveBeenCalledTimes(round));
			await h.on("input", { text: "继续目标", source: "extension" });
			const next = await h.on("before_agent_start", { prompt: "继续目标", systemPrompt: "base" });
			expect(next.message.content).toContain(id);
		}
		expect(h.appendEntry.mock.calls.filter(([type, data]) => type === "goal-continuation" && data.source === "workbench-job")).toHaveLength(8);
	});

	it("ignores jobs reported before the goal run is engaged", async () => {
		const h = (active = harness());
		await h.on("session_start");
		h.job({ id: "w1", state: "pending" });
		h.job({ id: "w1", state: "finished" });
		await h.settle();
		expect(h.sendUserMessage).not.toHaveBeenCalled();
		expect(h.stream).not.toHaveBeenCalled();
	});

	it("does not wake for results already collected with subagent_results", async () => {
		const h = (active = harness());
		await h.engage();
		h.setIdle(false);
		h.job({ id: "w1", state: "pending" });
		h.job({ id: "w2", state: "pending" });
		h.job({ id: "w2", state: "finished" });
		// Collected in the same run: one before its terminal event, one after.
		await h.on("tool_result", { toolName: "subagent_results", isError: false, input: { mode: "wait", workIds: ["w1", "w2"] }, details: { mode: "wait", completed: [{ workId: "w1" }, { workId: "w2" }], pending: [] } });
		h.job({ id: "w1", state: "finished" });
		await h.endTurn("GOAL_HANDOFF\nEvidence: reviewed both outputs");
		h.setIdle(true);
		await h.on("agent_settled");
		await vi.waitFor(() => expect(h.stream).toHaveBeenCalledOnce());
		const snapshot = JSON.parse((h.stream.mock.calls[0] as unknown as [unknown, { messages: { content: string }[] }])[1].messages[0].content);
		expect(snapshot.jobs).toEqual([]);
		expect(h.appendEntry).not.toHaveBeenCalledWith("goal-continuation", expect.objectContaining({ source: "workbench-job" }));
	});

	it("status-only reads do not count as collection", async () => {
		const h = (active = harness());
		await h.engage();
		h.job({ id: "w1", state: "pending" });
		h.setIdle(false);
		h.job({ id: "w1", state: "finished" });
		await h.on("tool_result", { toolName: "subagent_results", isError: false, input: { mode: "status" }, details: { mode: "status", completed: [{ workId: "w1" }] } });
		await h.endTurn();
		h.setIdle(true);
		await h.on("agent_settled");
		await vi.waitFor(() => expect(h.sendUserMessage).toHaveBeenCalledOnce());
		expect(h.stream).not.toHaveBeenCalled();
	});

	it("treats a cancelled subagent as neither a wake nor a stop", async () => {
		const h = (active = harness());
		await h.engage();
		h.job({ id: "w1", state: "pending" });
		h.job({ id: "w2", state: "pending" });
		h.job({ id: "w1", state: "cancelled" });
		await h.settle();
		expect(h.sendUserMessage).not.toHaveBeenCalled();
		h.job({ id: "w2", state: "failed" });
		await vi.waitFor(() => expect(h.sendUserMessage).toHaveBeenCalledOnce());
		await h.on("input", { text: "继续目标", source: "extension" });
		const next = await h.on("before_agent_start", { prompt: "继续目标", systemPrompt: "base" });
		expect(next.message.content).toContain("w2 (Review branch; failed)");
		expect(next.message.content).not.toContain("w1");
	});

	it("notices a job finishing while a continuation is already queued without a second wake", async () => {
		const h = (active = harness());
		await h.engage();
		h.job({ id: "w1", state: "pending" });
		h.job({ id: "w2", state: "pending" });
		h.job({ id: "w1", state: "finished" });
		await vi.waitFor(() => expect(h.sendUserMessage).toHaveBeenCalledOnce());
		h.job({ id: "w2", state: "finished" });
		await h.settle();
		await h.on("input", { text: "继续目标", source: "extension" });
		const next = await h.on("before_agent_start", { prompt: "继续目标", systemPrompt: "base" });
		expect(next.message.content).toContain("w1 (Review branch; finished)");
		expect(next.message.content).toContain("w2 (Review branch; finished)");
		await h.endTurn("GOAL_HANDOFF\nEvidence: collected w1 and w2");
		await h.on("agent_settled");
		await vi.waitFor(() => expect(h.sendUserMessage).toHaveBeenCalledTimes(2));
		expect(h.appendEntry.mock.calls.filter(([kind, data]) => kind === "goal-continuation" && data.source === "workbench-job" && data.action === "queued")).toHaveLength(1);
	});

	it("drops pending jobs when the user takes over with interactive input", async () => {
		const h = (active = harness());
		await h.engage();
		h.job({ id: "w1", state: "pending" });
		await h.on("input", { text: "stop and explain", source: "interactive" });
		h.job({ id: "w1", state: "finished" });
		await h.settle();
		expect(h.sendUserMessage).not.toHaveBeenCalled();
	});

	it("rechecks an open hard blocker once per blocker set instead of stalling on uncertainty", async () => {
		const h = (active = harness('{"decision":"uncertain","reason":"Blocked on a user decision and no ready action remains"}'));
		const base = { goalId: h.goal.goalId, acceptanceCriteriaIds: [], updatedAt: 2 };
		const blocker = {
			id: "mem-budget", goalId: h.goal.goalId, title: "Raise the sandbox memory budget", reason: "Needs the user to approve a larger budget",
			kind: "user_decision", disposition: "needs_user", state: "open", workItemIds: ["s2"],
			owner: "user", createdAt: 2, updatedAt: 2,
		};
		h.branch.push({ type: "custom", id: "graph", customType: "goal-state", data: { action: "graph", state: {
			...h.goal,
			workItems: [
				{ ...base, id: "m1", title: "Set baseline", horizon: "mid", state: "done", dependsOn: [] },
				{ ...base, id: "m2", title: "Prove the theorem", horizon: "mid", state: "in_progress", dependsOn: ["m1"] },
				{ ...base, id: "s1", title: "Existing certificates", horizon: "short", parentId: "m2", state: "done", dependsOn: [] },
				{ ...base, id: "s2", title: "Replay under a larger budget", horizon: "short", parentId: "m2", state: "in_progress", dependsOn: [] },
				{ ...base, id: "m3", title: "Write the paper", horizon: "mid", state: "todo", dependsOn: ["m2"] },
				{ ...base, id: "s3", title: "Draft the manuscript", horizon: "short", parentId: "m3", state: "todo", dependsOn: [] },
			],
			blockers: [blocker],
		} } });
		await h.engage();
		await h.endTurn("GOAL_HANDOFF\nBlocked: the memory budget needs a user decision.");
		await h.on("agent_settled");
		await vi.waitFor(() => expect(h.sendUserMessage).toHaveBeenCalledOnce());
		expect(h.appendEntry).toHaveBeenCalledWith("goal-evaluation", expect.objectContaining({ decision: "uncertain", fallback: "blocker-recheck" }));
		expect(h.appendEntry).toHaveBeenCalledWith("goal-scheduler", expect.objectContaining({ state: "blocker-recheck" }));
		expect(h.appendEntry).toHaveBeenCalledWith("goal-continuation", expect.objectContaining({ source: "blocker-recheck", action: "queued" }));
		h.sendUserMessage.mockClear();
		h.appendEntry.mockClear();
		await h.on("input", { text: "继续目标", source: "extension" });
		await h.on("before_agent_start", { prompt: "继续目标", systemPrompt: "base" });
		await h.endTurn("GOAL_HANDOFF\nStill waiting on the same user decision.");
		await h.on("agent_settled");
		await vi.waitFor(() => expect(h.appendEntry).toHaveBeenCalledWith("goal-evaluation", expect.objectContaining({ decision: "uncertain", fallback: undefined })));
		await h.settle();
		expect(h.sendUserMessage).not.toHaveBeenCalled();
	});
});
