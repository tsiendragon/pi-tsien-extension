/**
 * A/B harness for pi extensions, isolated from the live agent directory.
 *
 * Why: mechanism changes must be judged on **cost and task quality**, not on
 * token counts. The first version of this harness (see
 * docs/session-context-token-plan.md §7) showed a mechanism that cut prompt
 * tokens by 19% while raising cost by 41%, because rewriting already-sent
 * content invalidates the provider prefix cache and `cacheRead` is 10x cheaper
 * than `input`.
 *
 * Isolation: `PI_CODING_AGENT_DIR` redirects the agent config dir, so each arm
 * gets its own `observation-pack.json` (etc.) while everything else is
 * symlinked to the real config. The live setup is never touched.
 *
 * Usage:
 *   npx tsx scripts/extension-ab.ts --task /tmp/ab/task.txt --trials 3
 *   npx tsx scripts/extension-ab.ts --task t.txt --arm control --arm treat:P1
 *
 * Arm spec: `name` or `name:overrides.json` (a JSON file merged into
 * `.pi/agent/observation-pack.json` under the `observationPack` key). A patch may
 * instead carry `{"files": {"large-read-pack.json": {...}}}` to override any
 * per-arm config file this harness knows about.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Per-million-token prices for the model under test. */
const PRICES: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
	"dashscope/deepseek-v4.1-flash": { input: 0.3, output: 1.2, cacheRead: 0.03, cacheWrite: 0 },
	"dashscope/deepseek-v4-flash": { input: 0.2, output: 0.4, cacheRead: 0.02, cacheWrite: 0 },
};

interface Args {
	readonly task: string;
	readonly trials: number;
	readonly model: string;
	readonly thinking: string;
	readonly tools: string;
	readonly arms: readonly string[];
	readonly root: string;
}

function parseArgs(argv: readonly string[]): Args {
	const value = (flag: string, fallback?: string): string | undefined => {
		const index = argv.indexOf(flag);
		if (index >= 0 && index + 1 < argv.length) return argv[index + 1];
		return fallback;
	};
	const arms: string[] = [];
	argv.forEach((arg, index) => {
		if (arg === "--arm" && index + 1 < argv.length) arms.push(argv[index + 1]!);
	});
	return {
		task: value("--task") ?? "",
		trials: Number(value("--trials", "1")),
		model: value("--model", "dashscope/deepseek-v4.1-flash")!,
		thinking: value("--thinking", "high")!,
		tools: value("--tools", "read,bash,obs_recall")!,
		arms: arms.length > 0 ? arms : ["control"],
		root: value("--root", "/tmp/pi-extension-ab")!,
	};
}

function armName(spec: string): string {
	return spec.split(":")[0]!;
}

/** Links every agent config entry into the arm dir, then applies overrides. */
function setupArm(root: string, spec: string): string {
	const name = armName(spec);
	const agentDir = join(root, name, "agent");
	rmSync(join(root, name), { recursive: true, force: true });
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(join(root, name, "sessions"), { recursive: true });
	mkdirSync(join(root, name, "archiv"), { recursive: true });

	const liveDir = join(homedir(), ".pi", "agent");
	/** Config files this harness rewrites per arm instead of symlinking. */
	const overridable = new Set(["observation-pack.json", "large-read-pack.json"]);
	for (const entry of readdirSync(liveDir)) {
		if (entry === "sessions" || overridable.has(entry)) continue;
		symlinkSync(join(liveDir, entry), join(agentDir, entry));
	}

	const overridePath = spec.includes(":") ? resolve(spec.slice(name.length + 1)) : undefined;
	const base = JSON.parse(readFileSync(join(liveDir, "observation-pack.json"), "utf8")) as {
		observationPack: Record<string, unknown>;
	};
	let readPack: Record<string, unknown> = {};
	if (existsSync(join(liveDir, "large-read-pack.json"))) {
		readPack = JSON.parse(readFileSync(join(liveDir, "large-read-pack.json"), "utf8")) as Record<
			string,
			unknown
		>;
	}
	if (overridePath) {
		if (!existsSync(overridePath)) throw new Error(`missing override file: ${overridePath}`);
		const patch = JSON.parse(readFileSync(overridePath, "utf8")) as Record<string, unknown>;
		// `files: { "large-read-pack.json": {...} }` patches any overridable file;
		// a bare object still patches observation-pack, as before.
		const files = patch.files as Record<string, Record<string, unknown>> | undefined;
		if (files) {
			for (const [file, values] of Object.entries(files)) {
				if (!overridable.has(file)) throw new Error(`arm cannot override ${file}`);
				if (file === "observation-pack.json") {
					base.observationPack = { ...base.observationPack, ...(values.observationPack ?? values) };
				} else {
					readPack = { ...readPack, ...(values.largeReadPack ?? values) };
				}
			}
		} else {
			base.observationPack = { ...base.observationPack, ...(patch.observationPack ?? patch) };
		}
	}
	// Archive dir must stay inside the arm so arms cannot pollute each other.
	base.observationPack.archiveDir = join(root, name, "archiv");
	writeFileSync(join(agentDir, "observation-pack.json"), JSON.stringify(base, null, 2));
	if (Object.keys(readPack).length > 0) {
		writeFileSync(join(agentDir, "large-read-pack.json"), JSON.stringify(readPack, null, 2));
	}
	return agentDir;
}

