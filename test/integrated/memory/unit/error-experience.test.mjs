import test from "node:test";
import assert from "node:assert/strict";
import { recoveryFromToolOutcomes } from "pi-tsien-memory/src/application/tool-recovery.ts";
import { ModelCandidateReviewer } from "pi-tsien-memory/src/application/candidate-reviewer.ts";

const outcome = (toolName, isError) => ({ toolName, isError });

test("recovery requires the same tool to fail first and succeed later", () => {
  assert.deepEqual(recoveryFromToolOutcomes([outcome("shell", true), outcome("shell", false)]), {
    failedToolNames: ["shell"],
    recoveredToolNames: ["shell"],
  });
  assert.deepEqual(recoveryFromToolOutcomes([outcome("shell", true)]).recoveredToolNames, []);
  assert.deepEqual(recoveryFromToolOutcomes([outcome("shell", false), outcome("shell", true)]).recoveredToolNames, []);
  assert.deepEqual(recoveryFromToolOutcomes([outcome("shell", true), outcome("shell", false), outcome("shell", true)]).recoveredToolNames, []);
  assert.deepEqual(recoveryFromToolOutcomes([outcome("shell", true), outcome("shell", false), outcome("shell", true), outcome("shell", false)]).recoveredToolNames, ["shell"]);
  assert.deepEqual(recoveryFromToolOutcomes([outcome("shell", true), outcome("read", false)]).recoveredToolNames, []);
});

test("recovery keeps every independently recovered tool without duplication", () => {
  const result = recoveryFromToolOutcomes([
    outcome("shell", true),
    outcome("read", true),
    outcome("shell", false),
    outcome("read", false),
    outcome("shell", false),
  ]);
  assert.deepEqual(result.failedToolNames, ["shell", "read"]);
  assert.deepEqual(result.recoveredToolNames, ["shell", "read"]);
});

test("the reviewer receives failure and recovery evidence but no raw error body", async () => {
  let request;
  const reviewer = new ModelCandidateReviewer(
    { model: "test-model", timeoutMs: 1000, maxInputChars: 1000 },
    { run: async (input) => { request = input; return { output: JSON.stringify({ decision: "skip" }), isError: false }; } },
  );
  const turn = {
    turnKey: "t",
    profileId: "p",
    sessionId: "s",
    userEntryId: "u",
    userText: "请修复构建",
    assistantText: "已修正配置，重新运行成功",
    scope: { type: "repository", key: "repository:r" },
    settledAt: Date.now(),
    verifiedToolNames: ["shell"],
    failedToolNames: ["shell"],
    recoveredToolNames: ["shell"],
  };
  assert.equal(await reviewer.review(turn, "/tmp"), undefined);
  assert.match(request.task, /FAILED TOOLS:\nshell/);
  assert.match(request.task, /RECOVERED TOOLS \(failed first, then succeeded\):\nshell/);
  assert.match(request.task, /Never invent a root cause/);
});

test("reviews queue instead of dropping a turn while another review is busy", async () => {
  let calls = 0;
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const runner = {
    run: async () => {
      calls++;
      if (calls === 1) await firstGate;
      return { output: JSON.stringify({ decision: "skip" }), isError: false };
    },
  };
  const reviewer = new ModelCandidateReviewer({ model: "test-model", timeoutMs: 1000, maxInputChars: 1000 }, runner);
  const turn = {
    turnKey: "t", profileId: "p", sessionId: "s", userEntryId: "u",
    userText: "测试", assistantText: "完成", scope: { type: "repository", key: "repository:r" },
    settledAt: Date.now(), verifiedToolNames: ["shell"],
  };
  const first = reviewer.review(turn, "/tmp");
  const second = reviewer.review(turn, "/tmp");
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(calls, 1);
  releaseFirst();
  await first;
  await second;
  assert.equal(calls, 2);
});

