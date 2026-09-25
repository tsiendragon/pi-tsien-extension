import { describe, expect, it, vi } from "vitest";
import {
	createGoalContinuationState,
	GOAL_CONTINUATION_CUSTOM_TYPE,
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

	it("honors a one-minute interval configuration", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		try {
			const handlers = new Map<string, (event: unknown, ctx: never) => Promise<unknown>>();
			const created = createGoal();
			const branch: Array<{ type: string; id?: string; timestamp?: number; customType?: string; data?: unknown }> = [
				goalEntry(created.entry, 0),
			];
			const pi = {
				registerFlag: vi.fn(),
				on: vi.fn((event: string, handler) => handlers.set(event, handler)),
				appendEntry: vi.fn((customType: string, data: unknown) =>
					branch.push({ type: "custom", id: crypto.randomUUID(), timestamp: Date.now(), customType, data }),
				),
				sendUserMessage: vi.fn(),
				getFlag: vi.fn((name: string) => {
					if (name === "goal-continuation") return true;
					if (name === "goal-continuation-interval-minutes") return "1";
					return undefined;
				}),
			} as unknown as ExtensionAPI;
			const ctx = {
				sessionManager: { getBranch: vi.fn(() => branch) },
				ui: { setStatus: vi.fn(), setWidget: vi.fn() },
			};

			registerGoalRuntime(pi);
			await handlers.get("session_start")?.({}, ctx as never);
			await vi.advanceTimersByTimeAsync(60_000 - 1);
			expect((pi as unknown as { sendUserMessage: ReturnType<typeof vi.fn> }).sendUserMessage).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(1);
			expect((pi as unknown as { sendUserMessage: ReturnType<typeof vi.fn> }).sendUserMessage).toHaveBeenCalledWith(
				"继续目标",
				{ deliverAs: "followUp" },
			);
			await handlers.get("session_shutdown")?.({}, ctx as never);
		} finally {
			vi.useRealTimers();
		}
	});

	it("fires every 20 minutes by default and cleans up on shutdown", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		try {
			const handlers = new Map<string, (event: unknown, ctx: never) => Promise<unknown>>();
			const created = createGoal();
			const branch: Array<{ type: string; id?: string; timestamp?: number; customType?: string; data?: unknown }> = [
				goalEntry(created.entry, 0),
			];
			const pi = {
				registerFlag: vi.fn(),
				on: vi.fn((event: string, handler) => handlers.set(event, handler)),
				appendEntry: vi.fn((customType: string, data: unknown) =>
					branch.push({ type: "custom", id: crypto.randomUUID(), timestamp: Date.now(), customType, data }),
				),
				sendUserMessage: vi.fn(),
				getFlag: vi.fn((name: string) => (name === "goal-continuation" ? true : undefined)),
			} as unknown as ExtensionAPI;
			const ctx = {
				sessionManager: { getBranch: vi.fn(() => branch) },
				ui: { setStatus: vi.fn(), setWidget: vi.fn() },
			};

			registerGoalRuntime(pi);
			await handlers.get("session_start")?.({}, ctx as never);
			await vi.advanceTimersByTimeAsync(20 * 60 * 1000 - 1);
			expect((pi as unknown as { sendUserMessage: ReturnType<typeof vi.fn> }).sendUserMessage).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(1);
			expect((pi as unknown as { sendUserMessage: ReturnType<typeof vi.fn> }).sendUserMessage).toHaveBeenCalledWith(
				"继续目标",
				{ deliverAs: "followUp" },
			);
			expect((pi as unknown as { appendEntry: ReturnType<typeof vi.fn> }).appendEntry).toHaveBeenCalledWith(
				GOAL_CONTINUATION_CUSTOM_TYPE,
				expect.objectContaining({ action: "queued", source: "timer" }),
			);

			await handlers.get("input")?.({ text: "继续目标" }, ctx as never);
			await vi.advanceTimersByTimeAsync(20 * 60 * 1000);
			expect((pi as unknown as { sendUserMessage: ReturnType<typeof vi.fn> }).sendUserMessage).toHaveBeenCalledTimes(2);

			await handlers.get("session_shutdown")?.({}, ctx as never);
			await vi.advanceTimersByTimeAsync(20 * 60 * 1000);
			expect((pi as unknown as { sendUserMessage: ReturnType<typeof vi.fn> }).sendUserMessage).toHaveBeenCalledTimes(2);
		} finally {
			vi.useRealTimers();
		}
	});
});
