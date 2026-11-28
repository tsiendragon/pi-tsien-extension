import assert from "node:assert/strict";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import test, { mock } from "node:test";
import defaultSystemPromptExtension, {
  ACTION_GUIDELINES,
  adjustGuidelinesSection,
  DEFAULT_SYSTEM_PROMPT_FILE,
  replaceSystemPromptIntro,
} from "pi-tsien-default-system-prompt/src/index.ts";

test("replaces only the built-in introduction and retains tool guidance", () => {
  const original = [
    "You are an expert coding assistant.",
    "",
    "Available tools:",
    "- read",
    "",
    "Guidelines:",
    "- Use read before editing.",
  ].join("\n");

  assert.equal(
    replaceSystemPromptIntro(original, "# Custom agent\n\nFollow the business objective."),
    [
      "# Custom agent",
      "",
      "Follow the business objective.",
      "",
      "Available tools:",
      "- read",
      "",
      "Guidelines:",
      "- Use read before editing.",
    ].join("\n"),
  );
});

test("leaves the prompt unchanged when the tools section is unavailable", () => {
  assert.equal(replaceSystemPromptIntro("A custom prompt", "# Custom agent"), undefined);
});

test("adjusts Guidelines: drops common-sense lines and injects action guidelines", () => {
  const original = [
    "Available tools:",
    "- read",
    "",
    "Guidelines:",
    "- Use read before editing.",
    "- Be concise in your responses",
    "- Show file paths clearly when working with files",
  ].join("\n");

  const adjusted = adjustGuidelinesSection(original);
  assert.ok(!adjusted.includes("Be concise in your responses"));
  assert.ok(!adjusted.includes("Show file paths clearly"));
  assert.ok(adjusted.includes("- Use read before editing."));
  for (const guideline of ACTION_GUIDELINES) {
    assert.ok(adjusted.includes(guideline));
  }
});

test("keeps the prompt unchanged when Guidelines is absent", () => {
  const prompt = "No guidelines section here.";
  assert.equal(adjustGuidelinesSection(prompt), prompt);
});

const NEW_FORMAT = [
  "You are an expert coding assistant.",
  "",
  "<tools>",
  "- read: Read files",
  "</tools>",
  "",
  "<rules>",
  "- Use read before editing.",
  "- Be concise in your responses",
  "- Show file paths clearly when working with files",
  "</rules>",
  "",
  "<docs>x</docs>",
].join("\n");

test("new <tools>/<rules> format: replaces intro and keeps tags", () => {
  const out = replaceSystemPromptIntro(NEW_FORMAT, "# Custom\n");
  assert.ok(out !== undefined);
  assert.ok(out.startsWith("# Custom\n\n<tools>\n- read: Read files\n</tools>"));
  assert.ok(out.includes("</tools>"));
  assert.ok(out.includes("</rules>"));
  assert.ok(!out.includes("expert coding assistant"));
});

test("new <rules> format: drops common-sense lines and injects guidelines inside rules", () => {
  const adjusted = adjustGuidelinesSection(NEW_FORMAT);
  assert.ok(!adjusted.includes("Be concise in your responses"));
  assert.ok(!adjusted.includes("Show file paths clearly"));
  const open = adjusted.indexOf("<rules>");
  const close = adjusted.indexOf("</rules>");
  assert.ok(open !== -1 && close > open);
  for (const guideline of ACTION_GUIDELINES) {
    const at = adjusted.indexOf(guideline);
    assert.ok(at > open && at < close);
  }
  assert.ok(adjusted.includes("- Use read before editing."));
});

test("legacy format still works end to end", () => {
  const legacy = "Intro\n\nAvailable tools:\n- read\n\nGuidelines:\n- Be concise in your responses\n- x";
  const out = adjustGuidelinesSection(replaceSystemPromptIntro(legacy, "# C") as string);
  assert.ok(out.startsWith("# C\n\nAvailable tools:\n- read\n\nGuidelines:\n" + ACTION_GUIDELINES[0]));
  assert.ok(!out.includes("Be concise"));
  assert.ok(out.endsWith("- x"));
});

test("returns undefined when neither tools marker exists", () => {
  assert.equal(replaceSystemPromptIntro("<tool>no</tool> Available tools without newline", "# C"), undefined);
});

// ───────────────────────── before_agent_start 警告分支 ─────────────────────────
// 做法：用 mock.method 替换 fs.promises.readFile，再 syncBuiltinESMExports() 让 ESM 具名导出同步，
// 这样不依赖真实的 ~/.pi/agent/DefaultSystemPrompt.md，可确定性控制「有 / 无自定义文件」。
// 只拦截目标文件路径，其它路径仍走原实现。

type Handler = (event: { systemPrompt: string }, ctx: unknown) => Promise<{ systemPrompt: string } | undefined>;

const CUSTOM_INTRO = "# Fake Custom Agent Intro for tests\n\nAlways follow the business objective carefully and precisely.\n";

