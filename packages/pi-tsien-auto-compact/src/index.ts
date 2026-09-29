/**
 * Auto Compact Target — compact proactively at an absolute context-token target.
 *
 * Replaces the fixed "50% of a 1M window" rule with a single absolute target
 * (default 270K) applied to every model; models whose window cannot hold that
 * target converge proportionally (see core.ts).
 *
 * Trigger point is owned here (via `ctx.compact()`) instead of
 * `compaction.reserveTokens`, because pi derives the summarization output budget
 * from `reserveTokens` (`maxTokens = min(0.8 * reserveTokens, model.maxTokens)`);
 * inflating it to move the trigger would request a huge summary budget.
 *
 * The token count itself comes from `resolveCompactionTrigger` in core.ts — the
 * same resolver every status line (TUI bar, dashboard) uses to draw the trigger,
 * so a display can never show a line the actor does not use.
 *
 * Known limit: `ctx.isIdle()` guards every trigger, so compaction fires at agent
 * run boundaries (`agent_settled` / `session_start` / `model_select`). Pi's
 * built-in threshold stays in place as the last-resort guard for long
 * autonomous runs that never settle.
 *
 * Besides the token target, the package exposes the `compact_context` tool so an
 * agent asked in natural language to compact can request it explicitly. The tool
 * only records a request; the idle boundary above runs the compaction, because
 * `ctx.compact()` aborts a running turn (see compact-request.ts).
 */

import {
	SettingsManager,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	autoCompactTargetConfig,
	resolveCompactionTrigger,
	shouldCompact,
} from "pi-tsien-shared/src/auto-compact-target/core.ts";
import {
	createCompactRequestStore,
	type CompactRequestStore,
} from "./compact-request.ts";

/** Tool the model calls to ask for a compaction. */
const COMPACT_REQUEST_TOOL = "compact_context";

function sessionIdOf(ctx: ExtensionContext): string {
	return ctx.sessionManager.getSessionId();
}

function jsonResult(value: Record<string, unknown>) {
	return {
		content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
		details: value,
	};
}

/**
 * Register the agent-callable compaction trigger.
 *
 * The tool never compacts inline: it only records a request, so the run that
 * called it survives and its tool result reaches the model. `maybeCompact`
 * consumes the request once the session is idle.
 */
function registerCompactRequestTool(
	pi: ExtensionAPI,
	requests: CompactRequestStore,
): void {
	pi.registerTool({
		name: COMPACT_REQUEST_TOOL,
		label: "Compact context",
		description:
			"Summarize older conversation context into a structured summary so the session can keep working in a smaller window. " +
			"Call it when the user asks in natural language to compact, compress, or clean up the context, or when the context is getting large. " +
			"Compaction is scheduled and runs at the end of the current agent run; the most recent work is kept. " +
			"Do not call it merely to summarize text for the user — answer directly instead.",
		promptSnippet: "Schedule a context compaction at the end of this run",
		promptGuidelines: [
			"Call compact_context when the user asks to compact or compress the conversation context; it schedules compaction for the end of the current run, so stop starting new work after calling it.",
		],
		parameters: Type.Object(
			{
				instructions: Type.Optional(
					Type.String({
						minLength: 1,
						maxLength: 2000,
						description:
							"Optional focus for the summary, e.g. what must be carried over",
					}),
				),
			},
			{ additionalProperties: false },
		),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			// `ctx.compact()` is fire-and-forget and the one-shot modes (`-p` /
			// `--mode print|json`) dispose the session as soon as the run ends, which
			// cancels the deferred compaction mid-flight. Report that instead of
			// promising a compaction that cannot finish.
			if (ctx.mode !== "tui" && ctx.mode !== "rpc") {
				return jsonResult({
					status: "unavailable_in_one_shot_mode",
					mode: ctx.mode,
					note: "Nothing was scheduled: this mode exits as soon as the run ends, so a deferred compaction would be cancelled. Compaction works in interactive (tui) and rpc sessions.",
				});
			}

			const sessionId = sessionIdOf(ctx);
			const tokens = ctx.getContextUsage()?.tokens ?? null;
			const outcome = requests.request(sessionId, params.instructions);

			if (outcome === "already_scheduled") {
				return jsonResult({
					status: outcome,
					tokens,
					note: "A compaction is already scheduled for the end of this run.",
				});
			}

			ctx.ui.notify(
				`已安排在本轮结束后压缩上下文${tokens === null ? "" : `（当前 ${tokens.toLocaleString()} token）`}`,
				"info",
			);
			return jsonResult({
				status: outcome,
				tokens,
				customInstructions: params.instructions ?? null,
				note: "Compaction runs at the end of this agent run and replaces older messages with a summary; recent work is kept. Stop starting new work now.",
			});
		},
	});
}

