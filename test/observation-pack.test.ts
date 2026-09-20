import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	countLines,
	createObservation,
	DEFAULT_OBSERVATION_PACK_CONFIG,
	ensureStored,
	estimateTokens,
	isPureTextResult,
	loadObservationPackConfig,
	moveToTrash,
	OBSERVATION_ID_PATTERN,
	placeholderFor,
	readRecallChunk,
	recallChunkLimits,
	resolveSessionRoot,
	selectPruneCandidates,
} from "../extensions/observation-pack/core.ts";
import observationPack, { parsePruneArgs } from "../extensions/observation-pack.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

function toolResult(text: string, overrides: Record<string, unknown> = {}) {
	return {
		role: "toolResult" as const,
		toolCallId: "call-1",
		toolName: "bash",
		isError: false,
		content: [{ type: "text", text }],
		...overrides,
	};
}

async function tempDir(label: string): Promise<string> {
	return mkdtemp(join(tmpdir(), `obs-pack-${label}-`));
}

test("estimateTokens and countLines", () => {
	assert.equal(estimateTokens("abcd"), 1);
	assert.equal(estimateTokens("abcde"), 2);
	assert.equal(countLines(""), 0);
	assert.equal(countLines("a"), 1);
	assert.equal(countLines("a\nb"), 2);
	assert.equal(countLines("a\nb\n"), 2);
});

test("isPureTextResult accepts only non-error pure-text tool results", () => {
	assert.equal(isPureTextResult(toolResult("hi")), true);
	assert.equal(isPureTextResult(toolResult("hi", { isError: true })), false);
	assert.equal(isPureTextResult(toolResult("hi", { content: [{ type: "image" }] })), false);
	assert.equal(
		isPureTextResult(toolResult("hi", { content: [{ type: "text", text: "a" }, { type: "image" }] })),
		false,
	);
	assert.equal(isPureTextResult({ role: "assistant" }), false);
	assert.equal(isPureTextResult(undefined), false);
});

test("createObservation packs only large, non-receipt results", () => {
	const root = "/tmp/obs-root/session/observation-pack";
	assert.equal(createObservation(toolResult("small"), { sessionRoot: root }), undefined);

	const large = "x".repeat(DEFAULT_OBSERVATION_PACK_CONFIG.thresholdBytes + 1);
	const observation = createObservation(toolResult(large), { sessionRoot: root });
	assert.ok(observation);
	assert.match(observation.id, OBSERVATION_ID_PATTERN);
	assert.equal(observation.bytes, DEFAULT_OBSERVATION_PACK_CONFIG.thresholdBytes + 1);
	assert.equal(observation.filePath, join(root, "objects", `${observation.id}.txt`));

	const receipt = createObservation(
		toolResult(`sol_pi_evidence_receipt_v1\n${large}`),
		{ sessionRoot: root },
	);
	assert.equal(receipt, undefined);
});

test("createObservation is stable for the same call and payload", () => {
	const root = "/tmp/obs-root/session/observation-pack";
	const large = "y".repeat(20_000);
	const a = createObservation(toolResult(large), { sessionRoot: root });
	const b = createObservation(toolResult(large), { sessionRoot: root });
	assert.ok(a && b);
	assert.equal(a.id, b.id);
	const other = createObservation(toolResult(large, { toolCallId: "call-2" }), { sessionRoot: root });
	assert.notEqual(other?.id, a.id);
});

test("placeholder exposes id, size, and first/last lines", () => {
	const root = "/tmp/obs-root/session/observation-pack";
	const text = `HEAD-LINE\n${"middle\n".repeat(3000)}TAIL-LINE\n`;
	const observation = createObservation(toolResult(text), { sessionRoot: root });
	assert.ok(observation);
	const placeholder = placeholderFor(observation);
	assert.match(placeholder, new RegExp(`id: ${observation.id}`));
	assert.match(placeholder, /tool: bash/);
	assert.match(placeholder, new RegExp(`archived_bytes: ${observation.bytes}`));
	assert.match(placeholder, /HEAD-LINE/);
	assert.match(placeholder, /TAIL-LINE/);
	assert.ok(placeholder.length < observation.bytes);
});

