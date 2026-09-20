/**
 * Tool-Result Pipeline — the single `tool_result` entry point for this repo.
 *
 * Why one entry point: this layer used to hold several independent extensions
 * (RTK, bash-digest), and their relative order lived only in
 * `~/.pi/agent/extensions.config.json`'s `loadOrder` array. bash-digest's own
 * comment admitted it "runs after RTK", with nothing enforcing it. This module
 * makes the order an explicit, tested array, so adding a mechanism means adding
 * a stage — not another extension competing for the same hook.
 *
 * Stage contract: `(event, ctx) -> Promise<{ content } | undefined>`. A stage
 * returns `undefined` when it has nothing to say, and every stage must be
 * fail-open (return `undefined` on any error) so a broken stage degrades to
 * "output unchanged" instead of losing tool output.
 *
 * Layer map:
 *
 *   tool_result
 *     ├─ stage 1  rtk         ANSI / build / test / git / linter / truncate, source filter, grep grouping
 *     ├─ stage 2  bash-digest lossy bash summary with an `obs_recall` fallback
 *     └─ stage 3  large-read-pack  head + tail of a large `read`, full text archived for `obs_recall`
 *
 * Rewriting here happens at *insertion* time, so the reduced text is what enters
 * the conversation and what gets cached. Rewriting later (at `pi.on("context")`,
 * as observation-pack does) invalidates the provider prefix cache instead; see
 * `docs/session-context-token-plan.md` §7 for why that is expensive.
 */
import type {
	ExtensionAPI,
	ExtensionContext,
	ToolResultEvent,
} from "@earendil-works/pi-coding-agent";

import { applyRtkFilters, registerRtkSurface } from "./tool-result-pipeline/rtk/index.ts";
import { createBashDigestStage } from "./tool-result-pipeline/stages/bash-digest.ts";
import type { ToolResultStage } from "./tool-result-pipeline/stages/common.ts";
import { createLargeReadPackStage } from "./tool-result-pipeline/stages/large-read-pack.ts";

/** Declared stage order. Tests assert the constructed pipeline matches it. */
export const STAGE_ORDER = ["rtk", "bash-digest", "large-read-pack"] as const;

export function buildStages(): ToolResultStage[] {
	const stages: ToolResultStage[] = [];
	for (const create of [createBashDigestStage, createLargeReadPackStage]) {
		const stage = create();
		if (stage) stages.push(stage);
	}
	return stages;
}

export default function toolResultPipeline(pi: ExtensionAPI): void {
	// RTK also owns its commands, its `rtk_configure` tool and its system prompt
	// note; only its output transform moved into the pipeline.
	registerRtkSurface(pi);

	const stages = buildStages();

	pi.on("tool_result", async (event, ctx: ExtensionContext) => {
		let content: ToolResultEvent["content"] = event.content;
		let details: unknown = event.details;
		let usage: unknown;
		let changed = false;

		const rtk = await applyRtkFilters({ ...event, content } as ToolResultEvent, ctx);
		if (rtk) {
			content = rtk.content;
			changed = true;
		}

		for (const stage of stages) {
			try {
				const result = await stage.apply({ ...event, content } as ToolResultEvent, ctx);
				if (!result) continue;
				content = result.content as ToolResultEvent["content"];
				if (result.details !== undefined) details = result.details;
				if (result.usage !== undefined) usage = result.usage;
				changed = true;
			} catch {
				// Fail-open: a broken stage must not drop tool output.
				continue;
			}
		}

		if (!changed) return undefined;
		return usage === undefined ? { content, details } : { content, details, usage: usage as never };
	});
}
