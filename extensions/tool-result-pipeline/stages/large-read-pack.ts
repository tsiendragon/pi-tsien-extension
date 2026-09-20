/**
 * Large Read Pack — stage 3 of the tool-result pipeline.
 *
 * A large `read` result is replaced, before it enters the context, by its head
 * and tail plus an observation id. The full text is archived first, so nothing
 * is lost: `obs_recall` returns every omitted byte, and the header says how.
 *
 * Why `read` specifically: in a full-history replay it is 25.6% of all
 * replay-weighted prompt tokens (`scripts/context-age-analysis.ts`), and
 * capping only the results above ~2000 tokens removes 5.1% of replay.
 *
 * Insertion-time rewrite is the whole point. Rewriting later, when the context
 * is projected (`pi.on("context")`, as observation-pack does), breaks the
 * provider prefix cache from the rewrite point onwards; with `cacheRead:input`
 * at 1:10 that costs more than it saves. See
 * `docs/session-context-token-plan.md` §7.
 *
 * Hard constraint, same as bash-digest: requires observation-pack to be enabled,
 * because a lossy rewrite without a recall path is not acceptable. Also disabled
 * by default — `~/.pi/agent/large-read-pack.json` must opt in.
 *
 * Every failure path is fail-open: the original text is returned untouched.
 */
import type { ExtensionContext, ToolResultEvent } from "@earendil-works/pi-coding-agent";

import {
	createObservation,
	ensureStored,
	loadObservationPackConfig,
	resolveSessionRoot,
	type TextBlock,
} from "../../observation-pack/core.ts";
import { decideReadPack, loadLargeReadPackConfig, renderReadPack } from "../large-read-pack/core.ts";
import { isPureText, textFromContent, type ToolResultStage } from "./common.ts";

function isReadResult(event: ToolResultEvent): boolean {
	return event.toolName === "read";
}

/** Builds the stage, or `undefined` when it must stay inert. */
export function createLargeReadPackStage(): ToolResultStage | undefined {
	const config = loadLargeReadPackConfig();
	if (!config.enabled) return undefined;

	const observations = loadObservationPackConfig();
	if (!observations.enabled) return undefined;

	const rendered = new Map<string, string>();
	let warned = false;

	const apply = async (event: ToolResultEvent, ctx: ExtensionContext) => {
		if (!isReadResult(event)) return undefined;
		if (event.isError === true) return undefined;

		const cached = rendered.get(event.toolCallId);
		if (cached !== undefined) {
			return { content: [{ type: "text" as const, text: cached }], details: event.details };
		}

		const content = event.content ?? [];
		if (!isPureText(content)) return undefined;

		const text = textFromContent(content);
		const decision = decideReadPack(text, config);
		if (!decision) return undefined;

		const sessionId = ctx.sessionManager?.getSessionId?.();
		const sessionRoot =
			typeof sessionId === "string" && sessionId !== ""
				? resolveSessionRoot(observations.archiveDir, sessionId)
				: undefined;
		if (!sessionRoot) return undefined;

		try {
			const archiveBlock: TextBlock = { type: "text", text: decision.text };
			const observation = createObservation(
				{
					role: "toolResult",
					toolName: "read",
					toolCallId: event.toolCallId,
					isError: false,
					content: [archiveBlock],
				},
				{ sessionRoot, thresholdBytes: 0 },
			);
			if (!observation) return undefined;
			await ensureStored(observation);

			const packed = renderReadPack({ decision, observationId: observation.id });
			rendered.set(event.toolCallId, packed);
			return {
				content: [{ type: "text" as const, text: packed }],
				details: event.details,
			};
		} catch (error) {
			if (!warned) {
				warned = true;
				ctx.ui.notify(
					`large-read-pack 失败，已回退原文：${error instanceof Error ? error.message : String(error)}`,
					"warning",
				);
			}
			return undefined;
		}
	};

	return { name: "large-read-pack", apply };
}
