import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import subagentWorkbench from "../../../extensions/subagent-workbench/src/index.ts";
import { WorkbenchController } from "../../../extensions/subagent-workbench/src/workbench-controller.ts";
import {
  WORKBENCH_RUNTIME_SYMBOL,
  uninstallWorkbenchRuntime,
} from "../../../extensions/subagent-workbench/src/runtime.ts";

beforeAll(() => initTheme("dark"));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  uninstallWorkbenchRuntime();
});

describe("Pi extension", () => {
  it("registers multi_tool_use.parallel only inside child processes", () => {
    vi.stubEnv("PI_SUBAGENT_WORKBENCH_CHILD", "1");
    const tools = new Map<string, any>();
    const pi = {
      on: vi.fn(),
      registerCommand: vi.fn(),
      registerTool: vi.fn((tool: any) => tools.set(tool.name, tool)),
    };

    subagentWorkbench(pi as any);

    expect(tools.has("multi_tool_use_parallel")).toBe(true);
    expect(tools.has("subagent_start")).toBe(false);
    expect(tools.has("subagent_workflow")).toBe(false);
  });

  it("registers the command, installs runtime v1, renders status, and closes safely", async () => {
    const commands = new Map<string, any>();
    const tools = new Map<string, any>();
    const handlers = new Map<string, Array<(...args: any[]) => void>>();
    const pi = {
      on: vi.fn((event: string, handler: (...args: any[]) => void) => {
        const list = handlers.get(event) ?? [];
        list.push(handler);
        handlers.set(event, list);
      }),
      registerCommand: vi.fn((name: string, command: any) => {
        commands.set(name, command);
      }),
      registerTool: vi.fn((tool: any) => {
        tools.set(tool.name, tool);
      }),
    };

    subagentWorkbench(pi as any);

    expect(commands.has("subagent-workbench")).toBe(true);
    expect(tools.has("subagent_start")).toBe(true);
    expect(tools.has("subagent_workflow")).toBe(true);
    expect(tools.has("subagent_workflow_control")).toBe(true);
    expect(
      (globalThis as Record<PropertyKey, any>)[WORKBENCH_RUNTIME_SYMBOL]
        ?.apiVersion,
    ).toBe(1);

    let rendered: string[] = [];
    const command = commands.get("subagent-workbench");
    await command.handler("status", {
      mode: "tui",
      ui: {
        notify: vi.fn(),
        custom: async (factory: any) => {
          await new Promise<void>((resolve) => {
            const component = factory(
              { requestRender: vi.fn() },
              {
                fg: (_color: string, text: string) => text,
                bold: (text: string) => text,
              },
              {},
              resolve,
            );
            rendered = component.render(100);
            component.handleInput("q");
          });
        },
      },
    });

    expect(rendered.join("\n")).toContain("Subagent Workbench · Status");
    expect(rendered.join("\n")).toContain("active 0/4");

    for (const handler of handlers.get("session_shutdown") ?? []) {
      await handler();
    }
  });

  it("returns immediately for default-background Agent and Workflow tools", async () => {
    const handlers = new Map<string, Array<(...args: any[]) => any>>();
    const tools = new Map<string, any>();
    const agentRun = new Promise<any>(() => {});
    const workflowRun = new Promise<any>(() => {});
    const submitAgent = vi
      .spyOn(WorkbenchController.prototype, "submitAgent")
      .mockReturnValue({
        handle: { workId: "work-agent", kind: "agent", status: "queued", background: true },
        completion: agentRun,
      });
    const submitWorkflow = vi
      .spyOn(WorkbenchController.prototype, "submitWorkflow")
      .mockReturnValue({
        handle: { workId: "work-workflow", kind: "workflow", status: "queued", background: true },
        completion: workflowRun,
      });
    const pi = {
      on: vi.fn((event: string, handler: (...args: any[]) => any) => {
        const list = handlers.get(event) ?? [];
        list.push(handler);
        handlers.set(event, list);
      }),
      registerCommand: vi.fn(),
      registerTool: vi.fn((tool: any) => tools.set(tool.name, tool)),
    };
    subagentWorkbench(pi as any);
    const ctx = {
      cwd: process.cwd(),
      hasUI: false,
      ui: { notify: vi.fn() },
    };
    const signal = new AbortController().signal;

    const agentResult = await tools
      .get("subagent_start")
      .execute(
        "agent-call",
        { task: "background task" },
        signal,
        undefined,
        ctx,
      );
    expect(agentResult).toMatchObject({
      details: {
        status: "queued",
        background: true,
        workId: "work-agent",
      },
    });
    expect(submitAgent).toHaveBeenCalledWith(
      expect.objectContaining({ signal: undefined }),
      true,
    );

    const workflowResult = await tools
      .get("subagent_workflow")
      .execute(
        "workflow-call",
        {
          stages: [{ tasks: [{ task: "background workflow task" }] }],
        },
        signal,
        undefined,
        ctx,
      );
    expect(workflowResult).toMatchObject({
      details: {
        status: "queued",
        background: true,
        workId: "work-workflow",
      },
    });
    expect(submitWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({ signal: undefined }),
      true,
    );

    for (const handler of handlers.get("session_shutdown") ?? []) {
      await handler();
    }
  });

  it("saves and reuses a project workflow through the public tool", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "workflow-tool-"));
    const handlers = new Map<string, Array<(...args: any[]) => any>>();
    const tools = new Map<string, any>();
    let sequence = 0;
    const submitWorkflow = vi
      .spyOn(WorkbenchController.prototype, "submitWorkflow")
      .mockImplementation(() => ({
        handle: {
          workId: `work-saved-${++sequence}`,
          kind: "workflow",
          status: "queued",
          background: true,
        },
        completion: new Promise<any>(() => {}),
      }));
    const pi = {
      on: vi.fn((event: string, handler: (...args: any[]) => any) => {
        const list = handlers.get(event) ?? [];
        list.push(handler);
        handlers.set(event, list);
      }),
      registerCommand: vi.fn(),
      registerTool: vi.fn((tool: any) => tools.set(tool.name, tool)),
    };
    subagentWorkbench(pi as any);
    const ctx = { cwd, hasUI: false, ui: { notify: vi.fn() } };
    const signal = new AbortController().signal;

    try {
      const saved = await tools.get("subagent_workflow").execute(
        "save-workflow",
        {
          label: "Saved review",
          saveAs: "review-flow",
          stages: [
            {
              tasks: [
                { key: "review", task: "Review implementation" },
              ],
            },
          ],
        },
        signal,
        undefined,
        ctx,
      );
      const expectedPath = path.join(
        cwd,
        ".pi",
        "workflows",
        "review-flow.json",
      );
      expect(saved.details.savedPath).toBe(expectedPath);
      expect(JSON.parse(await readFile(expectedPath, "utf8"))).toMatchObject({
        version: 1,
        label: "Saved review",
      });

      await tools.get("subagent_workflow").execute(
        "reuse-workflow",
        { name: "review-flow" },
        signal,
        undefined,
        ctx,
      );
      expect(submitWorkflow).toHaveBeenLastCalledWith(
        expect.objectContaining({
          label: "Saved review",
          stages: [
            expect.objectContaining({
              tasks: [
                expect.objectContaining({
                  key: "review",
                  task: "Review implementation",
                }),
              ],
            }),
          ],
        }),
        true,
      );
    } finally {
      for (const handler of handlers.get("session_shutdown") ?? []) {
        await handler();
      }
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("registers result collection and cancellation tools for background work", async () => {
    const tools = new Map<string, any>();
    const pi = {
      on: vi.fn(),
      registerCommand: vi.fn(),
      registerTool: vi.fn((tool: any) => tools.set(tool.name, tool)),
    };
    const query = {
      completed: [
        {
          workId: "work-complete",
          kind: "agent",
          label: "Complete worker",
          status: "completed",
          background: true,
          createdAt: Date.now(),
          result: { output: "final result" },
        },
        {
          workId: "work-workflow-complete",
          kind: "workflow",
          label: "Complete workflow",
          status: "completed",
          background: true,
          createdAt: Date.now(),
          result: {
            workflowId: "workflow-complete",
            label: "Complete workflow",
            status: "completed",
            stages: [
              {
                id: "stage-1",
                label: "Synthesize",
                status: "completed",
                tasks: [
                  {
                    id: "task-1",
                    key: "summary",
                    label: "Summary",
                    status: "completed",
                    output: "workflow final result",
                  },
                ],
              },
            ],
          },
        },
      ],
      pending: [],
      missing: [],
    };
    const collect = vi.spyOn(WorkbenchController.prototype, "collectJobs").mockReturnValue(query as any);
    const cancel = vi.spyOn(WorkbenchController.prototype, "cancelJob").mockReturnValue({
      workId: "work-running",
      kind: "agent",
      label: "Running worker",
      status: "running",
      background: true,
      createdAt: Date.now(),
    } as any);
    subagentWorkbench(pi as any);

    expect(tools.has("subagent_results")).toBe(true);
    expect(tools.has("subagent_cancel")).toBe(true);
    expect(tools.has("subagent_workflow_control")).toBe(true);
    const ctx = { cwd: process.cwd(), hasUI: false, ui: { notify: vi.fn() } };
    const results = await tools.get("subagent_results").execute(
      "results-call",
      {
        workIds: ["work-complete", "work-workflow-complete"],
        mode: "collect",
      },
      new AbortController().signal,
      undefined,
      ctx,
    );
    expect(results.content[0].text).toContain("final result");
    expect(results.content[0].text).toContain("workflow final result");
    expect(collect).toHaveBeenCalledWith([
      "work-complete",
      "work-workflow-complete",
    ]);

    const cancelled = await tools.get("subagent_cancel").execute(
      "cancel-call",
      { workIds: ["work-running"] },
      new AbortController().signal,
      undefined,
      ctx,
    );
    expect(cancelled.details.cancelled).toEqual([
      { workId: "work-running", status: "running" },
    ]);
    expect(cancel).toHaveBeenCalledWith("work-running", undefined);
  });

  it("opens the Conversation Switcher and exits to Main without starting a process", async () => {
    const commands = new Map<string, any>();
    const handlers = new Map<string, Array<(...args: any[]) => any>>();
    const pi = {
      on: vi.fn((event: string, handler: (...args: any[]) => any) => {
        const list = handlers.get(event) ?? [];
        list.push(handler);
        handlers.set(event, list);
      }),
      registerCommand: vi.fn((name: string, command: any) => {
        commands.set(name, command);
      }),
      registerTool: vi.fn(),
    };
    subagentWorkbench(pi as any);

    let rendered: string[] = [];
    let narrow: string[] = [];
    let customOptions: any;
    await commands.get("subagent-workbench").handler("open", {
      mode: "tui",
      cwd: process.cwd(),
      model: { provider: "test", id: "model" },
      ui: {
        notify: vi.fn(),
        input: vi.fn(),
        custom: async (factory: any, options: any) => {
          customOptions = options;
          return new Promise((resolve) => {
            const component = factory(
              { requestRender: vi.fn(), terminal: { rows: 30 } },
              {
                fg: (_color: string, text: string) => text,
                bold: (text: string) => text,
              },
              {},
              resolve,
            );
            rendered = component.render(100);
            narrow = component.render(10);
            component.handleInput("q");
          });
        },
      },
    });

    expect(customOptions).toEqual({ fullscreen: true });
    expect(rendered.length).toBeGreaterThan(5);
    expect(rendered.join("\n")).toContain("Subagent Workbench · revision");
    expect(rendered.join("\n")).toContain("Main");
    expect(narrow.every((line) => visibleWidth(line) <= 10)).toBe(true);
    const runtime = (globalThis as Record<PropertyKey, any>)[
      WORKBENCH_RUNTIME_SYMBOL
    ];
    expect(runtime.getSnapshot().conversations.total).toBe(0);
    for (const handler of handlers.get("session_shutdown") ?? []) {
      await handler();
    }
  });

  it("renders a focusable one-line task navigator above the editor", async () => {
    const handlers = new Map<string, Array<(...args: any[]) => any>>();
    let widgetFactory: any;
    let terminalInput: ((data: string) => any) | undefined;
    let fullScreenRendered = "";
    let editorText = "";
    const requestRender = vi.fn();
    const setWidget = vi.fn((_key: string, content: any) => {
      if (typeof content === "function") widgetFactory = content;
    });
    const pi = {
      on: vi.fn((event: string, handler: (...args: any[]) => any) => {
        const list = handlers.get(event) ?? [];
        list.push(handler);
        handlers.set(event, list);
      }),
      registerCommand: vi.fn(),
      registerTool: vi.fn(),
    };
    subagentWorkbench(pi as any);

    for (const handler of handlers.get("session_start") ?? []) {
      await handler(
        {},
        {
          hasUI: true,
          ui: {
            notify: vi.fn(),
            input: vi.fn(),
            custom: async (factory: any) =>
              new Promise<void>((resolve) => {
                const fullScreen = factory(
                  { requestRender, terminal: { rows: 30 } },
                  {
                    fg: (_color: string, text: string) => text,
                    bg: (_color: string, text: string) => text,
                    bold: (text: string) => text,
                  },
                  {},
                  resolve,
                );
                fullScreenRendered = fullScreen.render(100).join("\n");
                fullScreen.handleInput("\u001b");
              }),
            setWidget,
            getEditorText: () => editorText,
            onTerminalInput: (handler: (data: string) => any) => {
              terminalInput = handler;
              return vi.fn();
            },
          },
        },
      );
    }
    expect(setWidget).toHaveBeenCalledWith(
      "subagent-workbench-navigation",
      expect.any(Function),
      { placement: "aboveStatus" },
    );
    const component = widgetFactory(
      { requestRender },
      {
        fg: (_color: string, text: string) => text,
        bg: (_color: string, text: string) => text,
      },
    );
    const runtime = (globalThis as Record<PropertyKey, any>)[
      WORKBENCH_RUNTIME_SYMBOL
    ];
    runtime.upsertConversation({
      id: "session-widget",
      label: "Widget agent",
      status: "running",
      updatedAt: Date.now(),
    });
    expect(component.render(100)).toHaveLength(1);
    expect(component.render(100)[0]).toContain("=> Main");
    expect(component.render(100)[0]).toContain("● Widget agent");

    expect(terminalInput?.("\u001b[A")).toBeUndefined();
    expect(component.render(100)[0]).not.toContain("▸ ● Widget agent");
    expect(terminalInput?.("\u001b[C")).toEqual({ consume: true });
    expect(component.render(100)[0]).toContain("▸ ● Widget agent");
    terminalInput?.("\u001b");

    editorText = "draft";
    expect(terminalInput?.("\u001b[C")).toBeUndefined();
    expect(component.render(100)[0]).not.toContain("▸ ● Widget agent");
    editorText = "";

    terminalInput?.("\u001b[17~");
    expect(component.render(100)[0]).toContain("▸ ● Widget agent");
    terminalInput?.("\r");
    await vi.waitFor(() => {
      expect(fullScreenRendered).toContain("Subagent · Widget agent");
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    terminalInput?.("\u001b[17~");
    runtime.upsertConversation({
      id: "session-widget",
      label: "Widget agent",
      status: "completed",
      updatedAt: Date.now(),
    });
    terminalInput?.("x");
    expect(component.render(100)).toEqual([]);
    for (const handler of handlers.get("session_shutdown") ?? []) {
      await handler();
    }
  });
});
