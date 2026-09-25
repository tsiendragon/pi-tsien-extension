/**
 * Contract tests for the unified tool-result pipeline.
 *
 * These lock the two things the merge was for:
 *   1. this layer has exactly one `tool_result` handler (no competing extensions)
 *   2. the stage order is declared in code and asserted, instead of depending on
 *      the user's `loadOrder` array
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import toolResultPipeline, { STAGE_ORDER, buildStages } from "pi-tsien-rtk-fork/src/index.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => Promise<Record<string, unknown> | undefined>;

function fakePi(): { pi: ExtensionAPI; handlers: Map<string, Handler[]>; commands: string[]; tools: string[] } {
	const handlers = new Map<string, Handler[]>();
	const commands: string[] = [];
	const tools: string[] = [];
	const pi = {
		on(name: string, handler: Handler) {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
			return pi;
		},
		registerCommand(name: string) {
			commands.push(name);
			return pi;
		},
		registerTool(tool: { name: string }) {
			tools.push(tool.name);
			return pi;
		},
	} as unknown as ExtensionAPI;
	return { pi, handlers, commands, tools };
}

function bashEvent(text: string, command = "cat something"): Record<string, unknown> {
	return {
		toolName: "bash",
		toolCallId: `call-${Math.random().toString(16).slice(2)}`,
		input: { command },
		content: [{ type: "text", text }],
		isError: false,
		details: { exitCode: 0 },
	};
}

const ctx = {
	ui: { notify: () => undefined },
	sessionManager: { getSessionId: () => undefined },
} as unknown as ExtensionContext;

test("pipeline owns exactly one tool_result handler", () => {
	const { pi, handlers } = fakePi();
	toolResultPipeline(pi);
	assert.equal(handlers.get("tool_result")?.length, 1);
});

test("RTK runs first inside the pipeline (ANSI stripping still applies)", async () => {
	const { pi, handlers } = fakePi();
	toolResultPipeline(pi);
	const handler = handlers.get("tool_result")![0]!;

	const result = await handler(bashEvent("\u001b[31mred\u001b[0m line\n"), ctx);
	assert.ok(result, "expected the pipeline to rewrite ANSI output");
	const text = (result!.content as { text: string }[])[0]!.text;
	assert.equal(text, "red line\n");
});

test("declared stage order matches the built pipeline", () => {
	const names = buildStages().map((stage) => stage.name);
	assert.equal(STAGE_ORDER[0], "rtk", "RTK is the upstream-managed first stage");
	assert.deepEqual(names, STAGE_ORDER.slice(1, names.length + 1));
});

test("RTK surface (commands and configure tool) is still registered", () => {
	const { pi, commands, tools } = fakePi();
	toolResultPipeline(pi);
	assert.ok(commands.includes("rtk-stats"), `expected rtk commands, got ${commands.join(",")}`);
	assert.ok(commands.includes("rtk-toggle-truncation"), "truncation toggle must survive the merge");
	assert.ok(tools.includes("rtk_configure"), "rtk_configure must survive the merge");
});

test("unrelated tools and small outputs stay untouched", async () => {
	const { pi, handlers } = fakePi();
	toolResultPipeline(pi);
	const handler = handlers.get("tool_result")![0]!;

	const readEvent = { ...bashEvent("small\n"), toolName: "read" };
	assert.equal(await handler(readEvent, ctx), undefined);

	assert.equal(await handler(bashEvent("ok\n", "cat x"), ctx), undefined);
});
