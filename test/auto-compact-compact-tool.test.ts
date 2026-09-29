import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type {
	ExtensionAPI,
	ExtensionContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import autoCompactTarget from "../packages/pi-tsien-auto-compact/src/index.ts";

// The factory reads the process-wide policy snapshot from the agent dir; keep the
// test independent of a real `~/.pi/agent/auto-compact-target.json`.
process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "auto-compact-test-agent-"));

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
type CompactOptions = {
	customInstructions?: string;
	onComplete?: (result: { tokensBefore: number; estimatedTokensAfter?: number }) => void;
	onError?: (error: Error) => void;
};

function fakePi(): {
	pi: ExtensionAPI;
	tools: Map<string, ToolDefinition>;
	handlers: Map<string, Handler>;
} {
	const tools = new Map<string, ToolDefinition>();
	const handlers = new Map<string, Handler>();
	const pi = {
		registerTool: (tool: ToolDefinition) => {
			tools.set(tool.name, tool);
		},
		on: (name: string, handler: Handler) => {
			handlers.set(name, handler);
		},
	} as unknown as ExtensionAPI;
	return { pi, tools, handlers };
}

function fakeCtx(
	sessionId: string,
	mode: "tui" | "rpc" | "json" | "print" = "tui",
): {
	ctx: ExtensionContext;
	compactions: CompactOptions[];
	notifications: string[];
	idle: { value: boolean };
} {
	const compactions: CompactOptions[] = [];
	const notifications: string[] = [];
	const idle = { value: true };
	const ctx = {
		mode,
		isIdle: () => idle.value,
		sessionManager: { getSessionId: () => sessionId },
		getContextUsage: () => ({ tokens: 5_000, contextWindow: 100_000, percent: 5 }),
		model: { contextWindow: 100_000 },
		ui: {
			notify: (message: string) => {
				notifications.push(message);
			},
		},
		compact: (options: CompactOptions) => {
			compactions.push(options);
		},
	} as unknown as ExtensionContext;
	return { ctx, compactions, notifications, idle };
}

function executeOf(tools: Map<string, ToolDefinition>): ToolDefinition["execute"] {
	const tool = tools.get("compact_context");
	assert.ok(tool, "the extension registers compact_context");
	return tool.execute;
}

test("the tool is registered and never compacts inline", async () => {
	const { pi, tools, handlers } = fakePi();
	autoCompactTarget(pi);
	const execute = executeOf(tools);

	const { ctx, compactions, notifications } = fakeCtx("session-a");
	const result = await execute("call-1", { instructions: "keep the deploy steps" }, undefined, undefined, ctx);

	assert.equal((result.details as { status: string }).status, "scheduled");
	// The run that called the tool must survive: nothing compacts while it streams.
	assert.equal(compactions.length, 0);
	assert.equal(notifications.length, 1);

	handlers.get("agent_settled")?.({}, ctx);

	assert.equal(compactions.length, 1);
	assert.equal(compactions[0]?.customInstructions, "keep the deploy steps");
});

test("a second request in the same run is reported instead of re-scheduled", async () => {
	const { pi, tools, handlers } = fakePi();
	autoCompactTarget(pi);
	const execute = executeOf(tools);

	const { ctx, compactions } = fakeCtx("session-a");
	await execute("call-1", {}, undefined, undefined, ctx);
	const duplicate = await execute("call-2", { instructions: "other focus" }, undefined, undefined, ctx);

	assert.equal((duplicate.details as { status: string }).status, "already_scheduled");

	handlers.get("agent_settled")?.({}, ctx);

	// The first request wins; the duplicate never queued a second compaction.
	assert.equal(compactions.length, 1);
	assert.equal(compactions[0]?.customInstructions, undefined);
});

test("a request recorded mid-run waits for the idle boundary", async () => {
	const { pi, tools, handlers } = fakePi();
	autoCompactTarget(pi);
	const execute = executeOf(tools);

	const { ctx, compactions, idle } = fakeCtx("session-a");
	await execute("call-1", {}, undefined, undefined, ctx);

	// `ctx.compact()` aborts a running turn, so a non-idle boundary must not fire it.
	idle.value = false;
	handlers.get("agent_settled")?.({}, ctx);
	assert.equal(compactions.length, 0);

	idle.value = true;
	handlers.get("agent_settled")?.({}, ctx);
	assert.equal(compactions.length, 1);
});

test("requests are isolated per session", async () => {
	const { pi, tools, handlers } = fakePi();
	autoCompactTarget(pi);
	const execute = executeOf(tools);

	const a = fakeCtx("session-a");
	const b = fakeCtx("session-b");
	await execute("call-1", { instructions: "for a" }, undefined, undefined, a.ctx);

	handlers.get("agent_settled")?.({}, b.ctx);
	assert.equal(b.compactions.length, 0, "another session must not consume the request");

	handlers.get("agent_settled")?.({}, a.ctx);
	assert.equal(a.compactions.length, 1);
	assert.equal(a.compactions[0]?.customInstructions, "for a");
});

test("session shutdown drops an unconsumed request", async () => {
	const { pi, tools, handlers } = fakePi();
	autoCompactTarget(pi);
	const execute = executeOf(tools);

	const { ctx, compactions } = fakeCtx("session-a");
	await execute("call-1", {}, undefined, undefined, ctx);

	handlers.get("session_shutdown")?.({}, ctx);
	handlers.get("agent_settled")?.({}, ctx);

	assert.equal(compactions.length, 0);
});

test("one-shot modes are told the compaction cannot finish instead of scheduling it", async () => {
	const { pi, tools, handlers } = fakePi();
	autoCompactTarget(pi);
	const execute = executeOf(tools);

	for (const mode of ["print", "json"] as const) {
		const { ctx, compactions, notifications } = fakeCtx("session-a", mode);
		const result = await execute("call-1", {}, undefined, undefined, ctx);

		assert.equal(
			(result.details as { status: string }).status,
			"unavailable_in_one_shot_mode",
		);
		assert.equal(compactions.length, 0);
		assert.equal(notifications.length, 0);

		handlers.get("agent_settled")?.({}, ctx);
		assert.equal(compactions.length, 0, `${mode} must not queue a doomed compaction`);
	}
});

test("rpc sessions can schedule a compaction", async () => {
	const { pi, tools, handlers } = fakePi();
	autoCompactTarget(pi);
	const execute = executeOf(tools);

	const { ctx, compactions } = fakeCtx("session-a", "rpc");
	const result = await execute("call-1", {}, undefined, undefined, ctx);

	assert.equal((result.details as { status: string }).status, "scheduled");
	handlers.get("agent_settled")?.({}, ctx);
	assert.equal(compactions.length, 1);
});

test("the completion notification reports the token delta", async () => {
	const { pi, tools, handlers } = fakePi();
	autoCompactTarget(pi);
	const execute = executeOf(tools);

	const { ctx, compactions, notifications } = fakeCtx("session-a");
	await execute("call-1", {}, undefined, undefined, ctx);
	handlers.get("agent_settled")?.({}, ctx);

	compactions[0]?.onComplete?.({ tokensBefore: 120_000, estimatedTokensAfter: 20_000 });

	assert.ok(notifications.some((message) => message.includes("120,000") && message.includes("20,000")));
});