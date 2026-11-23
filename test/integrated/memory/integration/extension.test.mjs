import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = await mkdtemp(join(tmpdir(), "pi-tsien-memory-extension-"));
process.env.PI_TSIEN_MEMORY_DIR = dataDir;
const { default: register } = await import("pi-tsien-memory/src/extension/index.ts");

function makeHarness({ hasUI = false, choices = [], candidateReviewer } = {}) {
  const handlers = new Map();
  const tools = new Map();
  const commands = new Map();
  const statuses = new Map();
  const notifications = [];
  const selections = [];
  const sessionManager = {
    getSessionId: () => "pi-session-1",
    getSessionFile: () => undefined,
    getEntries: () => [],
    getBranch: () => [],
    buildContextEntries: () => [],
  };
  const ctx = {
    cwd: "/tmp/pi-tsien-memory-test",
    mode: "json",
    hasUI,
    sessionManager,
    isProjectTrusted: () => false,
    ui: {
      notify: (message, type) => notifications.push({ message, type }),
      setStatus: (key, value) => statuses.set(key, value),
      confirm: async () => false,
      select: async (title, options, optionsConfig) => {
        selections.push({ title, options, optionsConfig });
        return choices.shift();
      },
      input: async () => undefined,
    },
  };
  const pi = {
    on: (event, handler) => handlers.set(event, handler),
    registerTool: (tool) => tools.set(tool.name, tool),
    registerCommand: (name, options) => commands.set(name, options),
    appendEntry: () => undefined,
    exec: async () => ({ stdout: "", stderr: "not git", code: 1, killed: false }),
    getAllTools: () => [],
  };
  register(pi, { candidateReviewer });
  return { handlers, tools, commands, statuses, notifications, selections, ctx };
}

async function waitFor(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for asynchronous candidate review");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("extension lifecycle writes explicit memory and injects only temporary context", async () => {
  const harness = makeHarness();
  await harness.handlers.get("session_start")({ type: "session_start" }, harness.ctx);
  assert.equal(harness.statuses.get("tsien-memory"), "on");
  harness.handlers.get("input")({ type: "input", text: "remember this", source: "interactive" }, harness.ctx);
  const before = await harness.handlers.get("before_agent_start")({ prompt: "remember this", systemPrompt: "base" }, harness.ctx);
  assert.match(before.systemPrompt, /untrusted historical evidence/);
  const remember = harness.tools.get("memory_remember");
  const result = await remember.execute("call-1", { content: "use pnpm", scope: "repository" }, undefined, undefined, harness.ctx);
  assert.match(result.content[0].text, /Saved active memory/);
  harness.handlers.get("tool_result")({ type: "tool_result", toolName: "memory_remember", toolCallId: "call-1", input: {}, content: result.content, isError: false }, harness.ctx);
  await harness.handlers.get("agent_settled")({ type: "agent_settled" }, harness.ctx);
  assert.equal(harness.notifications.filter((item) => /已记住/.test(item.message)).length, 0);

  harness.handlers.get("input")({ type: "input", text: "pnpm package manager", source: "interactive" }, harness.ctx);
  await harness.handlers.get("before_agent_start")({ prompt: "pnpm package manager", systemPrompt: "base" }, harness.ctx);
  const context = await harness.handlers.get("context")({ messages: [{ role: "user", content: "pnpm package manager" }] }, harness.ctx);
  assert.equal(context.messages[0].customType, "pi-tsien-memory.context.v1");
  assert.match(String(context.messages[0].content), /pnpm/);

  harness.handlers.get("input")({ type: "input", text: "forget use pnpm", source: "interactive" }, harness.ctx);
  await harness.handlers.get("before_agent_start")({ prompt: "forget use pnpm", systemPrompt: "base" }, harness.ctx);
  const forget = harness.tools.get("memory_forget");
  const preview = await forget.execute("call-2", { target: "use pnpm" }, undefined, undefined, harness.ctx);
  assert.match(preview.content[0].text, /Confirmation required/);
  const token = preview.details.confirmationToken;
  const forgotten = await forget.execute("call-3", { target: "use pnpm", confirmationToken: token }, undefined, undefined, harness.ctx);
  assert.match(forgotten.content[0].text, /Memory forgotten/);
  await harness.handlers.get("session_shutdown")({ type: "session_shutdown" }, harness.ctx);
});

