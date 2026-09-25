/**
 * The single model-call path used by the bash digest extension and by the
 * offline measurement scripts, so what is measured is exactly what runs.
 *
 * Returns undefined on any failure (missing model, timeout, provider error,
 * empty response) instead of throwing: the caller always falls back to the
 * original text.
 */

import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

import {
	buildDigestPrompt,
	estimateTokens,
	isKeepSignal,
	normalizeDigest,
	parseModelKey,
	resolveMaxTokens,
	type BashDigestConfig,
} from "./core.ts";

export interface DigestTextInput {
	readonly registry: ModelRegistry;
	/** `provider/model`, as configured. */
	readonly modelKey: string;
	readonly text: string;
	readonly command?: string;
	readonly config: BashDigestConfig;
	/** Parent cancellation, e.g. `ctx.signal`. */
	readonly signal?: AbortSignal;
	/** Override the computed output budget (used by measurement scripts). */
	readonly maxTokens?: number;
}

export interface DigestTextResult {
	/** `keep` means the model judged that compressing would drop distinct facts. */
	readonly kind: "digest" | "keep";
	readonly text: string;
	readonly tokens: number;
	readonly usage?: unknown;
}

function textFromParts(content: readonly { type: string; text?: string }[]): string {
	return content
		.filter((part) => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text ?? "")
		.join("");
}

export async function digestText(input: DigestTextInput): Promise<DigestTextResult | undefined> {
	const key = parseModelKey(input.modelKey);
	if (!key) return undefined;
	const model = input.registry?.find(key.provider, key.modelId);
	if (!model) return undefined;

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), input.config.timeoutMs);
	const signals: AbortSignal[] = [controller.signal];
	if (input.signal) signals.push(input.signal);

	try {
		const stream = input.registry.streamSimple(
			model,
			{
				messages: [
					{
						role: "user",
						timestamp: Date.now(),
						content: [
							{
								type: "text",
								text: buildDigestPrompt({
									output: input.text,
									command: input.command,
									targetTokens: input.config.targetTokens,
									maxDigestRatio: input.config.maxDigestRatio,
								}),
							},
						],
					},
				],
			},
			{
				maxTokens: input.maxTokens ?? resolveMaxTokens(estimateTokens(input.text), input.config),
				temperature: 0,
				// Non-thinking without sending `reasoning_effort`: the dashscope
				// adapter rejects that field when thinking is disabled.
				samplingParams: { enable_thinking: false },
				signal: AbortSignal.any(signals),
			},
		);
		const message = await stream.result();
		if (message.stopReason === "error" || message.errorMessage) return undefined;
		const text = normalizeDigest(textFromParts(message.content));
		if (text === "") return undefined;
		if (isKeepSignal(text)) {
			return { kind: "keep", text: "", tokens: 0, usage: message.usage };
		}
		return { kind: "digest", text, tokens: estimateTokens(text), usage: message.usage };
	} catch {
		return undefined;
	} finally {
		clearTimeout(timer);
	}
}
