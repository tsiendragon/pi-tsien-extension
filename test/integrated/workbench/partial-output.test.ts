import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import subagentWorkbench from "pi-tsien-subagent-workbench/src/index.ts";
import { PiRpcProcessProvider } from "pi-tsien-subagent-workbench/src/providers/pi-rpc-process-provider.ts";
import {
  uninstallWorkbenchRuntime,
  WorkbenchRuntimeHost,
} from "pi-tsien-subagent-workbench/src/runtime.ts";
import { ModelRouter } from "pi-tsien-subagent-workbench/src/model-router.ts";
import {
  PARTIAL_OUTPUT_MAX_CHARS,
  WorkbenchController,
} from "pi-tsien-subagent-workbench/src/workbench-controller.ts";

process.env.PI_SUBAGENT_SESSION_DIR = "off";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, "fixtures/fake-pi-rpc.mjs");
const controllers: WorkbenchController[] = [];

function setup(): { runtime: WorkbenchRuntimeHost; controller: WorkbenchController } {
  const runtime = new WorkbenchRuntimeHost({ activeLimit: 4, queueLimit: 8 });
  const provider = new PiRpcProcessProvider({
    executable: process.execPath,
    baseArgs: [fixture],
    commandTimeoutMs: 2_000,
    startupTimeoutMs: 2_000,
    runTimeoutMs: 5_000,
    shutdownTimeoutMs: 500,
    heartbeatIntervalMs: 50,
  });
  const controller = new WorkbenchController(runtime, {
    provider,
    router: new ModelRouter({
      configPath: path.join(here, "missing-subagent-models.json"),
      environment: { PI_SUBAGENT_EXECUTION_MODEL: "fake/fake-rpc" },
    }),
    jobLedger: null,
  });
  controllers.push(controller);
  return { runtime, controller };
}

/** Streams text for marked tasks, then waits for abort or fails; others run normally. */
function scriptProvider(controller: WorkbenchController): void {
  const originalRun = controller.provider.run.bind(controller.provider);
  vi.spyOn(controller.provider, "run").mockImplementation(async (request) => {
    const stream = /STREAM\[([^\]]*)\]/.exec(request.task)?.[1];
    if (stream === undefined) return originalRun(request);
    request.emit({ type: "assistant-start" } as any);
    request.emit({ type: "assistant-delta", block: "thinking", contentIndex: 0, delta: "HIDDEN_THINKING" });
    request.emit({ type: "message", text: stream });
    if (request.task.includes("FAIL")) throw new Error("synthetic task failure");
    await new Promise<void>((_resolve, reject) => {
      const abort = () => reject(new Error("Cancelled by user."));
      if (request.signal.aborted) abort();
      request.signal.addEventListener("abort", abort, { once: true });
    });
    throw new Error("unreachable");
  });
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  uninstallWorkbenchRuntime();
  await Promise.all(controllers.splice(0).map((controller) => controller.dispose()));
});

