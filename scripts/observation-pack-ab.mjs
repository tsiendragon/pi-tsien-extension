#!/usr/bin/env node
/**
 * Small-sample A/B for ObservationPack (design S2).
 *
 * Runs the same deterministic tasks twice — once with `observationPack.enabled`
 * off, once on — against the minimal extension set (RTK + observation-pack + PTC),
 * and reports capability plus token/context metrics from Pi's `--mode json` usage.
 *
 * Usage: node scripts/observation-pack-ab.mjs [--model provider/model] [--trials N]
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXT = join(REPO_ROOT, "extensions");
const RTK = "/home/tsien/.pi/agent/npm/node_modules/pi-rtk/index.ts";
const WORKSPACE = "/tmp/s2-obs-pack";
const OUT_DIR = join(WORKSPACE, "runs");
const CONFIG_PATH = join(homedir(), ".pi", "agent", "observation-pack.json");

function parseArgs(argv) {
	const options = { model: "dashscope/deepseek-v4-flash", trials: 1 };
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--model") options.model = argv[++index];
		else if (arg === "--trials") options.trials = Number(argv[++index]);
	}
	return options;
}

// --- deterministic fixture -------------------------------------------------

function buildFixture() {
	mkdirSync(WORKSPACE, { recursive: true });
	const lines = [];
	for (let i = 1; i <= 12000; i += 1) {
		const tail = i % 1000 === 0 ? " ERR" : "";
		lines.push(`L${String(i).padStart(6, "0")} ${"x".repeat(20)} v=${(i * 37) % 100000}${tail}`);
	}
	const text = `${lines.join("\n")}\n`;
	const file = join(WORKSPACE, "big.log");
	writeFileSync(file, text);
	const sha256 = createHash("sha256").update(text).digest("hex");
	const errCount = lines.filter((line) => line.includes("ERR")).length;
	const expected = { lines: lines.length, sha256, errCount };
	writeFileSync(join(WORKSPACE, "expected.json"), JSON.stringify(expected, null, 2));
	return expected;
}

const TASKS = [
	{
		id: "T1-read-7step",
		prompt: [
			"Perform exactly these 7 steps in order and do not add, skip, or reorder any step.",
			"Step 1: call the read tool on /tmp/s2-obs-pack/big.log with no line limit.",
			"Step 2: call bash with `echo step2`.",
			"Step 3: call bash with `echo step3`.",
			"Step 4: call bash with `echo step4`.",
			"Step 5: call bash with `echo step5`.",
			"Step 6: call bash with `wc -l < /tmp/s2-obs-pack/big.log` and `sha256sum /tmp/s2-obs-pack/big.log`.",
			"Step 7: reply with exactly one final line RESULT=<line_count>|<sha256_hex> and nothing after it.",
		].join(" "),
		check: (text, expected) => text.includes(`RESULT=${expected.lines}|${expected.sha256}`),
	},
	{
		id: "T2-runcode-7step",
		prompt: [
			"Perform exactly these 7 steps in order and do not add, skip, or reorder any step.",
			"Step 1: call run_code to read /tmp/s2-obs-pack/big.log and print its first 30000 characters verbatim.",
			"Step 2: call run_code with `console.log('step2')`.",
			"Step 3: call run_code with `console.log('step3')`.",
			"Step 4: call run_code with `console.log('step4')`.",
			"Step 5: call run_code with `console.log('step5')`.",
			"Step 6: call bash with `wc -l < /tmp/s2-obs-pack/big.log` and `sha256sum /tmp/s2-obs-pack/big.log`.",
			"Step 7: reply with exactly one final line RESULT=<line_count>|<sha256_hex> and nothing after it.",
		].join(" "),
		check: (text, expected) => text.includes(`RESULT=${expected.lines}|${expected.sha256}`),
	},
];

// --- run -------------------------------------------------------------------

function setEnabled(enabled) {
	mkdirSync(dirname(CONFIG_PATH), { recursive: true });
	writeFileSync(
		CONFIG_PATH,
		JSON.stringify(
			{ version: 1, observationPack: { enabled, archiveDir: "/mnt/workspace/lilong/agent/archiv" } },
			null,
			2,
		),
	);
}

function runOnce({ condition, task, model, trial, expected }) {
	const archiveDir = join(OUT_DIR, condition, task.id, `trial-${trial}`, "archive");
	mkdirSync(archiveDir, { recursive: true });
	setEnabled(condition === "on");
	const args = [
		"-p",
		"--no-extensions",
		"--no-skills",
		"--no-context-files",
		"--no-prompt-templates",
		"-e",
		RTK,
		"-e",
		join(EXT, "observation-pack.ts"),
		"-e",
		join(EXT, "ptc.ts"),
		"--model",
		model,
		"--mode",
		"json",
		task.prompt,
	];
	const started = Date.now();
	const result = spawnSync("pi", args, {
		cwd: WORKSPACE,
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
		timeout: 15 * 60 * 1000,
		env: { ...process.env, PI_OBSERVATION_DIR: archiveDir },
	});
	const elapsedMs = Date.now() - started;

	const events = result.stdout
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			try {
				return JSON.parse(line);
			} catch {
				return undefined;
			}
		})
		.filter(Boolean);

	let modelCalls = 0;
	const perTurn = [];
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0, cost: 0 };
	for (const event of events) {
		if (event.type !== "turn_end" || !event.message?.usage) continue;
		modelCalls += 1;
		const u = event.message.usage;
		usage.input += u.input ?? 0;
		usage.output += u.output ?? 0;
		usage.cacheRead += u.cacheRead ?? 0;
		usage.cacheWrite += u.cacheWrite ?? 0;
		usage.reasoning += u.reasoning ?? 0;
		usage.total += u.totalTokens ?? 0;
		usage.cost += u.cost?.total ?? 0;
		perTurn.push({ input: u.input ?? 0, cacheRead: u.cacheRead ?? 0, output: u.output ?? 0 });
	}
	const agentEnd = [...events].reverse().find((event) => event.type === "agent_end");
	const assistant = [...(agentEnd?.messages ?? [])].reverse().find((m) => m.role === "assistant");
	const finalText = (assistant?.content ?? [])
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n");

	const record = {
		condition,
		task: task.id,
		trial,
		model,
		elapsedMs,
		modelCalls,
		perTurn,
		usage,
		promptTokens: usage.input + usage.cacheRead,
		passed: task.check(finalText, expected),
		finalText: finalText.slice(0, 400),
		stderr: result.stderr.split("\n").filter((line) => line && !line.includes("Extension error")).slice(0, 5),
	};
	const dir = join(OUT_DIR, condition, task.id, `trial-${trial}`);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "result.json"), JSON.stringify(record, null, 2));
	writeFileSync(join(dir, "events.jsonl"), result.stdout);
	return record;
}

function summarize(records) {
	const byKey = new Map();
	for (const record of records) {
		const key = `${record.condition}|${record.task}`;
		const list = byKey.get(key) ?? [];
		list.push(record);
		byKey.set(key, list);
	}
	const rows = [];
	for (const [key, list] of byKey) {
		const mean = (get) => list.reduce((sum, item) => sum + get(item), 0) / list.length;
		rows.push({
			key,
			runs: list.length,
			passed: list.filter((item) => item.passed).length,
			modelCalls: mean((item) => item.modelCalls).toFixed(1),
			promptTokens: Math.round(mean((item) => item.promptTokens)),
			outputTokens: Math.round(mean((item) => item.usage.output)),
			seconds: (mean((item) => item.elapsedMs) / 1000).toFixed(1),
			cost: mean((item) => item.usage.cost).toFixed(6),
			promptSeries: list.map((item) => item.perTurn.map((t) => t.input + t.cacheRead).join(",")).join(" | "),
		});
	}
	return rows;
}

function main() {
	const options = parseArgs(process.argv.slice(2));
	const expected = buildFixture();
	const originalConfig = (() => {
		try {
			return readFileSync(CONFIG_PATH, "utf8");
		} catch {
			return undefined;
		}
	})();
	const records = [];
	try {
		for (let trial = 1; trial <= options.trials; trial += 1) {
			for (const condition of ["off", "on"]) {
				for (const task of TASKS) {
					const record = runOnce({ condition, task, model: options.model, trial, expected });
					records.push(record);
					process.stdout.write(
						`${record.condition} ${record.task} t${trial}: pass=${record.passed} calls=${record.modelCalls} prompt=${record.promptTokens} out=${record.usage.output}\n`,
					);
				}
			}
		}
	} finally {
		if (originalConfig !== undefined) writeFileSync(CONFIG_PATH, originalConfig);
		else setEnabled(false);
	}
	console.log("\n=== summary ===");
	console.table(summarize(records));
	console.log("\nexpected:", JSON.stringify(expected));
	writeFileSync(join(OUT_DIR, "summary.json"), JSON.stringify({ expected, records }, null, 2));
}

main();