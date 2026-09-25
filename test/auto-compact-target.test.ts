import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	autoCompactTargetConfig,
	CONFIG_FILE_NAME,
	DEFAULT_AUTO_COMPACT_TARGET_CONFIG,
	DEFAULT_TARGET_TOKENS,
	loadAutoCompactTargetConfig,
	resolveCompactionTrigger,
	resolveTargetTokens,
	shouldCompact,
} from "pi-tsien-shared/src/auto-compact-target/core.ts";

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

test("resolveCompactionTrigger reports the extension policy alone", () => {
	const trigger = resolveCompactionTrigger({
		contextWindow: 1_048_576,
		config: DEFAULT_AUTO_COMPACT_TARGET_CONFIG,
	});
	assert.equal(trigger.enabled, true);
	assert.equal(trigger.triggerTokens, DEFAULT_TARGET_TOKENS);
	assert.deepEqual(trigger.candidates, [
		{ source: "auto-compact-target", tokens: DEFAULT_TARGET_TOKENS },
	]);
});

test("resolveCompactionTrigger defaults to the shared policy snapshot", () => {
	// Callers that omit `config` must describe the policy the actor uses, not
	// silently report "compaction disabled".
	assert.deepEqual(
		resolveCompactionTrigger({ contextWindow: 1_048_576 }),
		resolveCompactionTrigger({ contextWindow: 1_048_576, config: autoCompactTargetConfig() }),
	);
});

test("resolveCompactionTrigger reports pi's reserve-token guard alone", () => {
	const trigger = resolveCompactionTrigger({
		contextWindow: 1_048_576,
		piPolicy: { enabled: true, reserveTokens: 22_000 },
		config: { ...DEFAULT_AUTO_COMPACT_TARGET_CONFIG, enabled: false },
	});
	assert.equal(trigger.enabled, true);
	assert.equal(trigger.triggerTokens, 1_026_576);
	assert.deepEqual(trigger.candidates, [
		{ source: "pi-reserve-tokens", tokens: 1_026_576 },
	]);
});

test("resolveCompactionTrigger takes the earliest enabled policy", () => {
	const trigger = resolveCompactionTrigger({
		contextWindow: 1_048_576,
		piPolicy: { enabled: true, reserveTokens: 22_000 },
		config: DEFAULT_AUTO_COMPACT_TARGET_CONFIG,
	});
	assert.equal(trigger.triggerTokens, DEFAULT_TARGET_TOKENS);
	assert.deepEqual(trigger.candidates.map((candidate) => candidate.source), [
		"auto-compact-target",
		"pi-reserve-tokens",
	]);
});

test("resolveCompactionTrigger lets a small window fall back to pi's guard", () => {
	// 32K window: the extension target (24K) is above pi's guard (10,768), so
	// compaction really fires at the guard and the display must say so.
	const trigger = resolveCompactionTrigger({
		contextWindow: 32_768,
		piPolicy: { enabled: true, reserveTokens: 22_000 },
		config: DEFAULT_AUTO_COMPACT_TARGET_CONFIG,
	});
	assert.equal(trigger.triggerTokens, 10_768);
});

test("resolveCompactionTrigger is disabled when no policy is enabled", () => {
	const trigger = resolveCompactionTrigger({
		contextWindow: 1_048_576,
		piPolicy: { enabled: false, reserveTokens: 22_000 },
		config: { ...DEFAULT_AUTO_COMPACT_TARGET_CONFIG, enabled: false },
	});
	assert.deepEqual(trigger, { enabled: false, triggerTokens: 0, candidates: [] });
});

test("resolveCompactionTrigger drops pi's candidate when the window is unknown", () => {
	const trigger = resolveCompactionTrigger({
		piPolicy: { enabled: true, reserveTokens: 22_000 },
		config: DEFAULT_AUTO_COMPACT_TARGET_CONFIG,
	});
	assert.deepEqual(trigger.candidates.map((candidate) => candidate.source), [
		"auto-compact-target",
	]);
});

test("resolveCompactionTrigger honours per-model overrides", () => {
	const config = {
		...DEFAULT_AUTO_COMPACT_TARGET_CONFIG,
		modelOverrides: { "dashscope/deepseek-v4.1-flash": { targetTokens: 100_000 } },
	};
	assert.equal(
		resolveCompactionTrigger({
			contextWindow: 1_048_576,
			model: { provider: "dashscope", id: "deepseek-v4.1-flash" },
			config,
		}).triggerTokens,
		100_000,
	);
	assert.equal(
		resolveCompactionTrigger({
			contextWindow: 1_048_576,
			model: { provider: "dashscope", id: "other" },
			config,
		}).triggerTokens,
		DEFAULT_TARGET_TOKENS,
	);
});

test("resolveCompactionTrigger clamps a reserve larger than the window to zero", () => {
	const trigger = resolveCompactionTrigger({
		contextWindow: 16_384,
		piPolicy: { enabled: true, reserveTokens: 22_000 },
		config: { ...DEFAULT_AUTO_COMPACT_TARGET_CONFIG, enabled: false },
	});
	assert.equal(trigger.triggerTokens, 0);
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
