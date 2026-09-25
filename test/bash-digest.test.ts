import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	buildDigestPrompt,
	DEFAULT_BASH_DIGEST_CONFIG as DEFAULTS,
	isKeepSignal,
	matchesExcludePattern,
	outputProducerCommands,
	resolveMaxTokens,
	codeLineRatio,
	CONFIG_FILE_NAME,
	DEFAULT_BASH_DIGEST_CONFIG,
	decideDigest,
	loadBashDigestConfig,
	looksLikeCodeDump,
	normalizeDigest,
	parseModelKey,
	preclean,
	renderDigest,
	stripAnsi,
} from "pi-tsien-rtk-fork/src/bash-digest/core.ts";

const config = { ...DEFAULT_BASH_DIGEST_CONFIG, enabled: true };

test("stripAnsi removes SGR sequences", () => {
	assert.equal(stripAnsi("\u001b[31merror\u001b[0m: bad"), "error: bad");
	assert.equal(stripAnsi("\u001b[1;33mwarning\u001b[0m"), "warning");
});

test("stripAnsi drops carriage-return overwrites (progress bars)", () => {
	assert.equal(stripAnsi("10%\r50%\r100% done"), "100% done");
	// A CRLF line ending is normalized to LF, not treated as an overwrite.
	assert.equal(stripAnsi("a\r\nb"), "a\nb");
});

test("preclean normalizes blank runs and trailing spaces", () => {
	const input = "a   \n\n\n\n b\n\n";
	assert.equal(preclean(input), "a\n\n b");
});

test("codeLineRatio counts source-style lines only", () => {
	assert.equal(codeLineRatio("const a = 1\nfunction b() {}\nexport type C = 1"), 1);
	assert.equal(codeLineRatio("total 42\npath /tmp/x\nstatus ok"), 0);
	assert.equal(codeLineRatio(""), 0);
});

test("looksLikeCodeDump respects the ratio", () => {
	const text = "const a = 1\nfunction b() {}\nplain line\nanother plain";
	// 2 of 4 lines are code-like.
	assert.equal(codeLineRatio(text), 0.5);
	assert.equal(looksLikeCodeDump(text, 0.3), true);
	assert.equal(looksLikeCodeDump(text, 0.6), false);
});

test("decideDigest skips small output", () => {
	const decision = decideDigest({ text: "ok\n", isError: false, config });
	assert.equal(decision.digest, false);
	assert.equal(decision.reason, "below-threshold");
});

test("decideDigest skips empty and error results", () => {
	assert.equal(decideDigest({ text: "", isError: false, config }).reason, "empty");
	assert.equal(decideDigest({ text: "", isError: true, config }).reason, "is-error");
	const big = "x".repeat(5000);
	assert.equal(decideDigest({ text: big, isError: true, config }).reason, "is-error");
});

test("decideDigest digests large non-code output and returns precleaned text", () => {
	const text = `${"\u001b[32mlog line\u001b[0m\n".repeat(200)}\n\n\n`;
	const decision = decideDigest({ text, isError: false, config });
	assert.equal(decision.digest, true);
	assert.equal(decision.reason, "digest");
	assert.ok(!decision.text.includes("\u001b["));
	assert.ok(!decision.text.includes("\n\n\n"));
	assert.ok(decision.tokens > config.targetTokens);
	assert.ok(decision.bytes > config.thresholdBytes);
});

test("decideDigest skips code dumps", () => {
	const text = `${"  const value = compute(input);\n".repeat(200)}`;
	const decision = decideDigest({ text, isError: false, config });
	assert.equal(decision.digest, false);
	assert.equal(decision.reason, "code-dump");
});

