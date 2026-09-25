/**
 * Smoke test for the capability extension.
 *
 * Drives the real registered tools with a real ModelRegistry and a real sandbox
 * child, then checks the ledger.
 *
 * Usage: npx tsx scripts/capability-smoke.ts
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";

import capabilityExtension from "../extensions/capability.ts";

interface RegisteredTool {
	readonly name: string;
	readonly execute: (
		toolCallId: string,
		params: Record<string, unknown>,
		signal: unknown,
		onUpdate: unknown,
		ctx: unknown,
	) => Promise<unknown>;
}

function textOf(result: unknown): string {
	const content = (result as { content?: { type: string; text?: string }[] }).content;
	if (!content || content.length === 0) throw new Error("tool returned no content");
	return content[0]?.text ?? "";
}

const ledgerHome = await mkdtemp(join(tmpdir(), "capability-smoke-"));
process.env.PI_AGENT_DIR = ledgerHome;

const tools = new Map<string, RegisteredTool>();
const pi = {
	registerTool(tool: RegisteredTool) {
		tools.set(tool.name, tool);
		return pi;
	},
	registerCommand() {
		return pi;
	},
	on() {
		return pi;
	},
};
capabilityExtension(pi as never);

const runtime = await ModelRuntime.create();
const registry = new ModelRegistry(runtime);
const ctx = {
	modelRegistry: registry,
	sessionManager: { getSessionId: () => "capability-smoke" },
};

const lsTool = tools.get("capability_ls");
const runTool = tools.get("capability_run");
assert.ok(lsTool && runTool, "expected both capability tools to be registered");

const listed = JSON.parse(textOf(await lsTool.execute("t1", {}, undefined, undefined, ctx))) as {
	name: string;
	layer: string;
	status: string;
	sensitivity: string;
}[];
console.log(`capability_ls: ${JSON.stringify(listed)}`);
assert.ok(Array.isArray(listed), "capability_ls must return an array");
assert.ok(
	listed.some((capability) => capability.name === "classify-text"),
	"expected classify-text to be discovered in L1",
);

const text = "2026-09-21 03:14:02 ERROR db.connect failed: timeout after 30s";
const first = JSON.parse(
	textOf(await runTool.execute("t2", { name: "classify-text", input: { text } }, undefined, undefined, ctx)),
) as { ok: boolean; output?: { label?: string }; cacheHits: number; costUsd: number };
console.log(`run#1: ${JSON.stringify(first)}`);
assert.equal(first.ok, true, "expected the sandboxed run to succeed");
assert.equal(first.output?.label, "error");
assert.ok(first.costUsd > 0, "expected a real model call to carry cost");

const second = JSON.parse(
	textOf(await runTool.execute("t3", { name: "classify-text", input: { text } }, undefined, undefined, ctx)),
) as { ok: boolean; output?: unknown; cacheHits: number };
console.log(`run#2: ${JSON.stringify(second)}`);
assert.equal(second.ok, true);
assert.equal(second.cacheHits, 1, "expected the repeated input to hit the cache");
assert.equal(JSON.stringify(second.output), JSON.stringify(first.output), "cached run must be deterministic");

const day = new Date().toISOString().slice(0, 10);
const ledger = await readFile(join(ledgerHome, "capability", "ledger", `${day}.jsonl`), "utf8");
const entries = ledger
	.trim()
	.split("\n")
	.map((line) => JSON.parse(line) as { capability: string; ok: boolean });
console.log(`ledger entries: ${entries.length}`);
assert.equal(entries.length, 2, "expected one ledger entry per run");
assert.equal(entries[0]?.capability, "classify-text");

console.log("capability smoke: PASS");