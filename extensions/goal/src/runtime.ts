import type { ExtensionAPI, InputEvent } from "@earendil-works/pi-coding-agent";
import { createGoalStateSnapshot, loadGoalState } from "./state.ts";
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
export const DEFAULT_GOAL_CONTINUATION_INTERVAL_MINUTES = 20;

interface GoalRuntimeContext {
	sessionManager: {
		getBranch(): Array<{
			type: string;
			id?: string;
			customType?: string;
			data?: unknown;
		}>;
		getSessionFile?: () => string | undefined;
	};
}

type GoalInputEvent = InputEvent & {
	text?: string;
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
	action: "queued" | "started" | "stopped";
	goalId: string;
	at: number;
	reason?: GoalContinuationStopReason;
	turnCount: number;
	source?: GoalContinuationSource;
}

export type GoalContinuationSource = "timer" | "explicit";
export type GoalContinuationStopReason = "disabled" | "not-active" | "duplicate-queue" | "stale-goal";

export interface GoalContinuationState {
	queuedGoalId?: string;
	hydrated: boolean;
}

export interface GoalContinuationDecision {
	queued: boolean;
	reason?: GoalContinuationStopReason;
	goalId?: string;
}

interface GoalTimerState {
	timer?: ReturnType<typeof setTimeout>;
	disposed: boolean;
}

