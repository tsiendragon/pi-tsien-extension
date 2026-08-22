import assert from "node:assert/strict";
import test from "node:test";

import { ModelCandidateReviewer } from "../extensions/memory/src/application/candidate-reviewer.ts";
import type { SettledTurn } from "../extensions/memory/src/ports/memory.ts";

const turn: SettledTurn = {
	turnKey: "turn",
	profileId: "profile",
	sessionId: "session",
	userEntryId: "entry",
	userText: "Python 3.11 已验证可用于此项目。",
	assistantText: "验证成功。",
	verifiedToolNames: ["bash"],
	scope: { type: "repository", key: "repository:pi-tsien-extension", repositoryId: "pi-tsien-extension" },
	settledAt: Date.now(),
};

function reviewer(output: string) {
	return new ModelCandidateReviewer(
		{ model: "openai-codex/gpt-5.6-luna", timeoutMs: 1_000, maxInputChars: 2_000 },
		{ run: async () => ({ output, isError: false }) },
	);
}

test("accepts only a structured candidate from the background reviewer", async () => {
	const candidate = await reviewer('{"decision":"candidate","content":"此项目已验证可使用 Python 3.11。","kind":"experience"}').review(turn, process.cwd());
	assert.deepEqual(candidate, { content: "此项目已验证可使用 Python 3.11。", kind: "experience" });
});

test("skips a one-off request when the reviewer rejects it", async () => {
	const candidate = await reviewer('{"decision":"skip"}').review({ ...turn, userText: "帮我安装这个 skill" }, process.cwd());
	assert.equal(candidate, undefined);
});
