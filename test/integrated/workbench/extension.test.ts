import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import subagentWorkbench, {
  projectLiveFeatureSnapshot,
} from "../../../extensions/subagent-workbench/src/index.ts";
import { WorkbenchController } from "../../../extensions/subagent-workbench/src/workbench-controller.ts";
import {
  loadWorkflowRun,
  saveWorkflowRun,
} from "../../../extensions/subagent-workbench/src/workflow-run-store.ts";
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
  it("projects only workbench summaries to live-session feature snapshots", () => {
    const projected = projectLiveFeatureSnapshot(
      {
        revision: 7,
        conversations: {
          total: 1,
          running: 1,
          needsAttention: 0,
          completed: 0,
          items: [
            {
              id: "agent-1",
              label: "Agent 1",
              status: "running",
              updatedAt: 1,
              messages: [{ id: "m", runId: "r", role: "assistant", text: "large" }],
              timeline: [{ id: "t", runId: "r", type: "user", text: "large", createdAt: 1 }],
            },
          ],
        },
        workflows: { total: 0, active: 0, failed: 0, items: [] },
        runHealth: { running: 1, stalled: 0 },
        governor: { active: 1, queued: 0, activeLimit: 8, queueLimit: 8, protection: "normal" },
        apiVersion: 1,
        generatedAt: 1,
      } as any,
      9,
    );

    expect(projected.generatedAt).toBe(9);
    expect(projected.conversations.items[0]).not.toHaveProperty("messages");
    expect(projected.conversations.items[0]).not.toHaveProperty("timeline");
    expect(projected.conversations.items[0]).toMatchObject({ id: "agent-1", status: "running" });
  });

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
    expect(rendered.join("\n")).toContain("active 0/8");

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

  it("wakes an idle main Agent when a background job fails", async () => {
    const handlers = new Map<string, Array<(...args: any[]) => any>>();
    const tools = new Map<string, any>();
    const failedJob = {
      workId: "work-failed",
      kind: "agent",
      label: "Failing worker",
      status: "failed",
      background: true,
      createdAt: Date.now(),
      error: "Request exceeds the model context window.",
    } as any;
    vi.spyOn(WorkbenchController.prototype, "pendingJobCompletions").mockReturnValue([
      failedJob,
    ]);
    const markDelivered = vi
      .spyOn(WorkbenchController.prototype, "markJobCompletionDelivered")
      .mockReturnValue(true);
    vi.spyOn(WorkbenchController.prototype, "getJobs").mockReturnValue({
      completed: [failedJob],
      pending: [],
      missing: [],
    } as any);
    const sendMessage = vi.fn();
    const pi = {
      on: vi.fn((event: string, handler: (...args: any[]) => any) => {
        const list = handlers.get(event) ?? [];
        list.push(handler);
        handlers.set(event, list);
      }),
      registerCommand: vi.fn(),
      registerTool: vi.fn((tool: any) => tools.set(tool.name, tool)),
      sendMessage,
    };
    subagentWorkbench(pi as any);
    const ctx = {
      cwd: process.cwd(),
      hasUI: false,
      isIdle: () => true,
      ui: { notify: vi.fn() },
    };
    const signal = new AbortController().signal;

    for (const handler of handlers.get("session_start") ?? []) {
      await handler({}, ctx);
    }
    await tools
      .get("subagent_results")
      .execute("first-query", { mode: "status" }, signal, undefined, ctx);
    await tools
      .get("subagent_results")
      .execute("second-query", { mode: "status" }, signal, undefined, ctx);

    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "subagent-workbench-completion",
        content: expect.stringContaining("Subagent agent failed"),
      }),
      { triggerTurn: true, deliverAs: "followUp" },
    );
    expect(markDelivered).toHaveBeenCalledWith("work-failed");

    for (const handler of handlers.get("session_shutdown") ?? []) {
      await handler();
    }
  });

  it("wakes an idle main Agent for a soft long-running warning", async () => {
    const handlers = new Map<string, Array<(...args: any[]) => any>>();
    const tools = new Map<string, any>();
    const warning = {
      id: "run_warning_1",
      workId: "work-long",
      kind: "workflow",
      label: "Long workflow",
      sessionId: "session-long",
      runId: "run-long",
      workflowId: "workflow-long",
      warning: "idle",
      message: "No RPC progress, but the task is still running.",
      elapsedMs: 700_000,
      idleMs: 600_000,
    } as const;
    vi.spyOn(WorkbenchController.prototype, "pendingRunWarnings").mockReturnValue([
      warning,
    ]);
    const markDelivered = vi
      .spyOn(WorkbenchController.prototype, "markRunWarningDelivered")
      .mockReturnValue(true);
    vi.spyOn(WorkbenchController.prototype, "getJobs").mockReturnValue({
      completed: [],
      pending: [],
      missing: [],
    } as any);
    const sendMessage = vi.fn();
    const notify = vi.fn();
    const pi = {
      on: vi.fn((event: string, handler: (...args: any[]) => any) => {
        const list = handlers.get(event) ?? [];
        list.push(handler);
        handlers.set(event, list);
      }),
      registerCommand: vi.fn(),
      registerTool: vi.fn((tool: any) => tools.set(tool.name, tool)),
      sendMessage,
    };
    subagentWorkbench(pi as any);
    const ctx = {
      cwd: process.cwd(),
      hasUI: true,
      isIdle: () => true,
      ui: { notify },
    };
    const sessionCtx = { ...ctx, hasUI: false };
    const signal = new AbortController().signal;

    for (const handler of handlers.get("session_start") ?? []) {
      await handler({}, sessionCtx);
    }
    await tools
      .get("subagent_results")
      .execute("first-query", { mode: "status" }, signal, undefined, ctx);
    await tools
      .get("subagent_results")
      .execute("second-query", { mode: "status" }, signal, undefined, ctx);

    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "subagent-workbench-run-warning",
        content: expect.stringContaining("The task is still running"),
      }),
      { triggerTurn: true, deliverAs: "followUp" },
    );
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("work-long"),
      "warning",
    );
    expect(markDelivered).toHaveBeenCalledWith("run_warning_1");

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
          parameters: { country: "IQ" },
          stages: [
            {
              tasks: [
                {
                  key: "review",
                  task: "Review {{parameters.country}} implementation",
                  when: "{{parameters.country}} == \"IQ\"",
                  outputSchema: { type: "object" },
                },
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
        parameters: { country: "IQ" },
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
          parameters: { country: "IQ" },
          stages: [
            expect.objectContaining({
              tasks: [
                expect.objectContaining({
                  key: "review",
                  task: "Review {{parameters.country}} implementation",
                  when: "{{parameters.country}} == \"IQ\"",
                  outputSchema: { type: "object" },
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

  it("previews a Workflow without saving or submitting it", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "workflow-dry-run-"));
    const handlers = new Map<string, Array<(...args: any[]) => any>>();
    const tools = new Map<string, any>();
    const submitWorkflow = vi.spyOn(
      WorkbenchController.prototype,
      "submitWorkflow",
    );
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

    try {
      const result = await tools.get("subagent_workflow").execute(
        "dry-run",
        {
          dryRun: true,
          saveAs: "must-not-save",
          parameters: { files: ["a.ts", "b.ts"] },
          stages: [
            {
              label: "Inspect",
              tasks: [
                {
                  key: "inspect",
                  foreach: "{{parameters.files}}",
                  maxItems: 2,
                  task: "Inspect {{item}}",
                },
              ],
            },
          ],
        },
        new AbortController().signal,
        undefined,
        { cwd, hasUI: false, ui: { notify: vi.fn() } },
      );

      expect(result).toMatchObject({
        details: {
          status: "completed",
          dryRun: true,
          preflight: {
            stages: 1,
            taskDefinitions: 1,
            maximumChildTasks: 2,
          },
        },
      });
      expect(result.content[0].text).toContain("foreach<=2");
      expect(submitWorkflow).not.toHaveBeenCalled();
      await expect(
        readFile(path.join(cwd, ".pi", "workflows", "must-not-save.json")),
      ).rejects.toThrow();
    } finally {
      for (const handler of handlers.get("session_shutdown") ?? []) {
        await handler();
      }
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("wraps one task and compiles restricted JavaScript plans for dry-run", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "workflow-auto-tool-"));
    const handlers = new Map<string, Array<(...args: any[]) => any>>();
    const tools = new Map<string, any>();
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

    try {
      const single = await tools.get("subagent_workflow").execute(
        "single-workflow",
        { task: "inspect one file", dryRun: true },
        new AbortController().signal,
        undefined,
        ctx,
      );
      expect(single.details.preflight).toMatchObject({
        stages: 1,
        taskDefinitions: 1,
      });

      const generated = await tools.get("subagent_workflow").execute(
        "javascript-workflow",
        {
          dryRun: true,
          parameters: { files: ["a.ts", "b.ts"] },
          javascript:
            'const stage = workflow.stage("Inspect"); for (const file of parameters.files) stage.task({ key: file.replace(".", "_"), task: "Inspect " + file });',
        },
        new AbortController().signal,
        undefined,
        ctx,
      );
      expect(generated.details.preflight).toMatchObject({
        stages: 1,
        taskDefinitions: 2,
      });
    } finally {
      for (const handler of handlers.get("session_shutdown") ?? []) {
        await handler();
      }
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("persists explicit run records and retries a full record across sessions", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "workflow-record-"));
    const handlers = new Map<string, Array<(...args: any[]) => any>>();
    const tools = new Map<string, any>();
    const definition = {
      version: 1 as const,
      label: "Persistent",
      stages: [{ tasks: [{ key: "inspect", task: "inspect" }] }],
    };
    const completed = {
      workflowId: "workflow_persisted",
      label: "Persistent",
      status: "completed" as const,
      attempt: 1,
      stages: [
        {
          id: "stage-1",
          label: "Stage 1",
          status: "completed" as const,
          tasks: [
            {
              id: "task-1",
              key: "inspect",
              label: "Inspect",
              status: "completed" as const,
              output: "sensitive output",
            },
          ],
        },
      ],
    };
    vi.spyOn(WorkbenchController.prototype, "submitWorkflow").mockReturnValue({
      handle: {
        workId: "work_metadata_public",
        kind: "workflow",
        status: "queued",
        background: false,
      },
      completion: Promise.resolve(completed),
    });
    let rejectRetry!: (error: Error) => void;
    const retryCompletion = new Promise<any>((_resolve, reject) => {
      rejectRetry = reject;
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const retryFromResult = vi
      .spyOn(WorkbenchController.prototype, "retryWorkflowFromResult")
      .mockReturnValue({
        handle: {
          workId: "work_cross_session_retry",
          kind: "workflow",
          status: "queued",
          background: true,
        },
        completion: retryCompletion,
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
    const ctx = { cwd, hasUI: false, ui: { notify: vi.fn() } };

    try {
      const recorded = await tools.get("subagent_workflow").execute(
        "record-run",
        {
          background: false,
          record: "metadata",
          label: definition.label,
          stages: definition.stages,
        },
        new AbortController().signal,
        undefined,
        ctx,
      );
      expect(recorded.details).toMatchObject({
        status: "completed",
        runRecordPath: path.join(
          cwd,
          ".pi",
          "workflow-runs",
          "work_metadata_public.json",
        ),
      });
      const metadata = await loadWorkflowRun(cwd, "work_metadata_public");
      expect(metadata.mode).toBe("metadata");
      expect(JSON.stringify(metadata)).not.toContain("sensitive output");

      await saveWorkflowRun(
        cwd,
        "work_persisted_source",
        "full",
        definition,
        completed,
      );
      const retried = await tools.get("subagent_workflow_control").execute(
        "retry-persisted",
        { action: "retry", workId: "work_persisted_source" },
        new AbortController().signal,
        undefined,
        ctx,
      );
      expect(retried).toMatchObject({
        details: {
          status: "queued",
          sourceWorkId: "work_persisted_source",
          workId: "work_cross_session_retry",
          retryRecordPath: path.join(
            cwd,
            ".pi",
            "workflow-runs",
            "work_cross_session_retry.json",
          ),
        },
      });
      expect(retryFromResult).toHaveBeenCalledWith(
        "work_persisted_source",
        expect.objectContaining({
          label: "Persistent",
          stages: [
            expect.objectContaining({
              tasks: [expect.objectContaining({ key: "inspect" })],
            }),
          ],
        }),
        completed,
        { parentToolCallId: "retry-persisted" },
      );
      rejectRetry(new Error("cancelled after Session shutdown"));
      await Promise.resolve();
      await Promise.resolve();
      expect(ctx.ui.notify).not.toHaveBeenCalled();
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining("Workflow retry record failed"),
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
