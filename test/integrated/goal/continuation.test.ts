import { describe, expect, it, vi } from "vitest";
import {
	createGoalContinuationState,
	maybeQueueGoalContinuation,
	registerGoalRuntime,
} from "pi-tsien-goal/src/runtime.ts";
import { saveGoalState } from "pi-tsien-goal/src/state.ts";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { GoalState, GoalStateEntry, GoalStateEvent } from "pi-tsien-goal/src/types.ts";

function persist(event: GoalStateEvent, current: GoalState | null) {
	const appendEntry = vi.fn();
	const state = saveGoalState({ appendEntry }, event, current);
	return { entry: appendEntry.mock.calls[0][1] as GoalStateEntry, state };
}

function goalEntry(data: GoalStateEntry, timestamp = 0) {
	return { type: "custom", id: crypto.randomUUID(), timestamp, customType: "goal-state", data };
}

function createGoal() {
	return persist(
		{
			action: "create",
			goalId: "goal-1",
			objective: "Keep pursuing the goal",
			now: 0,
			acceptanceCriteria: ["Continue safely"],
		},
		null,
	);
}

function createHarness(branch: Array<{ type: string; customType?: string; data?: unknown }> = []) {
	const appendEntry = vi.fn();
	const sendUserMessage = vi.fn();
	const ctx = {
		sessionManager: { getBranch: vi.fn(() => branch) },
		isIdle: vi.fn(() => false),
		hasPendingMessages: vi.fn(() => true),
		ui: { setStatus: vi.fn(), setWidget: vi.fn() },
	};
	const api = {
		appendEntry,
		sendUserMessage,
		getFlag: vi.fn((name: string): unknown => (name === "goal-continuation" ? true : undefined)),
	};
	return { api, appendEntry, branch, ctx, sendUserMessage };
}

describe("goal continuation", () => {
	it("queues one follow-up for an active goal without checking idle or pending messages", async () => {
		const created = createGoal();
		const { api, ctx, sendUserMessage } = createHarness([goalEntry(created.entry)]);
		const state = createGoalContinuationState();

		await expect(maybeQueueGoalContinuation(api, state, ctx)).resolves.toMatchObject({
			queued: true,
			goalId: "goal-1",
		});
		expect(sendUserMessage).toHaveBeenCalledWith("继续目标", { deliverAs: "followUp" });
	});

	it("does not queue when continuation is disabled", async () => {
		const created = createGoal();
		const { api, ctx, sendUserMessage } = createHarness([goalEntry(created.entry)]);
		api.getFlag.mockReturnValue(false);

		await expect(maybeQueueGoalContinuation(api, createGoalContinuationState(), ctx)).resolves.toMatchObject({
			queued: false,
			reason: "disabled",
		});
		expect(sendUserMessage).not.toHaveBeenCalled();
	});

	it("allows only one queued follow-up", async () => {
		const created = createGoal();
		const { api, ctx, sendUserMessage } = createHarness([goalEntry(created.entry)]);
		const state = createGoalContinuationState();

		await maybeQueueGoalContinuation(api, state, ctx);
		await expect(maybeQueueGoalContinuation(api, state, ctx)).resolves.toMatchObject({
			queued: false,
			reason: "duplicate-queue",
		});
		expect(sendUserMessage).toHaveBeenCalledOnce();
	});

	it("does not queue paused or complete goals", async () => {
		const created = createGoal();
		const paused = persist({ action: "pause", goalId: "goal-1", now: 1, reason: "Waiting for input" }, created.state);
		const completed = persist({ action: "complete", goalId: "goal-1", now: 1 }, created.state);

		for (const entry of [paused.entry, completed.entry]) {
			const { api, ctx } = createHarness([goalEntry(created.entry), goalEntry(entry)]);
			await expect(maybeQueueGoalContinuation(api, createGoalContinuationState(), ctx)).resolves.toMatchObject({
				queued: false,
				reason: "not-active",
			});
		}
	});

	it.each(["provider/model", "off"])("does not inject periodic continuation with %s", async (models) => {
		vi.useFakeTimers();
		try {
			const handlers = new Map<string, (event: unknown, ctx: never) => Promise<unknown>>();
			const { api, ctx, sendUserMessage } = createHarness([goalEntry(createGoal().entry)]);
			registerGoalRuntime({ ...api, getFlag: (name: string) => name === "goal-evaluator-models" ? models : undefined,
				on: (event: string, handler: never) => handlers.set(event, handler),
			} as unknown as ExtensionAPI);
			await handlers.get("session_start")?.({}, ctx as never);
			await vi.advanceTimersByTimeAsync(60 * 60_000);
			expect(sendUserMessage).not.toHaveBeenCalled();
			await handlers.get("session_shutdown")?.({}, ctx as never);
		} finally {
			vi.useRealTimers();
		}
	});
});