test("decideDigest honours excludePatterns against the command", () => {
	const flagged = {
		...config,
		excludePatterns: ["^sed -n", "deploy"],
	};
	const text = `${"log line\n".repeat(400)}`;
	assert.equal(
		decideDigest({ text, isError: false, config: flagged, command: "sed -n 1,50p f" }).reason,
		"excluded",
	);
	assert.equal(
		decideDigest({ text, isError: false, config: flagged, command: "make deploy" }).reason,
		"excluded",
	);
	assert.equal(
		decideDigest({ text, isError: false, config: flagged, command: "ls -la" }).reason,
		"digest",
	);
});

test("outputProducerCommands keeps only the command that prints", () => {
	assert.deepEqual(outputProducerCommands("cd x && ls -la"), ["cd x", "ls -la"]);
	assert.deepEqual(outputProducerCommands("python3 s.py | head -20"), ["head -20"]);
	assert.deepEqual(outputProducerCommands("ls | wc -l"), ["wc -l"]);
	assert.deepEqual(outputProducerCommands("sudo -u root cat f"), ["cat f"]);
	assert.deepEqual(outputProducerCommands("FOO=1 python3 x.py"), ["python3 x.py"]);
	assert.deepEqual(outputProducerCommands("a; b\nc"), ["a", "b", "c"]);
});

test("matchesExcludePattern ignores filter-only stages of a pipeline", () => {
	const patterns = ["^grep\\b", "^cat\\b", "^ls\\b"];
	// `grep` is the stage whose stdout is captured, so it counts...
	assert.equal(matchesExcludePattern("cat f | grep x", ["^grep\\b"]), true);
	// ...while `cat` only feeds it, so it does not.
	assert.equal(matchesExcludePattern("cat f | grep x", ["^cat\\b"]), false);
	assert.equal(matchesExcludePattern("cd x && ls", patterns), true);
	assert.equal(matchesExcludePattern("python3 x.py", patterns), false);
	assert.equal(matchesExcludePattern("python3 x.py", ["(["]), false, "invalid pattern is ignored");
});

test("decideDigest survives an invalid exclude pattern", () => {
	const flagged = { ...config, excludePatterns: ["(["] };
	const text = `${"log line\n".repeat(400)}`;
	assert.equal(decideDigest({ text, isError: false, config: flagged, command: "ls" }).reason, "digest");
});

test("buildDigestPrompt includes the command and the target", () => {
	const prompt = buildDigestPrompt({
		output: "OUTPUT-BODY",
		command: "ls -la",
		targetTokens: 40,
	});
	assert.ok(prompt.includes("<cmd>ls -la</cmd>"));
	assert.ok(prompt.includes("<out>OUTPUT-BODY</out>"));
	assert.ok(prompt.includes("target 40 tokens"));
	assert.ok(prompt.includes("keep every entry in the original order"));
});

test("buildDigestPrompt omits an empty command", () => {
	const prompt = buildDigestPrompt({ output: "x", command: "  ", targetTokens: 40 });
	assert.ok(!prompt.includes("<cmd>"));
	assert.ok(prompt.includes("<out>x</out>"));
});

test("renderDigest shows the ratio and the observation id", () => {
	const text = renderDigest({
		digest: "summary",
		originalTokens: 2500,
		digestTokens: 70,
		observationId: "obs_0123456789abcdef01234567",
	});
	assert.ok(text.startsWith("[digest 2500 tok -> 70 tok | raw: obs_0123456789abcdef01234567"));
	assert.ok(text.endsWith("\nsummary"));
});

test("renderDigest flags an unarchived raw output", () => {
	const text = renderDigest({ digest: "s", originalTokens: 10, digestTokens: 2 });
	assert.ok(text.includes("raw not archived"));
});

test("normalizeDigest strips markdown fences", () => {
	assert.equal(normalizeDigest("```\nhello\n```"), "hello");
	assert.equal(normalizeDigest("```text\nhello\n```"), "hello");
	assert.equal(normalizeDigest("  hello  "), "hello");
});

