/**
 * End-to-end smoke test of the bash-digest extension hook.
 *
 * Drives the real `pi.on("tool_result")` handler with a real ModelRegistry and a
 * synthetic large bash result, then verifies the digest is produced, the raw text
 * is archived under the observation-pack layout, and the fail-open paths hold.
 *
 * Usage: npx tsx scripts/bash-digest-smoke.ts
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
	type ExtensionAPI,
	type ExtensionContext,
	ModelRegistry,
	ModelRuntime,
} from "@earendil-works/pi-coding-agent";

import {
	createBashDigestStage,
	type ToolResultStage,
} from "../extensions/tool-result-pipeline/stages/bash-digest.ts";
import {
	estimateTokens,
	loadBashDigestConfig,
} from "../extensions/tool-result-pipeline/bash-digest/core.ts";
import { loadObservationPackConfig, resolveSessionRoot } from "../extensions/observation-pack/core.ts";

const SESSION_ID = `smoke-bash-digest-${Date.now()}`;

type Handler = (
	event: Record<string, unknown>,
	ctx: ExtensionContext,
) => Promise<Record<string, unknown> | undefined>;

const handlers = new Map<string, Handler[]>();
const pi = {
	on(name: string, handler: Handler) {
		const list = handlers.get(name) ?? [];
		list.push(handler);
		handlers.set(name, list);
		return pi;
	},
} as unknown as ExtensionAPI;

const LARGE_OUTPUT = [
	"== tables ==",
	...Array.from({ length: 40 }, (_, i) => `dwd_okx_user_kyc_table_${i}_df: ${20 + i} cols, pt YYYYMMDD`),
	"== partitions ==",
	...Array.from({ length: 30 }, (_, i) => `2026${String((i % 12) + 1).padStart(2, "0")}01\t${1024 * (i + 1)} bytes`),
	"== warnings ==",
	"WARN: partition pt=20260931 is empty, skipped",
	"ERROR: table dwd_okx_user_kyc_table_7_df missing partition pt=20260901",
].join("\n");

function makeEvent(text: string, toolCallId: string): Record<string, unknown> {
	return {
		type: "tool_result",
		toolName: "bash",
		toolCallId,
		input: { command: "python3 inspect_tables.py" },
		content: [{ type: "text", text }],
		isError: false,
		details: { exitCode: 0 },
	};
}

async function run(): Promise<void> {
	const config = loadBashDigestConfig();
	console.log(`config: ${JSON.stringify(config)}`);
	assert.equal(config.enabled, true, "bash-digest.json must enable the extension");

	const observations = loadObservationPackConfig();
	assert.equal(observations.enabled, true, "observation-pack must be enabled for a recall path");

	const stage = createBashDigestStage();
	assert.ok(stage, "expected the bash-digest stage to be active (check bash-digest.json + observation-pack.json)");
	const handler: Handler = (event, ctx) =>
		(stage as ToolResultStage).apply(event as never, ctx) as unknown as Promise<
			Record<string, unknown> | undefined
		>;

	const runtime = await ModelRuntime.create();
	const registry = new ModelRegistry(runtime);
	const ctx = {
		modelRegistry: registry,
		sessionManager: { getSessionId: () => SESSION_ID },
		ui: { notify: (message: string, level?: string) => console.log(`notify[${level}]: ${message}`) },
	} as unknown as ExtensionContext;

	// 1. Large non-code output is digested.
	// A transient provider failure is fail-open by design, so retry once before
	// treating a missing digest as a regression.
	const started = Date.now();
	let result = await handler(makeEvent(LARGE_OUTPUT, "call-digest"), ctx);
	if (!result) {
		console.log("first attempt returned raw output (provider failure?); retrying once");
		result = await handler(makeEvent(LARGE_OUTPUT, "call-digest-retry"), ctx);
	}
	const elapsed = Date.now() - started;
	assert.ok(result, "expected a digest result");
	const content = result.content as { type: string; text: string }[];
	const text = content[0]!.text;
	assert.ok(text.startsWith("[digest "), `unexpected digest header: ${text.slice(0, 80)}`);

	const match = /^\[digest (\d+) tok -> (\d+) tok \| raw: (obs_[a-f0-9]+)\]/.exec(text);
	assert.ok(match, `no observation id in header: ${text.slice(0, 120)}`);
	const originalTokens = Number(match[1]);
	const digestTokens = Number(match[2]);
	const observationId = match[3]!;

	assert.ok(originalTokens > 0, "original token estimate must be positive");
	assert.ok(digestTokens < originalTokens, "digest must be smaller than the original");
	assert.ok(result.usage, "digest usage should be reported on the tool result");

	const sessionRoot = resolveSessionRoot(observations.archiveDir, SESSION_ID);
	assert.ok(sessionRoot, "expected a session root");
	const archived = await readFile(join(sessionRoot, "objects", `${observationId}.txt`), "utf8");
	assert.ok(archived.includes("dwd_okx_user_kyc_table_7_df"), "archive must hold the raw text");

	console.log(`\ndigest in ${elapsed} ms: ${originalTokens} tok -> ${digestTokens} tok`);
	console.log(`archive: ${join(sessionRoot, "objects", `${observationId}.txt`)}`);
	console.log(`--- digest body ---\n${text}\n--------------------`);

	// 2. Same toolCallId is served from cache (no second model call).
	const cachedId = result.content === undefined ? "call-digest-retry" : "call-digest";
	const again = await handler(makeEvent(LARGE_OUTPUT, cachedId), ctx);
	assert.equal((again?.content as { text: string }[])[0]!.text, text, "cached digest expected");

	// 3. Small output passes through untouched.
	const small = await handler(makeEvent("ok\n", "call-small"), ctx);
	assert.equal(small, undefined, "small output must not be rewritten");

	// 4. Error results pass through untouched.
	const errored = makeEvent(LARGE_OUTPUT, "call-error");
	errored.isError = true;
	assert.equal(await handler(errored, ctx), undefined, "error results must not be rewritten");

	// 5. Non-bash tools pass through untouched.
	const other = makeEvent(LARGE_OUTPUT, "call-other");
	other.toolName = "read";
	assert.equal(await handler(other, ctx), undefined, "non-bash results must not be rewritten");

	console.log("\nsmoke: PASS");
}

await run();
