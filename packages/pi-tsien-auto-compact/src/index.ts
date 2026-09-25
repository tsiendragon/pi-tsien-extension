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
 * Known limit: `ctx.isIdle()` guards the trigger, so compaction fires at agent
 * run boundaries (`agent_settled` / `session_start` / `model_select`). Pi's
 * built-in threshold stays in place as the last-resort guard for long
 * autonomous runs that never settle.
 */

import {
	SettingsManager,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	autoCompactTargetConfig,
	resolveCompactionTrigger,
	shouldCompact,
} from "pi-tsien-shared/src/auto-compact-target/core.ts";

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
	if (!config.enabled) return;

	// Re-armed once usage drops back below the target (e.g. after compaction),
	// so each threshold crossing triggers at most one proactive compaction.
	let armed = true;

	const maybeCompact = (_event: unknown, ctx: ExtensionContext): void => {
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
}