/** Fire an agent-requested compaction and report its outcome to the user. */
function runRequestedCompaction(
	ctx: ExtensionContext,
	requests: CompactRequestStore,
	sessionId: string,
	instructions: string | undefined,
): void {
	const tokens = ctx.getContextUsage()?.tokens ?? null;
	ctx.ui.notify(
		`按 Agent 请求压缩上下文${tokens === null ? "" : `（当前 ${tokens.toLocaleString()} token）`}`,
		"info",
	);
	ctx.compact({
		customInstructions: instructions,
		onComplete: (result) => {
			requests.clear(sessionId);
			const after = result.estimatedTokensAfter;
			ctx.ui.notify(
				after === undefined
					? `上下文已压缩（压缩前 ${result.tokensBefore.toLocaleString()} token）`
					: `上下文已压缩：${result.tokensBefore.toLocaleString()} → ${after.toLocaleString()} token`,
				"info",
			);
		},
		onError: (error) => {
			requests.clear(sessionId);
			ctx.ui.notify(`上下文压缩失败：${error.message}`, "error");
		},
	});
}

function compactionEnabled(ctx: ExtensionContext): boolean {
	try {
		const settings = SettingsManager.create(ctx.cwd, undefined, {
			projectTrusted: ctx.isProjectTrusted(),
		}).getCompactionSettings(ctx.model ?? undefined);
		return settings.enabled;
	} catch {
		return true;
	}
}

export default function autoCompactTarget(pi: ExtensionAPI): void {
	const config = autoCompactTargetConfig();

	// The agent tool is available even when proactive threshold compaction is
	// disabled: a request is explicit, the config only governs the automatic path.
	const requests = createCompactRequestStore();
	registerCompactRequestTool(pi, requests);

	// Re-armed once usage drops back below the target (e.g. after compaction),
	// so each threshold crossing triggers at most one proactive compaction.
	let armed = true;

	const maybeCompact = (_event: unknown, ctx: ExtensionContext): void => {
		// An explicit agent request wins over the threshold trigger, but it still
		// waits for an idle boundary because `ctx.compact()` aborts a running turn.
		if (ctx.isIdle()) {
			const sessionId = sessionIdOf(ctx);
			const requested = requests.take(sessionId);
			if (requested) {
				runRequestedCompaction(ctx, requests, sessionId, requested.instructions);
				return;
			}
		}

		if (!config.enabled) return;

		const usage = ctx.getContextUsage();
		if (!usage) return;

		const contextWindow = ctx.model?.contextWindow ?? usage.contextWindow;
		// This extension's own candidate only: pi's `reserveTokens` guard stays pi's
		// job (it fires at the same point or earlier and needs no help here). The
		// shared resolver is what keeps this trigger and every display in sync.
		const { triggerTokens } = resolveCompactionTrigger({
			contextWindow,
			model: ctx.model ?? undefined,
			config,
		});

		if (!shouldCompact(usage.tokens, triggerTokens)) {
			armed = true;
			return;
		}
		if (!armed) return;
		if (!ctx.isIdle()) return;
		if (!compactionEnabled(ctx)) return;

		armed = false;
		ctx.ui.notify(
			`上下文 ${usage.tokens?.toLocaleString()} token 已达目标 ${triggerTokens.toLocaleString()}，提前压缩`,
			"info",
		);
		ctx.compact();
	};

	pi.on("session_start", (_event, ctx) => {
		armed = true;
		maybeCompact(undefined, ctx);
	});
	pi.on("context", maybeCompact);
	pi.on("agent_settled", maybeCompact);
	pi.on("model_select", (_event, ctx) => {
		armed = true;
		maybeCompact(undefined, ctx);
	});
	pi.on("session_shutdown", (_event, ctx) => {
		requests.clear(sessionIdOf(ctx));
	});
}