test("ensureStored is idempotent and rejects a corrupted object", async () => {
	const root = await tempDir("store");
	const observation = createObservation(toolResult("z".repeat(20_000)), { sessionRoot: root });
	assert.ok(observation);
	await ensureStored(observation);
	await ensureStored(observation); // second call verifies and reuses
	assert.equal(await readFile(observation.filePath, "utf8"), observation.text);

	await writeFile(observation.filePath, "Q".repeat(observation.bytes));
	await assert.rejects(() => ensureStored(observation), /hash mismatch/);
});

test("readRecallChunk aligns the start forward to a UTF-8 boundary", async () => {
	const root = await tempDir("utf8");
	const observation = createObservation(toolResult("ééé"), {
		sessionRoot: root,
		thresholdBytes: 1,
	});
	assert.ok(observation);
	await ensureStored(observation);

	// Byte 1 is the continuation byte of the first "é"; recall must skip to byte 2.
	const chunk = await readRecallChunk(observation.filePath, 1, {
		maxBytes: 1024,
		maxLines: 100,
	});
	assert.equal(chunk.actualOffset, 2);
	assert.equal(chunk.text, "éé");
	assert.equal(chunk.eof, true);
});

test("readRecallChunk pages by lines and reports eof at the end", async () => {
	const root = await tempDir("page");
	const text = Array.from({ length: 50 }, (_, index) => `line-${index}`).join("\n");
	const observation = createObservation(toolResult(text), {
		sessionRoot: root,
		thresholdBytes: 1,
	});
	assert.ok(observation);
	await ensureStored(observation);

	let offset = 0;
	let assembled = "";
	let guard = 0;
	while (guard < 100) {
		guard += 1;
		const chunk = await readRecallChunk(observation.filePath, offset, {
			maxBytes: 16,
			maxLines: 3,
		});
		assert.ok(Buffer.byteLength(chunk.text, "utf8") <= 16);
		assert.ok(chunk.lines <= 3);
		assembled += chunk.text;
		offset = chunk.nextOffset;
		if (chunk.eof) break;
	}
	assert.equal(assembled, text);
});

test("recallChunkLimits keeps a full chunk plus the tool header inside the hard limits", async () => {
	// Regression: the recall tool prefixes two header lines and measures the
	// response with `text.split("\n").length`. Reserving only two lines made a
	// full-size chunk of many short lines (bash listings, large read results)
	// fail the check, so recall broke exactly where it was needed most.
	const root = await tempDir("limits");
	const lines = Array.from({ length: 5000 }, (_, index) => `row-${index}`);
	const observation = createObservation(toolResult(lines.join("\n")), {
		sessionRoot: root,
		thresholdBytes: 1,
	});
	assert.ok(observation);
	await ensureStored(observation);

	const recallMaxBytes = 16384;
	const recallMaxLines = 400;
	const limits = recallChunkLimits(recallMaxBytes, recallMaxLines);
	const chunk = await readRecallChunk(observation.filePath, 0, limits);

	const header = [
		`[obs_recall id=${observation.id} offset=${chunk.actualOffset} next_offset=${chunk.nextOffset} eof=${chunk.eof}]`,
		`[chunk_bytes=${chunk.bytes} chunk_lines=${chunk.lines}; use next_offset to continue]`,
	].join("\n");
	const text = `${header}\n${chunk.text}`;
	assert.ok(
		Buffer.byteLength(text, "utf8") <= recallMaxBytes,
		`response ${Buffer.byteLength(text, "utf8")} bytes exceeds recallMaxBytes`,
	);
	assert.ok(
		text.split("\n").length <= recallMaxLines,
		`response ${text.split("\n").length} lines exceeds recallMaxLines`,
	);
	assert.ok(chunk.lines > 300, "a dense observation must fill the chunk, not come back tiny");
});

test("readRecallChunk rejects offsets past the end", async () => {
	const root = await tempDir("offset");
	const observation = createObservation(toolResult("abcd"), { sessionRoot: root, thresholdBytes: 1 });
	assert.ok(observation);
	await ensureStored(observation);
	await assert.rejects(
		() => readRecallChunk(observation.filePath, 999, { maxBytes: 16, maxLines: 3 }),
		/exceeds observation size/,
	);
});

