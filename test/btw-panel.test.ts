import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { BtwPanel } from "pi-tsien-side-chat/src/panel.ts";
import type { BtwSessionController } from "pi-tsien-side-chat/src/session.ts";

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

const tui = {
  terminal: { rows: 40 },
  requestRender: () => {},
} as unknown as TUI;

function panelWith(lastAnswer?: string, busy = false) {
  const copied: string[] = [];
  const notices: string[] = [];
  const controller = {
    conversation: [],
    parentMessageCount: 3,
    busy,
    activity: busy ? "只读工具：read src/app.ts" : "",
    modelLabel: "test-provider/test-model",
    lastAnswer,
    onChange: undefined,
    submit: async () => {},
    abort: async () => {},
    refreshParentSnapshot: async () => {},
  } as unknown as BtwSessionController;
  const panel = new BtwPanel(tui, theme, controller, {
    close: () => {},
    copyToMain: () => {},
    copyAnswer: (text) => {
      copied.push(text);
    },
    notify: (message) => {
      notices.push(message);
    },
  });
  return { panel, copied, notices };
}

test("c copies the last answer as raw Markdown while the input is empty", () => {
  const { panel, copied, notices } = panelWith("**答案**\n第二行");
  panel.handleInput("c");
  assert.deepEqual(copied, ["**答案**\n第二行"]);
  assert.deepEqual(notices, []);
});

test("c stays a normal keystroke while the input has text", () => {
  const { panel, copied } = panelWith("答案");
  panel.handleInput("a");
  panel.handleInput("c");
  assert.deepEqual(copied, [], "typing must never hit the clipboard");
  assert.ok(panel.render(100).join("\n").includes("ac"), "the letter was typed into the input");
});

test("c reports when there is no answer to copy yet", () => {
  const { panel, copied, notices } = panelWith(undefined);
  panel.handleInput("c");
  assert.deepEqual(copied, []);
  assert.equal(notices.length, 1);
});

test("the panel shows the sync state and only the keys that work right now", () => {
  const idle = panelWith(undefined).panel.render(120).join("\n");
  assert.match(idle, /主上下文 3 条（每次提问前自动同步）/);
  assert.match(idle, /Esc 关闭/);
  assert.doesNotMatch(idle, /c 复制回答/, "nothing to copy before the first answer");

  const answering = panelWith(undefined, true).panel.render(120).join("\n");
  assert.match(answering, /只读工具：read src\/app\.ts/);
  assert.match(answering, /Esc 取消/);

  const answered = panelWith("答案").panel.render(120).join("\n");
  assert.match(answered, /c 复制回答/);
});