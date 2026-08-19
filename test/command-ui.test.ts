import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import {
  KeybindingsManager,
  TUI_KEYBINDINGS,
  setKeybindings,
  visibleWidth,
  type EditorTheme,
  type TUI,
} from "@earendil-works/pi-tui";

import runningCommandsExtension from "../extensions/running-commands.ts";
import { BACKGROUND_COMMAND_MANAGER_SYMBOL_KEY } from "../extensions/lib/background-commands/manager.ts";
import { CommandAwareEditor } from "../extensions/lib/command-ui/command-aware-editor.ts";
import {
  MAX_FOREGROUND_OUTPUT_BYTES,
  RunningCommandRegistry,
  normalizeCommand,
  normalizeCommandTitle,
  truncateUtf8Tail,
} from "../extensions/lib/command-ui/command-registry.ts";
import { CommandFocusController } from "../extensions/lib/command-ui/focus-controller.ts";
import { PRE_POWERLINE_HOST_SYMBOL_KEY } from "../extensions/lib/command-ui/pre-powerline-client.ts";
import {
  RunningCommandsWidget,
  formatElapsedDuration,
  sanitizeOutputLines,
} from "../extensions/lib/command-ui/running-commands-widget.ts";

function startedRegistry(count = 2): RunningCommandRegistry {
  const registry = new RunningCommandRegistry();
  for (let index = 0; index < count; index += 1) {
    registry.start(`bash-${index}`, { command: `npm   run\njob-${index}` }, 1_000 + index);
  }
  return registry;
}

const fakeTui = {
  terminal: { rows: 24, columns: 80 },
  requestRender() {},
} as unknown as TUI;

const editorTheme = {
  borderColor: (value: string) => value,
  selectList: {},
} as EditorTheme;

const powerlineTheme = {
  fg: (_color: string, value: string) => value,
} as unknown as Theme;

test("registry orders commands, normalizes display text, and replaces output snapshots", () => {
  const registry = startedRegistry();
  registry.update("bash-0", { content: [{ type: "text", text: "first" }] });
  registry.update("bash-0", { content: [{ type: "text", text: "second" }] });

  const commands = registry.snapshot();
  assert.deepEqual(commands.map((command) => command.toolCallId), ["bash-0", "bash-1"]);
  assert.equal(commands[0]?.command, "npm run job-0");
  assert.equal(commands[0]?.outputTail, "second");
  assert.equal(normalizeCommand({ command: "\u001b[31mnpm\u001b[0m\u0007  test" }), "npm test");
  assert.equal(normalizeCommandTitle("\u001b[32mLinux\nbuild\u001b[0m", "npm test"), "Linux build");
  assert.equal(normalizeCommandTitle("\u0007", "npm test"), "npm test");
});

test("commands started in the same millisecond keep event order", () => {
  const registry = new RunningCommandRegistry();
  registry.start("bash-z", { command: "first" }, 1_000);
  registry.start("bash-a", { command: "second" }, 1_000);
  assert.deepEqual(registry.snapshot().map((command) => command.toolCallId), ["bash-z", "bash-a"]);
});

test("foreground commands stay before background tasks and share focus navigation", () => {
  const registry = new RunningCommandRegistry();
  registry.startBackground({
    taskId: "bash-bg01",
    command: "vite --host",
    startedAt: 500,
    outputTail: "ready",
    outputTruncated: false,
    outputFile: "/tmp/pi-background/bash-bg01.log",
  });
  registry.start("bash-bg01", { command: "npm test" }, 1_000);
  const commands = registry.snapshot();
  assert.deepEqual(commands.map((command) => command.mode), ["foreground", "background"]);
  assert.equal(commands[1]?.taskId, "bash-bg01");

  const focus = new CommandFocusController();
  focus.enterList(commands);
  assert.equal(focus.selectedTaskId, "background:bash-bg01");
  focus.moveList(-1, commands);
  assert.equal(focus.selectedTaskId, "foreground:bash-bg01");
});

test("UTF-8 output tail stays within 50KB without a broken leading character", () => {
  const result = truncateUtf8Tail(`prefix-${"界".repeat(MAX_FOREGROUND_OUTPUT_BYTES)}`);
  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(result.text, "utf8") <= MAX_FOREGROUND_OUTPUT_BYTES);
  assert.equal(result.text.startsWith("�"), false);
});