interface ArmMetrics {
	input: number;
	cacheRead: number;
	cacheWrite: number;
	output: number;
	requests: number;
	toolCalls: Record<string, number>;
	packed: number;
	recalled: number;
	answer: string;
}

function collectMetrics(armPath: string): ArmMetrics {
	const metrics: ArmMetrics = {
		input: 0,
		cacheRead: 0,
		cacheWrite: 0,
		output: 0,
		requests: 0,
		toolCalls: {},
		packed: 0,
		recalled: 0,
		answer: "",
	};
	const sessionDir = join(armPath, "sessions");
	if (!existsSync(sessionDir)) return metrics;
	const walk = (dir: string): string[] =>
		readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
			const path = join(dir, entry.name);
			return entry.isDirectory() ? walk(path) : path.endsWith(".jsonl") ? [path] : [];
		});
	for (const file of walk(sessionDir)) {
		for (const line of readFileSync(file, "utf8").split("\n")) {
			if (line.trim() === "") continue;
			let record: Record<string, unknown>;
			try {
				record = JSON.parse(line) as Record<string, unknown>;
			} catch {
				continue;
			}
			if (record.type !== "message") continue;
			const message = record.message as Record<string, unknown> | undefined;
			if (message?.role !== "assistant") continue;
			const usage = message.usage as Record<string, number> | undefined;
			if (usage && (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0) > 0) {
				metrics.requests += 1;
				metrics.input += usage.input ?? 0;
				metrics.cacheRead += usage.cacheRead ?? 0;
				metrics.cacheWrite += usage.cacheWrite ?? 0;
				metrics.output += usage.output ?? 0;
			}
			const content = message.content;
			if (!Array.isArray(content)) continue;
			for (const block of content as Record<string, unknown>[]) {
				if (block.type === "toolCall" && typeof block.name === "string") {
					metrics.toolCalls[block.name] = (metrics.toolCalls[block.name] ?? 0) + 1;
				}
				if (block.type === "text" && typeof block.text === "string" && block.text.trim() !== "") {
					metrics.answer = block.text.trim();
				}
			}
		}
	}
	const ledgerDir = join(armPath, "archiv");
	if (existsSync(ledgerDir)) {
		const ledgers = walk(ledgerDir).filter((path) => path.endsWith("ledger.jsonl"));
		for (const file of ledgers) {
			for (const line of readFileSync(file, "utf8").split("\n")) {
				if (line.trim() === "") continue;
				try {
					const event = JSON.parse(line) as { event?: string };
					if (event.event === "full") metrics.packed += 1;
					if (event.event === "recall") metrics.recalled += 1;
				} catch {
					// ignore malformed ledger lines
				}
			}
		}
	}
	return metrics;
}

