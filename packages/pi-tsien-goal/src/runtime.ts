import type { ExtensionAPI, ExtensionContext, InputEvent } from "@earendil-works/pi-coding-agent";
import { latestResearchFeedback } from "./research-feedback.ts";
import { createGoalStateSnapshot, loadGoalState } from "./state.ts";
import { branchLedgerKey, openGoalLedger, type GoalLedger } from "./ledger.ts";
import { applyGoalUi, renderContinuationStatus } from "./ui.ts";
import {
	compactGoalDetails,
	GOAL_CONTEXT_CUSTOM_TYPE,
	GOAL_CONTINUATION_PROMPT,
	GOAL_EXECUTION_SYSTEM_PROMPT,
	renderCompactGoalSummary,
	renderContinuationPrompt,
	renderGoalContext,
} from "./prompts.ts";

import type { GoalState } from "./types.ts";
import { allPathsBlocked, getOpenBlockers, getWorkItems, readyWorkItems } from "./goal-graph.ts";
import { askGoalEvaluator, DEFAULT_GOAL_EVALUATORS, evaluateGoal, evaluatorModels, handoffAction, PROOF_JOB_EVENT, WORKBENCH_JOB_EVENT, type EvaluatorFailure } from "./evaluator.ts";

export const GOAL_CONTINUATION_CUSTOM_TYPE = "goal-continuation";

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

export type GoalContinuationSource = "explicit" | "evaluator" | "proof-job" | "workbench-job" | "handoff";
type GoalJobKind = "proof" | "workbench";
interface GoalJob { kind: GoalJobKind; id: string; label: string; state: string; collected?: boolean }
const GOAL_START_PREFIX = "Start working toward the active goal now.";
const TERMINAL_JOB_STATES = new Set(["finished", "failed", "cancelled"]);
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