test("focus enters on newest command, navigates, and returns to editor below the last row", () => {
  const commands = startedRegistry(3).snapshot();
  const focus = new CommandFocusController();

  assert.equal(focus.enterList(commands), true);
  assert.equal(focus.selectedTaskId, "foreground:bash-2");
  focus.moveList(-1, commands);
  assert.equal(focus.selectedTaskId, "foreground:bash-1");
  focus.moveList(1, commands);
  focus.moveList(1, commands);
  assert.equal(focus.focusMode, "editor");
});

test("output scrolling pauses following, reports new lines, and End resumes", () => {
  const commands = startedRegistry(1).snapshot();
  const focus = new CommandFocusController();
  focus.enterList(commands);
  focus.openOutput(commands);
  focus.setOutputMetrics("foreground:bash-0", 20, 5);
  focus.scrollOutput(-1);
  focus.setOutputMetrics("foreground:bash-0", 23, 5);

  assert.equal(focus.getOutputViewport("foreground:bash-0").following, false);
  assert.equal(focus.getOutputViewport("foreground:bash-0").newLines, 3);
  focus.followLatest();
  assert.equal(focus.getOutputViewport("foreground:bash-0").following, true);
  assert.equal(focus.getOutputViewport("foreground:bash-0").scrollTop, 18);
});

test("command-aware editor only steals Up for a strictly empty input", () => {
  setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
  const registry = startedRegistry(1);
  const focus = new CommandFocusController();
  let renders = 0;
  const appKeybindings = { matches: () => false } as never;
  const editor = new CommandAwareEditor(fakeTui, editorTheme, appKeybindings, {
    registry,
    focus,
    requestRender: () => renders++,
  });

  editor.addToHistory("previous prompt");
  editor.setText(" ");
  editor.handleInput("\x1b[A");
  assert.equal(focus.focusMode, "editor");

  editor.setText("");
  editor.handleInput("\x1b[1;5A");
  assert.equal(focus.focusMode, "editor");
  assert.equal(editor.getText(), "previous prompt");
  editor.handleInput("\x1b[1;5B");
  assert.equal(focus.focusMode, "editor");
  assert.equal(editor.getText(), "");

  editor.handleInput("\x1b[A");
  assert.equal(focus.focusMode, "command-list");
  assert.equal(renders, 1);
});

test("Esc in command focus returns to the editor without invoking Agent interrupt", () => {
  setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
  const registry = startedRegistry(1);
  const focus = new CommandFocusController();
  const editor = new CommandAwareEditor(fakeTui, editorTheme, { matches: () => false } as never, {
    registry,
    focus,
    requestRender() {},
  });
  let interrupted = 0;
  editor.onEscape = () => interrupted++;

  focus.enterList(registry.snapshot());
  editor.handleInput("\x1b");
  assert.equal(focus.focusMode, "editor");
  assert.equal(interrupted, 0);
});

test("widget keeps every rendered line within terminal width", () => {
  const registry = startedRegistry(3);
  registry.update("bash-2", {
    content: [{ type: "text", text: "\u001b[31mred\u001b[0m\n" + "x".repeat(120) }],
  });
  const focus = new CommandFocusController();
  focus.enterList(registry.snapshot());
  focus.openOutput(registry.snapshot());
  const widget = new RunningCommandsWidget(fakeTui, powerlineTheme, {
    registry,
    focus,
    getEditorText: () => "",
    now: () => 4_000,
  });

  const lines = widget.render(48);
  assert.ok(lines.some((line) => line.includes("Recent output")));
  for (const terminalWidth of [24, 48, 80, 120, 200]) {
    assert.ok(widget.render(terminalWidth).every((line) => visibleWidth(line) <= terminalWidth));
  }
  assert.deepEqual(sanitizeOutputLines("a\r\nb\t\u0000c"), ["a", "b    c"]);
  assert.equal(formatElapsedDuration(125_000), "2m05s");
});

