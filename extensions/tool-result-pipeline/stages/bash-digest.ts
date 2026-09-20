/**
 * Bash Digest — replace large bash output with a short model-written digest.
 *
 * Runs as stage 2 of `extensions/tool-result-pipeline.ts`, after the RTK stage,
 * so it digests the RTK-filtered text; the pipeline feeds each stage's output
 * into the next one. The raw text is archived with the observation-pack layout
 * and referenced by observation id, so the digest is an index and `obs_recall`
 * still reaches the full output.
 *
 * Hard constraint: digesting requires observation-pack to be enabled, because a
 * lossy rewrite without a recall path is not acceptable. Otherwise this
 * extension stays inert and bash output is returned unchanged.
 *
 * Every failure path is fail-open: the original text is returned untouched.
 * Design and measured numbers: docs/session-context-token-plan.md
 */

import type { ExtensionContext, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { isBashToolResult } from "@earendil-works/pi-coding-agent";

import { isPureText, textFromContent, type ToolResultStage } from "./common.ts";

export type { ToolResultStage };

import {
	createObservation,
	ensureStored,
	loadObservationPackConfig,
	resolveSessionRoot,
	type TextBlock,
} from "../../observation-pack/core.ts";
import { digestText } from "../bash-digest/model.ts";
import {
	decideDigest,
	loadBashDigestConfig,
	renderDigest,
	type BashDigestConfig,
} from "../bash-digest/core.ts";

function commandFromInput(input: Record<string, unknown>): string | undefined {
	const command = input.command;
	return typeof command === "string" ? command : undefined;
}

/**
 * Builds the bash-digest stage, or `undefined` when it must stay inert:
 * inert when the digest is disabled, or when observation-pack is disabled,
 * because a lossy rewrite without a recall path is not acceptable.
 *
 * Every failure path is fail-open: the original text is returned untouched.
 */
export function createBashDigestStage(): ToolResultStage | undefined {
	const config: BashDigestConfig = loadBashDigestConfig();
	if (!config.enabled) return;

	// A lossy rewrite needs a recall path; without observation-pack, stay inert.
	const observations = loadObservationPackConfig();
	if (!observations.enabled) return;

	const rendered = new Map<string, string>();
	let active = 0;
	let warned = false;

	const apply = async (event: ToolResultEvent, ctx: ExtensionContext) => {
			if (!isBashToolResult(event)) return undefined;
			if (event.isError === true) return undefined;
			if (!isPureText(event.content)) return undefined;

			const cached = rendered.get(event.toolCallId);
			if (cached !== undefined) {
				return { content: [{ type: "text" as const, text: cached }], details: event.details };
			}

			if (active >= config.maxConcurrent) return undefined;

			const command = commandFromInput(event.input);
			const decision = decideDigest({
				text: textFromContent(event.content),
				isError: false,
				config,
				command,
			});
			if (!decision.digest) return undefined;

			const sessionId = ctx.sessionManager?.getSessionId?.();
			const sessionRoot =
				typeof sessionId === "string" && sessionId !== ""
					? resolveSessionRoot(observations.archiveDir, sessionId)
					: undefined;
			if (!sessionRoot) return undefined;

			active += 1;
			try {
				const archiveBlock: TextBlock = { type: "text", text: decision.text };
				const observation = createObservation(
					{
						role: "toolResult",
						toolName: "bash",
						toolCallId: event.toolCallId,
						isError: false,
						content: [archiveBlock],
					},
					{ sessionRoot, thresholdBytes: 0 },
				);
				if (!observation) return undefined;
				await ensureStored(observation);

				const digest = await digestText({
					registry: ctx.modelRegistry,
					modelKey: config.digestModel,
					text: decision.text,
					command,
					config,
					signal: ctx.signal,
				});
				if (!digest) return undefined;

				// The model declined to compress, or the digest is not meaningfully
				// smaller: either way the original text is more useful than a rewrite
				// that would only force the agent to call `obs_recall` anyway.
				if (digest.kind === "keep") return undefined;
				if (digest.tokens >= decision.tokens * config.maxDigestRatio) return undefined;

				const text = renderDigest({
					digest: digest.text,
					originalTokens: decision.tokens,
					digestTokens: digest.tokens,
					observationId: observation.id,
				});
				rendered.set(event.toolCallId, text);
				return {
					content: [{ type: "text" as const, text }],
					details: event.details,
					usage: digest.usage as never,
				};
			} catch (error) {
				if (!warned) {
					warned = true;
					ctx.ui.notify(
						`bash-digest 失败，已回退原文：${error instanceof Error ? error.message : String(error)}`,
						"warning",
					);
				}
				return undefined;
			} finally {
				active -= 1;
			}
	};

	return { name: "bash-digest", apply };
}
