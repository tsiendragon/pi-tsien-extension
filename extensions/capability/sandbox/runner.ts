/**
 * Capability sandbox runner.
 *
 * Starts a `node --permission` child that can read only the capability directory
 * and write only the per-job temp directory. Network, child processes, workers,
 * FFI and addons are all denied, so the child cannot reach a model by itself:
 * every model call is an RPC frame that this parent answers.
 *
 * The child's protocol is one JSON object per line on stdout:
 *   { "__frame__": "rpc", id, prompt_id, input, max_tokens }   parent must reply
 *   { "__frame__": "result", output }                          terminal
 * The parent replies on the child's stdin:
 *   { "__frame__": "job", input }                              first line
 *   { "__frame__": "rpc_result", id, ok, data?, error? }        per rpc
 */

import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

export interface LlmRequest {
	readonly id: number;
	readonly promptId: string;
	readonly input: unknown;
	readonly maxTokens?: number;
}

export interface LlmReply {
	readonly data: unknown;
	readonly tokens: { readonly input: number; readonly output: number };
	readonly costUsd?: number;
	readonly cached: boolean;
}

export type LlmProxy = (request: LlmRequest) => Promise<LlmReply>;

export interface RunCapabilityOptions {
	readonly capabilityDir: string;
	readonly input: unknown;
	readonly llm: LlmProxy;
	readonly timeoutMs?: number;
	readonly maxOutputBytes?: number;
	readonly maxLlmCalls?: number;
}

export interface RunCapabilityResult {
	readonly ok: boolean;
	readonly output?: unknown;
	readonly error?: string;
	readonly llmCalls: number;
	readonly tokens: { readonly input: number; readonly output: number };
	readonly costUsd: number;
	readonly cacheHits: number;
	readonly durationMs: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1 << 20;
const DEFAULT_MAX_LLM_CALLS = 8;

export async function runCapability(options: RunCapabilityOptions): Promise<RunCapabilityResult> {
	const started = Date.now();
	const jobTmp = await mkdtemp(join(tmpdir(), "cap-job-"));
	const entry = join(options.capabilityDir, "impl", "run.mjs");
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
	const maxLlmCalls = options.maxLlmCalls ?? DEFAULT_MAX_LLM_CALLS;

	const child = spawn(
		process.execPath,
		["--permission", `--allow-fs-read=${options.capabilityDir}`, `--allow-fs-write=${jobTmp}`, entry],
		{ cwd: jobTmp, stdio: ["pipe", "pipe", "pipe"] },
	);

	let stderr = "";
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk: string) => {
		if (stderr.length < 4096) stderr += chunk;
	});

	let output: unknown;
	let failure: string | undefined;
	let llmCalls = 0;
	let cacheHits = 0;
	let outputBytes = 0;
	let costUsd = 0;
	const tokens = { input: 0, output: 0 };

	const closed = new Promise<void>((resolve) => {
		child.on("close", () => resolve());
		child.on("error", (error) => {
			failure ??= `spawn: ${error.message}`;
			resolve();
		});
	});

	const timer = setTimeout(() => {
		failure ??= "timeout";
		child.kill("SIGKILL");
	}, timeoutMs);

	const write = (frame: Record<string, unknown>): void => {
		if (child.stdin.writable) child.stdin.write(`${JSON.stringify(frame)}\n`);
	};

	let queue: Promise<void> = Promise.resolve();
	const handleFrame = (frame: Record<string, unknown>): void => {
		queue = queue.then(async () => {
			if (frame.__frame__ === "result") {
				output = frame.output;
				return;
			}
			if (frame.__frame__ !== "rpc") return;
			const id = Number(frame.id);
			if (llmCalls >= maxLlmCalls) {
				write({ __frame__: "rpc_result", id, ok: false, error: "budget_exceeded" });
				return;
			}
			llmCalls += 1;
			try {
				const reply = await options.llm({
					id,
					promptId: String(frame.prompt_id),
					input: frame.input,
					maxTokens: typeof frame.max_tokens === "number" ? frame.max_tokens : undefined,
				});
				if (reply.cached) cacheHits += 1;
				tokens.input += reply.tokens.input;
				tokens.output += reply.tokens.output;
				costUsd += reply.costUsd ?? 0;
				write({ __frame__: "rpc_result", id, ok: true, data: reply.data, cached: reply.cached });
			} catch (error) {
				write({
					__frame__: "rpc_result",
					id,
					ok: false,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		});
	};

	const stdout = createInterface({ input: child.stdout });
	stdout.on("line", (line: string) => {
		outputBytes += Buffer.byteLength(line);
		if (outputBytes > maxOutputBytes) {
			failure ??= "output_limit";
			child.kill("SIGKILL");
			return;
		}
		let frame: Record<string, unknown>;
		try {
			frame = JSON.parse(line) as Record<string, unknown>;
		} catch {
			return;
		}
		handleFrame(frame);
	});

	write({ __frame__: "job", input: options.input });
	await closed;
	clearTimeout(timer);
	stdout.close();
	await queue;
	await rm(jobTmp, { recursive: true, force: true });

	const durationMs = Date.now() - started;
	if (failure) return { ok: false, error: failure, llmCalls, tokens, costUsd, cacheHits, durationMs };
	if (output === undefined) {
		const detail = stderr.trim().slice(0, 400);
		return {
			ok: false,
			error: detail ? `no_result: ${detail}` : "no_result",
			llmCalls,
			tokens,
			costUsd,
			cacheHits,
			durationMs,
		};
	}
	return { ok: true, output, llmCalls, tokens, costUsd, cacheHits, durationMs };
}