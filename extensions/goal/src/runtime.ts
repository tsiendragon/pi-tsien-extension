import type { ExtensionAPI, InputEvent } from "@earendil-works/pi-coding-agent";
import { createGoalStateSnapshot, loadGoalState, saveGoalState } from "./state.ts";
import {
	allPathsBlocked,
	chooseExplorableBlocker,
	readyWorkItems,
	renderBlockerReport,
} from "./goal-graph.ts";
import { branchLedgerKey, openGoalLedger, type GoalLedger } from "./ledger.ts";
import { applyGoalUi, renderContinuationStatus } from "./ui.ts";
import {
	compactGoalDetails,
	GOAL_CONTEXT_CUSTOM_TYPE,
	GOAL_CONTINUATION_PROMPT,
	renderCompactGoalSummary,
	renderContinuationPrompt,
	renderGoalContext,
} from "./prompts.ts";

import type { GoalState } from "./types.ts";

export const GOAL_CONTINUATION_CUSTOM_TYPE = "goal-continuation";
// Zero disables a turn cap; wall-clock duration is the default budget boundary.
export const DEFAULT_GOAL_CONTINUATION_MAX_TURNS = 0;
export const DEFAULT_GOAL_CONTINUATION_MAX_DURATION_HOURS = 48;
export const DEFAULT_GOAL_CONTINUATION_MAX_NO_PROGRESS_TURNS = 2;
export const DEFAULT_GOAL_CONTINUATION_WATCHDOG_SILENCE_MINUTES = 30;
const GOAL_CONTINUATION_WATCHDOG_RETRY_MS = 60_000;

interface GoalRuntimeContext {
	sessionManager: {
		getBranch(): Array<{
			type: string;
			id?: string;
			timestamp?: string | number;
			customType?: string;
			data?: unknown;
		}>;
		getSessionFile?: () => string | undefined;
	};
}

type GoalInputEvent = InputEvent & {
	streamingBehavior?: "steer" | "followUp";
	input?: string;
	prompt?: string;
};

interface ContextMessage {
	role?: string;
	customType?: string;
	content?: unknown;
	details?: unknown;
}

interface ContinuationContext extends GoalRuntimeContext {
	isIdle?: () => boolean;
	hasPendingMessages?: () => boolean;
	mode?: "tui" | "rpc" | "json" | "print";
	hasUI?: boolean;
	ui?: {
		setStatus?: (key: string, value: string | undefined) => void;
		setWidget?: (key: string, value: string[] | undefined) => void;
	};
}

interface ContinuationAPI {
	appendEntry(customType: string, data?: unknown): unknown;
	sendUserMessage(message: string, options?: { deliverAs?: "followUp" | "steer" }): unknown;
	getFlag?: (name: string) => unknown;
}

export interface GoalContinuationRecord {
	action: "queued" | "started" | "stopped" | "completed-turn";
	goalId: string;
	at: number;
	reason?: GoalContinuationStopReason;
	turnCount: number;
	noProgressCount?: number;
	workItemId?: string;
	source?: GoalContinuationSource;
}

export type GoalContinuationSource = "settled" | "watchdog" | "explicit";

export type GoalContinuationStopReason =
	| "disabled"
	| "not-active"
	| "busy"
	| "pending-messages"
	| "stale-goal"
	| "duplicate-queue"
	| "no-progress"
	| "max-turns"
	| "duration-budget"
	| "no-progress-budget"
	| "all-paths-blocked"
	| "user-interrupt";

export interface GoalContinuationState {
	queuedGoalId?: string;
	runningGoalId?: string;
	runningStartedAt?: number;
	runningGoalUpdatedAt?: number;
	stoppedGoalId?: string;
	stoppedReason?: GoalContinuationStopReason;
	turnCounts: Map<string, number>;
	budgetStartedAts: Map<string, number>;
	noProgressCounts: Map<string, number>;
	selectedWorkItems: Map<string, string>;
	hydrated: boolean;
}

export interface GoalContinuationDecision {
	queued: boolean;
	reason?: GoalContinuationStopReason;
	goalId?: string;
}

