import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_TRANSCRIPT_WINDOW,
  resolveTranscriptWindowConfig,
} from "pi-tsien-session-ui-fork/src/transcript-window/config.ts";
import { TranscriptWindowController } from "pi-tsien-session-ui-fork/src/transcript-window/controller.ts";
import { installInteractiveTranscriptPatch } from "pi-tsien-session-ui-fork/src/transcript-window/interactive-patch.ts";
import { selectTranscriptWindow } from "pi-tsien-session-ui-fork/src/transcript-window/turns.ts";

function turn(id) {
  return [
    { role: "user", id: "user-" + id },
    { role: "assistant", id: "assistant-" + id },
    { role: "toolResult", id: "result-" + id },
  ];
}

function idleContext(notifications = []) {
  return {
    isIdle: () => true,
    ui: {
      notify(message, type) {
        notifications.push({ message, type });
      },
    },
  };
}

test("resolves project transcript-window fields over global fields", () => {
  const config = resolveTranscriptWindowConfig(
    {
      transcriptWindow: {
        enabled: false,
        recentTurns: 40,
        hideHistoricalTools: false,
      },
    },
    {
      transcriptWindow: {
        recentTurns: 5,
        hideHistoricalThinking: false,
      },
    },
  );

  assert.deepEqual(config, {
    enabled: false,
    recentTurns: 5,
    hideHistoricalTools: false,
    hideHistoricalThinking: false,
  });
});

test("falls back safely for invalid configuration values", () => {
  const config = resolveTranscriptWindowConfig(
    {
      transcriptWindow: {
        enabled: "yes",
        recentTurns: 0,
        hideHistoricalTools: 1,
        hideHistoricalThinking: null,
      },
    },
    {},
  );

  assert.deepEqual(config, DEFAULT_TRANSCRIPT_WINDOW);
});

test("keeps only the requested suffix of complete user-started turns", () => {
  const items = [
    ...turn(1),
    { type: "custom", id: "old-custom" },
    ...turn(2),
    ...turn(3),
  ];
  const selection = selectTranscriptWindow(items, 2);

  assert.equal(selection.hiddenTurns, 1);
  assert.deepEqual(selection.visibleItems, [
    { role: "user", id: "user-2" },
    { role: "assistant", id: "assistant-2" },
    { role: "toolResult", id: "result-2" },
    { role: "user", id: "user-3" },
    { role: "assistant", id: "assistant-3" },
    { role: "toolResult", id: "result-3" },
  ]);
});

test("preserves a transcript with no user messages", () => {
  const items = [
    { role: "assistant", id: "startup" },
    { type: "custom", id: "notice" },
  ];
  assert.deepEqual(selectTranscriptWindow(items, 1), {
    visibleItems: items,
    hiddenTurns: 0,
  });
});

test("commands change only process-local view state", async () => {
  const controller = new TranscriptWindowController(() => ({
    ...DEFAULT_TRANSCRIPT_WINDOW,
  }));
  controller.onSessionStart("/repo");
  const rebuilt = [];
  controller.onInteractiveMode({
    rebuildChatFromMessages() {
      rebuilt.push("rebuilt");
    },
  });

  const notifications = [];
  const ctx = idleContext(notifications);

  await controller.handleCommand("expand", ctx);
  assert.equal(controller.getStatus().effectiveRecentTurns, null);

  await controller.handleCommand("collapse", ctx);
  assert.equal(controller.getStatus().effectiveRecentTurns, 20);

  await controller.handleCommand("turns 5", ctx);
  assert.equal(controller.getStatus().effectiveRecentTurns, 5);

  await controller.handleCommand("turns 0", ctx);
  assert.equal(controller.getStatus().effectiveRecentTurns, 5);
  assert.equal(rebuilt.length, 3);
  assert.equal(notifications.at(-1).type, "warning");
});

test("refreshes the transcript after a newly completed turn exceeds the window", () => {
  const controller = new TranscriptWindowController(() => ({
    ...DEFAULT_TRANSCRIPT_WINDOW,
    recentTurns: 1,
  }));
  controller.onSessionStart("/repo");
  const rebuilt = [];
  controller.onInteractiveMode({
    rebuildChatFromMessages() {
      rebuilt.push("rebuilt");
    },
  });
  const entries = [
    { type: "message", message: { role: "user" } },
    { type: "message", message: { role: "assistant" } },
    { type: "message", message: { role: "user" } },
  ];

  controller.onAgentSettled(entries);
  assert.equal(rebuilt.length, 1);

  controller.onAgentSettled(entries.slice(0, 2));
  assert.equal(rebuilt.length, 1);
});

test("the renderer patch inserts one notice and never sends old turns to Pi", () => {
  const controller = new TranscriptWindowController(() => ({
    ...DEFAULT_TRANSCRIPT_WINDOW,
    recentTurns: 1,
  }));
  controller.onSessionStart("/repo");

  const prototype = {
    renderSessionItems(items) {
      this.receivedItems = items;
      return items.length;
    },
  };
  const restore = installInteractiveTranscriptPatch(controller, prototype);
  const children = [];
  const mode = {
    chatContainer: {
      addChild(component) {
        children.push(component);
      },
    },
    ui: { requestRender() {} },
  };
  const items = [...turn(1), ...turn(2)];

  assert.equal(prototype.renderSessionItems.call(mode, items), 3);
  assert.deepEqual(mode.receivedItems, turn(2));
  assert.equal(children.length, 2);

  restore();
  assert.notEqual(prototype.renderSessionItems.name, "wrappedRenderSessionItems");
});

test("the renderer patch declines an unsupported Pi prototype", () => {
  const controller = new TranscriptWindowController();
  const restore = installInteractiveTranscriptPatch(controller, {});
  assert.doesNotThrow(restore);
});
