/**
 * Host-side model proxy for sandboxed capabilities.
 *
 * The sandbox has no network access, so an `llm` step cannot call a model by
 * itself. It emits an RPC frame and this proxy answers it. Keeping the call here
 * is what makes the API key, the prompt template, the cost accounting and the
 * cache all live outside the sandbox.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

import type { Capability } from "./core.ts";
import type { LlmProxy } from "./sandbox/runner.ts";

export interface LlmUse {
	readonly capability: string;
	readonly promptId: string;
	readonly model: string;
	readonly cached: boolean;
	readonly tokens: { readonly input: number; readonly output: number };
	readonly costUsd: number;
}

export interface LlmProxyContext {
	readonly registry: ModelRegistry;
	readonly capability: Capability;
	readonly cache: Map<string, unknown>;
	readonly onUse?: (use: LlmUse) => void;
}

interface UsageShape {
	readonly input?: number;
	readonly output?: number;
	readonly cost?: { readonly total?: number };
}

/** `{key}` placeholders are replaced; other braces (e.g. JSON examples) are left alone. */
export function renderTemplate(template: string, variables: Record<string, unknown>): string {
	return template.replace(/\{(\w+)\}/g, (match, key: string) => {
		if (!(key in variables)) return match;
		const value = variables[key];
		if (Array.isArray(value)) return value.join(", ");
		if (value === null || value === undefined) return "";
		return typeof value === "object" ? JSON.stringify(value) : String(value);
	});
}

function textOf(content: readonly { type: string; text?: string }[]): string {
	return content
		.filter((part) => part.type === "text")
		.map((part) => part.text ?? "")
		.join("");
}

function extractJson(text: string): string {
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start < 0 || end <= start) {
		throw new Error(`model output is not JSON: ${text.slice(0, 120)}`);
	}
	return text.slice(start, end + 1);
}

function resolveModel(registry: ModelRegistry, modelKey: string) {
	const slash = modelKey.indexOf("/");
	if (slash <= 0) throw new Error(`model key must be "provider/model", got "${modelKey}"`);
	const model = registry.find(modelKey.slice(0, slash), modelKey.slice(slash + 1));
	if (!model) throw new Error(`model not found: ${modelKey}`);
	return model;
}

export function createLlmProxy(context: LlmProxyContext): LlmProxy {
	const templates = new Map<string, string>();

	return async (request) => {
		const step = context.capability.steps.find(
			(candidate) => candidate.kind === "llm" && candidate.id === request.promptId,
		);
		if (!step) {
			throw new Error(`capability "${context.capability.name}" has no llm step "${request.promptId}"`);
		}
		if (!step.prompt) throw new Error(`llm step "${step.id}" declares no prompt`);
		if (!step.model) throw new Error(`llm step "${step.id}" declares no model`);

		const variables =
			request.input && typeof request.input === "object"
				? (request.input as Record<string, unknown>)
				: {};

		let template = templates.get(step.prompt);
		if (template === undefined) {
			template = await readFile(join(context.capability.dir, step.prompt), "utf8");
			templates.set(step.prompt, template);
		}
		const prompt = renderTemplate(template, variables);
		const maxTokens = request.maxTokens ?? step.maxTokens ?? 256;

		const cacheKey = createHash("sha256")
			.update(JSON.stringify([context.capability.name, step.model, step.prompt, maxTokens, prompt]))
			.digest("hex");
		const cached = context.cache.get(cacheKey);
		if (cached !== undefined) {
			context.onUse?.({
				capability: context.capability.name,
				promptId: step.id,
				model: step.model,
				cached: true,
				tokens: { input: 0, output: 0 },
				costUsd: 0,
			});
			return { data: cached, tokens: { input: 0, output: 0 }, costUsd: 0, cached: true };
		}

		const stream = context.registry.streamSimple(
			resolveModel(context.registry, step.model),
			{
				messages: [
					{ role: "user", timestamp: Date.now(), content: [{ type: "text", text: prompt }] },
				],
			},
			{ maxTokens, temperature: 0, samplingParams: { enable_thinking: false } },
		);
		const message = await stream.result();
		if (message.stopReason === "error" || message.errorMessage) {
			throw new Error(message.errorMessage ?? "model call failed");
		}

		const data = JSON.parse(extractJson(textOf(message.content))) as unknown;
		context.cache.set(cacheKey, data);

		const usage = message.usage as UsageShape | undefined;
		const tokens = { input: usage?.input ?? 0, output: usage?.output ?? 0 };
		const costUsd = usage?.cost?.total ?? 0;
		context.onUse?.({
			capability: context.capability.name,
			promptId: step.id,
			model: step.model,
			cached: false,
			tokens,
			costUsd,
		});
		return { data, tokens, costUsd, cached: false };
	};
}