test("agent-settled queues model-reviewed candidates for human acceptance", async () => {
  const candidateReviewer = {
    async review() { return { content: "Use Node version 22 for this repository", kind: "experience" }; },
    async dispose() {},
  };
  const harness = makeHarness({ hasUI: true, choices: ["Accept"], candidateReviewer });
  await harness.handlers.get("session_start")({ type: "session_start" }, harness.ctx);
  harness.handlers.get("input")({ type: "input", text: "This works with node version 22", source: "interactive" }, harness.ctx);
  await harness.handlers.get("before_agent_start")({ prompt: "This works with node version 22", systemPrompt: "base" }, harness.ctx);
  harness.handlers.get("tool_result")({ type: "tool_result", toolName: "shell", toolCallId: "call-shell", input: {}, content: [], isError: false }, harness.ctx);
  harness.handlers.get("agent_end")({ messages: [{ role: "assistant", content: "Verified the fix." }] }, harness.ctx);
  await harness.handlers.get("agent_settled")({ type: "agent_settled" }, harness.ctx);
  await waitFor(() => harness.selections.length === 1 && /已接受候选记忆/.test(harness.notifications.at(-1)?.message ?? ""));

  assert.equal(harness.selections.length, 1);
  assert.match(harness.notifications.at(-1).message, /已接受候选记忆/);

  const search = harness.tools.get("memory_search");
  const result = await search.execute("call-search", { query: "node version 22" }, undefined, undefined, harness.ctx);
  assert.match(result.content[0].text, /active/);
  await harness.handlers.get("session_shutdown")({ type: "session_shutdown" }, harness.ctx);
});

test("a failed then recovered tool produces a reviewable Chinese experience", async () => {
  const candidateReviewer = {
    async review(turn) {
      assert.deepEqual(turn.failedToolNames, ["shell"]);
      assert.deepEqual(turn.recoveredToolNames, ["shell"]);
      return { content: "构建命令失败后应修正配置并重新运行验证", kind: "experience" };
    },
    async dispose() {},
  };
  const harness = makeHarness({ hasUI: true, choices: ["Accept"], candidateReviewer });
  await harness.handlers.get("session_start")({ type: "session_start" }, harness.ctx);
  harness.handlers.get("input")({ type: "input", text: "构建失败了，帮我修好", source: "interactive" }, harness.ctx);
  await harness.handlers.get("before_agent_start")({ prompt: "构建失败了，帮我修好", systemPrompt: "base" }, harness.ctx);
  harness.handlers.get("tool_result")({ type: "tool_result", toolName: "shell", toolCallId: "call-fail", input: {}, content: [], isError: true }, harness.ctx);
  harness.handlers.get("tool_result")({ type: "tool_result", toolName: "shell", toolCallId: "call-success", input: {}, content: [], isError: false }, harness.ctx);
  harness.handlers.get("agent_end")({ messages: [{ role: "assistant", content: "已修正配置，重新运行同一命令成功。" }] }, harness.ctx);
  await harness.handlers.get("agent_settled")({ type: "agent_settled" }, harness.ctx);
  await waitFor(() => /已接受候选记忆/.test(harness.notifications.at(-1)?.message ?? ""));
  assert.equal(harness.selections.length, 1);
  const result = await harness.tools.get("memory_search").execute("call-search", { query: "构建命令" }, undefined, undefined, harness.ctx);
  assert.match(result.content[0].text, /active/);
  await harness.handlers.get("session_shutdown")({ type: "session_shutdown" }, harness.ctx);
});

test("an unrecovered failure does not become a success experience", async () => {
  let reviewed = false;
  const candidateReviewer = {
    async review() {
      reviewed = true;
      return { content: "未恢复专用经验标记不应出现", kind: "experience" };
    },
    async dispose() {},
  };
  const harness = makeHarness({ hasUI: true, choices: [], candidateReviewer });
  await harness.handlers.get("session_start")({ type: "session_start" }, harness.ctx);
  harness.handlers.get("input")({ type: "input", text: "构建还是失败", source: "interactive" }, harness.ctx);
  await harness.handlers.get("before_agent_start")({ prompt: "构建还是失败", systemPrompt: "base" }, harness.ctx);
  harness.handlers.get("tool_result")({ type: "tool_result", toolName: "shell", toolCallId: "call-fail", input: {}, content: [], isError: true }, harness.ctx);
  harness.handlers.get("tool_result")({ type: "tool_result", toolName: "read", toolCallId: "call-read", input: {}, content: [], isError: false }, harness.ctx);
  harness.handlers.get("agent_end")({ messages: [{ role: "assistant", content: "还没有修好，需要继续排查。" }] }, harness.ctx);
  await harness.handlers.get("agent_settled")({ type: "agent_settled" }, harness.ctx);
  await waitFor(() => reviewed);
  await new Promise((resolve) => setTimeout(resolve, 80));
  const result = await harness.tools.get("memory_search").execute("call-search", { query: "未恢复专用经验标记" }, undefined, undefined, harness.ctx);
  assert.equal(result.details.count, 0);
  assert.equal(harness.selections.length, 0);
  await harness.handlers.get("session_shutdown")({ type: "session_shutdown" }, harness.ctx);
});