test("mixed foreground and background tasks render in stable order with shared output view", () => {
  const registry = new RunningCommandRegistry();
  registry.startBackground({
    taskId: "bash-mix1",
    command: "vite --host",
    title: "Dev server",
    startedAt: 500,
    outputTail: "server ready",
    outputTruncated: false,
    outputFile: "/tmp/pi-background/bash-mix1.log",
  });
  registry.start("foreground-mix", { command: "npm run lint" }, 1_000);
  const focus = new CommandFocusController();
  const widget = new RunningCommandsWidget(fakeTui, powerlineTheme, {
    registry,
    focus,
    getEditorText: () => "",
    now: () => 3_000,
  });

  const list = widget.render(120);
  assert.ok(list[0]?.includes("1 个前台 · 1 个后台任务"));
  const foregroundLine = list.findIndex((line) => line.includes("Foreground"));
  const backgroundLine = list.findIndex((line) => line.includes("Background · bash-mix1"));
  assert.ok(foregroundLine > 0 && backgroundLine > foregroundLine);
  assert.ok(list[backgroundLine]?.includes("Dev server"));
  assert.equal(list[backgroundLine]?.includes("vite --host"), false);

  focus.enterList(registry.snapshot());
  focus.openOutput(registry.snapshot());
  const output = widget.render(120);
  assert.ok(output[0]?.includes("bash-mix1"));
  assert.ok(output[0]?.includes("Dev server"));
  assert.ok(output.some((line) => line.includes("server ready")));
  assert.ok(output.every((line) => visibleWidth(line) <= 120));
});

test("extension lifecycle registers tools, updates UI, and restores the editor", async () => {
  type Handler = (event: Record<string, unknown>, ctx: unknown) => unknown;
  const handlers = new Map<string, Handler>();
  const tools = new Map<string, unknown>();
  const sentMessages: unknown[] = [];
  const extensionApi = {
    on(name: string, handler: Handler) {
      handlers.set(name, handler);
    },
    registerTool(tool: { name: string }) {
      tools.set(tool.name, tool);
    },
    sendMessage(message: unknown) {
      sentMessages.push(message);
    },
  } as unknown as ExtensionAPI;

  let componentFactory: ((tui: TUI, theme: Theme) => { render(width: number): string[] }) | undefined;
  let unregistered = false;
  let renderRequests = 0;
  const host = {
    version: 1 as const,
    register(_key: string, factory: typeof componentFactory) {
      componentFactory = factory;
      return () => {
        unregistered = true;
        componentFactory = undefined;
      };
    },
    requestRender() {
      renderRequests += 1;
    },
  };
  const globals = globalThis as unknown as Record<symbol, unknown>;
  const hostSymbol = Symbol.for(PRE_POWERLINE_HOST_SYMBOL_KEY);
  const managerSymbol = Symbol.for(BACKGROUND_COMMAND_MANAGER_SYMBOL_KEY);
  delete globals[managerSymbol];
  globals[hostSymbol] = host;

  let currentEditorFactory: unknown;
  const notifications: string[] = [];
  const ctx = {
    mode: "tui",
    hasUI: true,
    cwd: "/mnt/workspace/lilong/repos/pi-tsien-extension",
    sessionManager: {
      getSessionId: () => "command-ui-lifecycle",
      getSessionFile: () => undefined,
    },
    isProjectTrusted: () => true,
    ui: {
      getEditorComponent: () => currentEditorFactory,
      setEditorComponent: (factory: unknown) => {
        currentEditorFactory = factory;
      },
      getEditorText: () => "",
      notify: (message: string) => notifications.push(message),
    },
  };

  try {
    runningCommandsExtension(extensionApi);
    assert.deepEqual([...tools.keys()].sort(), [
      "background_command_cancel",
      "background_command_output",
      "background_command_start",
      "background_command_status",
    ]);
    await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);
    assert.equal(typeof currentEditorFactory, "function");
    assert.equal(notifications.length, 0);

    handlers.get("tool_execution_start")?.({
      type: "tool_execution_start",
      toolName: "bash",
      toolCallId: "bash-lifecycle",
      args: { command: "npm test" },
    }, ctx);
    handlers.get("tool_execution_update")?.({
      type: "tool_execution_update",
      toolName: "bash",
      toolCallId: "bash-lifecycle",
      partialResult: { content: [{ type: "text", text: "running" }] },
    }, ctx);

    assert.ok(componentFactory);
    const component = componentFactory(fakeTui, powerlineTheme);
    assert.ok(component.render(80).some((line) => line.includes("npm test")));

    handlers.get("tool_execution_end")?.({
      type: "tool_execution_end",
      toolName: "bash",
      toolCallId: "bash-lifecycle",
    }, ctx);
    assert.deepEqual(component.render(80), []);

    await handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" }, ctx);
    assert.equal(currentEditorFactory, undefined);
    assert.equal(unregistered, true);
    assert.equal(sentMessages.length, 0);
    assert.ok(renderRequests > 0);
  } finally {
    const holder = globals[managerSymbol] as { manager?: { shutdown?: () => Promise<void> } } | undefined;
    await holder?.manager?.shutdown?.();
    delete globals[hostSymbol];
    delete globals[managerSymbol];
  }
});
