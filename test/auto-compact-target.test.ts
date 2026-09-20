import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	CONFIG_FILE_NAME,
	DEFAULT_AUTO_COMPACT_TARGET_CONFIG,
	DEFAULT_TARGET_TOKENS,
	loadAutoCompactTargetConfig,
	resolveTargetTokens,
	shouldCompact,
} from "../extensions/auto-compact-target/core.ts";

test("resolveTargetTokens uses the absolute target for 1M-class windows", () => {
	assert.equal(resolveTargetTokens(1_048_576), DEFAULT_TARGET_TOKENS);
	assert.equal(resolveTargetTokens(1_050_000), DEFAULT_TARGET_TOKENS);
	assert.equal(resolveTargetTokens(1_000_000), DEFAULT_TARGET_TOKENS);
	// 270K only fits while floor(0.75 * window) >= 270K, i.e. window >= 360K.
	assert.equal(resolveTargetTokens(360_000), DEFAULT_TARGET_TOKENS);
	assert.equal(resolveTargetTokens(359_999), 269_999);
});

test("resolveTargetTokens converges proportionally on smaller windows", () => {
	assert.equal(resolveTargetTokens(272_000), 204_000);
	assert.equal(resolveTargetTokens(262_144), 196_608);
	assert.equal(resolveTargetTokens(128_000), 96_000);
});

test("resolveTargetTokens clamps per-model overrides to the window ratio", () => {
	assert.equal(resolveTargetTokens(1_048_576, { overrideTargetTokens: 100_000 }), 100_000);
	// Override above the window cap must not exceed floor(windowRatio * window).
	assert.equal(resolveTargetTokens(128_000, { overrideTargetTokens: 200_000 }), 96_000);
});

test("resolveTargetTokens honours a custom target and window ratio", () => {
	assert.equal(resolveTargetTokens(1_000_000, { targetTokens: 120_000 }), 120_000);
	assert.equal(resolveTargetTokens(300_000, { windowRatio: 0.5 }), 150_000);
	assert.equal(resolveTargetTokens(1_000_000, { windowRatio: 0.5 }), 270_000);
});

test("resolveTargetTokens falls back to the target when the window is unknown", () => {
	assert.equal(resolveTargetTokens(undefined), DEFAULT_TARGET_TOKENS);
	assert.equal(resolveTargetTokens(null), DEFAULT_TARGET_TOKENS);
	assert.equal(resolveTargetTokens(Number.NaN), DEFAULT_TARGET_TOKENS);
	assert.equal(resolveTargetTokens(0), DEFAULT_TARGET_TOKENS);
});

test("resolveTargetTokens always returns a positive integer", () => {
	for (const window of [1, 10, 100, 999, 1_000_000]) {
		const target = resolveTargetTokens(window);
		assert.ok(Number.isInteger(target), `integer for ${window}`);
		assert.ok(target >= 1, `positive for ${window}`);
	}
});

test("shouldCompact compares usage against the target", () => {
	assert.equal(shouldCompact(269_999, 270_000), false);
	assert.equal(shouldCompact(270_000, 270_000), true);
	assert.equal(shouldCompact(530_000, 270_000), true);
	assert.equal(shouldCompact(null, 270_000), false);
	assert.equal(shouldCompact(undefined, 270_000), false);
	assert.equal(shouldCompact(0, 270_000), false);
	assert.equal(shouldCompact(Number.NaN, 270_000), false);
});

test("loadAutoCompactTargetConfig returns defaults when the file is missing", async () => {
	const dir = await mkdtemp(join(tmpdir(), "act-"));
	const config = loadAutoCompactTargetConfig({ PI_CODING_AGENT_DIR: dir });
	assert.deepEqual(config, DEFAULT_AUTO_COMPACT_TARGET_CONFIG);
});

test("loadAutoCompactTargetConfig returns defaults when the file is malformed", async () => {
	const dir = await mkdtemp(join(tmpdir(), "act-"));
	await writeFile(join(dir, CONFIG_FILE_NAME), "{not json", "utf8");
	const config = loadAutoCompactTargetConfig({ PI_CODING_AGENT_DIR: dir });
	assert.deepEqual(config, DEFAULT_AUTO_COMPACT_TARGET_CONFIG);
});

test("loadAutoCompactTargetConfig reads config, overrides and rejects junk", async () => {
	const dir = await mkdtemp(join(tmpdir(), "act-"));
	await writeFile(
		join(dir, CONFIG_FILE_NAME),
		JSON.stringify({
			autoCompactTarget: {
				enabled: false,
				targetTokens: 150_000,
				windowRatio: 0.5,
				modelOverrides: {
					"dashscope/deepseek-v4.1-flash": { targetTokens: 200_000 },
					"broken/model": { targetTokens: -1 },
					"alsobroken/model": "nope",
				},
			},
		}),
		"utf8",
	);
	const config = loadAutoCompactTargetConfig({ PI_CODING_AGENT_DIR: dir });
	assert.equal(config.enabled, false);
	assert.equal(config.targetTokens, 150_000);
	assert.equal(config.windowRatio, 0.5);
	assert.deepEqual(config.modelOverrides, {
		"dashscope/deepseek-v4.1-flash": { targetTokens: 200_000 },
	});
});

test("loadAutoCompactTargetConfig accepts a bare (unwrapped) section", async () => {
	const dir = await mkdtemp(join(tmpdir(), "act-"));
	await writeFile(join(dir, CONFIG_FILE_NAME), JSON.stringify({ targetTokens: 180_000 }), "utf8");
	const config = loadAutoCompactTargetConfig({ PI_CODING_AGENT_DIR: dir });
	assert.equal(config.targetTokens, 180_000);
	assert.equal(config.enabled, DEFAULT_AUTO_COMPACT_TARGET_CONFIG.enabled);
});

test("loadAutoCompactTargetConfig ignores an out-of-range window ratio", async () => {
	const dir = await mkdtemp(join(tmpdir(), "act-"));
	await writeFile(join(dir, CONFIG_FILE_NAME), JSON.stringify({ windowRatio: 1.5 }), "utf8");
	const config = loadAutoCompactTargetConfig({ PI_CODING_AGENT_DIR: dir });
	assert.equal(config.windowRatio, DEFAULT_AUTO_COMPACT_TARGET_CONFIG.windowRatio);
});