function installReadFileMock(behavior: { content: string } | { errorCode: string }) {
  const original = fsPromises.readFile;
  const m = mock.method(fsPromises, "readFile", async (...args: unknown[]) => {
    if (String(args[0]) === DEFAULT_SYSTEM_PROMPT_FILE) {
      if ("errorCode" in behavior) {
        throw Object.assign(new Error(behavior.errorCode), { code: behavior.errorCode });
      }
      return behavior.content;
    }
    return (original as (...a: unknown[]) => unknown)(...args);
  });
  syncBuiltinESMExports();
  return m;
}

function setup() {
  let handler: Handler | undefined;
  defaultSystemPromptExtension({
    on: (name: string, h: Handler) => {
      if (name === "before_agent_start") handler = h;
    },
  } as never);
  assert.ok(handler, "扩展必须注册 before_agent_start");
  const notifications: Array<[string, string | undefined]> = [];
  const ctx = { hasUI: true, ui: { notify: (m: string, t?: string) => notifications.push([m, t]) } };
  return { handler: handler as Handler, ctx, notifications };
}

const NEW_FMT_PROMPT = "Pi built-in intro\n\n<tools>\n- read: Read files\n</tools>\n\n<rules>\n- Be concise in your responses\n</rules>";

test.afterEach(() => {
  mock.restoreAll();
  syncBuiltinESMExports();
});

test("before_agent_start: 新版 <tools>/<rules> 格式正常路径不报警，并注入 ACTION_GUIDELINES", async () => {
  // 防回归：正常路径被误报，或没有替换开头/调整 rules。
  installReadFileMock({ content: CUSTOM_INTRO });
  const { handler, ctx, notifications } = setup();
  const result = await handler({ systemPrompt: NEW_FMT_PROMPT }, ctx);
  assert.equal(notifications.length, 0);
  assert.ok(result);
  for (const g of ACTION_GUIDELINES) assert.ok(result.systemPrompt.includes(g));
  assert.ok(!result.systemPrompt.includes("Be concise in your responses"));
  assert.ok(result.systemPrompt.startsWith("# Fake Custom Agent Intro"));
  assert.ok(!result.systemPrompt.includes("Pi built-in intro"));
});

test("before_agent_start: Pi 已自行应用自定义开头时不误报，仍调整提示", async () => {
  // 防回归（当前真实场景）：Pi >= 1.6 自己读取 DefaultSystemPrompt.md，提示以自定义开头的前 60 字符起头，
  // 此时 replaceSystemPromptIntro 仍可能找不到旧标记，但不应弹「未找到 <tools>」警告。
  installReadFileMock({ content: CUSTOM_INTRO });
  const { handler, ctx, notifications } = setup();
  const prompt = `${CUSTOM_INTRO.trim().slice(0, 60)} (Pi applied)\n\n<tools>\n- read\n</tools>\n\n<rules>\n- Be concise in your responses\n</rules>`;
  // 该提示含 <tools>，会走替换分支；再构造一个仅以自定义开头、无任何 tools 标记的提示覆盖 head 分支。
  const headOnly = `${CUSTOM_INTRO.trim().slice(0, 60)} (Pi applied)\nno tools markers\n\n<rules>\n- Be concise in your responses\n</rules>`;
  for (const p of [prompt, headOnly]) {
    const result = await handler({ systemPrompt: p }, ctx);
    assert.ok(result, "仍须返回调整后的提示");
    for (const g of ACTION_GUIDELINES) assert.ok(result.systemPrompt.includes(g));
    assert.ok(!result.systemPrompt.includes("Be concise in your responses"));
  }
  assert.equal(notifications.length, 0);
});

test("before_agent_start: 既无自定义开头也无 tools 标记时只报警一次", async () => {
  // 防回归：缺失 tools 段时必须告警，且 notifiedMissingToolsSection 一次性抑制，不能每轮刷屏。
  // 实现在该分支 return undefined（保留 Pi 原提示）。
  installReadFileMock({ content: CUSTOM_INTRO });
  const { handler, ctx, notifications } = setup();
  const first = await handler({ systemPrompt: "totally unrelated prompt" }, ctx);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0][1], "warning");
  assert.ok(notifications[0][0].includes("<tools>"));
  assert.equal(first, undefined);
  const second = await handler({ systemPrompt: "totally unrelated prompt" }, ctx);
  assert.equal(notifications.length, 1, "第二次不应再次通知");
  assert.equal(second, undefined);
});

test("before_agent_start: 自定义文件不存在（ENOENT）时静默直接返回", async () => {
  // 防回归：用户没有配置自定义提示是正常情况，不能报警，也不能改动提示。
  const m = installReadFileMock({ errorCode: "ENOENT" });
  const { handler, ctx, notifications } = setup();
  const result = await handler({ systemPrompt: NEW_FMT_PROMPT }, ctx);
  assert.ok(m.mock.callCount() >= 1, "mock 必须真正被扩展调用，否则用例无效");
  assert.equal(notifications.length, 0);
  assert.equal(result, undefined);
});
