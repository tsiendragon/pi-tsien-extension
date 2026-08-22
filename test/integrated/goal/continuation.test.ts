import { describe, expect, it, vi } from "vitest";
import {
	createGoalContinuationState,
	finishRunningGoalContinuation,
	GOAL_CONTINUATION_CUSTOM_TYPE,
	maybeQueueGoalContinuation,
	registerGoalRuntime,
	startQueuedGoalContinuation,
	stopGoalContinuation,
} from "../../../extensions/goal/src/runtime.ts";
import { saveGoalState } from "../../../extensions/goal/src/state.ts";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { GoalState, GoalStateEntry, GoalStateEvent } from "../../../extensions/goal/src/types.ts";

function persist(event: GoalStateEvent, current: GoalState | null) {
	const appendEntry = vi.fn();
	const state = saveGoalState({ appendEntry }, event, current);
	return { entry: appendEntry.mock.calls[0][1] as GoalStateEntry, state };
}

function customEntry(data: GoalStateEntry) {
	return { type: "custom", customType: "goal-state", data };
}

function queuedContinuationEntry() {
	return {
		type: "custom",
		customType: GOAL_CONTINUATION_CUSTOM_TYPE,
		data: {
			action: "queued",
			goalId: "goal-1",
			at: 10,
			turnCount: 0,
			workItemId: "criterion-1",
			source: "watchdog",
		},
	};
}

function startedContinuationEntry() {
	return {
		type: "custom",
		customType: GOAL_CONTINUATION_CUSTOM_TYPE,
		data: {
			action: "started",
			goalId: "goal-1",
			at: 20,
			turnCount: 1,
			workItemId: "criterion-1",
		},
	};
}

function createGoal() {
	return persist(
		{
			action: "create",
			goalId: "goal-1",
			objective: "Finish continuation safely",
			now: 1,
			acceptanceCriteria: ["queues only when idle"],
			progress: { lastSummary: "created" },
		},
		null,
	);
}

function createHarness(
	options: {
		enabled?: boolean;
		maxTurns?: number | string;
		maxDurationHours?: number | string;
		maxNoProgressTurns?: number | string;
		idle?: boolean;
		pending?: boolean;
		branch?: Array<{ type: string; customType?: string; data?: unknown }>;
	} = {},
) {
	const appendEntry = vi.fn();
	const sendUserMessage = vi.fn();
	const ui = { setStatus: vi.fn(), notify: vi.fn() };
	const ctx = {
		sessionManager: { getBranch: vi.fn(() => options.branch ?? []) },
		isIdle: vi.fn(() => options.idle ?? true),
		hasPendingMessages: vi.fn(() => options.pending ?? false),
		ui,
	};
	const api = {
		appendEntry,
		sendUserMessage,
		getFlag: vi.fn((name: string) => {
			if (name === "goal-continuation") return options.enabled ?? false;
			if (name === "goal-continuation-max-turns") return options.maxTurns;
			if (name === "goal-continuation-max-duration-hours") return options.maxDurationHours;
			if (name === "goal-continuation-max-no-progress-turns") return options.maxNoProgressTurns;
			return undefined;
		}),
	};
	return { api, ctx, appendEntry, sendUserMessage, ui };
}

