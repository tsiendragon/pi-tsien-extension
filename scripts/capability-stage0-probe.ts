/**
 * Stage 0 probe for the capability layer.
 *
 * Verifies the two mechanisms the design depends on, with real calls:
 *  1. a sandboxed capability child can reach a model only through the host proxy
 *  2. what one fixed-pipeline call costs in tokens and latency, and whether the
 *     cache turns a repeat input into a deterministic, zero-cost hit
 *
 * Usage: npx tsx scripts/capability-stage0-probe.ts
 */
import { createHash } from "node:crypto";
import { join } from "node:path";

import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";

import { runCapability, type LlmReply } from "../extensions/capability/sandbox/runner.ts";

const MODEL_KEY = process.env.CAPABILITY_PROBE_MODEL ?? "dashscope/deepseek-v4.1-flash";
const CAPABILITY_DIR = join(
	import.meta.dirname,
	"..",
	"extensions",
	"capability",
	"capabilities",
	"classify-text",
);

const SAMPLES = [
	"2026-09-21 03:14:02 ERROR db.connect failed: timeout after 30s (host=db-primary-7)",
	"2026-09-21 03:14:05 WARN retry budget exhausted after 3 attempts",
	"2026-09-21 03:14:07 INFO pipeline resumed from checkpoint 42",
	"2026-09-21 03:14:09 DEBUG flushing buffer size=8192",
];

function buildPrompt(promptId: string, input: unknown): string {
	const payload = input as { text?: string; labels?: string[] };
	switch (promptId) {
		case "classify":
			return [
				`Classify the log line into exactly one label from: ${(payload.labels ?? []).join(", ")}.`,
				`Respond with JSON only: {"label":"<label>"}.`,
				"",
				payload.text ?? "",
			].join("\n");
		default:
			throw new Error(`unknown prompt: ${promptId}`);
	}
}

function extractJson(text: string): string {
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start < 0 || end <= start) throw new Error(`no json in model output: ${text.slice(0, 120)}`);
	return text.slice(start, end + 1);
}

async function main(): Promise<void> {
	const runtime = await ModelRuntime.create();
	const registry = new ModelRegistry(runtime);

	const slash = MODEL_KEY.indexOf("/");
	const provider = MODEL_KEY.slice(0, slash);
	const modelId = MODEL_KEY.slice(slash + 1);
	const model = registry.find(provider, modelId);
	if (!model) throw new Error(`model not found: ${MODEL_KEY}`);
	console.log(`model: ${MODEL_KEY}`);

	const cache = new Map<string, unknown>();
	let realCalls = 0;
	let cacheHits = 0;
	let usageShapePrinted = false;

	const llm = async (request: {
		id: number;
		promptId: string;
		input: unknown;
		maxTokens?: number;
	}): Promise<LlmReply> => {
		const key = createHash("sha256")
			.update(JSON.stringify([MODEL_KEY, request.promptId, request.input, request.maxTokens ?? null]))
			.digest("hex");
		const hit = cache.get(key);
		if (hit !== undefined) {
			cacheHits += 1;
			return { data: hit, tokens: { input: 0, output: 0 }, cached: true };
		}

		realCalls += 1;
		const stream = registry.streamSimple(
			model,
			{
				messages: [
					{
						role: "user",
						timestamp: Date.now(),
						content: [{ type: "text", text: buildPrompt(request.promptId, request.input) }],
					},
				],
			},
			{ maxTokens: request.maxTokens ?? 128, temperature: 0, samplingParams: { enable_thinking: false } },
		);
		const message = await stream.result();
		if (!usageShapePrinted) {
			console.log(`usage shape: ${JSON.stringify(message.usage)}`);
			usageShapePrinted = true;
		}
		const text = message.content
			.filter((part) => part.type === "text")
			.map((part) => part.text ?? "")
			.join("");
		const data = JSON.parse(extractJson(text)) as unknown;
		cache.set(key, data);

		const usage = message.usage as
			| { input?: number; output?: number; cost?: { total?: number } }
			| undefined;
		return {
			data,
			tokens: { input: usage?.input ?? 0, output: usage?.output ?? 0 },
			costUsd: usage?.cost?.total ?? 0,
			cached: false,
		};
	};

	console.log(`capability dir: ${CAPABILITY_DIR}`);
	console.log("");

	const runs: Awaited<ReturnType<typeof runCapability>>[] = [];
	for (const [index, text] of SAMPLES.entries()) {
		const result = await runCapability({ capabilityDir: CAPABILITY_DIR, input: { text }, llm, timeoutMs: 60_000 });
		runs.push(result);
		console.log(`run#${index + 1} ${JSON.stringify(result)}`);
	}

	const totalLlmCallsBeforeRepeat = realCalls;
	const repeat = await runCapability({
		capabilityDir: CAPABILITY_DIR,
		input: { text: SAMPLES[0] },
		llm,
		timeoutMs: 60_000,
	});
	console.log(`run#repeat ${JSON.stringify(repeat)}`);

	const coldDurations = runs.map((run) => run.durationMs);
	const totalCost = runs.reduce((sum, run) => sum + run.costUsd, 0);
	const totalTokens = runs.reduce(
		(acc, run) => ({ input: acc.input + run.tokens.input, output: acc.output + run.tokens.output }),
		{ input: 0, output: 0 },
	);

	console.log("");
	console.log(`distinct model calls (4 samples): ${totalLlmCallsBeforeRepeat}`);
	console.log(`cold latency ms: ${JSON.stringify(coldDurations)}`);
	console.log(`tokens: ${JSON.stringify(totalTokens)}, cost usd: ${totalCost.toFixed(8)}`);
	console.log(`repeat consumed real calls: ${realCalls - totalLlmCallsBeforeRepeat}`);
	const deterministic = JSON.stringify(runs[0]?.output) === JSON.stringify(repeat.output);
	console.log(`deterministic after cache: ${deterministic}`);
	console.log(
		"acceptance: 4 runs ok + 4 distinct calls + repeat adds 0 calls + identical repeat output == pass",
	);

	const allOk = runs.every((run) => run.ok) && repeat.ok;
	if (!allOk || totalLlmCallsBeforeRepeat !== SAMPLES.length || !deterministic) process.exitCode = 1;
}

await main();