test("resolveSessionRoot rejects unsafe session ids", () => {
	const root = "/tmp/obs-root";
	const resolved = resolveSessionRoot(root, "01a0a371-eb19-711b");
	assert.equal(resolved, join(root, "01a0a371-eb19-711b", "observation-pack"));
	assert.equal(resolveSessionRoot(root, "../evil"), undefined);
	assert.equal(resolveSessionRoot(root, "a/b"), undefined);
	assert.equal(resolveSessionRoot(root, ""), undefined);
	assert.equal(resolveSessionRoot(root, ".hidden"), undefined);
});

test("loadObservationPackConfig reads defaults, file values, and env override", async () => {
	const emptyAgentDir = await tempDir("cfg-empty");
	const defaults = loadObservationPackConfig({ PI_CODING_AGENT_DIR: emptyAgentDir });
	assert.equal(defaults.enabled, false);
	assert.equal(defaults.archiveDir, DEFAULT_OBSERVATION_PACK_CONFIG.archiveDir);
	assert.equal(defaults.fullSends, 2);

	const configDir = await tempDir("cfg-file");
	await writeFile(
		join(configDir, "observation-pack.json"),
		JSON.stringify({ version: 1, observationPack: { enabled: true, fullSends: 5, thresholdBytes: 2048 } }),
	);
	const loaded = loadObservationPackConfig({ PI_CODING_AGENT_DIR: configDir });
	assert.equal(loaded.enabled, true);
	assert.equal(loaded.fullSends, 5);
	assert.equal(loaded.thresholdBytes, 2048);

	const overridden = loadObservationPackConfig({
		PI_CODING_AGENT_DIR: configDir,
		PI_OBSERVATION_DIR: "/tmp/other-archive",
	});
	assert.equal(overridden.archiveDir, "/tmp/other-archive");
});

test("selectPruneCandidates skips current session, fresh sessions, and non-pack dirs", async () => {
	const root = await tempDir("prune");
	const oldSession = join(root, "old-session", "observation-pack");
	const freshSession = join(root, "fresh-session", "observation-pack");
	const currentSession = join(root, "current-session", "observation-pack");
	await mkdir(oldSession, { recursive: true });
	await mkdir(freshSession, { recursive: true });
	await mkdir(currentSession, { recursive: true });
	await mkdir(join(root, "not-a-pack"), { recursive: true });

	const oldDate = new Date(Date.now() - 10 * DAY_MS);
	await utimes(oldSession, oldDate, oldDate);

	const candidates = await selectPruneCandidates(root, {
		excludeSessionId: "current-session",
		retentionDays: 5,
	});
	assert.deepEqual(
		candidates.map((candidate) => candidate.sessionId),
		["old-session"],
	);

	const trash = await moveToTrash(root, candidates[0]!);
	assert.ok(trash.includes(".trash"));
	const remaining = await selectPruneCandidates(root, {
		excludeSessionId: "current-session",
		retentionDays: 5,
	});
	assert.equal(remaining.length, 0);
});

test("parsePruneArgs understands days, equals form, and yes", () => {
	assert.deepEqual(parsePruneArgs(""), { days: undefined, yes: false });
	assert.deepEqual(parsePruneArgs("--days 7"), { days: 7, yes: false });
	assert.deepEqual(parsePruneArgs("--days=3 --yes"), { days: 3, yes: true });
	assert.deepEqual(parsePruneArgs("-y -d 9"), { days: 9, yes: true });
});

// ---------------------------------------------------------------------------
// Wiring smoke test (fake ExtensionAPI)
// ---------------------------------------------------------------------------

type Handler = (event: unknown, ctx: unknown) => unknown;

function fakePi() {
	const handlers = new Map<string, Handler>();
	const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
	const commands = new Map<string, unknown>();
	return {
		handlers,
		tools,
		commands,
		pi: {
			on: (name: string, handler: Handler) => handlers.set(name, handler),
			registerTool: (tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) =>
				tools.set(tool.name, tool),
			registerCommand: (name: string, options: unknown) => commands.set(name, options),
		},
	};
}

