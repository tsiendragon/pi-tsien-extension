import { initTheme } from "@earendil-works/pi-coding-agent";
import {
  KeybindingsManager,
  TUI_KEYBINDINGS,
  stripTerminalSequences,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { openConversationWorkbench } from "../../../extensions/subagent-workbench/src/conversation-workbench.ts";
import { WorkbenchRuntimeHost } from "../../../extensions/subagent-workbench/src/runtime.ts";

beforeAll(() => initTheme("dark"));

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

function openView(runtime: WorkbenchRuntimeHost, initialTargetId: string) {
  let component: any;
  let customOptions: any;
  const ctx = {
    cwd: process.cwd(),
    model: { provider: "test", id: "model" },
    ui: {
      notify: vi.fn(),
      input: vi.fn(),
      custom: async (factory: any, options: any) => {
        customOptions = options;
        return new Promise<void>((resolve) => {
          component = factory(
            { requestRender: vi.fn(), terminal: { rows: 30 } },
            theme,
            new KeybindingsManager(TUI_KEYBINDINGS),
            resolve,
          );
          component.focused = true;
        });
      },
    },
  };
  const promise = openConversationWorkbench(ctx as any, runtime, vi.fn(), {
    initialTargetId,
  });
  return {
    get component() {
      return component;
    },
    get customOptions() {
      return customOptions;
    },
    promise,
  };
}

describe("Conversation Workbench full-screen routes", () => {
  it("renders a direct Subagent with an inline Follow-up input", async () => {
    const runtime = new WorkbenchRuntimeHost();
    const commands: any[] = [];
    runtime.setCommandHandler(async (command) => {
      commands.push(command);
      return {
        ok: true,
        accepted: "queued",
        sessionId: "session-direct",
      };
    });
    runtime.upsertConversation({
      id: "session-direct",
      label: "Source review",
      status: "completed",
      availability: "ready",
      updatedAt: Date.now(),
      activeRunId: null,
      provider: "test-provider",
      model: "test-model",
      thinkingLevel: "high",
      messages: [
        {
          id: "message-1",
          runId: "run-1",
          role: "assistant",
          text: "Review complete.",
          createdAt: Date.now(),
        },
      ],
      timeline: [
        {
          id: "user-1",
          runId: "run-1",
          type: "user",
          text: "Review the source",
          createdAt: Date.now(),
        },
        {
          id: "assistant-1",
          runId: "run-1",
          type: "assistant",
          content: [
            { type: "thinking", thinking: "Inspecting files" },
            { type: "text", text: "I will inspect README." },
          ],
          createdAt: Date.now(),
          streaming: false,
          provider: "test",
          model: "model",
        },
        {
          id: "tool-1",
          runId: "run-1",
          type: "tool",
          toolCallId: "call-1",
          name: "read",
          args: { path: "README.md" },
          output: {
            content: [{ type: "text", text: "README content" }],
          },
          status: "completed",
          createdAt: Date.now(),
        },
      ],
    });

    const view = openView(runtime, "session-direct");
    const rendered = view.component.render(100);
    expect(view.customOptions).toEqual({ fullscreen: true });
    expect(rendered.length).toBeGreaterThan(5);
    const plain = rendered.map(stripTerminalSequences).join("\n");
    expect(plain).toContain("Subagent · Source review");
    expect(plain).toContain("Inspecting files");
    expect(plain).toContain("read README.md");
    expect(plain).toContain("test-model • high");
    expect(plain).toContain("Enter send/queue");
    expect(rendered.every((line: string) => visibleWidth(line) <= 100)).toBe(
      true,
    );

    for (const character of "continue") view.component.handleInput(character);
    view.component.handleInput("\r");
    await vi.waitFor(() => {
      expect(commands).toContainEqual({
        type: "send-agent",
        sessionId: "session-direct",
        message: "continue",
      });
    });

    view.component.handleInput("\u001b");
    await view.promise;
    runtime.dispose();
  });

  it("renders a Workflow and its child Agent as read-only full-screen views", async () => {
    const runtime = new WorkbenchRuntimeHost();
    runtime.setCommandHandler(async () => ({ ok: true }));
    runtime.upsertConversation({
      id: "session-child",
      label: "Sample analysis",
      status: "running",
      workflowId: "workflow-1",
      updatedAt: Date.now(),
      activeRunId: "run-child",
      provider: "workflow-provider",
      model: "workflow-model",
      thinkingLevel: "medium",
      messages: [
        {
          id: "message-child",
          runId: "run-child",
          role: "assistant",
          text: "Processing samples…",
          createdAt: Date.now(),
        },
      ],
    });
    runtime.upsertWorkflow({
      id: "workflow-1",
      label: "Router evaluation",
      status: "running",
      updatedAt: Date.now(),
      currentStage: 0,
      stages: [
        {
          id: "stage-1",
          label: "Analyze",
          status: "running",
          tasks: [
            {
              id: "task-1",
              label: "Sample analysis",
              status: "running",
              sessionId: "session-child",
              runId: "run-child",
            },
          ],
        },
      ],
    });

    const view = openView(runtime, "workflow-1");
    let rendered = view.component.render(110);
    expect(rendered.length).toBeGreaterThan(5);
    expect(rendered.join("\n")).toContain("Workflow · Router evaluation");
    expect(rendered.join("\n")).toContain(
      "workflow-provider/workflow-model · effort medium",
    );
    expect(rendered.join("\n")).toContain(" running 1");
    expect(rendered.join("\n")).not.toContain("Follow-up");

    view.component.handleInput("\r");
    rendered = view.component.render(110);
    expect(rendered.join("\n")).toContain("Workflow Agent · Sample analysis");
    expect(rendered.join("\n")).toContain("read-only");
    expect(rendered.map(stripTerminalSequences).join("\n")).toContain(
      "workflow-model • medium",
    );
    expect(rendered.join("\n")).not.toContain("Follow-up");

    view.component.handleInput("\u001b");
    expect(view.component.render(110).join("\n")).toContain(
      "Workflow · Router evaluation",
    );
    view.component.handleInput("\u001b");
    await view.promise;
    runtime.dispose();
  });
});