test("parseModelKey splits provider and model", () => {
	assert.deepEqual(parseModelKey("dashscope/qwen3.8-flash"), {
		provider: "dashscope",
		modelId: "qwen3.8-flash",
	});
	assert.equal(parseModelKey("nope"), undefined);
	assert.equal(parseModelKey("/leading"), undefined);
	assert.equal(parseModelKey("trailing/"), undefined);
});

test("resolveMaxTokens scales with the input and respects bounds", () => {
	const config = { ...DEFAULTS, maxTokens: 128, maxDigestRatio: 0.6 };
	assert.equal(resolveMaxTokens(100, config), 128, "floored at the configured budget");
	assert.equal(resolveMaxTokens(400, config), 240, "scales with the input");
	assert.equal(resolveMaxTokens(1000, config), 256, "capped");
});

test("isKeepSignal recognizes the decline reply", () => {
	assert.equal(isKeepSignal("KEEP"), true);
	assert.equal(isKeepSignal("  keep. "), true);
	assert.equal(isKeepSignal("`KEEP`"), true);
	assert.equal(isKeepSignal("kept 3 rows"), false);
});

test("loadBashDigestConfig defaults to disabled when the file is missing", async () => {
	const dir = await mkdtemp(join(tmpdir(), "bd-"));
	assert.deepEqual(loadBashDigestConfig({ PI_CODING_AGENT_DIR: dir }), DEFAULT_BASH_DIGEST_CONFIG);
});

test("loadBashDigestConfig ignores malformed json", async () => {
	const dir = await mkdtemp(join(tmpdir(), "bd-"));
	await writeFile(join(dir, CONFIG_FILE_NAME), "nope", "utf8");
	assert.deepEqual(loadBashDigestConfig({ PI_CODING_AGENT_DIR: dir }), DEFAULT_BASH_DIGEST_CONFIG);
});

test("loadBashDigestConfig reads values and rejects junk", async () => {
	const dir = await mkdtemp(join(tmpdir(), "bd-"));
	await writeFile(
		join(dir, CONFIG_FILE_NAME),
		JSON.stringify({
			bashDigest: {
				enabled: true,
				thresholdBytes: 2048,
				targetTokens: 30,
				maxTokens: 128,
				timeoutMs: 1500,
				maxConcurrent: 1,
				digestModel: "dashscope/deepseek-v4.1-flash",
				codeDumpRatio: 0.5,
				excludePatterns: ["a", 3, "b"],
			},
		}),
		"utf8",
	);
	const loaded = loadBashDigestConfig({ PI_CODING_AGENT_DIR: dir });
	assert.equal(loaded.enabled, true);
	assert.equal(loaded.thresholdBytes, 2048);
	assert.equal(loaded.targetTokens, 30);
	assert.equal(loaded.maxTokens, 128);
	assert.equal(loaded.timeoutMs, 1500);
	assert.equal(loaded.maxConcurrent, 1);
	assert.equal(loaded.digestModel, "dashscope/deepseek-v4.1-flash");
	assert.equal(loaded.codeDumpRatio, 0.5);
	assert.deepEqual(loaded.excludePatterns, ["a", "b"]);
});

test("loadBashDigestConfig falls back on out-of-range numbers", async () => {
	const dir = await mkdtemp(join(tmpdir(), "bd-"));
	await writeFile(
		join(dir, CONFIG_FILE_NAME),
		JSON.stringify({ codeDumpRatio: 5, thresholdBytes: -1, digestModel: "" }),
		"utf8",
	);
	const loaded = loadBashDigestConfig({ PI_CODING_AGENT_DIR: dir });
	assert.equal(loaded.codeDumpRatio, DEFAULT_BASH_DIGEST_CONFIG.codeDumpRatio);
	assert.equal(loaded.thresholdBytes, DEFAULT_BASH_DIGEST_CONFIG.thresholdBytes);
	assert.equal(loaded.digestModel, DEFAULT_BASH_DIGEST_CONFIG.digestModel);
});
