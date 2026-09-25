/**
 * Tests for the large-read-pack decision/render core and its stage guard.
 *
 * The stage rewrites what the model sees for large `read` results, so the tests
 * pin the two properties that make that acceptable: the pack must be a clear
 * win in tokens, and it must always carry an observation id (the recall path)
 * plus an explicit statement of what was omitted.
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
	DEFAULT_LARGE_READ_PACK_CONFIG,
	PACK_OVERHEAD_TOKENS,
	decideReadPack,
	headAtLineBoundary,
	loadLargeReadPackConfig,
	renderReadPack,
	tailAtLineBoundary,
} from "pi-tsien-rtk-fork/src/large-read-pack/core.ts";
import { createLargeReadPackStage } from "pi-tsien-rtk-fork/src/stages/large-read-pack.ts";

const CONFIG = { ...DEFAULT_LARGE_READ_PACK_CONFIG, enabled: true };
/** Big enough that the default pack clears the `minSavedRatio` guard. */
const LARGE_LINES = 4000;

function numberedFile(lines: number, prefix = "line"): string {
	return Array.from({ length: lines }, (_, i) => `${prefix} ${i + 1} content`).join("\n") + "\n";
}

test("default config is disabled and only the file can turn it on", () => {
	assert.equal(DEFAULT_LARGE_READ_PACK_CONFIG.enabled, false);
	const dir = mkdtempSync(join(tmpdir(), "lrp-"));
	const env = { PI_CODING_AGENT_DIR: dir };
	assert.equal(loadLargeReadPackConfig(env).enabled, false, "missing file must stay disabled");

	writeFileSync(
		join(dir, "large-read-pack.json"),
		JSON.stringify({ enabled: true, headBytes: 2000, tailBytes: 500 }),
	);
	const loaded = loadLargeReadPackConfig(env);
	assert.equal(loaded.enabled, true);
	assert.equal(loaded.headBytes, 2000);
	assert.equal(loaded.tailBytes, 500);
	assert.equal(loaded.thresholdBytes, DEFAULT_LARGE_READ_PACK_CONFIG.thresholdBytes);

	writeFileSync(join(dir, "large-read-pack.json"), "{ not json");
	assert.equal(loadLargeReadPackConfig(env).enabled, false, "malformed config must fall back to disabled");
});

test("stage stays inert when the config file does not enable it", () => {
	const dir = mkdtempSync(join(tmpdir(), "lrp-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	try {
		assert.equal(createLargeReadPackStage(), undefined);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
	}
});

test("small results are left alone", () => {
	assert.equal(decideReadPack("a\nb\nc\n", CONFIG), undefined);
	assert.equal(decideReadPack("", CONFIG), undefined);
	// Just over the byte threshold but nothing worth dropping.
	assert.equal(decideReadPack("x".repeat(CONFIG.thresholdBytes + 1), CONFIG), undefined);
});

test("a large result is cut to a head and a tail at line boundaries", () => {
	const text = numberedFile(LARGE_LINES);
	const decision = decideReadPack(text, CONFIG);
	assert.ok(decision, "expected a decision for a large file");
	assert.ok(decision!.head.endsWith("\n"), "head must end on a line boundary");
	assert.ok(decision!.head.startsWith("line 1 "));
	assert.ok(decision!.tail.startsWith("line "), "tail must start at the beginning of a line");
	assert.ok(text.includes(decision!.tail.trimEnd()));
	assert.ok(decision!.keptTokens < decision!.tokens);
	assert.ok(decision!.omittedBytes > 0);
	assert.equal(decision!.omittedFromLine, decision!.headLines + 1);
	assert.ok(decision!.omittedToLine > decision!.omittedFromLine, "omission must span a range");
	assert.ok(
		decision!.headLines + decision!.tailLines + (decision!.omittedToLine - decision!.omittedFromLine + 1) >=
			LARGE_LINES,
		"line accounting must cover the whole file",
	);
});

test("the rewrite must actually save tokens", () => {
	// 9 KB of one very long line: the line-boundary cut cannot drop much, and
	// the pack would cost the same as the original.
	const config = { ...CONFIG, headBytes: 8 * 1024, tailBytes: 512, minSavedRatio: 0.5 };
	assert.equal(decideReadPack("y".repeat(9 * 1024), config), undefined);
});

test("renderReadPack keeps the recall path and states what was omitted", () => {
	const decision = decideReadPack(numberedFile(LARGE_LINES), CONFIG)!;
	const packed = renderReadPack({ decision, observationId: "obs_" + "a".repeat(24) });
	const header = packed.split("\n")[0]!;

	assert.match(header, /^\[read-pack \d+ tok -> \d+ tok \| kept lines /);
	assert.ok(header.includes("obs_" + "a".repeat(24)), "header must carry the observation id");
	assert.ok(header.includes('obs_recall with {"id":"obs_'), "header must say how to retrieve");
	assert.ok(header.includes(`omitted lines ${decision.omittedFromLine}-${decision.omittedToLine}`));
	assert.ok(packed.includes(decision.head.trimEnd()), "head content must be present");
	assert.ok(packed.includes(decision.tail.trimEnd()), "tail content must be present");
	assert.ok(
		packed.includes(`[*** lines ${decision.omittedFromLine}-${decision.omittedToLine} omitted`),
		"an omission marker must sit between head and tail",
	);
	assert.ok(
		packed.indexOf(decision.head.trimEnd()) < packed.indexOf("[*** lines"),
		"marker must come after the head",
	);
});

test("line boundary helpers", () => {
	assert.equal(headAtLineBoundary("aaa\nbbb\nccc\n", 5), "aaa\n");
	assert.equal(headAtLineBoundary("short\n", 100), "short\n");
	assert.equal(headAtLineBoundary("x", 0), "");
	assert.equal(tailAtLineBoundary("aaa\nbbb\nccc\n", 5), "ccc\n");
	assert.equal(tailAtLineBoundary("short\n", 100), "short\n");
	assert.equal(tailAtLineBoundary("x", 0), "");
});

test("pack overhead is accounted for in the reported kept size", () => {
	const decision = decideReadPack(numberedFile(LARGE_LINES), CONFIG)!;
	const raw = Math.ceil((decision.head.length + decision.tail.length) / 4);
	assert.equal(decision.keptTokens, raw + PACK_OVERHEAD_TOKENS);
});