describe("WorkbenchController partial output", () => {
  it("returns bounded assistant text for a running agent without its prompt", async () => {
    const { controller } = setup();
    scriptProvider(controller);
    const longText = `${"x".repeat(500)}LATEST_TAIL`;
    const submission = controller.submitAgent({
      task: `PROMPT_SECRET STREAM[${longText}]`,
      label: "Streaming agent",
      cwd: process.cwd(),
    });
    submission.completion.catch(() => undefined);

    await vi.waitFor(() => {
      expect(controller.partialJobOutput(submission.handle.workId)?.sources).toHaveLength(1);
    });
    const partial = controller.partialJobOutput(submission.handle.workId, 200)!;
    expect(partial).toMatchObject({ kind: "agent", status: "running", omittedSources: 0 });
    const [source] = partial.sources;
    expect(source).toMatchObject({ label: "Streaming agent", streaming: true, truncated: true });
    expect(source!.text.length).toBeLessThanOrEqual(200);
    expect(source!.text.endsWith("LATEST_TAIL")).toBe(true);
    expect(JSON.stringify(partial)).not.toContain("PROMPT_SECRET");
    expect(JSON.stringify(partial)).not.toContain("HIDDEN_THINKING");

    // Out-of-range budgets are clamped to the hard maximum.
    expect(
      controller.partialJobOutput(submission.handle.workId, 1e9)!.sources[0]!.text.length,
    ).toBeLessThanOrEqual(PARTIAL_OUTPUT_MAX_CHARS);

    controller.cancelJob(submission.handle.workId);
    await vi.waitFor(() => {
      expect(controller.getJobs([submission.handle.workId]).completed[0]?.status).toBe(
        "cancelled",
      );
    });
    expect(controller.partialJobOutput(submission.handle.workId)?.sources[0]?.text).toContain(
      "LATEST_TAIL",
    );
  });

  it("returns nothing for completed or unknown jobs", async () => {
    const { controller } = setup();
    const submission = controller.submitAgent({
      task: "retained-result",
      label: "Done",
      cwd: process.cwd(),
    });
    await submission.completion;
    expect(controller.partialJobOutput(submission.handle.workId)).toBeUndefined();
    expect(controller.partialJobOutput("work_missing")).toBeUndefined();
  });

  it("shows failed workflow task text but never unrelated sessions or finished siblings", async () => {
    const { runtime, controller } = setup();
    scriptProvider(controller);
    await runtime.dispatch({
      type: "start-agent",
      task: "STREAM[UNRELATED_SECRET]",
      label: "Unrelated",
      cwd: process.cwd(),
    });
    await vi.waitFor(() => {
      expect(
        runtime
          .getSnapshot()
          .conversations.items.find((item) => item.label === "Unrelated")
          ?.messages?.some((message) => message.text.includes("UNRELATED_SECRET")),
      ).toBe(true);
    });

    const submission = controller.submitWorkflow({
      label: "Partial workflow",
      cwd: process.cwd(),
      stages: [
        {
          tasks: [
            { key: "ok", label: "Fine task", task: "sibling-finished", cwd: process.cwd() },
            { key: "bad", label: "Broken task", task: "FAIL STREAM[HALF_DONE_WORK]", cwd: process.cwd() },
          ],
        },
      ],
    });
    await submission.completion.catch(() => undefined);
    await vi.waitFor(() => {
      expect(controller.getJobs([submission.handle.workId]).completed[0]?.status).toBe("failed");
    });

    const partial = controller.partialJobOutput(submission.handle.workId)!;
    expect(partial.kind).toBe("workflow");
    expect(partial.sources.map((source) => source.taskKey)).toEqual(["bad"]);
    expect(partial.sources[0]).toMatchObject({ status: "failed", streaming: false });
    expect(partial.sources[0]!.text).toContain("HALF_DONE_WORK");
    const serialized = JSON.stringify(partial);
    expect(serialized).not.toContain("UNRELATED_SECRET");
    expect(serialized).not.toContain("sibling-finished");
  });

  it("shows running workflow task text from the active projection", async () => {
    const { controller } = setup();
    scriptProvider(controller);
    const submission = controller.submitWorkflow({
      label: "Running workflow",
      cwd: process.cwd(),
      stages: [{ tasks: [{ key: "slow", task: "STREAM[IN_PROGRESS_NOTE]", cwd: process.cwd() }] }],
    });
    submission.completion.catch(() => undefined);
    await vi.waitFor(() => {
      expect(controller.partialJobOutput(submission.handle.workId)?.sources[0]?.text).toBe(
        "IN_PROGRESS_NOTE",
      );
    });
    expect(controller.partialJobOutput(submission.handle.workId)).toMatchObject({
      status: "running",
      sources: [{ taskKey: "slow", streaming: true }],
    });
    controller.cancelJob(submission.handle.workId);
  });
});