describe("goal continuation scheduler", () => {
	it("stops when continuation is explicitly disabled", async () => {
		const created = createGoal();
		const { api, ctx, sendUserMessage } = createHarness({ branch: [customEntry(created.entry)] });
		const state = createGoalContinuationState();

		await expect(maybeQueueGoalContinuation(api, state, ctx, 10)).resolves.toEqual({
			queued: false,
			reason: "disabled",
		});
		expect(sendUserMessage).not.toHaveBeenCalled();
	});

	it("continues by default when no disabling flag value is supplied", async () => {
		const created = createGoal();
		const { api, ctx, sendUserMessage } = createHarness({ branch: [customEntry(created.entry)] });
		api.getFlag.mockImplementation((name: string) => (name === "goal-continuation" ? undefined : undefined));
		await expect(
			maybeQueueGoalContinuation(api, createGoalContinuationState(), ctx, 10),
		).resolves.toMatchObject({ queued: true, goalId: "goal-1" });
		expect(sendUserMessage).toHaveBeenCalledOnce();
	});

	it("records watchdog as the source of a queued continuation", async () => {
		const created = createGoal();
		const { api, ctx, appendEntry } = createHarness({
			enabled: true,
			branch: [customEntry(created.entry)],
		});

		await maybeQueueGoalContinuation(api, createGoalContinuationState(), ctx, 10, "watchdog");

		expect(appendEntry).toHaveBeenCalledWith(
			GOAL_CONTINUATION_CUSTOM_TYPE,
			expect.objectContaining({ action: "queued", source: "watchdog" }),
		);
	});

	it("queues a requested continuation only when active, idle, and no pending messages exist", async () => {
		const created = createGoal();
		const { api, ctx, appendEntry, sendUserMessage, ui } = createHarness({
			enabled: true,
			branch: [customEntry(created.entry)],
		});
		const state = createGoalContinuationState();

		const decision = await maybeQueueGoalContinuation(api, state, ctx, 10);

		expect(decision).toEqual({ queued: true, goalId: "goal-1" });
		expect(sendUserMessage).toHaveBeenCalledWith("继续目标", { deliverAs: "followUp" });
		expect(appendEntry).toHaveBeenCalledWith(
			GOAL_CONTINUATION_CUSTOM_TYPE,
			expect.objectContaining({ action: "queued", goalId: "goal-1", turnCount: 0 }),
		);
		expect(ui.setStatus).toHaveBeenLastCalledWith("goal-continuation", "goal: continuation queued");
	});

	it("does not queue while busy or while user messages are pending", async () => {
		const created = createGoal();
		const busy = createHarness({ enabled: true, idle: false, branch: [customEntry(created.entry)] });
		await expect(
			maybeQueueGoalContinuation(busy.api, createGoalContinuationState(), busy.ctx),
		).resolves.toMatchObject({
			queued: false,
			reason: "busy",
		});

		const pending = createHarness({ enabled: true, pending: true, branch: [customEntry(created.entry)] });
		await expect(
			maybeQueueGoalContinuation(pending.api, createGoalContinuationState(), pending.ctx),
		).resolves.toMatchObject({ queued: false, reason: "pending-messages" });
	});

	it("does not queue for paused, complete, or cleared goals", async () => {
		const created = createGoal();
		const paused = persist({ action: "pause", goalId: "goal-1", now: 2 }, created.state);
		const completed = persist({ action: "complete", goalId: "goal-1", now: 3 }, created.state);
		const cleared = persist({ action: "clear", goalId: "goal-1", now: 4 }, created.state);

		for (const entry of [paused.entry, completed.entry, cleared.entry]) {
			const { api, ctx } = createHarness({
				enabled: true,
				branch: [customEntry(created.entry), customEntry(entry)],
			});
			await expect(
				maybeQueueGoalContinuation(api, createGoalContinuationState(), ctx),
			).resolves.toMatchObject({
				queued: false,
				reason: "not-active",
			});
		}
	});

	it("prevents duplicate queueing", async () => {
		const created = createGoal();
		const { api, ctx, sendUserMessage } = createHarness({
			enabled: true,
			branch: [customEntry(created.entry)],
		});
		const state = createGoalContinuationState();

		await maybeQueueGoalContinuation(api, state, ctx);
		await expect(maybeQueueGoalContinuation(api, state, ctx)).resolves.toMatchObject({
			queued: false,
			reason: "duplicate-queue",
			goalId: "goal-1",
		});
		expect(sendUserMessage).toHaveBeenCalledTimes(1);
	});

	it("does not overwrite a terminal stop reason during shutdown cleanup", () => {
		const created = createGoal();
		const state = createGoalContinuationState();
		state.stoppedGoalId = "goal-1";
		state.stoppedReason = "max-turns";
		const { api, appendEntry } = createHarness({ branch: [customEntry(created.entry)] });

		stopGoalContinuation(api, state, "stale-goal", 20);

		expect(state.stoppedReason).toBe("max-turns");
		expect(appendEntry).not.toHaveBeenCalled();
	});

	it("hydrates an unconsumed watchdog queue after reload", async () => {
		const created = createGoal();
		const queued = {
			type: "custom",
			customType: GOAL_CONTINUATION_CUSTOM_TYPE,
			data: {
				action: "queued",
				goalId: "goal-1",
				at: 10,
				turnCount: 0,
				workItemId: "criterion-1",
				source: "watchdog",
			},
		};
		const state = createGoalContinuationState();
		const { api, ctx, sendUserMessage } = createHarness({
			enabled: true,
			branch: [customEntry(created.entry), queued],
		});

		await expect(maybeQueueGoalContinuation(api, state, ctx, 20)).resolves.toMatchObject({
			queued: false,
			reason: "duplicate-queue",
			goalId: "goal-1",
		});
		expect(state.queuedGoalId).toBe("goal-1");
		expect(sendUserMessage).not.toHaveBeenCalled();
	});

	it("restores a running continuation after reload and prevents duplicate queueing", async () => {
		const created = createGoal();
		const state = createGoalContinuationState();
		const { api, ctx, sendUserMessage } = createHarness({
			enabled: true,
			branch: [customEntry(created.entry), queuedContinuationEntry(), startedContinuationEntry()],
		});

		await expect(maybeQueueGoalContinuation(api, state, ctx, 30)).resolves.toMatchObject({
			queued: false,
			reason: "duplicate-queue",
			goalId: "goal-1",
		});
		expect(state.runningGoalId).toBe("goal-1");
		expect(sendUserMessage).not.toHaveBeenCalled();
	});

	it("re-checks goalId before marking queued continuation as running", () => {
		const created = createGoal();
		const replacement = persist(
			{ action: "replace", goalId: "goal-2", objective: "Replacement", now: 2 },
			created.state,
		);
		const state = createGoalContinuationState();
		state.queuedGoalId = "goal-1";
		const { api, ctx, appendEntry } = createHarness({
			enabled: true,
			branch: [customEntry(created.entry), customEntry(replacement.entry)],
		});

		startQueuedGoalContinuation(api, state, ctx, 20);

		expect(state.runningGoalId).toBeUndefined();
		expect(state.stoppedReason).toBe("stale-goal");
		expect(appendEntry).toHaveBeenCalledWith(
			GOAL_CONTINUATION_CUSTOM_TYPE,
			expect.objectContaining({ action: "stopped", goalId: "goal-1", reason: "stale-goal" }),
		);
	});

	it("marks a queued continuation running and updates UI", () => {
		const created = createGoal();
		const state = createGoalContinuationState();
		state.queuedGoalId = "goal-1";
		const { api, ctx, ui } = createHarness({ enabled: true, branch: [customEntry(created.entry)] });

		startQueuedGoalContinuation(api, state, ctx, 20);

		expect(state.runningGoalId).toBe("goal-1");
		expect(state.queuedGoalId).toBeUndefined();
		expect(ui.setStatus).toHaveBeenLastCalledWith("goal-continuation", "goal: continuation running");
	});

	it("does not start a persisted queued continuation when explicitly disabled", () => {
		const created = createGoal();
		const state = createGoalContinuationState();
		state.queuedGoalId = "goal-1";
		const { api, ctx, appendEntry } = createHarness({ enabled: false, branch: [customEntry(created.entry)] });

		startQueuedGoalContinuation(api, state, ctx, 20);

		expect(state.runningGoalId).toBeUndefined();
		expect(state.queuedGoalId).toBeUndefined();
		expect(state.stoppedReason).toBe("disabled");
		expect(appendEntry).toHaveBeenCalledWith(
			GOAL_CONTINUATION_CUSTOM_TYPE,
			expect.objectContaining({ action: "stopped", goalId: "goal-1", reason: "disabled" }),
		);
	});

	it("stops running continuation when the goal is paused, completed, cleared, or replaced", () => {
		const created = createGoal();
		const paused = persist({ action: "pause", goalId: "goal-1", now: 2 }, created.state);
		const completed = persist({ action: "complete", goalId: "goal-1", now: 3 }, created.state);
		const cleared = persist({ action: "clear", goalId: "goal-1", now: 4 }, created.state);
		const replaced = persist(
			{ action: "replace", goalId: "goal-2", objective: "Replacement", now: 5 },
			created.state,
		);

		for (const entry of [paused.entry, completed.entry, cleared.entry, replaced.entry]) {
			const branch = [customEntry(created.entry)];
			const state = createGoalContinuationState();
			state.queuedGoalId = "goal-1";
			const { api, ctx } = createHarness({ enabled: true, branch });
			startQueuedGoalContinuation(api, state, ctx, 20);
			branch.push(customEntry(entry));

			expect(finishRunningGoalContinuation(api, state, ctx, 30)).toBe("stale-goal");
			expect(state.stoppedReason).toBe("stale-goal");
		}
	});

	it("stops after the configured consecutive no-progress budget", () => {
		const created = createGoal();
		const state = createGoalContinuationState();
		state.queuedGoalId = "goal-1";
		const { api, ctx } = createHarness({
			enabled: true,
			maxNoProgressTurns: 1,
			branch: [customEntry(created.entry)],
		});
		startQueuedGoalContinuation(api, state, ctx, 20);

		const reason = finishRunningGoalContinuation(api, state, ctx, 30);

		expect(reason).toBe("no-progress-budget");
		expect(state.stoppedReason).toBe("no-progress-budget");
		expect(api.appendEntry).toHaveBeenLastCalledWith(
			GOAL_CONTINUATION_CUSTOM_TYPE,
			expect.objectContaining({ action: "stopped", reason: "no-progress-budget", turnCount: 1 }),
		);
	});

	it("stops after the configured wall-clock duration budget", async () => {
		const created = createGoal();
		const state = createGoalContinuationState();
		const { api, ctx } = createHarness({
			enabled: true,
			maxDurationHours: 1,
			branch: [customEntry(created.entry)],
		});

		await maybeQueueGoalContinuation(api, state, ctx, 0);
		state.queuedGoalId = undefined;
		await expect(maybeQueueGoalContinuation(api, state, ctx, 60 * 60 * 1000)).resolves.toMatchObject({
			queued: false,
			reason: "duration-budget",
			goalId: "goal-1",
		});
	});

	it("continues after progress but stops at max turn cap", async () => {
		const created = createGoal();
		const progress = persist(
			{
				action: "progress",
				goalId: "goal-1",
				now: 2,
				progress: { lastSummary: "made progress" },
			},
			created.state,
		);
		const branch = [customEntry(created.entry)];
		const state = createGoalContinuationState();
		state.queuedGoalId = "goal-1";
		const { api, ctx } = createHarness({
			enabled: true,
			maxTurns: "1",
			branch,
		});
		startQueuedGoalContinuation(api, state, ctx, 20);
		branch.push(customEntry(progress.entry));
		const reason = finishRunningGoalContinuation(api, state, ctx, 30);

		expect(reason).toBe("max-turns");
		await expect(maybeQueueGoalContinuation(api, state, ctx)).resolves.toMatchObject({
			queued: false,
			reason: "max-turns",
		});
	});

	it("registered hooks never treat settled as a continuation trigger", async () => {
		const handlers = new Map<string, (event: unknown, ctx?: unknown) => Promise<unknown>>();
		const pi = {
			registerFlag: vi.fn(),
			on: vi.fn((event: string, handler) => handlers.set(event, handler)),
			appendEntry: vi.fn(),
			sendUserMessage: vi.fn(),
			getFlag: vi.fn((name: string) => (name === "goal-continuation" ? true : undefined)),
		} as unknown as ExtensionAPI;
		const created = createGoal();
		const ctx = {
			sessionManager: { getBranch: vi.fn(() => [customEntry(created.entry)]) },
			isIdle: vi.fn(() => true),
			hasPendingMessages: vi.fn(() => true),
			ui: { setStatus: vi.fn() },
		};

		registerGoalRuntime(pi);
		expect(handlers.has("agent_end")).toBe(false);
		await handlers.get("agent_settled")?.({}, ctx);
		ctx.hasPendingMessages.mockReturnValue(false);
		await handlers.get("agent_settled")?.({}, ctx);
		await handlers.get("agent_settled")?.({}, ctx);

		expect(
			(pi as unknown as { sendUserMessage: ReturnType<typeof vi.fn> }).sendUserMessage,
		).not.toHaveBeenCalled();
		await handlers.get("session_shutdown")?.({}, ctx);
	});

	it("does not queue immediately when the agent settles", async () => {
		const handlers = new Map<string, (event: unknown, ctx?: unknown) => Promise<unknown>>();
		const pi = {
			registerFlag: vi.fn(),
			on: vi.fn((event: string, handler) => handlers.set(event, handler)),
			appendEntry: vi.fn(),
			sendUserMessage: vi.fn(),
			getFlag: vi.fn((name: string) =>
				name === "goal-continuation" || name === "goal-continuation-watchdog" ? true : undefined,
			),
		} as unknown as ExtensionAPI;
		const created = createGoal();
		const ctx = {
			sessionManager: { getBranch: vi.fn(() => [customEntry(created.entry)]) },
			isIdle: vi.fn(() => true),
			hasPendingMessages: vi.fn(() => false),
			ui: { setStatus: vi.fn(), setWidget: vi.fn() },
		};

		registerGoalRuntime(pi);
		await handlers.get("agent_settled")?.({}, ctx);

		expect(
			(pi as unknown as { sendUserMessage: ReturnType<typeof vi.fn> }).sendUserMessage,
		).not.toHaveBeenCalled();
		await handlers.get("session_shutdown")?.({}, ctx);
	});

	it("uses a default silence threshold of 30 minutes", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		try {
			const handlers = new Map<string, (event: unknown, ctx?: unknown) => Promise<unknown>>();
			const created = createGoal();
			const branch = [{ ...customEntry(created.entry), id: "goal-create", timestamp: 0 }];
			const pi = {
				registerFlag: vi.fn(),
				on: vi.fn((event: string, handler) => handlers.set(event, handler)),
				appendEntry: vi.fn(),
				sendUserMessage: vi.fn(),
				getFlag: vi.fn((name: string) =>
					name === "goal-continuation" || name === "goal-continuation-watchdog" ? true : undefined,
				),
			} as unknown as ExtensionAPI;
			const ctx = {
				sessionManager: { getBranch: vi.fn(() => branch) },
				isIdle: vi.fn(() => true),
				hasPendingMessages: vi.fn(() => false),
				ui: { setStatus: vi.fn(), setWidget: vi.fn() },
			};

			registerGoalRuntime(pi);
			await handlers.get("session_start")?.({}, ctx);
			await vi.advanceTimersByTimeAsync(30 * 60 * 1000 - 1);
			expect(
				(pi as unknown as { sendUserMessage: ReturnType<typeof vi.fn> }).sendUserMessage,
			).not.toHaveBeenCalled();

			await vi.advanceTimersByTimeAsync(1);
			expect(
				(pi as unknown as { sendUserMessage: ReturnType<typeof vi.fn> }).sendUserMessage,
			).toHaveBeenCalledWith("继续目标", { deliverAs: "followUp" });
			await handlers.get("session_shutdown")?.({}, ctx);
		} finally {
			vi.useRealTimers();
		}
	});

	it("honors a configured 60-minute silence threshold", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		try {
			const handlers = new Map<string, (event: unknown, ctx?: unknown) => Promise<unknown>>();
			const branch: Array<{
				type: string;
				id?: string;
				timestamp?: number;
				customType?: string;
				data?: unknown;
			}> = [];
			const created = createGoal();
			branch.push({ ...customEntry(created.entry), id: "goal-create", timestamp: 0 });
			const pi = {
				registerFlag: vi.fn(),
				on: vi.fn((event: string, handler) => handlers.set(event, handler)),
				appendEntry: vi.fn((customType: string, data: unknown) =>
					branch.push({
						type: "custom",
						id: `entry-${branch.length}`,
						timestamp: Date.now(),
						customType,
						data,
					}),
				),
				sendUserMessage: vi.fn(),
				getFlag: vi.fn((name: string) => {
					if (name === "goal-continuation" || name === "goal-continuation-watchdog") return true;
					if (name === "goal-continuation-watchdog-silence-minutes") return "60";
					return undefined;
				}),
			} as unknown as ExtensionAPI;
			const ctx = {
				sessionManager: { getBranch: vi.fn(() => branch) },
				isIdle: vi.fn(() => true),
				hasPendingMessages: vi.fn(() => false),
				ui: { setStatus: vi.fn(), setWidget: vi.fn() },
			};

			registerGoalRuntime(pi);
			await handlers.get("session_start")?.({}, ctx);
			await vi.advanceTimersByTimeAsync(60 * 60 * 1000 - 1);
			expect(
				(pi as unknown as { sendUserMessage: ReturnType<typeof vi.fn> }).sendUserMessage,
			).not.toHaveBeenCalled();

			await vi.advanceTimersByTimeAsync(1);
			expect(
				(pi as unknown as { sendUserMessage: ReturnType<typeof vi.fn> }).sendUserMessage,
			).toHaveBeenCalledOnce();
			expect((pi as unknown as { appendEntry: ReturnType<typeof vi.fn> }).appendEntry).toHaveBeenCalledWith(
				GOAL_CONTINUATION_CUSTOM_TYPE,
				expect.objectContaining({ action: "queued", source: "watchdog" }),
			);

			await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000);
			expect(
				(pi as unknown as { sendUserMessage: ReturnType<typeof vi.fn> }).sendUserMessage,
			).toHaveBeenCalledOnce();
			await handlers.get("session_shutdown")?.({}, ctx);
		} finally {
			vi.useRealTimers();
		}
	});

	it("settled UI notification does not reset silence, while a branch notification does", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		try {
			const handlers = new Map<string, (event: unknown, ctx?: unknown) => Promise<unknown>>();
			const created = createGoal();
			const branch = [{ ...customEntry(created.entry), id: "goal-create", timestamp: 0 }] as Array<{
				type: string;
				id?: string;
				timestamp?: number;
				customType?: string;
				data?: unknown;
			}>;
			const pi = {
				registerFlag: vi.fn(),
				on: vi.fn((event: string, handler) => handlers.set(event, handler)),
				appendEntry: vi.fn((customType: string, data: unknown) =>
					branch.push({
						type: "custom",
						id: `entry-${branch.length}`,
						timestamp: Date.now(),
						customType,
						data,
					}),
				),
				sendUserMessage: vi.fn(),
				getFlag: vi.fn((name: string) => {
					if (name === "goal-continuation" || name === "goal-continuation-watchdog") return true;
					if (name === "goal-continuation-watchdog-silence-minutes") return "60";
					return undefined;
				}),
			} as unknown as ExtensionAPI;
			const ctx = {
				sessionManager: { getBranch: vi.fn(() => branch) },
				isIdle: vi.fn(() => true),
				hasPendingMessages: vi.fn(() => true),
				ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn() },
			};

			registerGoalRuntime(pi);
			await handlers.get("session_start")?.({}, ctx);
			await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
			await handlers.get("agent_settled")?.({}, ctx);
			await vi.advanceTimersByTimeAsync(20 * 60 * 1000);
			branch.push({
				type: "custom_message",
				id: "subagent-notify",
				timestamp: Date.now(),
				customType: "subagent-notify",
			});
			await vi.advanceTimersByTimeAsync(59 * 60 * 1000);
			ctx.hasPendingMessages.mockReturnValue(false);
			expect(
				(pi as unknown as { sendUserMessage: ReturnType<typeof vi.fn> }).sendUserMessage,
			).not.toHaveBeenCalled();

			await vi.advanceTimersByTimeAsync(60 * 1000);
			expect(
				(pi as unknown as { sendUserMessage: ReturnType<typeof vi.fn> }).sendUserMessage,
			).toHaveBeenCalledOnce();
			await handlers.get("session_shutdown")?.({}, ctx);
		} finally {
			vi.useRealTimers();
		}
	});

	it("finalizes a running continuation once only after the agent settles", async () => {
		const handlers = new Map<string, (event: unknown, ctx?: unknown) => Promise<unknown>>();
		const pi = {
			registerFlag: vi.fn(),
			on: vi.fn((event: string, handler) => handlers.set(event, handler)),
			appendEntry: vi.fn(),
			sendUserMessage: vi.fn(),
			getFlag: vi.fn((name: string) => (name === "goal-continuation" ? true : undefined)),
		} as unknown as ExtensionAPI;
		const created = createGoal();
		const progress = persist(
			{
				action: "progress",
				goalId: "goal-1",
				now: 2,
				progress: { lastSummary: "settled progress" },
			},
			created.state,
		);
		const branch = [customEntry(created.entry), queuedContinuationEntry()];
		const ctx = {
			sessionManager: { getBranch: vi.fn(() => branch) },
			isIdle: vi.fn(() => true),
			hasPendingMessages: vi.fn(() => false),
			ui: { setStatus: vi.fn() },
		};

		registerGoalRuntime(pi);
		await handlers.get("session_start")?.({}, ctx);
		await handlers.get("agent_start")?.({}, ctx);
		branch.push(customEntry(progress.entry));

		expect(handlers.has("agent_end")).toBe(false);
		expect((pi as unknown as { appendEntry: ReturnType<typeof vi.fn> }).appendEntry).not.toHaveBeenCalledWith(
			GOAL_CONTINUATION_CUSTOM_TYPE,
			expect.objectContaining({ action: "completed-turn" }),
		);

		await handlers.get("agent_settled")?.({}, ctx);
		await handlers.get("agent_settled")?.({}, ctx);
		const continuationRecords = (
			pi as unknown as { appendEntry: ReturnType<typeof vi.fn> }
		).appendEntry.mock.calls.filter(
			([customType, record]) =>
				customType === GOAL_CONTINUATION_CUSTOM_TYPE &&
				(record as { action?: string }).action === "completed-turn",
		);
		expect(continuationRecords).toHaveLength(1);
		expect(
			(pi as unknown as { sendUserMessage: ReturnType<typeof vi.fn> }).sendUserMessage,
		).not.toHaveBeenCalled();
		await handlers.get("session_shutdown")?.({}, ctx);
	});

	it("registered hooks stop a persisted queued continuation on current Pi text input", async () => {
		const handlers = new Map<string, (event: unknown, ctx?: unknown) => Promise<unknown>>();
		const pi = {
			registerFlag: vi.fn(),
			on: vi.fn((event: string, handler) => handlers.set(event, handler)),
			appendEntry: vi.fn(),
			sendUserMessage: vi.fn(),
			getFlag: vi.fn((name: string) => (name === "goal-continuation" ? true : undefined)),
		} as unknown as ExtensionAPI;
		const created = createGoal();
		const branch = [customEntry(created.entry), queuedContinuationEntry()];
		const ctx = {
			sessionManager: { getBranch: vi.fn(() => branch) },
			isIdle: vi.fn(() => true),
			hasPendingMessages: vi.fn(() => false),
			ui: { setStatus: vi.fn() },
		};
		registerGoalRuntime(pi);
		expect((pi as unknown as { registerFlag: ReturnType<typeof vi.fn> }).registerFlag).toHaveBeenCalledWith(
			"goal-continuation-max-turns",
			expect.objectContaining({ type: "string", default: "0" }),
		);
		expect((pi as unknown as { registerFlag: ReturnType<typeof vi.fn> }).registerFlag).toHaveBeenCalledWith(
			"goal-continuation-max-duration-hours",
			expect.objectContaining({ type: "string", default: "48" }),
		);

		await handlers.get("session_start")?.({}, ctx);
		await handlers.get("input")?.(
			{ type: "input", text: "user interrupts", source: "interactive", streamingBehavior: "followUp" },
			ctx,
		);

		expect((pi as unknown as { appendEntry: ReturnType<typeof vi.fn> }).appendEntry).toHaveBeenLastCalledWith(
			GOAL_CONTINUATION_CUSTOM_TYPE,
			expect.objectContaining({ action: "stopped", reason: "user-interrupt" }),
		);
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("goal-continuation", undefined);
		await handlers.get("session_shutdown")?.({}, ctx);
	});

	it("handles a queued continuation prompt when continuation is disabled", async () => {
		const handlers = new Map<string, (event: unknown, ctx?: unknown) => Promise<unknown>>();
		const pi = {
			registerFlag: vi.fn(),
			on: vi.fn((event: string, handler) => handlers.set(event, handler)),
			appendEntry: vi.fn(),
			sendUserMessage: vi.fn(),
			getFlag: vi.fn((name: string) => (name === "goal-continuation" ? false : undefined)),
		} as unknown as ExtensionAPI;
		const created = createGoal();
		const ctx = {
			sessionManager: { getBranch: vi.fn(() => [customEntry(created.entry)]) },
			ui: { setStatus: vi.fn() },
		};
		registerGoalRuntime(pi);

		await expect(handlers.get("input")?.({ text: "继续目标", source: "extension" }, ctx)).resolves.toEqual({
			action: "handled",
		});
		expect((pi as unknown as { appendEntry: ReturnType<typeof vi.fn> }).appendEntry).not.toHaveBeenCalled();
	});

	it("keeps deliberate legacy input fallback and clears queued state on shutdown", async () => {
		const handlers = new Map<string, (event: unknown, ctx?: unknown) => Promise<unknown>>();
		const pi = {
			registerFlag: vi.fn(),
			on: vi.fn((event: string, handler) => handlers.set(event, handler)),
			appendEntry: vi.fn(),
			sendUserMessage: vi.fn(),
			getFlag: vi.fn((name: string) => (name === "goal-continuation" ? true : undefined)),
		} as unknown as ExtensionAPI;
		const created = createGoal();
		const branch = [customEntry(created.entry), queuedContinuationEntry()];
		const ctx = {
			sessionManager: { getBranch: vi.fn(() => branch) },
			isIdle: vi.fn(() => true),
			hasPendingMessages: vi.fn(() => false),
			ui: { setStatus: vi.fn() },
		};

		registerGoalRuntime(pi);
		await handlers.get("session_start")?.({}, ctx);
		await handlers.get("input")?.({ input: "Continue working toward the active goal." }, ctx);
		expect(
			(pi as unknown as { appendEntry: ReturnType<typeof vi.fn> }).appendEntry,
		).not.toHaveBeenLastCalledWith(
			GOAL_CONTINUATION_CUSTOM_TYPE,
			expect.objectContaining({ action: "stopped", reason: "user-interrupt" }),
		);

		await handlers.get("session_shutdown")?.({ reason: "reload" }, ctx);
		expect((pi as unknown as { appendEntry: ReturnType<typeof vi.fn> }).appendEntry).toHaveBeenLastCalledWith(
			GOAL_CONTINUATION_CUSTOM_TYPE,
			expect.objectContaining({ action: "stopped", reason: "stale-goal" }),
		);
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("goal-continuation", undefined);
	});
});