export function registerGoalRuntime(pi: ExtensionAPI): void {
	const api = pi as ExtensionAPI & ContinuationAPI;
	const continuationState = createGoalContinuationState();
	const timerState: GoalTimerState = { disposed: false };
	let ledger: GoalLedger | undefined;

	api.registerFlag?.("goal-continuation", {
		description: "Enable or disable automatic 20-minute continuation for active /goal state",
		type: "boolean",
		default: true,
	});
	api.registerFlag?.("goal-continuation-interval-minutes", {
		description: "Minutes between automatic active-goal follow-ups",
		type: "string",
		default: String(DEFAULT_GOAL_CONTINUATION_INTERVAL_MINUTES),
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
		return {
			messages: filterGoalContextMessages(event.messages as ContextMessage[], goal) as typeof event.messages,
		};
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
		if (!isContinuationPrompt(getInputText(event as GoalInputEvent))) return;
		const goal = loadGoalState(ctx);
		if (api.getFlag?.("goal-continuation") === false || !isActiveGoal(goal)) return { action: "handled" };
		if (continuationState.queuedGoalId !== goal.goalId) return;
		continuationState.queuedGoalId = undefined;
		recordGoalContinuation(api, { action: "started", goalId: goal.goalId, at: Date.now(), turnCount: 0 });
		updateContinuationStatus(ctx, continuationState);
	});

	pi.on("agent_settled", async (_event, ctx) => {
		syncLedger(ledger, ctx);
	});

	pi.on("session_start", async (_event, ctx) => {
		hydrateGoalContinuationState(continuationState, ctx);
		try {
			ledger = openGoalLedger();
			syncLedger(ledger, ctx);
		} catch {
			ledger = undefined;
		}
		applyGoalUi(ctx as ContinuationContext, loadGoalState(ctx));
		updateContinuationStatus(ctx, continuationState);
		timerState.disposed = false;
		scheduleGoalContinuation(api, continuationState, timerState, ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		disposeGoalTimer(timerState);
		continuationState.queuedGoalId = undefined;
		updateContinuationStatus(ctx, continuationState);
		syncLedger(ledger, ctx);
		ledger?.close();
		ledger = undefined;
	});

	pi.on("session_tree", async (_event, ctx) => {
		continuationState.queuedGoalId = undefined;
		continuationState.hydrated = true;
		applyGoalUi(ctx as ContinuationContext, loadGoalState(ctx));
		updateContinuationStatus(ctx, continuationState);
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

export function filterGoalContextMessages<T extends ContextMessage>(messages: T[], goal: GoalState | null): T[] {
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
		return activeGoalId !== undefined && index === lastCurrentContextIndex && messageHasGoalId(message, activeGoalId);
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
	return {
		compaction: {
			summary: [
				event.preparation.previousSummary?.trim() || "Conversation summary will continue from Pi's retained recent messages.",
				renderCompactGoalSummary(goal),
			].join("\n\n"),
			firstKeptEntryId: event.preparation.firstKeptEntryId,
			tokensBefore: event.preparation.tokensBefore,
			details: compactGoalDetails(goal),
		},
	};
}

export function createGoalContinuationState(): GoalContinuationState {
	return { hydrated: false };
}

export async function maybeQueueGoalContinuation(
	api: ContinuationAPI,
	state: GoalContinuationState,
	ctx: ContinuationContext,
	now = Date.now(),
	source: GoalContinuationSource = "explicit",
): Promise<GoalContinuationDecision> {
	if (api.getFlag?.("goal-continuation") === false) return stopDecision("disabled");
	const goal = loadGoalState(ctx);
	if (!isActiveGoal(goal)) return stopDecision("not-active");
	if (state.queuedGoalId) return stopDecision("duplicate-queue", state.queuedGoalId);

	state.queuedGoalId = goal.goalId;
	recordGoalContinuation(api, { action: "queued", goalId: goal.goalId, at: now, turnCount: 0, source });
	updateContinuationStatus(ctx, state);
	api.sendUserMessage(renderContinuationPrompt(goal), { deliverAs: "followUp" });
	return { queued: true, goalId: goal.goalId };
}

export function startQueuedGoalContinuation(
	api: ContinuationAPI,
	state: GoalContinuationState,
	ctx: ContinuationContext,
	now = Date.now(),
): void {
	const goal = loadGoalState(ctx);
	if (!isActiveGoal(goal) || state.queuedGoalId !== goal.goalId) return;
	state.queuedGoalId = undefined;
	recordGoalContinuation(api, { action: "started", goalId: goal.goalId, at: now, turnCount: 0 });
	updateContinuationStatus(ctx, state);
}

export function finishRunningGoalContinuation(
	_api: ContinuationAPI,
	_state: GoalContinuationState,
	_ctx: ContinuationContext,
): undefined {
	return undefined;
}

export function stopGoalContinuation(
	api: ContinuationAPI,
	state: GoalContinuationState,
	reason: GoalContinuationStopReason,
	now = Date.now(),
): void {
	const goalId = state.queuedGoalId;
	state.queuedGoalId = undefined;
	if (!goalId) return;
	recordGoalContinuation(api, { action: "stopped", goalId, at: now, turnCount: 0, reason });
}

export function clearStickyStopForActiveGoal(_state: GoalContinuationState, _ctx: GoalRuntimeContext): void {
	// The timer has no sticky stop state. Pause or complete the goal to stop it.
}

export function hydrateGoalContinuationState(state: GoalContinuationState, _ctx: GoalRuntimeContext): void {
	// Pending follow-ups belong to the previous runtime and are intentionally not recovered after reload.
	state.queuedGoalId = undefined;
	state.hydrated = true;
}

function scheduleGoalContinuation(
	api: ContinuationAPI,
	continuation: GoalContinuationState,
	timer: GoalTimerState,
	ctx: ContinuationContext,
): void {
	clearGoalTimer(timer);
	if (timer.disposed || api.getFlag?.("goal-continuation") === false) return;
	const delay = getGoalContinuationIntervalMs(api);
	timer.timer = setTimeout(async () => {
		if (timer.disposed) return;
		await maybeQueueGoalContinuation(api, continuation, ctx, Date.now(), "timer");
		scheduleGoalContinuation(api, continuation, timer, ctx);
	}, delay);
	timer.timer.unref?.();
}

function disposeGoalTimer(timer: GoalTimerState): void {
	clearGoalTimer(timer);
	timer.disposed = true;
}

function clearGoalTimer(timer: GoalTimerState): void {
	if (timer.timer) clearTimeout(timer.timer);
	timer.timer = undefined;
}

function getGoalContinuationIntervalMs(api: ContinuationAPI): number {
	const configured = api.getFlag?.("goal-continuation-interval-minutes");
	const value = typeof configured === "number" ? configured : typeof configured === "string" ? Number(configured) : NaN;
	const minutes = Number.isFinite(value) && value > 0 ? value : DEFAULT_GOAL_CONTINUATION_INTERVAL_MINUTES;
	return Math.floor(minutes * 60_000);
}

function getInputText(event: GoalInputEvent): string {
	return event.text ?? event.input ?? event.prompt ?? "";
}

function isContinuationPrompt(prompt: string): boolean {
	return prompt.trim() === GOAL_CONTINUATION_PROMPT || prompt.includes("Continue working toward the active goal.");
}

function recordGoalContinuation(api: ContinuationAPI, record: GoalContinuationRecord): void {
	api.appendEntry(GOAL_CONTINUATION_CUSTOM_TYPE, record);
}

function updateContinuationStatus(ctx: ContinuationContext, state: GoalContinuationState): void {
	ctx.ui?.setStatus?.("goal-continuation", state.queuedGoalId ? renderContinuationStatus("queued") : undefined);
}

function syncLedger(ledger: GoalLedger | undefined, ctx: GoalRuntimeContext): void {
	const goal = loadGoalState(ctx);
	if (!ledger || !goal) return;
	ledger.syncGoal(ctx.sessionManager.getSessionFile?.() ?? "ephemeral", branchLedgerKey(ctx.sessionManager.getBranch()), goal);
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
	if (typeof details === "object" && details !== null && "goalId" in details && details.goalId === goalId) return true;
	const content = typeof message.content === "string" ? message.content : "";
	return content.includes(`goal_id="${goalId.replace(/"/g, "&quot;")}"`);
}