describe("subagent_results partial output", () => {
  function install() {
    // Tests may run inside a Workbench child; register the parent tools anyway.
    vi.stubEnv("PI_SUBAGENT_WORKBENCH_CHILD", "0");
    vi.stubEnv("PI_RUNTIME", "");
    const tools = new Map<string, any>();
    const handlers = new Map<string, Array<(...args: any[]) => any>>();
    const appendEntry = vi.fn();
    subagentWorkbench({
      appendEntry,
      on: vi.fn((event: string, handler: (...args: any[]) => any) => {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      }),
      registerCommand: vi.fn(),
      registerTool: vi.fn((tool: any) => tools.set(tool.name, tool)),
    } as any);
    const ctx = { cwd: process.cwd(), hasUI: false, isIdle: () => true, ui: { notify: vi.fn() } };
    return { tools, handlers, ctx, appendEntry };
  }

  it("requires a reason and records a successful explicit extension", async () => {
    const extend = vi.spyOn(WorkbenchController.prototype, "extendJobDeadline").mockReturnValue({
      ok: true, previousDeadlineAt: 10_000, deadlineAt: 70_000, extendMs: 60_000,
    });
    const { tools, handlers, ctx, appendEntry } = install();
    const params = { workId: "work-1", runId: "run-1", extendMs: 60_000, reason: " " };
    const invoke = () => tools.get("subagent_extend").execute("extend", params, new AbortController().signal, undefined, ctx);
    expect((await invoke()).details.ok).toBe(false);
    expect(extend).not.toHaveBeenCalled();
    params.reason = "One saved checkpoint remains to verify";
    expect((await invoke()).details).toMatchObject({ ok: true, deadlineAt: 70_000 });
    expect(extend).toHaveBeenCalledWith("work-1", "run-1", 60_000);
    expect(appendEntry).toHaveBeenCalledWith("subagent-deadline-extension", expect.objectContaining({ reason: params.reason, previousDeadlineAt: 10_000, deadlineAt: 70_000 }));
    for (const handler of handlers.get("session_shutdown") ?? []) await handler();
  });

  it("registers distinct, tool-named delegation and result guidelines", async () => {
    const { tools, handlers } = install();
    for (const name of ["subagent_start", "subagent_workflow", "subagent_results"]) {
      const guidelines: string[] = tools.get(name).promptGuidelines;
      expect(guidelines.length).toBeGreaterThan(0);
      expect(guidelines.every((line) => line.includes(name))).toBe(true);
    }
    expect(tools.get("subagent_start").promptGuidelines.join(" ")).toContain("one independent, verifiable task");
    expect(tools.get("subagent_workflow").promptGuidelines.join(" ")).toContain("reuse finished siblings");
    expect(tools.get("subagent_results").promptGuidelines.join(" ")).toContain("partial text as unverified");
    for (const handler of handlers.get("session_shutdown") ?? []) await handler();
  });

  it("distinguishes timeout recovery from quota failures without retrying", async () => {
    const timeout = "Pi RPC Run example exceeded hard wall time 100000 ms.";
    vi.spyOn(WorkbenchController.prototype, "getJobs").mockReturnValue({
      pending: [], missing: [], completed: [
        { workId: "work-timeout", kind: "workflow", status: "failed", label: "Run", result: { stages: [{ label: "Stage 1", tasks: [{ key: "audit", error: timeout, status: "failed" }] }] } },
        { workId: "work-quota", kind: "agent", status: "failed", label: "Review", error: "quota_exhausted" },
      ],
    } as any);
    const { tools, handlers, ctx } = install();
    const response = await tools.get("subagent_results").execute("q", { mode: "status" }, new AbortController().signal, undefined, ctx);
    expect(response.details.completed[0].failure).toMatchObject({ code: "timeout", wallTimeMs: 100000, checkpoint: "unknown" });
    expect(response.content[0].text).toContain("Retry only audit with retry_task");
    expect(response.details.completed[1].failure).toMatchObject({ code: "quota_exhausted" });
    expect(response.content[0].text).toContain("Do not retry immediately against the same exhausted quota");
    for (const handler of handlers.get("session_shutdown") ?? []) await handler();
  });

  it("is opt-in, requires explicit workIds, and stays bounded", async () => {
    const runningJob = {
      workId: "work-running",
      kind: "workflow",
      label: "Running",
      status: "running",
      background: true,
      createdAt: Date.now(),
    } as any;
    vi.spyOn(WorkbenchController.prototype, "getJobs").mockReturnValue({
      completed: [],
      pending: [runningJob],
      missing: [],
    } as any);
    const partialJobOutput = vi
      .spyOn(WorkbenchController.prototype, "partialJobOutput")
      .mockReturnValue({
        workId: "work-running",
        kind: "workflow",
        status: "running",
        sources: [
          {
            label: "Task A",
            taskKey: "a",
            sessionId: "s",
            runId: "r",
            status: "running",
            text: "y".repeat(100_000),
            truncated: true,
            streaming: true,
          },
        ],
        omittedSources: 2,
      });
    const { tools, handlers, ctx } = install();
    const signal = new AbortController().signal;
    const results = tools.get("subagent_results");

    const plain = await results.execute("q1", { mode: "status", workIds: ["work-running"] }, signal, undefined, ctx);
    expect(partialJobOutput).not.toHaveBeenCalled();
    expect(plain.details).not.toHaveProperty("partial");

    const noIds = await results.execute("q2", { mode: "status", includePartial: true }, signal, undefined, ctx);
    expect(partialJobOutput).not.toHaveBeenCalled();
    expect(noIds.content[0].text).toContain("requires explicit workIds");

    const withPartial = await results.execute(
      "q3",
      { mode: "status", workIds: ["work-running"], includePartial: true, partialMaxChars: 500 },
      signal,
      undefined,
      ctx,
    );
    expect(partialJobOutput).toHaveBeenCalledWith("work-running", 500);
    const text: string = withPartial.content[0].text;
    expect(text).toContain("Partial output · work-running");
    expect(text).toContain("unverified");
    expect(text).toContain("Task A (a) · running · streaming");
    expect(text.length).toBeLessThan(70 * 1024);
    expect(withPartial.details.partial).toEqual([
      {
        workId: "work-running",
        status: "running",
        sources: [
          { label: "Task A", taskKey: "a", status: "running", chars: 100_000, truncated: true, streaming: true },
        ],
        omittedSources: 2,
      },
    ]);
    expect(JSON.stringify(withPartial.details)).not.toContain("yyyy");

    for (const handler of handlers.get("session_shutdown") ?? []) await handler();
  });
});
