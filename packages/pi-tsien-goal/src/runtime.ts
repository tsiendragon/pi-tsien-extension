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
import { allPathsBlocked, currentMilestone, getOpenBlockers, getWorkItems, isHardBlocker, readyWorkItems } from "./goal-graph.ts";
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

export type GoalContinuationSource = "explicit" | "evaluator" | "proof-job" | "workbench-job" | "handoff" | "compaction" | "wait-recheck" | "provider-retry" | "evaluator-fallback" | "blocker-recheck";
export const GOAL_WAIT_RECHECK_MS = 5 * 60_000;
// A bounded turn that may only re-validate open hard blockers. It exists so an
// `uncertain` verdict with a needs_user/external_wait blocker does not stall the
// goal silently; it never authorizes the blocked work itself.
export const GOAL_BLOCKER_RECHECK_ACTION = "Recheck the open hard blockers before anything else: for each one, verify from existing evidence whether its stated condition still holds. If it no longer holds, resolve or supersede the blocker with that evidence and stop there. If it still holds, record that it still holds and stop. Do not perform the blocked work items, do not start work that depends on the missing user decision or external event, and do not repeat the same request to the user.";
const PROVIDER_RETRY_MS = 30_000;
export const GOAL_EVALUATOR_RETRY_MS = 60_000;
type GoalJobKind = "proof" | "workbench";
interface GoalJob { kind: GoalJobKind; id: string; label: string; state: string; collected?: boolean }
const GOAL_START_PREFIX = "Start working toward the active goal now.";
const TERMINAL_JOB_STATES = new Set(["finished", "failed", "cancelled"]);
export type GoalContinuationStopReason = "disabled" | "not-active" | "duplicate-queue" | "stale-goal" | "delivery-failed";

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
	let ordinaryPrompt: string | undefined;
	let ordinaryTurn = false;
	const routesTried = new Set<string>();
	let progressKey = "";
	let summary = "";
	let reason: string | undefined;
	let stopped = false;
	let lastRunOutcome: "success" | "error" | "aborted" | undefined;
	let providerRetryUsed = false;
	let retryTimer: ReturnType<typeof setTimeout> | undefined;
	let retryDue = false;
	let evaluationRetry: ReturnType<typeof setTimeout> | undefined;
	let evaluationRetryUsed = false;
	let compacting = false;
	let compacted = false;
	let waitTimer: ReturnType<typeof setTimeout> | undefined;
	let waitDue: GoalJob[] | undefined;
	let waitRechecks = 0;
	const blockerRechecked = new Set<string>();
	const rechecked = new Set<string>();
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
	const clearWait = () => {
		if (waitTimer) clearTimeout(waitTimer);
		waitTimer = undefined;
		waitDue = undefined;
	};
	const reset = () => {
		control?.abort();
		control = undefined;
		if (pending) clearTimeout(pending);
		if (retryTimer) clearTimeout(retryTimer);
		retryTimer = pending = undefined;
		if (evaluationRetry) clearTimeout(evaluationRetry);
		evaluationRetry = undefined;
		evaluationRetryUsed = false;
		clearWait();
		rechecked.clear();
		blockerRechecked.clear();
		waitRechecks = 0;
		lastRunOutcome = undefined;
		providerRetryUsed = retryDue = compacting = compacted = false;
		engaged = undefined;
		idleTurns = 0;
		usedHandoffFallback = false;
		ordinaryPrompt = undefined;
		ordinaryTurn = false;
		routesTried.clear();
		progressKey = "";
		summary = "";
		reason = undefined;
		stopped = false;
		jobs.clear();
	};
	const assess = (ctx: ExtensionContext) => {
		const unavailable = () => compacting || stopped || !engaged || api.getFlag?.("goal-continuation") === false || !models().length;
		if (pending || control || continuationState.queuedGoalId || unavailable()) return;
		pending = setTimeout(() => {
			pending = undefined;
			if (unavailable() || !ctx.isIdle() || continuationState.queuedGoalId) return;
			const goal = loadGoalState(ctx);
			if (!isActiveGoal(goal) || goal.goalId !== engaged) return;
			const ready = readyWorkItems(goal);
			const queue = (source: GoalContinuationSource, hint: string) => {
				clearWait();
				if (evaluationRetry) clearTimeout(evaluationRetry);
				evaluationRetry = undefined;
				compacted = retryDue = false;
				if (retryTimer) clearTimeout(retryTimer);
				retryTimer = undefined;
				reason = hint;
				void maybeQueueGoalContinuation(api, continuationState, ctx, Date.now(), source).catch(() => {
					api.appendEntry("goal-scheduler", { goalId: goal.goalId, state: "queue-failed", source });
				});
			};
			const completed = takeCompletedJobs();
			if (completed.length) {
				// A terminal event is new evidence. Give the worker one bounded chance to
				// collect it; a stale handoff or a reviewer verdict is not a stop decision.
				queue(completed.some(job => job.kind === "proof") ? "proof-job" : "workbench-job", completedJobsNotice(completed));
				return;
			}
			if (waitDue) {
				const due = waitDue.filter(job => jobs.get(`${job.kind}:${job.id}`)?.state === "pending");
				waitDue = undefined;
				if (due.length) {
					for (const job of due) rechecked.add(`${job.kind}:${job.id}`);
					waitRechecks++;
					queue("wait-recheck", `Waiting job(s) had no terminal event: ${due.map(job => `${job.kind}:${job.id}`).join(", ")}. Reconcile their status using proof_jobs or subagent_results and check existing persisted artifacts. This is not a failure signal or authority to restart work. Do not duplicate live or completed work; if still running, report that; if missing, record what you verified and use only an authorized checkpoint.`);
					return;
				}
			}
			if (allPathsBlocked(goal) || getOpenBlockers(goal).some(b => b.disposition !== "agent_can_try" && !b.workItemIds.length)) return;
			if (retryDue) { queue("provider-retry", "The last request failed after Pi retry handling. Make one bounded attempt from the current checkpoint; do not repeat already successful work."); return; }
			if (retryTimer || waitTimer || evaluationRetry || lastRunOutcome === "error") return;
			if (idleTurns >= 3) { compacted = false; return; }
			if (compacted && ready.length) { queue("compaction", "Context compaction finished. Resume from the current checkpoint and existing work items; collect any terminal jobs before starting duplicate work."); return; }
			compacted = false;
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
				const hasPendingJobs = [...jobs.values()].some(job => job.state === "pending");
				const handoff = !answer && !usedHandoffFallback
					? handoffAction(summary, ready.map(item => item.id), hasPendingJobs) : undefined;
				const defaultAction = "Resume from the saved checkpoint: take an authorized ready action, or add a concrete next action to the unfinished current milestone. Do not repeat completed work or bypass blockers";
				const hardBlockers = getOpenBlockers(goal).filter(isHardBlocker);
				const blockerSignature = hardBlockers.map(blocker => blocker.id).sort().join("|");
				const canResume = !hasPendingJobs && (ready.length > 0 ||
					(currentMilestone(goal) !== undefined && hardBlockers.length === 0));
				// A model cannot veto authorized ready work based solely on its own stop/wait suggestion.
				const defaultResume = answer?.decision !== "continue" && !handoff && canResume && !routesTried.has(defaultAction.toLowerCase());
				const blockerRecheck = !defaultResume && !handoff && answer?.decision === "uncertain" && !hasPendingJobs &&
					hardBlockers.length > 0 && !blockerRechecked.has(blockerSignature);
				const fallback = handoff ?? (defaultResume ? defaultAction : blockerRecheck ? GOAL_BLOCKER_RECHECK_ACTION : undefined);
				const action = answer?.decision === "continue" ? answer.action : fallback;
				const key = action?.toLowerCase().replace(/\s+/g, " ");
				const recheck = fallback === GOAL_BLOCKER_RECHECK_ACTION;
				const repeated = key !== undefined && (recheck ? blockerRechecked.has(blockerSignature) : routesTried.has(key));
				api.appendEntry("goal-evaluation", { goalId: goal.goalId, model: answer?.model, decision: repeated ? "repeated-action" : answer?.decision ?? "unavailable", reason: answer?.reason, action, wake: answer?.decision === "wait" ? answer.wake : undefined, failures, fallback: fallback && !repeated ? (defaultResume ? "default-resume" : recheck ? "blocker-recheck" : "handoff") : undefined, at: Date.now() });
				if (recheck && !repeated) api.appendEntry("goal-scheduler", { goalId: goal.goalId, state: "blocker-recheck", blockers: hardBlockers.map(blocker => ({ id: blocker.id, disposition: blocker.disposition, workItemIds: blocker.workItemIds })) });
				if (answer?.decision === "stop" && !canResume && !hasPendingJobs) stopped = true;
				if (hasPendingJobs && (!action || repeated)) {
					const live = [...jobs.entries()].filter(([id, job]) => job.state === "pending" && !rechecked.has(id));
					const named = live.filter(([, job]) => answer?.decision === "wait" && answer.wake.includes(job.id));
					const targets = (named.length ? named : live).map(([, job]) => job);
					if (targets.length && waitRechecks < 3) {
						api.appendEntry("goal-scheduler", { goalId: goal.goalId, state: "waiting-job", ids: targets.map(job => job.id), recheckAt: Date.now() + GOAL_WAIT_RECHECK_MS });
						waitTimer = setTimeout(() => {
							waitTimer = undefined;
							waitDue = targets;
							assess(ctx);
						}, GOAL_WAIT_RECHECK_MS);
						waitTimer.unref?.();
					}
				}
				if (!answer && !fallback && !hasPendingJobs) {
					if (!evaluationRetryUsed && ready.length) {
						evaluationRetryUsed = true;
						api.appendEntry("goal-scheduler", { goalId: goal.goalId, state: "evaluator-backoff", retryAt: Date.now() + GOAL_EVALUATOR_RETRY_MS });
						evaluationRetry = setTimeout(() => {
							evaluationRetry = undefined;
							assess(ctx);
						}, GOAL_EVALUATOR_RETRY_MS);
						evaluationRetry.unref?.();
					} else {
						api.appendEntry("goal-scheduler", { goalId: goal.goalId, state: "evaluator-unavailable-no-retry", reason: ready.length ? "retry-exhausted" : "no-ready-work" });
						ctx.ui?.notify?.("/goal 自动续跑评估不可用；没有后台任务可等待。恢复后可用 /goal start 从检查点继续。", "warning");
					}
				} else if (answer) evaluationRetryUsed = false;
				if (!key || repeated) return;
				if (recheck) blockerRechecked.add(blockerSignature);
				else routesTried.add(key);
				if (handoff) usedHandoffFallback = true;
				reason = `Proposed next action: ${action}. Reason: ${answer?.reason ?? "Continue only within the active goal's existing authorization."}`;
				await maybeQueueGoalContinuation(api, continuationState, ctx, Date.now(), defaultResume ? "evaluator-fallback" : recheck ? "blocker-recheck" : handoff ? "handoff" : "evaluator");
			}).catch(() => {
				if (!run.signal.aborted) api.appendEntry("goal-scheduler", { goalId: goal.goalId, state: "evaluation-failed" });
			}).finally(() => {
				if (control !== run) return;
				control = undefined;
				if (jobEventVersion !== epoch || compacted || waitDue || retryDue) assess(ctx);
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
			jobs.delete(key);
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
		ordinaryTurn = ordinaryPrompt === prompt;
		ordinaryPrompt = undefined;
		if (!ordinaryTurn && (isContinuationPrompt(prompt) || prompt.startsWith(GOAL_START_PREFIX))) engaged = goal.goalId;
		if (deferredStart && prompt.startsWith(GOAL_START_PREFIX)) deferredStart = undefined;
		// Results that finished while a continuation was already queued are noticed
		// here once, instead of causing a second wake after this run.
		const executing = !ordinaryTurn && engaged === goal.goalId;
		const late = executing ? completedJobsNotice(takeCompletedJobs()) : "";
		const hint = executing ? [reason, late].filter(Boolean).join(" ") || undefined : undefined;
		if (executing) reason = undefined;
		return {
			...(executing && event.systemPrompt !== undefined && !event.systemPrompt.includes(GOAL_EXECUTION_SYSTEM_PROMPT)
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

	pi.on("session_before_compact", async (event) => {
		if (engaged && !stopped) {
			compacting = true;
			control?.abort();
			control = undefined;
		}
		return createGoalCompaction(event);
	});

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
		if (event.source === "interactive" || event.source === "rpc") {
			const goal = loadGoalState(ctx);
			if (!isActiveGoal(goal) || !text.trim()) return;
			const stopLocally = isExplicitGoalStop(text);
			const continueLocally = !stopLocally && isContinuationPrompt(text);
			control?.abort();
			const leaf = ctx.sessionManager.getLeafId();
			const intent = continueLocally || stopLocally || !models().length ? undefined : await evaluateGoal(
				models(), JSON.stringify({ userMessage: text.slice(0, 4000) }),
				AbortSignal.timeout(5_000), askGoalEvaluator(ctx, true), 1_500,
			);
			if (ctx.sessionManager.getLeafId() !== leaf || loadGoalState(ctx)?.goalId !== goal.goalId) return;
			if (continueLocally || intent?.decision === "continue") {
				continuationState.queuedGoalId = undefined;
				reset();
				engaged = goal.goalId;
				api.appendEntry("goal-input-intent", { goalId: goal.goalId, decision: "continue", model: intent?.model });
			} else {
				if (stopLocally || intent?.decision === "stop") {
					continuationState.queuedGoalId = undefined;
					reset();
					stopped = true;
					updateContinuationStatus(ctx, continuationState);
					api.appendEntry("goal-input-intent", { goalId: goal.goalId, decision: "stop", model: intent?.model });
				}
				if (!event.streamingBehavior) ordinaryPrompt = text;
			}
			return;
		}
		if (!isContinuationPrompt(text)) return;
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
		if (!engaged || ordinaryTurn || !last) return;
		lastRunOutcome = last.stopReason === "aborted" || last.stopReason === "error" ? last.stopReason : "success";
		if (lastRunOutcome !== "success") return;
		providerRetryUsed = retryDue = false;
		if (retryTimer) clearTimeout(retryTimer);
		retryTimer = undefined;
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
	pi.on("session_compact", async (event, ctx) => {
		if (!compacting) return;
		compacting = false;
		if (event.willRetry) return;
		compacted = true;
		assess(ctx);
	});
	pi.on("session_compact_failed", async (event, ctx) => {
		if (!compacting) return;
		compacting = false;
		if (!event.aborted && !event.willRetry) assess(ctx);
	});
	pi.on("agent_settled", async (_event, ctx) => {
		syncLedger(ledger, ctx);
		if (engaged && lastRunOutcome === "aborted") {
			stopped = true;
			clearWait();
			api.appendEntry("goal-scheduler", { goalId: engaged, state: "aborted" });
			return;
		}
		if (engaged && lastRunOutcome === "error" && !stopped && !providerRetryUsed && api.getFlag?.("goal-continuation") !== false && models().length) {
			providerRetryUsed = true;
			api.appendEntry("goal-scheduler", { goalId: engaged, state: "provider-backoff", retryAt: Date.now() + PROVIDER_RETRY_MS });
			retryTimer = setTimeout(() => {
				retryTimer = undefined;
				retryDue = true;
				assess(ctx);
			}, PROVIDER_RETRY_MS);
			retryTimer.unref?.();
		} else if (engaged && lastRunOutcome === "error" && !retryTimer && !retryDue) {
			api.appendEntry("goal-scheduler", { goalId: engaged, state: "provider-error-no-retry" });
		}
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
	try {
		await api.sendUserMessage(renderContinuationPrompt(goal), { deliverAs: "followUp" });
	} catch (error) {
		if (state.queuedGoalId === goal.goalId) {
			stopGoalContinuation(api, state, "delivery-failed");
			updateContinuationStatus(ctx, state);
		}
		throw error;
	}
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

function isExplicitGoalStop(prompt: string): boolean {
	const text = prompt.trim().normalize("NFKC");
	if (/[?？]/u.test(text)) return false;
	return /^(?:暂停|停止|取消)(?:当前|这个|该)?(?:目标|研究|自动续跑)|^(?:不要|不用|不必|别|先别|暂不|先不)\s*继续(?:目标|研究|推进|执行)|^(?:do not|don['’]t)\s+(?:resume|continue)(?:\s+the goal)?\b|^(?:stop|pause)(?:\s+(?:the |this )?goal|\s+and explain|[.!]?$)/iu.test(text);
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
