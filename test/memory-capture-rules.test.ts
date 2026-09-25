import assert from "node:assert/strict";
import test from "node:test";

import { RuleCaptureStrategy } from "pi-tsien-memory/src/application/capture-rules.ts";
import type { SettledTurn } from "pi-tsien-memory/src/ports/memory.ts";

const scope = { type: "repository" as const, key: "repository:pi-tsien-extension", repositoryId: "pi-tsien-extension" };

function turn(userText: string): SettledTurn {
	return {
		turnKey: "turn",
		profileId: "profile",
		sessionId: "session",
		userEntryId: "entry",
		userText,
		assistantText: "安装并验证成功",
		verifiedToolNames: ["bash"],
		scope,
		settledAt: Date.now(),
	};
}

test("does not capture a one-off Chinese installation request", async () => {
	const proposals = await new RuleCaptureStrategy().extract(
		turn("帮我安装这个 skill /mnt/workspace/lilong/repos/eagleeye-ai-dev/marketplace/packages/plugins/markdown-minify 到 codex 和 pi，并加入 eagleye-install config"),
	);
	assert.deepEqual(proposals, []);
});

test("only captures an explicit remember request", async () => {
	const strategy = new RuleCaptureStrategy();
	assert.deepEqual(await strategy.extract(turn("Python 3.11 已验证可用于此项目。")), []);
	const proposals = await strategy.extract(turn("记住：Python 3.11 已验证可用于此项目。"));
	assert.equal(proposals.length, 1);
	assert.equal(proposals[0]?.explicit, true);
});