interface GoalWatchdogState {
	timer?: ReturnType<typeof setTimeout>;
	generation: number;
	lastEntryToken?: string;
	lastActivityAt?: number;
	disposed: boolean;
}

export function registerGoalRuntime(pi: ExtensionAPI): void {
	const api = pi as ExtensionAPI & ContinuationAPI;
	const continuationState = createGoalContinuationState();
	const watchdogState: GoalWatchdogState = { generation: 0, disposed: false };
	let ledger: GoalLedger | undefined;

	api.registerFlag?.("goal-continuation", {
		description:
			"Enable or disable automatic idle continuation for active /goal state (enabled by default in this local fork)",
		type: "boolean",
		default: true,
	});
	api.registerFlag?.("goal-continuation-max-turns", {
		description: "Maximum automatic continuation turns per goal (0 disables the turn cap)",
		type: "string",
		default: String(DEFAULT_GOAL_CONTINUATION_MAX_TURNS),
	});
	api.registerFlag?.("goal-continuation-max-duration-hours", {
		description: "Maximum wall-clock continuation budget per goal in hours",
		type: "string",
		default: String(DEFAULT_GOAL_CONTINUATION_MAX_DURATION_HOURS),
	});
	api.registerFlag?.("goal-continuation-max-no-progress-turns", {
		description: "Maximum consecutive automatic turns without recorded progress",
		type: "string",
		default: String(DEFAULT_GOAL_CONTINUATION_MAX_NO_PROGRESS_TURNS),
	});
	api.registerFlag?.("goal-continuation-watchdog", {
		description: "Wake an idle active goal after a period without new session entries",
		type: "boolean",
		default: true,
	});
	api.registerFlag?.("goal-continuation-watchdog-silence-minutes", {
		description: "Minutes without a new session entry before the goal watchdog may continue",
		type: "string",
		default: String(DEFAULT_GOAL_CONTINUATION_WATCHDOG_SILENCE_MINUTES),
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		const goal = loadGoalState(ctx);
		if (!isActiveGoal(goal)) return;
		return {
			message: {
				customType: GOAL_CONTEXT_CUSTOM_TYPE,
				content: renderGoalContext(goal),
				display: false,
				details: { goalId: goal.goalId },
			},
		};
	});

	pi.on("context", async (event, ctx) => {
		const goal = loadGoalState(ctx);
		const messages = event.messages as ContextMessage[];
		return { messages: filterGoalContextMessages(messages, goal) as typeof event.messages };
	});

	pi.on("session_before_compact", async (event) =>
		createGoalCompaction(
			event as {
				preparation: { previousSummary?: string; firstKeptEntryId: string; tokensBefore: number };
				branchEntries: Array<{ type: string; customType?: string; data?: unknown }>;
			},
		),
	);

	pi.on("input", async (event, ctx) => {
		observeGoalBranchActivity(watchdogState, ctx);
		const prompt = getInputText(event as GoalInputEvent);
		if (isContinuationPrompt(prompt) && api.getFlag?.("goal-continuation") === false) {
			stopGoalContinuation(api, continuationState, "disabled");
			updateContinuationStatus(ctx, continuationState);
			return { action: "handled" };
		}
		if (continuationState.queuedGoalId || continuationState.runningGoalId) {
			if (!isContinuationPrompt(prompt)) {
				stopGoalContinuation(api, continuationState, "user-interrupt");
				updateContinuationStatus(ctx, continuationState);
			}
		}
		scheduleGoalWatchdog(api, continuationState, watchdogState, ctx);
	});

	pi.on("agent_start", async (_event, ctx) => {
		observeGoalBranchActivity(watchdogState, ctx);
		startQueuedGoalContinuation(api, continuationState, ctx);
		scheduleGoalWatchdog(api, continuationState, watchdogState, ctx);
	});

	pi.on("agent_settled", async (_event, ctx) => {
		observeGoalBranchActivity(watchdogState, ctx);
		finishRunningGoalContinuation(api, continuationState, ctx);
		syncLedger(ledger, ctx);
		scheduleGoalWatchdog(api, continuationState, watchdogState, ctx);
	});

	pi.on("session_start", async (_event, ctx) => {
		hydrateGoalContinuationState(continuationState, ctx);
		if (api.getFlag?.("goal-continuation") === false) {
			stopGoalContinuation(api, continuationState, "disabled");
		} else if (continuationState.runningGoalId) {
			stopGoalContinuation(api, continuationState, "stale-goal");
		}
		try {
			ledger = openGoalLedger();
			syncLedger(ledger, ctx);
		} catch {
			ledger = undefined;
		}
		refreshGoalUi(ctx);
		updateContinuationStatus(ctx, continuationState);
		watchdogState.disposed = false;
		observeGoalBranchActivity(watchdogState, ctx);
		scheduleGoalWatchdog(api, continuationState, watchdogState, ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		disposeGoalWatchdog(watchdogState);
		stopGoalContinuation(api, continuationState, "stale-goal");
		syncLedger(ledger, ctx);
		ledger?.close();
		ledger = undefined;
		updateContinuationStatus(ctx, continuationState);
	});

	pi.on("session_tree", async (_event, ctx) => {
		resetGoalWatchdog(watchdogState);
		stopGoalContinuation(api, continuationState, "stale-goal");
		continuationState.turnCounts.clear();
		continuationState.budgetStartedAts.clear();
		continuationState.noProgressCounts.clear();
		continuationState.selectedWorkItems.clear();
		continuationState.hydrated = false;
		hydrateGoalContinuationState(continuationState, ctx);
		if (continuationState.runningGoalId) stopGoalContinuation(api, continuationState, "stale-goal");
		refreshGoalUi(ctx);
		updateContinuationStatus(ctx, continuationState);
		observeGoalBranchActivity(watchdogState, ctx);
		scheduleGoalWatchdog(api, continuationState, watchdogState, ctx);
	});
}

export function createGoalContextMessage(goal: GoalState):
	| {
			customType: string;
			content: string;
			display: false;
			details: { goalId: string };
	  }
	| undefined {
	if (!isActiveGoal(goal)) return undefined;
	return {
		customType: GOAL_CONTEXT_CUSTOM_TYPE,
		content: renderGoalContext(goal),
		display: false,
		details: { goalId: goal.goalId },
	};
}

export function filterGoalContextMessages<T extends ContextMessage>(
	messages: T[],
	goal: GoalState | null,
): T[] {
	const activeGoalId = isActiveGoal(goal) ? goal.goalId : undefined;
	let lastCurrentContextIndex = -1;

	if (activeGoalId) {
		messages.forEach((message, index) => {
			if (isGoalContextMessage(message) && messageHasGoalId(message, activeGoalId)) {
				lastCurrentContextIndex = index;
			}
		});
	}

	return messages.filter((message, index) => {
		if (!isGoalContextMessage(message)) return true;
		if (!activeGoalId) return false;
		return index === lastCurrentContextIndex && messageHasGoalId(message, activeGoalId);
	});
}

export function createGoalCompaction(event: {
	preparation: { previousSummary?: string; firstKeptEntryId: string; tokensBefore: number };
	branchEntries: Array<{ type: string; customType?: string; data?: unknown }>;
}):
	| {
			compaction: {
				summary: string;
				firstKeptEntryId: string;
				tokensBefore: number;
				details: ReturnType<typeof compactGoalDetails>;
			};
	  }
	| undefined {
	const goal = createGoalStateSnapshot(event.branchEntries).current;
	if (!isActiveGoal(goal)) return undefined;

	const priorSummary = event.preparation.previousSummary?.trim();
	const summary = [
		priorSummary || "Conversation summary will continue from Pi's retained recent messages.",
		renderCompactGoalSummary(goal),
	].join("\n\n");

	return {
		compaction: {
			summary,
			firstKeptEntryId: event.preparation.firstKeptEntryId,
			tokensBefore: event.preparation.tokensBefore,
			details: compactGoalDetails(goal),
		},
	};
}

export function createGoalContinuationState(): GoalContinuationState {
	return {
		turnCounts: new Map(),
		budgetStartedAts: new Map(),
		noProgressCounts: new Map(),
		selectedWorkItems: new Map(),
		hydrated: false,
	};
}

export async function maybeQueueGoalContinuation(
	api: ContinuationAPI,
	state: GoalContinuationState,
	ctx: ContinuationContext,
	now = Date.now(),
	source: GoalContinuationSource = "explicit",
): Promise<GoalContinuationDecision> {
	hydrateGoalContinuationState(state, ctx);
	if (api.getFlag?.("goal-continuation") === false) return stopDecision("disabled");
	if (state.queuedGoalId || state.runningGoalId)
		return stopDecision("duplicate-queue", state.queuedGoalId ?? state.runningGoalId);
	if (ctx.isIdle?.() !== true) return stopDecision("busy");
	if (ctx.hasPendingMessages?.() === true) return stopDecision("pending-messages");

	const goal = loadGoalState(ctx);
	if (!isActiveGoal(goal)) return stopDecision("not-active");
	if (state.stoppedGoalId === goal.goalId && state.stoppedReason === "all-paths-blocked")
		return stopDecision("all-paths-blocked", goal.goalId);
	if (state.stoppedGoalId === goal.goalId && state.stoppedReason === "no-progress-budget")
		return stopDecision("no-progress-budget", goal.goalId);
	if (state.stoppedGoalId === goal.goalId && state.stoppedReason === "max-turns")
		return stopDecision("max-turns", goal.goalId);
	if (state.stoppedGoalId === goal.goalId && state.stoppedReason === "duration-budget")
		return stopDecision("duration-budget", goal.goalId);
	const maxTurns = getMaxContinuationTurns(api);
	const turnCount = state.turnCounts.get(goal.goalId) ?? 0;
	const budgetStartedAt = state.budgetStartedAts.get(goal.goalId);
	if (budgetStartedAt !== undefined && now - budgetStartedAt >= getMaxContinuationDurationMs(api)) {
		persistStopReport(api, goal, "duration_budget", now);
		state.stoppedGoalId = goal.goalId;
		state.stoppedReason = "duration-budget";
		recordGoalContinuation(api, {
			action: "stopped",
			goalId: goal.goalId,
			at: now,
			turnCount,
			reason: "duration-budget",
		});
		return stopDecision("duration-budget", goal.goalId);
	}
	if (maxTurns !== undefined && turnCount >= maxTurns) {
		persistStopReport(api, goal, "max_turns", now);
		state.stoppedGoalId = goal.goalId;
		state.stoppedReason = "max-turns";
		recordGoalContinuation(api, {
			action: "stopped",
			goalId: goal.goalId,
			at: now,
			turnCount,
			reason: "max-turns",
		});
		return stopDecision("max-turns", goal.goalId);
	}

	const ready = readyWorkItems(goal);
	const explorableBlocker = ready.length === 0 ? chooseExplorableBlocker(goal) : undefined;
	if (ready.length === 0 && !explorableBlocker) {
		if (allPathsBlocked(goal)) {
			const report = renderBlockerReport(goal, "all_paths_blocked", now);
			saveGoalState(
				api,
				{
					action: "graph",
					goalId: goal.goalId,
					now,
					report,
					reason: "All unfinished work paths are blocked.",
				},
				goal,
			);
			state.stoppedGoalId = goal.goalId;
			state.stoppedReason = "all-paths-blocked";
			recordGoalContinuation(api, {
				action: "stopped",
				goalId: goal.goalId,
				at: now,
				turnCount,
				reason: "all-paths-blocked",
			});
			return stopDecision("all-paths-blocked", goal.goalId);
		}
		return stopDecision("no-progress", goal.goalId);
	}

	const rechecked = loadGoalState(ctx);
	if (!isActiveGoal(rechecked) || rechecked.goalId !== goal.goalId)
		return stopDecision("stale-goal", goal.goalId);

	if (explorableBlocker) {
		saveGoalState(
			api,
			{
				action: "graph",
				goalId: goal.goalId,
				now,
				attempt: {
					id: crypto.randomUUID(),
					goalId: goal.goalId,
					blockerId: explorableBlocker.id,
					hypothesis: "A bounded technical investigation may unblock this work.",
					action: "Scheduled agent_can_try continuation",
					result: "Scheduled",
					createdAt: now,
				},
				reason: `Scheduled bounded exploration for blocker: ${explorableBlocker.title}.`,
			},
			goal,
		);
	}
	if (!state.budgetStartedAts.has(goal.goalId)) state.budgetStartedAts.set(goal.goalId, now);
	state.queuedGoalId = goal.goalId;
	const selected = ready[0];
	if (selected) state.selectedWorkItems.set(goal.goalId, selected.id);
	recordGoalContinuation(api, {
		action: "queued",
		goalId: goal.goalId,
		at: now,
		turnCount,
		workItemId: selected?.id,
		source,
	});
	updateContinuationStatus(ctx, state);
	api.sendUserMessage(renderContinuationPrompt(goal, selected, explorableBlocker?.title), {
		deliverAs: "followUp",
	});
	return { queued: true, goalId: goal.goalId };
}

export function startQueuedGoalContinuation(
	api: ContinuationAPI,
	state: GoalContinuationState,
	ctx: ContinuationContext,
	now = Date.now(),
): void {
	const goalId = state.queuedGoalId;
	if (!goalId) return;
	if (api.getFlag?.("goal-continuation") === false) {
		stopGoalContinuation(api, state, "disabled", now);
		updateContinuationStatus(ctx, state);
		return;
	}
	const goal = loadGoalState(ctx);
	if (!isActiveGoal(goal) || goal.goalId !== goalId) {
		stopGoalContinuation(api, state, "stale-goal", now);
		updateContinuationStatus(ctx, state);
		return;
	}
	const turnCount = (state.turnCounts.get(goalId) ?? 0) + 1;
	state.turnCounts.set(goalId, turnCount);
	state.queuedGoalId = undefined;
	state.runningGoalId = goalId;
	state.runningStartedAt = now;
	state.runningGoalUpdatedAt = goal.updatedAt;
	state.stoppedGoalId = undefined;
	state.stoppedReason = undefined;
	recordGoalContinuation(api, {
		action: "started",
		goalId,
		at: now,
		turnCount,
		workItemId: state.selectedWorkItems.get(goalId),
	});
	updateContinuationStatus(ctx, state);
}

export function finishRunningGoalContinuation(
	api: ContinuationAPI,
	state: GoalContinuationState,
	ctx: ContinuationContext,
	now = Date.now(),
): GoalContinuationStopReason | undefined {
	const goalId = state.runningGoalId;
	if (!goalId) return undefined;
	const turnCount = state.turnCounts.get(goalId) ?? 0;
	const goal = loadGoalState(ctx);
	state.runningGoalId = undefined;
	state.runningStartedAt = undefined;
	const previousUpdatedAt = state.runningGoalUpdatedAt;
	state.runningGoalUpdatedAt = undefined;

	if (!isActiveGoal(goal) || goal.goalId !== goalId) {
		const reason: GoalContinuationStopReason = "stale-goal";
		state.stoppedGoalId = goalId;
		state.stoppedReason = reason;
		recordGoalContinuation(api, { action: "stopped", goalId, at: now, turnCount, reason });
		updateContinuationStatus(ctx, state);
		return reason;
	}
	if (previousUpdatedAt !== undefined && goal.updatedAt <= previousUpdatedAt) {
		const noProgressCount = (state.noProgressCounts.get(goalId) ?? 0) + 1;
		state.noProgressCounts.set(goalId, noProgressCount);
		if (noProgressCount >= getMaxNoProgressTurns(api)) {
			const reason: GoalContinuationStopReason = "no-progress-budget";
			state.stoppedGoalId = goalId;
			state.stoppedReason = reason;
			persistStopReport(api, goal, "no_progress_budget", now);
			recordGoalContinuation(api, { action: "stopped", goalId, at: now, turnCount, reason, noProgressCount });
			updateContinuationStatus(ctx, state);
			return reason;
		}
	} else {
		state.noProgressCounts.set(goalId, 0);
	}
	const maxTurns = getMaxContinuationTurns(api);
	if (maxTurns !== undefined && turnCount >= maxTurns) {
		const reason: GoalContinuationStopReason = "max-turns";
		state.stoppedGoalId = goalId;
		state.stoppedReason = reason;
		persistStopReport(api, goal, "max_turns", now);
		recordGoalContinuation(api, { action: "stopped", goalId, at: now, turnCount, reason });
		updateContinuationStatus(ctx, state);
		return reason;
	}

	recordGoalContinuation(api, {
		action: "completed-turn",
		goalId,
		at: now,
		turnCount,
		noProgressCount: state.noProgressCounts.get(goalId) ?? 0,
	});
	updateContinuationStatus(ctx, state);
	return undefined;
}

export function stopGoalContinuation(
	api: ContinuationAPI,
	state: GoalContinuationState,
	reason: GoalContinuationStopReason,
	now = Date.now(),
): void {
	const goalId = state.runningGoalId ?? state.queuedGoalId;
	state.queuedGoalId = undefined;
	state.runningGoalId = undefined;
	state.runningStartedAt = undefined;
	state.runningGoalUpdatedAt = undefined;
	if (!goalId) return;
	state.stoppedGoalId = goalId;
	state.stoppedReason = reason;
	recordGoalContinuation(api, {
		action: "stopped",
		goalId,
		at: now,
		turnCount: state.turnCounts.get(goalId) ?? 0,
		reason,
	});
}

function getInputText(event: GoalInputEvent): string {
	return event.text ?? event.input ?? event.prompt ?? "";
}

function isContinuationPrompt(prompt: string): boolean {
	return (
		prompt.trim() === GOAL_CONTINUATION_PROMPT || prompt.includes("Continue working toward the active goal.")
	);
}

function recordGoalContinuation(api: ContinuationAPI, record: GoalContinuationRecord): void {
	api.appendEntry(GOAL_CONTINUATION_CUSTOM_TYPE, record);
}

function refreshGoalUi(ctx: ContinuationContext): void {
	applyGoalUi(ctx, loadGoalState(ctx));
}

function updateContinuationStatus(ctx: ContinuationContext, state: GoalContinuationState): void {
	if (state.queuedGoalId) {
		ctx.ui?.setStatus?.("goal-continuation", renderContinuationStatus("queued"));
		return;
	}
	if (state.runningGoalId) {
		ctx.ui?.setStatus?.("goal-continuation", renderContinuationStatus("running"));
		return;
	}
	ctx.ui?.setStatus?.("goal-continuation", undefined);
}

export function hydrateGoalContinuationState(state: GoalContinuationState, ctx: GoalRuntimeContext): void {
	if (state.hydrated) return;
	const currentGoal = loadGoalState(ctx);
	for (const entry of ctx.sessionManager.getBranch()) {
		if (
			entry.type !== "custom" ||
			entry.customType !== GOAL_CONTINUATION_CUSTOM_TYPE ||
			!isContinuationRecord(entry.data)
		)
			continue;
		state.turnCounts.set(
			entry.data.goalId,
			Math.max(state.turnCounts.get(entry.data.goalId) ?? 0, entry.data.turnCount),
		);
		if (entry.data.action === "queued" || entry.data.action === "started") {
			const existing = state.budgetStartedAts.get(entry.data.goalId);
			state.budgetStartedAts.set(
				entry.data.goalId,
				existing === undefined ? entry.data.at : Math.min(existing, entry.data.at),
			);
		}
		if (entry.data.action === "queued") {
			state.queuedGoalId = entry.data.goalId;
			state.runningGoalId = undefined;
			state.runningStartedAt = undefined;
			state.runningGoalUpdatedAt = undefined;
			if (entry.data.workItemId) state.selectedWorkItems.set(entry.data.goalId, entry.data.workItemId);
		}
		if (entry.data.action === "started") {
			state.queuedGoalId = undefined;
			state.runningGoalId = entry.data.goalId;
			state.runningStartedAt = entry.data.at;
			state.runningGoalUpdatedAt =
				currentGoal?.goalId === entry.data.goalId ? currentGoal.updatedAt : undefined;
		}
		if (entry.data.action === "completed-turn" || entry.data.action === "stopped") {
			if (state.queuedGoalId === entry.data.goalId) state.queuedGoalId = undefined;
			if (state.runningGoalId === entry.data.goalId) {
				state.runningGoalId = undefined;
				state.runningStartedAt = undefined;
				state.runningGoalUpdatedAt = undefined;
			}
		}
		if (entry.data.noProgressCount !== undefined)
			state.noProgressCounts.set(entry.data.goalId, entry.data.noProgressCount);
		if (entry.data.action === "stopped") {
			state.stoppedGoalId = entry.data.goalId;
			state.stoppedReason = entry.data.reason;
		}
	}
	state.hydrated = true;
}

function observeGoalBranchActivity(
	state: GoalWatchdogState,
	ctx: GoalRuntimeContext,
	now = Date.now(),
): void {
	const branch = ctx.sessionManager.getBranch();
	const last = branch.at(-1);
	const token = last ? `${branch.length}:${last.id ?? ""}:${last.type}:${last.customType ?? ""}` : "0";
	if (state.lastEntryToken === token) return;
	state.lastEntryToken = token;
	state.lastActivityAt = readEntryTime(last) ?? now;
}

function scheduleGoalWatchdog(
	api: ContinuationAPI,
	continuation: GoalContinuationState,
	watchdog: GoalWatchdogState,
	ctx: ContinuationContext,
	retryAfterCheck = false,
): void {
	clearGoalWatchdogTimer(watchdog);
	if (watchdog.disposed || !isGoalWatchdogEnabled(api) || !isActiveGoal(loadGoalState(ctx))) return;
	const generation = ++watchdog.generation;
	const now = Date.now();
	observeGoalBranchActivity(watchdog, ctx, now);
	const silenceMs = getGoalWatchdogSilenceMs(api);
	const remaining = Math.max(0, silenceMs - (now - (watchdog.lastActivityAt ?? now)));
	const delay =
		remaining > 0
			? Math.min(remaining, GOAL_CONTINUATION_WATCHDOG_RETRY_MS)
			: retryAfterCheck
				? GOAL_CONTINUATION_WATCHDOG_RETRY_MS
				: 0;
	watchdog.timer = setTimeout(async () => {
		if (watchdog.disposed || watchdog.generation !== generation) return;
		watchdog.timer = undefined;
		const checkedAt = Date.now();
		observeGoalBranchActivity(watchdog, ctx, checkedAt);
		if (checkedAt - (watchdog.lastActivityAt ?? checkedAt) >= silenceMs) {
			await maybeQueueGoalContinuation(api, continuation, ctx, checkedAt, "watchdog");
			observeGoalBranchActivity(watchdog, ctx, checkedAt);
		}
		scheduleGoalWatchdog(api, continuation, watchdog, ctx, true);
	}, delay);
	watchdog.timer.unref?.();
}

function resetGoalWatchdog(state: GoalWatchdogState): void {
	clearGoalWatchdogTimer(state);
	state.generation += 1;
	state.lastEntryToken = undefined;
	state.lastActivityAt = undefined;
	state.disposed = false;
}

function disposeGoalWatchdog(state: GoalWatchdogState): void {
	clearGoalWatchdogTimer(state);
	state.generation += 1;
	state.disposed = true;
}

function clearGoalWatchdogTimer(state: GoalWatchdogState): void {
	if (state.timer) clearTimeout(state.timer);
	state.timer = undefined;
}

function readEntryTime(entry: { timestamp?: string | number } | undefined): number | undefined {
	if (!entry) return undefined;
	if (typeof entry.timestamp === "number" && Number.isFinite(entry.timestamp)) return entry.timestamp;
	if (typeof entry.timestamp === "string") {
		const parsed = Date.parse(entry.timestamp);
		if (Number.isFinite(parsed)) return parsed;
	}
	return undefined;
}

function isGoalWatchdogEnabled(api: ContinuationAPI): boolean {
	return (
		api.getFlag?.("goal-continuation") !== false && api.getFlag?.("goal-continuation-watchdog") !== false
	);
}

function getGoalWatchdogSilenceMs(api: ContinuationAPI): number {
	const configured = api.getFlag?.("goal-continuation-watchdog-silence-minutes");
	const value =
		typeof configured === "number" ? configured : typeof configured === "string" ? Number(configured) : NaN;
	const minutes =
		Number.isFinite(value) && value > 0 ? value : DEFAULT_GOAL_CONTINUATION_WATCHDOG_SILENCE_MINUTES;
	return Math.floor(minutes * 60_000);
}

function persistStopReport(api: ContinuationAPI, goal: GoalState, trigger: string, now: number): void {
	if (goal.reports?.at(-1)?.trigger === trigger) return;
	const report = renderBlockerReport(goal, trigger, now);
	saveGoalState(
		api,
		{ action: "graph", goalId: goal.goalId, now, report, reason: `Continuation stopped: ${trigger}.` },
		goal,
	);
}

function syncLedger(ledger: GoalLedger | undefined, ctx: GoalRuntimeContext): void {
	const goal = loadGoalState(ctx);
	if (!ledger || !goal) return;
	const branch = ctx.sessionManager.getBranch();
	ledger.syncGoal(ctx.sessionManager.getSessionFile?.() ?? "ephemeral", branchLedgerKey(branch), goal);
}

function isContinuationRecord(value: unknown): value is GoalContinuationRecord {
	return (
		typeof value === "object" &&
		value !== null &&
		"goalId" in value &&
		typeof value.goalId === "string" &&
		"turnCount" in value &&
		typeof value.turnCount === "number" &&
		"action" in value &&
		(value.action === "queued" ||
			value.action === "started" ||
			value.action === "stopped" ||
			value.action === "completed-turn")
	);
}

function getMaxNoProgressTurns(api: ContinuationAPI): number {
	const configured = api.getFlag?.("goal-continuation-max-no-progress-turns");
	const value =
		typeof configured === "number" ? configured : typeof configured === "string" ? Number(configured) : NaN;
	return Number.isFinite(value) && value > 0
		? Math.floor(value)
		: DEFAULT_GOAL_CONTINUATION_MAX_NO_PROGRESS_TURNS;
}

function getMaxContinuationTurns(api: ContinuationAPI): number | undefined {
	const configured = api.getFlag?.("goal-continuation-max-turns");
	const value =
		typeof configured === "number" ? configured : typeof configured === "string" ? Number(configured) : NaN;
	if (Number.isFinite(value) && value > 0) return Math.floor(value);
	return DEFAULT_GOAL_CONTINUATION_MAX_TURNS > 0 ? DEFAULT_GOAL_CONTINUATION_MAX_TURNS : undefined;
}

function getMaxContinuationDurationMs(api: ContinuationAPI): number {
	const configured = api.getFlag?.("goal-continuation-max-duration-hours");
	const value =
		typeof configured === "number" ? configured : typeof configured === "string" ? Number(configured) : NaN;
	const hours = Number.isFinite(value) && value > 0 ? value : DEFAULT_GOAL_CONTINUATION_MAX_DURATION_HOURS;
	return Math.floor(hours * 60 * 60 * 1000);
}

function stopDecision(reason: GoalContinuationStopReason, goalId?: string): GoalContinuationDecision {
	return { queued: false, reason, goalId };
}

function isActiveGoal(goal: GoalState | null): goal is GoalState {
	return goal !== null && goal.status === "active";
}

function isGoalContextMessage(message: ContextMessage): boolean {
	return message.customType === GOAL_CONTEXT_CUSTOM_TYPE;
}

function messageHasGoalId(message: ContextMessage, goalId: string): boolean {
	const details = message.details;
	if (typeof details === "object" && details !== null && "goalId" in details && details.goalId === goalId) {
		return true;
	}
	const content = typeof message.content === "string" ? message.content : "";
	return content.includes(`goal_id="${goalId.replace(/"/g, "&quot;")}"`);
}