async function withEnv(
	env: Record<string, string | undefined>,
	run: () => Promise<void>,
): Promise<void> {
	const saved = new Map<string, string | undefined>();
	for (const [key, value] of Object.entries(env)) {
		saved.set(key, process.env[key]);
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	try {
		await run();
	} finally {
		for (const [key, value] of saved) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

test("wiring: replaces after fullSends and recalls exact bytes", async () => {
	const agentDir = await tempDir("wire-agent");
	const archiveDir = await tempDir("wire-archive");
	await writeFile(
		join(agentDir, "observation-pack.json"),
		JSON.stringify({
			version: 1,
			observationPack: {
				enabled: true,
				archiveDir,
				thresholdBytes: 64,
				fullSends: 2,
				placeholderExcerptBytes: 128,
				recallMaxBytes: 4096,
				recallMaxLines: 100,
			},
		}),
	);

	await withEnv({ PI_CODING_AGENT_DIR: agentDir, PI_OBSERVATION_DIR: undefined }, async () => {
		const { pi, handlers, tools } = fakePi();
		observationPack(pi as never);
		const ctx = { sessionManager: { getSessionId: () => "wire-session" }, ui: { notify: () => {} } };
		const sessionStart = handlers.get("session_start");
		const context = handlers.get("context");
		assert.ok(sessionStart && context);
		await sessionStart({}, ctx);

		const large = "A".repeat(200);
		const tr = toolResult(large);
		const assistant = { role: "assistant", content: [] };

		const first = (await context({ messages: [tr] }, ctx)) as { messages: unknown[] };
		assert.equal((first.messages[0] as { content: { text: string }[] }).content[0]!.text, large);

		const second = (await context({ messages: [tr, assistant] }, ctx)) as { messages: unknown[] };
		assert.equal((second.messages[0] as { content: { text: string }[] }).content[0]!.text, large);

		const third = (await context({ messages: [tr, assistant, assistant] }, ctx)) as {
			messages: { content: { text: string }[] }[];
		};
		const placeholder = third.messages[0]!.content[0]!.text;
		assert.match(placeholder, /large tool result replaced after its first 2 provider requests/);
		const id = /id: (obs_[a-f0-9]{24})/.exec(placeholder)?.[1];
		assert.ok(id);

		const recall = tools.get("obs_recall");
		assert.ok(recall);
		const recalled = (await recall.execute("call", { id, offset: 0 }, undefined, undefined, ctx)) as {
			content: { text: string }[];
		};
		assert.match(recalled.content[0]!.text, /\[obs_recall id=.*next_offset=200 eof=true\]/);
		assert.ok(recalled.content[0]!.text.endsWith(large));

		const ledger = await readFile(
			join(archiveDir, "wire-session", "observation-pack", "ledger.jsonl"),
			"utf8",
		);
		assert.match(ledger, /"event":"placeholder"/);
		assert.match(ledger, /"event":"recall"/);
	});
});

test("wiring: disabled by default and returns no projection", async () => {
	const agentDir = await tempDir("wire-off");
	await withEnv({ PI_CODING_AGENT_DIR: agentDir, PI_OBSERVATION_DIR: undefined }, async () => {
		const { pi, handlers, tools } = fakePi();
		observationPack(pi as never);
		const ctx = { sessionManager: { getSessionId: () => "wire-session" }, ui: { notify: () => {} } };
		await handlers.get("session_start")!({}, ctx);
		const result = await handlers.get("context")!({ messages: [toolResult("B".repeat(200))] }, ctx);
		assert.equal(result, undefined);
		assert.equal(tools.has("obs_recall"), false);
	});
});

test("wiring: fails open when the archive root is unusable", async () => {
	const agentDir = await tempDir("wire-fail-agent");
	const blocker = join(agentDir, "blocker");
	await writeFile(blocker, "not a directory");
	await writeFile(
		join(agentDir, "observation-pack.json"),
		JSON.stringify({
			version: 1,
			observationPack: { enabled: true, archiveDir: blocker, thresholdBytes: 64 },
		}),
	);
	await withEnv({ PI_CODING_AGENT_DIR: agentDir, PI_OBSERVATION_DIR: undefined }, async () => {
		const { pi, handlers } = fakePi();
		observationPack(pi as never);
		const ctx = { sessionManager: { getSessionId: () => "wire-session" }, ui: { notify: () => {} } };
		await handlers.get("session_start")!({}, ctx);
		const original = "C".repeat(200);
		const result = (await handlers.get("context")!({ messages: [toolResult(original)] }, ctx)) as {
			messages: { content: { text: string }[] }[];
		};
		// Fail open: the original observation is preserved even though archiving failed.
		assert.equal(result.messages[0]!.content[0]!.text, original);
	});
});