function costOf(metrics: ArmMetrics, model: string): number {
	const price = PRICES[model] ?? PRICES["dashscope/deepseek-v4.1-flash"]!;
	return (
		(metrics.input / 1e6) * price.input +
		(metrics.cacheRead / 1e6) * price.cacheRead +
		(metrics.output / 1e6) * price.output
	);
}

function median(values: readonly number[]): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)]!;
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	if (!args.task || !existsSync(args.task)) throw new Error("--task must point to an existing prompt file");
	const prompt = readFileSync(args.task, "utf8");
	const results = new Map<string, ArmMetrics[]>();

	for (const spec of args.arms) {
		const name = armName(spec);
		const agentDir = setupArm(args.root, spec);
		for (let trial = 1; trial <= args.trials; trial += 1) {
			const armPath = join(args.root, name);
			rmSync(join(armPath, "sessions"), { recursive: true, force: true });
			rmSync(join(armPath, "archiv"), { recursive: true, force: true });
			mkdirSync(join(armPath, "sessions"), { recursive: true });
			mkdirSync(join(armPath, "archiv"), { recursive: true });
			// stdin must be ignored: `pi -p` blocks waiting on an open stdin pipe.
			const exitCode = await new Promise<number>((resolvePromise) => {
				const child = spawn(
					"pi",
					[
						"-p",
						"--session-dir",
						join(armPath, "sessions"),
						"--model",
						args.model,
						"--thinking",
						args.thinking,
						"--tools",
						args.tools,
						prompt,
					],
					{
						stdio: ["ignore", "pipe", "pipe"],
						env: {
							...process.env,
							PI_CODING_AGENT_DIR: agentDir,
							PI_OBSERVATION_DIR: join(armPath, "archiv"),
						},
					},
				);
				let stdout = "";
				let stderr = "";
				child.stdout.on("data", (chunk: Buffer) => {
					stdout += chunk.toString();
				});
				child.stderr.on("data", (chunk: Buffer) => {
					stderr += chunk.toString();
				});
				const timer = setTimeout(() => child.kill("SIGKILL"), 1_800_000);
				child.on("close", (code) => {
					clearTimeout(timer);
					writeFileSync(join(armPath, `stdout-${trial}.txt`), stdout);
					if (code !== 0) console.error(`[${name} trial ${trial}] pi exit=${code}\n${stderr.slice(-2000)}`);
					resolvePromise(code ?? 1);
				});
			});
			if (exitCode !== 0) console.error(`[${name} trial ${trial}] non-zero exit`);
			const metrics = collectMetrics(armPath);
			results.set(name, [...(results.get(name) ?? []), metrics]);
			console.log(
				`[${name} trial ${trial}] req=${metrics.requests} prompt=${metrics.input + metrics.cacheRead} ` +
					`cacheRead=${((metrics.cacheRead / Math.max(1, metrics.input + metrics.cacheRead)) * 100).toFixed(1)}% ` +
					`cost=$${costOf(metrics, args.model).toFixed(4)} packed=${metrics.packed} recalled=${metrics.recalled}`,
			);
			writeFileSync(join(armPath, `answer-${trial}.txt`), metrics.answer);
		}
	}

	console.log("\narm        trials  med_prompt  med_cacheRead  med_cost   packed  recalled");
	for (const [name, trials] of results) {
		console.log(
			`${name.padEnd(10)} ${String(trials.length).padStart(6)}  ${String(
				median(trials.map((t) => t.input + t.cacheRead)),
			).padStart(10)}  ${median(trials.map((t) => (t.cacheRead / Math.max(1, t.input + t.cacheRead)) * 100))
				.toFixed(1)
				.padStart(13)}%  ${`$${median(trials.map((t) => costOf(t, args.model))).toFixed(4)}`.padStart(8)}  ${String(
				median(trials.map((t) => t.packed)),
			).padStart(6)}  ${String(median(trials.map((t) => t.recalled))).padStart(8)}`,
		);
	}
	console.log(`\nanswers written to ${args.root}/<arm>/answer-<trial>.txt (grade them against your ground truth)`);
}

await main();
