/**
 * L2 (business capability) smoke test.
 *
 * Builds a self-contained fixture project and verifies the promise that matters
 * for reuse: any repository that ships `.pi/capabilities/` works with **no
 * configuration and no dependency on this repository's own layout**.
 *
 * Also checks discovery, a multi-step (code -> llm -> code) run, and the
 * generated adoption skill.
 *
 * Usage: npx tsx scripts/capability-l2-smoke.ts
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";

const agentDir = await mkdtemp(join(tmpdir(), "capability-l2-agent-"));
process.env.PI_AGENT_DIR = agentDir;
delete process.env.PI_CAPABILITY_ROOTS;

const FIXTURE_NAME = "scan-level";

const IMPL_SOURCE = [
	'import { createInterface } from "node:readline";',
	"const reader = createInterface({ input: process.stdin });",
	"const waiters = new Map();",
	"let nextId = 1;",
	"let resolveJob;",
	"const job = new Promise((resolve) => { resolveJob = resolve; });",
	"reader.on('line', (line) => {",
	"  let frame; try { frame = JSON.parse(line); } catch { return; }",
	"  if (frame.__frame__ === 'job') { resolveJob(frame.input); return; }",
	"  if (frame.__frame__ === 'rpc_result') {",
	"    const waiter = waiters.get(frame.id);",
	"    if (waiter) { waiters.delete(frame.id); waiter(frame); }",
	"  }",
	"});",
	"function ask(promptId, input, maxTokens) {",
	"  const id = nextId++;",
	"  return new Promise((resolve, reject) => {",
	"    waiters.set(id, (f) => (f.ok ? resolve(f.data) : reject(new Error(String(f.error)))));",
	"    process.stdout.write(JSON.stringify({ __frame__: 'rpc', id, prompt_id: promptId, input, max_tokens: maxTokens }) + '\\n');",
	"  });",
	"}",
	"function emit(output) { process.stdout.write(JSON.stringify({ __frame__: 'result', output }) + '\\n'); }",
	"const input = await job;",
	"const text = String(input?.text ?? '');",
	"const level = (/(ERROR|WARN|WARNING|INFO|DEBUG)/.exec(text)?.[1] ?? 'unknown').toUpperCase();",
	"const answer = await ask('classify', { text, labels: ['infra', 'data', 'code', 'config', 'capacity', 'unknown'] }, 64);",
	"emit({ ok: true, level, category: answer?.category ?? 'unknown', escalate: level === 'ERROR' });",
	"reader.close();",
	"process.exit(0);",
].join("\n");

// A "foreign" project: nothing here references pi-tsien-extension or any other repo.
const projectDir = await mkdtemp(join(tmpdir(), "capability-l2-project-"));
process.chdir(projectDir);
const fixtureDir = join(projectDir, ".pi", "capabilities", FIXTURE_NAME);
await mkdir(join(fixtureDir, "impl"), { recursive: true });
await mkdir(join(fixtureDir, "prompts"), { recursive: true });
await writeFile(
	join(fixtureDir, "CAPABILITY.yaml"),
	[
		`name: ${FIXTURE_NAME}`,
		"version: 0.1.0",
		"sensitivity: internal",
		"status: draft",
		"description: fixture capability",
		"when: fixture only",
		"steps:",
		"  - id: extract",
		"    kind: code",
		"  - id: classify",
		"    kind: llm",
		"    prompt: prompts/classify.md",
		"    model: dashscope/deepseek-v4.1-flash",
		"    max_tokens: 64",
		"",
	].join("\n"),
	"utf8",
);
await writeFile(
	join(fixtureDir, "prompts", "classify.md"),
	"Classify into exactly one of: {labels}\nJSON only: {\"category\":\"...\"}\n\n{text}\n",
	"utf8",
);
await writeFile(join(fixtureDir, "impl", "run.mjs"), IMPL_SOURCE, "utf8");

const { default: capabilityExtension } = await import("../extensions/capability.ts");

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;

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

const tools = new Map<string, RegisteredTool>();
const handlers = new Map<string, Handler[]>();
const pi = {
	registerTool(tool: RegisteredTool) {
		tools.set(tool.name, tool);
		return pi;
	},
	registerCommand() {
		return pi;
	},
	on(name: string, handler: Handler) {
		const list = handlers.get(name) ?? [];
		list.push(handler);
		handlers.set(name, list);
		return pi;
	},
};
capabilityExtension(pi as never);

const runtime = await ModelRuntime.create();
const registry = new ModelRegistry(runtime);
const ctx = {
	modelRegistry: registry,
	sessionManager: { getSessionId: () => "capability-l2-smoke" },
};

const lsTool = tools.get("capability_ls");
const runTool = tools.get("capability_run");
assert.ok(lsTool && runTool, "expected both capability tools to be registered");

const listed = JSON.parse(textOf(await lsTool.execute("t1", {}, undefined, undefined, ctx))) as {
	name: string;
	layer: string;
	sensitivity: string;
	when?: string;
}[];
console.log("capability_ls:");
for (const capability of listed) {
	console.log(`  ${capability.name} [${capability.layer}] ${capability.sensitivity} — ${capability.when ?? ""}`);
}

const fixture = listed.find((capability) => capability.name === FIXTURE_NAME);
assert.ok(fixture, "a project-local `.pi/capabilities/` entry must be discovered with no config");
assert.equal(fixture.layer, "L2");
assert.ok(listed.some((capability) => capability.name === "classify-text"), "L1 must still be present");

const text = "2026-09-21 03:14:02 ERROR db.connect failed: timeout after 30s (host=db-primary-7)";
const run = JSON.parse(
	textOf(await runTool.execute("t2", { name: FIXTURE_NAME, input: { text } }, undefined, undefined, ctx)),
) as {
	ok: boolean;
	output?: { level?: string; category?: string; escalate?: boolean };
	llmCalls: number;
};
console.log(`run: ${JSON.stringify(run)}`);

assert.equal(run.ok, true, "expected the multi-step run to succeed");
assert.equal(run.llmCalls, 1, "expected exactly one model call for one llm step");
assert.equal(run.output?.level, "ERROR", "deterministic step must run in the sandbox");
assert.equal(run.output?.escalate, true);
assert.ok(run.output?.category, "expected a category from the llm step");

const discover = handlers.get("resources_discover")?.[0];
assert.ok(discover, "expected a resources_discover handler");
const discovered = (await discover({ cwd: projectDir, reason: "startup" }, ctx)) as {
	skillPaths?: string[];
};
assert.ok(discovered.skillPaths?.length, "expected resources_discover to return a skill path");
const skillText = await readFile(join(discovered.skillPaths[0]!, "SKILL.md"), "utf8");
assert.ok(skillText.includes(FIXTURE_NAME), "skill must list the discovered capability");
assert.ok(skillText.includes("capability_run"), "skill must tell the agent how to run it");

console.log("capability L2 smoke: PASS");