test("a new user input clears the previous turn failure evidence", async () => {
  let secondTurn;
  const candidateReviewer = {
    async review(turn) {
      secondTurn = turn;
      return undefined;
    },
    async dispose() {},
  };
  const harness = makeHarness({ hasUI: true, choices: [], candidateReviewer });
  await harness.handlers.get("session_start")({ type: "session_start" }, harness.ctx);
  harness.handlers.get("input")({ type: "input", text: "第一次构建失败", source: "interactive" }, harness.ctx);
  await harness.handlers.get("before_agent_start")({ prompt: "第一次构建失败", systemPrompt: "base" }, harness.ctx);
  harness.handlers.get("tool_result")({ type: "tool_result", toolName: "shell", toolCallId: "call-old-fail", input: {}, content: [], isError: true }, harness.ctx);
  harness.handlers.get("input")({ type: "input", text: "换一个任务", source: "interactive" }, harness.ctx);
  await harness.handlers.get("before_agent_start")({ prompt: "换一个任务", systemPrompt: "base" }, harness.ctx);
  harness.handlers.get("tool_result")({ type: "tool_result", toolName: "shell", toolCallId: "call-new-success", input: {}, content: [], isError: false }, harness.ctx);
  harness.handlers.get("agent_end")({ messages: [{ role: "assistant", content: "新的任务已完成。" }] }, harness.ctx);
  await harness.handlers.get("agent_settled")({ type: "agent_settled" }, harness.ctx);
  await waitFor(() => secondTurn !== undefined);
  assert.deepEqual(secondTurn.failedToolNames, []);
  assert.deepEqual(secondTurn.recoveredToolNames, []);
  await harness.handlers.get("session_shutdown")({ type: "session_shutdown" }, harness.ctx);
});

test("memory tools do not count as evidence for new memories", async () => {
  let reviewed = false;
  let seenTools;
  const candidateReviewer = {
    async review(turn) {
      reviewed = true;
      seenTools = turn.verifiedToolNames;
      return { content: "旧记忆不能证明这条新记忆", kind: "experience" };
    },
    async dispose() {},
  };
  const harness = makeHarness({ hasUI: true, choices: [], candidateReviewer });
  await harness.handlers.get("session_start")({ type: "session_start" }, harness.ctx);
  harness.handlers.get("input")({ type: "input", text: "搜索一下已有记忆", source: "interactive" }, harness.ctx);
  await harness.handlers.get("before_agent_start")({ prompt: "搜索一下已有记忆", systemPrompt: "base" }, harness.ctx);
  harness.handlers.get("tool_result")({ type: "tool_result", toolName: "memory_search", toolCallId: "call-memory-search", input: {}, content: [], isError: false }, harness.ctx);
  harness.handlers.get("agent_end")({ messages: [{ role: "assistant", content: "这是搜索结果。" }] }, harness.ctx);
  await harness.handlers.get("agent_settled")({ type: "agent_settled" }, harness.ctx);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(reviewed, false, `reviewer saw tools: ${JSON.stringify(seenTools)}`);
  await harness.handlers.get("session_shutdown")({ type: "session_shutdown" }, harness.ctx);
});

test("a delayed review cannot write into a newer turn", async () => {
  let releaseReview;
  let reviewStarted;
  const started = new Promise((resolve) => { reviewStarted = resolve; });
  const candidateReviewer = {
    review() {
      reviewStarted();
      return new Promise((resolve) => { releaseReview = () => resolve({ content: "过期审核不应写入新轮次", kind: "experience" }); });
    },
    async dispose() {},
  };
  const harness = makeHarness({ hasUI: true, choices: [], candidateReviewer });
  await harness.handlers.get("session_start")({ type: "session_start" }, harness.ctx);
  harness.handlers.get("input")({ type: "input", text: "第一轮任务", source: "interactive" }, harness.ctx);
  await harness.handlers.get("before_agent_start")({ prompt: "第一轮任务", systemPrompt: "base" }, harness.ctx);
  harness.handlers.get("tool_result")({ type: "tool_result", toolName: "shell", toolCallId: "call-old", input: {}, content: [], isError: false }, harness.ctx);
  harness.handlers.get("agent_end")({ messages: [{ role: "assistant", content: "第一轮已完成。" }] }, harness.ctx);
  await harness.handlers.get("agent_settled")({ type: "agent_settled" }, harness.ctx);
  await started;
  harness.handlers.get("input")({ type: "input", text: "用户已经开始第二轮", source: "interactive" }, harness.ctx);
  releaseReview();
  await new Promise((resolve) => setTimeout(resolve, 100));
  const result = await harness.tools.get("memory_search").execute("call-search", { query: "过期审核不应写入新轮次" }, undefined, undefined, harness.ctx);
  assert.equal(result.content[0].text.includes("过期审核不应写入新轮次"), false);
  await harness.handlers.get("session_shutdown")({ type: "session_shutdown" }, harness.ctx);
});

after(async () => {
  await rm(dataDir, { recursive: true, force: true });
});