export function registerGoalRuntime(pi: ExtensionAPI): void {
	const api = pi as ExtensionAPI & ContinuationAPI;
	const continuationState = createGoalContinuationState();
	let ledger: GoalLedger | undefined;
	let engaged: string | undefined;
	let control: AbortController | undefined;
	let pending: ReturnType<typeof setTimeout> | undefined;
	let idleTurns = 0;
	let usedHandoffFallback = false;
	const routesTried = new Set<string>();
	let progressKey = "";
	let summary = "";
	let reason: string | undefined;
	let stopped = false;
	let jobEventVersion = 0;
	// Keyed by `${kind}:${id}` so proof jobs and workbench jobs never collide.
	const jobs = new Map<string, GoalJob>();
	// A start prompt queued while the drafting run was still streaming. Pi would
	// absorb it into that run without before_agent_start, so it is re-sent once idle.
	let deferredStart: { goalId: string; text: string } | undefined;
	const takeCompletedJobs = () => {
		const done = [...jobs].filter(([, job]) => job.state === "finished" || job.state === "failed");
		for (const [key] of done) jobs.delete(key);
		return done.map(([, job]) => job);
	};
	const completedJobsNotice = (done: GoalJob[]) => {
		const proof = done.filter(job => job.kind === "proof");
		const work = done.filter(job => job.kind === "workbench");
		return [
			proof.length ? `Collect the terminal proof job(s) with proof_jobs before deciding the next step: ${proof.map(job => job.id).join(", ")}. Collecting results does not authorize blocked actions. This notification is not proof evidence.` : "",
			work.length ? `Collect the terminal background subagent/workflow job(s) with subagent_results (mode "collect", workIds ${JSON.stringify(work.map(job => job.id))}) and base the next step on their actual outputs: ${work.map(job => `${job.id} (${job.label}; ${job.state})`).join(", ")}. This notification is not evidence of their results.` : "",
		].filter(Boolean).join(" ");
	};
	const modelSetting = () => String(api.getFlag?.("goal-evaluator-models") ?? process.env.PI_GOAL_EVALUATOR_MODELS ?? DEFAULT_GOAL_EVALUATORS);
	const models = () => evaluatorModels(modelSetting());
	const reset = () => {
		control?.abort();
		if (pending) clearTimeout(pending);
		pending = undefined;
		engaged = undefined;
		idleTurns = 0;
		usedHandoffFallback = false;
		routesTried.clear();
		progressKey = "";
		summary = "";
		reason = undefined;
		stopped = false;
		jobs.clear();
	};
	const assess = (ctx: ExtensionContext) => {
		if (pending || control || continuationState.queuedGoalId || stopped || !engaged || api.getFlag?.("goal-continuation") === false || !models().length) return;
		pending = setTimeout(() => {
			pending = undefined;
			if (!ctx.isIdle() || continuationState.queuedGoalId) return;
			const goal = loadGoalState(ctx);
			if (!isActiveGoal(goal) || goal.goalId !== engaged) return;
			const ready = readyWorkItems(goal);
			const completed = takeCompletedJobs();
			if (completed.length) {
				// A terminal event is new evidence. Give the worker one bounded chance to
				// collect it; a stale handoff or a reviewer verdict is not a stop decision.
				reason = completedJobsNotice(completed);
				const source = completed.some(job => job.kind === "proof") ? "proof-job" : "workbench-job";
				void maybeQueueGoalContinuation(api, continuationState, ctx, Date.now(), source).catch(() => { stopped = true; });
				return;
			}
			if (allPathsBlocked(goal) || getOpenBlockers(goal).some(b => b.disposition !== "agent_can_try" && !b.workItemIds.length)) return;
			if (idleTurns >= 3) return;
			const epoch = jobEventVersion;
			const leaf = ctx.sessionManager.getLeafId();
			const run = new AbortController();
			control = run;
			const snapshot = JSON.stringify({
				objective: goal.objective.slice(0, 2000),
				criteria: goal.acceptanceCriteria.slice(0, 12).map(s => s.slice(0, 300)),
				constraints: goal.constraints.slice(0, 12).map(s => s.slice(0, 300)),
				ready: ready.slice(0, 10).map(w => ({ id: w.id, title: w.title.slice(0, 250) })),
				blockers: getOpenBlockers(goal).slice(0, 10).map(b => ({ id: b.id, title: b.title.slice(0, 180), disposition: b.disposition, reason: b.reason.slice(0, 240) })),
				recentAttempts: (goal.blockerAttempts ?? []).slice(-8).map(a => ({ blockerId: a.blockerId, action: a.action.slice(0, 240), result: a.result.slice(0, 240), evidence: a.evidence?.slice(0, 240) })),
				proposedActions: [...routesTried],
				jobs: [...jobs.values()].slice(-12).map(job => ({ id: job.id, kind: job.kind, label: job.label, state: job.state })),
				researchCheckpoints: goal.progress.researchCheckpoints?.slice(-3).map(({ kind, evidence, decision }) => ({ kind, evidence, decision })),
				researchFeedback: latestResearchFeedback(goal.progress.researchCheckpoints),
				latestAssistantHandoff: summary,
			});
			const failures: { model: string; kind: EvaluatorFailure }[] = [];
			void evaluateGoal(models(), snapshot, run.signal, askGoalEvaluator(ctx), undefined, (model, kind) => failures.push({ model, kind })).then(async answer => {
				if (run.signal.aborted || !ctx.isIdle() || ctx.sessionManager.getLeafId() !== leaf || loadGoalState(ctx)?.status !== "active" || loadGoalState(ctx)?.goalId !== goal.goalId || api.getFlag?.("goal-continuation") === false) return;
				if (jobEventVersion !== epoch) return;
				const fallback = !answer && !usedHandoffFallback
					? handoffAction(summary, ready.map(item => item.id), [...jobs.values()].some(job => job.state === "pending")) : undefined;
				const action = answer?.decision === "continue" ? answer.action : fallback;
				const key = action?.toLowerCase().replace(/\s+/g, " ");
				const repeated = key !== undefined && routesTried.has(key);
				api.appendEntry("goal-evaluation", { goalId: goal.goalId, model: answer?.model, decision: repeated ? "repeated-action" : answer?.decision ?? "unavailable", reason: answer?.reason, action, wake: answer?.decision === "wait" ? answer.wake : undefined, failures, fallback: fallback && !repeated ? "handoff" : undefined, at: Date.now() });
				if (answer?.decision === "stop") stopped = true;
				if (!key || repeated) return;
				routesTried.add(key);
				if (fallback) usedHandoffFallback = true;
				reason = `Proposed next action: ${action}. Reason: ${answer?.reason ?? "Evaluator unavailable; resume the explicit checkpoint action if still authorized and unblocked."}`;
				await maybeQueueGoalContinuation(api, continuationState, ctx, Date.now(), fallback ? "handoff" : "evaluator");
			}).catch(() => { stopped = true; }).finally(() => {
				if (control === run) control = undefined;
				if (!run.signal.aborted && jobEventVersion !== epoch) assess(ctx);
			});
		}, 0);
	};
	let sessionCtx: ExtensionContext | undefined;
	const onJobEvent = (kind: GoalJobKind) => (value: unknown) => {
		const event = value as { sessionId?: unknown; id?: unknown; label?: unknown; state?: unknown; claim?: unknown } | undefined;
		// Only jobs started by this session while its goal is engaged can wake it.
		if (!engaged || !sessionCtx || typeof event?.id !== "string" || !event.id || typeof event.sessionId !== "string") return;
		if (event.sessionId !== sessionCtx.sessionManager.getSessionId()) return;
		if (loadGoalState(sessionCtx)?.goalId !== engaged) return;
		const key = `${kind}:${event.id}`;
		if (event.state === "pending") {
			if (!jobs.has(key)) jobs.set(key, { kind, id: event.id, label: String(event.label ?? "").slice(0, 180), state: "pending" });
			return;
		}
		const job = jobs.get(key);
		const state = String(event.state);
		if (job?.state !== "pending" || !TERMINAL_JOB_STATES.has(state)) return;
		if (kind === "workbench" && typeof event.claim === "function") event.claim();
		job.state = state;
		jobEventVersion++;
		if (state === "cancelled") {
			// A cancelled proof job is a user stop. A cancelled background subagent is
			// not a wake: it has no result to collect and may be the worker's own choice.
			if (kind === "proof") { stopped = true; control?.abort(); }
			else jobs.delete(key);
			return;
		}
		if (job.collected) { jobs.delete(key); return; }
		idleTurns = 0;
		assess(sessionCtx);
	};
	pi.events?.on(PROOF_JOB_EVENT, onJobEvent("proof"));
	pi.events?.on(WORKBENCH_JOB_EVENT, onJobEvent("workbench"));
	pi.on("tool_result", async (event) => {
		// Results already collected in-turn need no extra wake.
		const result = event as { toolName?: string; isError?: boolean; input?: { includeOutput?: unknown }; details?: { mode?: unknown; completed?: Array<{ workId?: unknown }> } };
		if (result.toolName !== "subagent_results" || result.isError || result.details?.mode === "status" || result.input?.includeOutput === false) return;
		for (const done of result.details?.completed ?? []) {
			const job = typeof done?.workId === "string" ? jobs.get(`workbench:${done.workId}`) : undefined;
			if (!job) continue;
			if (job.state === "pending") job.collected = true;
			else jobs.delete(`workbench:${job.id}`);
		}
	});
	api.registerFlag?.("goal-evaluator-models", {
		description: "Ordered provider/model fallbacks for goal evaluation (off disables automatic continuation)",
		type: "string",
		default: process.env.PI_GOAL_EVALUATOR_MODELS ?? DEFAULT_GOAL_EVALUATORS,
	});

	api.registerFlag?.("goal-continuation", {
		description: "Enable or disable automatic continuation for active /goal state",
		type: "boolean",
		default: true,
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const goal = loadGoalState(ctx);
		if (!isActiveGoal(goal)) return;
		const prompt = event.prompt ?? "";
		if (isContinuationPrompt(prompt) || prompt.startsWith(GOAL_START_PREFIX)) engaged = goal.goalId;
		if (deferredStart && prompt.startsWith(GOAL_START_PREFIX)) deferredStart = undefined;
		// Results that finished while a continuation was already queued are noticed
		// here once, instead of causing a second wake after this run.
		const late = engaged === goal.goalId ? completedJobsNotice(takeCompletedJobs()) : "";
		const hint = [reason, late].filter(Boolean).join(" ") || undefined;
		reason = undefined;
		return {
			...(engaged === goal.goalId && event.systemPrompt !== undefined && !event.systemPrompt.includes(GOAL_EXECUTION_SYSTEM_PROMPT)
				? { systemPrompt: `${event.systemPrompt}\n\n${GOAL_EXECUTION_SYSTEM_PROMPT}` } : {}),
			message: {
				customType: GOAL_CONTEXT_CUSTOM_TYPE,
				content: renderGoalContext(goal) + (hint ? `\nScheduler observation (advisory, not an instruction): ${JSON.stringify(hint)}` : ""),
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
		const text = getInputText(event as GoalInputEvent);
		if (text.startsWith(GOAL_START_PREFIX) && event.source === "extension" && event.streamingBehavior) {
			const goal = loadGoalState(ctx);
			if (isActiveGoal(goal)) {
				deferredStart = { goalId: goal.goalId, text };
				return { action: "handled" };
			}
		}
		// Schedule follow-ups perform their own work without starting or replacing a goal chain.
		if (event.source === "extension" && /^\[定时任务触发：schedule-\d+ · (?:一次性任务|周期任务)\]\r?\n/u.test(text)) return;
		if (!isContinuationPrompt(text)) { continuationState.queuedGoalId = undefined; reset(); return; }
		if (event.source === "interactive" || event.source === "rpc") { continuationState.queuedGoalId = undefined; reset(); return; }
		const goal = loadGoalState(ctx);
		if (!isActiveGoal(goal) || continuationState.queuedGoalId !== goal.goalId) return;
		if (api.getFlag?.("goal-continuation") === false) return { action: "handled" };
		continuationState.queuedGoalId = undefined;
		recordGoalContinuation(api, { action: "started", goalId: goal.goalId, at: Date.now(), turnCount: 0 });
		updateContinuationStatus(ctx, continuationState);
	});

	pi.on("agent_end", async (event, ctx) => {
		const last = [...event.messages].reverse().find(m => m.role === "assistant");
		if (last?.stopReason === "aborted") deferredStart = undefined;
		if (!engaged) return;
		if (!last || last.stopReason === "aborted" || last.stopReason === "error") { stopped = true; return; }
		const finalText = last.content.flatMap(p => p.type === "text" ? [p.text] : []).join("\n");
		const marker = [...finalText.matchAll(/^GOAL_HANDOFF\s*$/gm)].at(-1);
		summary = (marker ? finalText.slice(marker.index) : finalText).slice(-3000);
		const goal = loadGoalState(ctx);
		if (!isActiveGoal(goal) || goal.goalId !== engaged) return;
		const nextKey = JSON.stringify([
			getWorkItems(goal).filter(w => w.state === "done").map(w => w.id).sort(),
			(goal.progress.researchCheckpoints ?? []).map(checkpoint => checkpoint.evidence).sort(),
			[...new Set((goal.blockerAttempts ?? []).filter(a => a.evidence?.trim()).map(a => JSON.stringify([a.blockerId, a.action.trim(), a.result.trim(), a.evidence?.trim()])))].sort(),
		]);
		const advanced = progressKey !== nextKey;
		if (advanced) routesTried.clear();
		idleTurns = advanced ? 0 : idleTurns + 1;
		progressKey = nextKey;
	});
	pi.on("agent_settled", async (_event, ctx) => {
		syncLedger(ledger, ctx);
		if (deferredStart) {
			const start = deferredStart;
			setTimeout(() => {
				if (deferredStart !== start || !ctx.isIdle()) return;
				deferredStart = undefined;
				const goal = loadGoalState(ctx);
				if (!isActiveGoal(goal) || goal.goalId !== start.goalId) return;
				// Idle delivery takes the normal prompt path, so before_agent_start engages the goal.
				void Promise.resolve(api.sendUserMessage(start.text)).catch(() => undefined);
			}, 0);
			return;
		}
		assess(ctx);
	});

	pi.on("session_start", async (_event, ctx) => {
		sessionCtx = ctx;
		hydrateGoalContinuationState(continuationState, ctx);
		try {
			ledger = openGoalLedger();
			syncLedger(ledger, ctx);
		} catch {
			ledger = undefined;
		}
		applyGoalUi(ctx as ContinuationContext, loadGoalState(ctx));
		updateContinuationStatus(ctx, continuationState);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		reset();
		deferredStart = undefined;
		sessionCtx = undefined;
		continuationState.queuedGoalId = undefined;
		updateContinuationStatus(ctx, continuationState);
		syncLedger(ledger, ctx);
		ledger?.close();
		ledger = undefined;
	});

	pi.on("session_tree", async (_event, ctx) => {
		reset();
		deferredStart = undefined;
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
}

export function hydrateGoalContinuationState(state: GoalContinuationState, _ctx: GoalRuntimeContext): void {
	// Pending follow-ups belong to the previous runtime and are intentionally not recovered after reload.
	state.queuedGoalId = undefined;
	state.hydrated = true;
}

function getInputText(event: GoalInputEvent): string {
	return event.text ?? event.input ?? event.prompt ?? "";
}

function isContinuationPrompt(prompt: string): boolean {
	const text = prompt.trim().normalize("NFKC");
	if (text === GOAL_CONTINUATION_PROMPT) return true;
	// Match an instruction at the start, not a mention anywhere in the prompt.
	// Keep this local and deterministic: routing a turn must not depend on a model.
	const lead = text.match(/^[^。.!！,，:：;；\n]*/u)?.[0] ?? "";
	if (lead.includes("?") || lead.includes("？")) return false;
	// A clear stop or status-only qualifier takes priority over a resume prefix.
	if (/(?:不要|不用|不必|别|先别|暂不|先不|无需)\s*(?:再?继续(?:目标|研究|执行|推进)?|自动(?:续跑|接续|唤醒|执行))(?=$|[\s。.!！?？,，:：;；])|(?:暂停|停止|取消)(?:当前|这个|该)?(?:目标|研究|自动续跑|自动唤醒)|(?:只|仅)(?:需|要)?(?:问|看|报告|汇报|告诉我)(?:一下)?(?:当前)?(?:的)?(?:进度|状态)|\b(?:do not|don['’]t|stop|pause)\s+(?:continue|resume|automatic continuation|(?:the |this )?(?:goal|research))\b|\b(?:only|just)\s+(?:report|show|tell me)\s+(?:the |current )?(?:status|progress)\b/iu.test(text)) return false;
	const zh = text.replace(/^(?:(?:好的?|可以|行|嗯|那就|那|麻烦你?|请你?|帮我)\s*[,，、]?\s*)+/u, "");
	if (/^(?:继续|接着|接续|恢复)\s*(?:吧|呀|一下)?(?=$|[。.!！,，:：;；\n])/u.test(zh)) return true;
	if (/^(?:(?:继续|接着|接续|恢复|续跑)(?:\s*(?:(?:上次|刚才|当前|现有|原来|原先|原定|这个|该|的|我们的)\s*)*(?:目标|研究|任务|工作|实验|推导|证明|推进|执行|往下(?:做|走)?|跑|做|干)|\s*(?:从|沿着?|按(?:照)?)\s*[^。.!！？?\n]+)|(?:从|沿着?|按(?:照)?)\s*[^。.!！？?\n]{1,80}(?:继续|接着|续跑|推进))/u.test(zh)
		&& !/(?:怎么|如何|是否|能否|是不是|是什么意思|什么(?:意思|情况)|会不会|要不要|有何|\?)/u.test(lead)) return true;
	return /^(?:(?:ok(?:ay)?|yes|sure)[, ]+)?(?:please\s+)?(?:continue|resume|carry on|keep going)(?=$|[.!,:;\n]|\s+(?:working|with|on|from|where|towards?|(?:the |this |our |current )?(?:goal|research|work|task|experiment))\b)/iu.test(text)
		&& !/\b(?:mean(?:s|ing)?|what|whether|how|should|can|could|would|without resuming)\b/iu.test(lead);
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
	try {
		ledger.syncGoal(ctx.sessionManager.getSessionFile?.() ?? "ephemeral", branchLedgerKey(ctx.sessionManager.getBranch()), goal);
	} catch {
		// The SQLite ledger is a projection; a failed sync must not block scheduling.
		// The session branch remains authoritative and the next sync retries it.
	}
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
