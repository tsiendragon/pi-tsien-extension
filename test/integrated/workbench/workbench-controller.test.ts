import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PiRpcProcessProvider,
  type PiRpcProcessProviderOptions,
} from "../../../extensions/subagent-workbench/src/providers/pi-rpc-process-provider.ts";
import { WorkbenchRuntimeHost } from "../../../extensions/subagent-workbench/src/runtime.ts";
import {
  WorkbenchController,
  type WorkbenchRunWarning,
} from "../../../extensions/subagent-workbench/src/workbench-controller.ts";

const fixture = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures/fake-pi-rpc.mjs",
);

const controllers: WorkbenchController[] = [];

function setup(
  maxTranscriptBytes = 1024 * 1024,
  stalledAfterMs?: number,
  maxSessions?: number,
  activeLimit = 2,
  providerOverrides: PiRpcProcessProviderOptions = {},
  onRunWarning?: (warning: WorkbenchRunWarning) => void,
): {
  runtime: WorkbenchRuntimeHost;
  controller: WorkbenchController;
} {
  const runtime = new WorkbenchRuntimeHost({ activeLimit, queueLimit: 8 });
  const provider = new PiRpcProcessProvider({
    executable: process.execPath,
    baseArgs: [fixture],
    commandTimeoutMs: 2_000,
    startupTimeoutMs: 2_000,
    runTimeoutMs: 5_000,
    shutdownTimeoutMs: 500,
    heartbeatIntervalMs: 50,
    ...(maxSessions === undefined ? {} : { maxSessions }),
    ...providerOverrides,
  });
  const controller = new WorkbenchController(runtime, {
    provider,
    maxTranscriptBytes,
    ...(stalledAfterMs === undefined ? {} : { stalledAfterMs }),
    ...(onRunWarning === undefined ? {} : { onRunWarning }),
  });
  controllers.push(controller);
  return { runtime, controller };
}

afterEach(async () => {
  await Promise.all(
    controllers.splice(0).map((controller) => controller.dispose()),
  );
});

describe("WorkbenchController", () => {
  it("rejects invalid volatile commands before creating a Session", async () => {
    const { runtime, controller } = setup();
    await expect(
      runtime.dispatch({
        type: "start-agent",
        task: "   ",
        cwd: process.cwd(),
      }),
    ).resolves.toEqual({ ok: false, error: "invalid_task" });
    await expect(
      runtime.dispatch({
        type: "send-agent",
        sessionId: "missing",
        message: "hello",
      }),
    ).resolves.toEqual({ ok: false, error: "session_not_found" });
    expect(runtime.getSnapshot().conversations.total).toBe(0);
    expect(controller.provider.snapshot().sessions).toBe(0);
  });

  it("uses independent 16-session provider capacity per Controller", async () => {
    const first = setup();
    const second = setup();

    expect(first.controller.provider.snapshot()).toMatchObject({
      sessions: 0,
      limit: 16,
    });
    expect(second.controller.provider.snapshot()).toMatchObject({
      sessions: 0,
      limit: 16,
    });

    await first.controller.runAgent({
      task: "first-controller-only",
      cwd: process.cwd(),
    });
    expect(first.controller.provider.snapshot().sessions).toBe(1);
    expect(second.controller.provider.snapshot().sessions).toBe(0);
  });

  it("projects a multi-Run conversation and preserves one RPC ChildSession", async () => {
    const { runtime, controller } = setup();
    const accepted = await runtime.dispatch({
      type: "start-agent",
      task: "remember: SWITCHER_7319",
      label: "Memory worker",
      cwd: process.cwd(),
      thinking: "high",
    });
    expect(accepted).toEqual({ ok: true, accepted: "volatile" });

    await vi.waitFor(() => {
      expect(runtime.getSnapshot().conversations.items[0]?.status).toBe(
        "completed",
      );
    });
    const first = runtime.getSnapshot().conversations.items[0]!;
    expect(first.messages?.map((message) => message.role)).toEqual([
      "user",
      "assistant",
    ]);
    expect(first.messages?.at(-1)?.streaming).toBe(false);
    expect(first.activeRunId).toBeNull();
    expect(controller.provider.snapshot()).toMatchObject({
      sessions: 1,
      active: 0,
      acceptedRuns: 1,
    });

    const followUp = await runtime.dispatch({
      type: "send-agent",
      sessionId: first.id,
      message: "what was remembered",
    });
    expect(followUp).toMatchObject({
      ok: true,
      accepted: "volatile",
      sessionId: first.id,
    });
    await vi.waitFor(() => {
      const conversation = runtime.getSnapshot().conversations.items[0]!;
      expect(conversation.messages).toHaveLength(4);
      expect(conversation.messages?.at(-1)?.text).toBe("SWITCHER_7319");
      expect(conversation.status).toBe("completed");
    });
    expect(controller.provider.snapshot()).toMatchObject({
      sessions: 1,
      acceptedRuns: 2,
    });
  });

  it("projects thinking, tool progress, and multi-turn assistant blocks into the timeline", async () => {
    const { runtime, controller } = setup();
    const result = await controller.runAgent({
      task: "timeline-events",
      cwd: process.cwd(),
    });

    expect(result.output).toBe("Inspection complete.");
    const conversation = runtime.getSnapshot().conversations.items[0];
    expect(conversation).toMatchObject({
      provider: "fake",
      model: "fake-rpc",
      thinkingLevel: "off",
    });
    expect(conversation?.usage).toEqual({
      input: 15,
      output: 4,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0.002,
    });
    const timeline = conversation?.timeline;
    expect(timeline?.map((entry) => entry.type)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
    expect(timeline?.[1]).toMatchObject({
      type: "assistant",
      streaming: false,
      content: [
        { type: "thinking", thinking: "Inspecting the repository" },
        { type: "text", text: "I will read the source." },
        { type: "toolCall", id: "call-read", name: "read" },
      ],
    });
    expect(timeline?.[2]).toMatchObject({
      type: "tool",
      toolCallId: "call-read",
      status: "completed",
      output: { content: [{ type: "text", text: "complete README" }] },
    });
    expect(timeline?.[3]).toMatchObject({
      type: "assistant",
      streaming: false,
      content: [{ type: "text", text: "Inspection complete." }],
    });
  });

  it("serializes concurrent Follow-ups through one FIFO drain", async () => {
    const { runtime, controller } = setup();
    await runtime.dispatch({
      type: "start-agent",
      task: "initial-turn",
      label: "Concurrent queue",
      cwd: process.cwd(),
    });
    await vi.waitFor(() => {
      expect(runtime.getSnapshot().conversations.items[0]?.status).toBe(
        "completed",
      );
    });
    const sessionId = runtime.getSnapshot().conversations.items[0]!.id;
    const followUps = ["follow-up-1", "follow-up-2", "follow-up-3"];
    const accepted = await Promise.all(
      followUps.map((message) =>
        runtime.dispatch({ type: "send-agent", sessionId, message }),
      ),
    );
    expect(accepted.map((result) => result.accepted)).toEqual([
      "volatile",
      "queued",
      "queued",
    ]);

    await vi.waitFor(() => {
      const conversation = runtime
        .getSnapshot()
        .conversations.items.find((item) => item.id === sessionId)!;
      expect(
        conversation.messages
          ?.filter((message) => message.role === "user")
          .map((message) => message.text),
      ).toEqual(["initial-turn", ...followUps]);
      expect(conversation.status).toBe("completed");
    });
    expect(controller.provider.snapshot().acceptedRuns).toBe(4);
  });

  it("queues a Follow-up while a direct Agent Run is active", async () => {
    const { runtime } = setup();
    await runtime.dispatch({
      type: "start-agent",
      task: "wait-for-abort",
      label: "Queueable",
      cwd: process.cwd(),
    });
    await vi.waitFor(() => {
      expect(
        runtime.getSnapshot().conversations.items[0]?.activeRunId,
      ).toBeTruthy();
    });
    const conversation = runtime.getSnapshot().conversations.items[0]!;
    await expect(
      runtime.dispatch({
        type: "send-agent",
        sessionId: conversation.id,
        message: "queued-follow-up",
      }),
    ).resolves.toMatchObject({
      ok: true,
      accepted: "queued",
      sessionId: conversation.id,
    });
    await runtime.dispatch({
      type: "interrupt-agent",
      sessionId: conversation.id,
    });
    await vi.waitFor(() => {
      const latest = runtime.getSnapshot().conversations.items[0]!;
      expect(latest.status).toBe("completed");
      expect(latest.messages?.at(-2)?.text).toBe("queued-follow-up");
    });
  });

  it("interrupts an active Run without closing the Conversation", async () => {
    const { runtime, controller } = setup();
    await runtime.dispatch({
      type: "start-agent",
      task: "wait-for-abort",
      label: "Interruptible",
      cwd: process.cwd(),
    });
    await vi.waitFor(() => {
      expect(
        runtime.getSnapshot().conversations.items[0]?.activeRunId,
      ).toBeTruthy();
    });
    const running = runtime.getSnapshot().conversations.items[0]!;
    const interrupted = await runtime.dispatch({
      type: "interrupt-agent",
      sessionId: running.id,
    });
    expect(interrupted).toMatchObject({ ok: true, sessionId: running.id });
    await vi.waitFor(() => {
      const conversation = runtime.getSnapshot().conversations.items[0]!;
      expect(conversation.status).toBe("interrupted");
      expect(conversation.activeRunId).toBeNull();
      expect(conversation.availability).toBe("ready");
      expect(conversation.messages?.some((message) => message.streaming)).toBe(
        false,
      );
    });

    await runtime.dispatch({
      type: "send-agent",
      sessionId: running.id,
      message: "after abort",
    });
    await vi.waitFor(() => {
      expect(runtime.getSnapshot().conversations.items[0]?.status).toBe(
        "completed",
      );
    });
    expect(controller.provider.snapshot()).toMatchObject({
      sessions: 1,
      acceptedRuns: 1,
    });
  });

  it("finalizes a partial streaming assistant message on failure", async () => {
    const { runtime, controller } = setup();
    const originalRun = controller.provider.run.bind(controller.provider);
    vi.spyOn(controller.provider, "run").mockImplementation(async (request) => {
      if (request.task !== "stream-then-fail") return originalRun(request);
      request.emit({ type: "message", text: "partial output" });
      throw new Error("synthetic provider failure");
    });

    await runtime.dispatch({
      type: "start-agent",
      task: "stream-then-fail",
      label: "Streaming failure",
      cwd: process.cwd(),
    });
    await vi.waitFor(() => {
      const conversation = runtime
        .getSnapshot()
        .conversations.items.find(
          (item) => item.label === "Streaming failure",
        )!;
      expect(conversation.status).toBe("failed");
      expect(conversation.messages?.at(-1)).toMatchObject({
        role: "assistant",
        text: "partial output",
        streaming: false,
      });
    });
  });

  it("marks a running Conversation stalled after heartbeats stop", async () => {
    const { runtime, controller } = setup(1024 * 1024, 30);
    const originalRun = controller.provider.run.bind(controller.provider);
    vi.spyOn(controller.provider, "run").mockImplementation((request) => {
      if (request.task !== "no-heartbeats") return originalRun(request);
      return new Promise((_, reject) => {
        const onAbort = (): void => reject(new Error("watchdog run aborted"));
        if (request.signal.aborted) onAbort();
        else request.signal.addEventListener("abort", onAbort, { once: true });
      });
    });

    await runtime.dispatch({
      type: "start-agent",
      task: "no-heartbeats",
      label: "Stalled run",
      cwd: process.cwd(),
    });
    await vi.waitFor(() => {
      expect(runtime.getSnapshot().conversations.items[0]).toMatchObject({
        status: "running",
        stalled: true,
        needsAttention: true,
      });
    });
    const sessionId = runtime.getSnapshot().conversations.items[0]!.id;
    await runtime.dispatch({ type: "interrupt-agent", sessionId });
    await vi.waitFor(() => {
      expect(runtime.getSnapshot().conversations.items[0]).toMatchObject({
        status: "interrupted",
        stalled: false,
      });
    });
  });

  it("marks volatile Sessions disposed across controller shutdown and reload", async () => {
    const { runtime, controller } = setup();
    await runtime.dispatch({
      type: "start-agent",
      task: "one turn",
      cwd: process.cwd(),
    });
    await vi.waitFor(() => {
      expect(runtime.getSnapshot().conversations.items[0]?.status).toBe(
        "completed",
      );
    });
    const sessionId = runtime.getSnapshot().conversations.items[0]!.id;
    await controller.dispose();
    expect(runtime.getSnapshot().conversations.items[0]).toMatchObject({
      id: sessionId,
      availability: "disposed",
      activeRunId: null,
    });
    expect(controller.provider.snapshot().sessions).toBe(0);

    const replacement = new WorkbenchController(runtime, {
      provider: new PiRpcProcessProvider({
        executable: process.execPath,
        baseArgs: [fixture],
        shutdownTimeoutMs: 500,
      }),
    });
    controllers.push(replacement);
    await expect(
      runtime.dispatch({
        type: "send-agent",
        sessionId,
        message: "must not fake retained context",
      }),
    ).resolves.toEqual({ ok: false, error: "session_disposed" });
    expect(replacement.provider.snapshot().sessions).toBe(0);
  });

  it("bounds transcript bytes and marks evicted content", async () => {
    const { runtime } = setup(48);
    await runtime.dispatch({
      type: "start-agent",
      task: "x".repeat(120),
      cwd: process.cwd(),
    });
    await vi.waitFor(() => {
      expect(runtime.getSnapshot().conversations.items[0]?.status).toBe(
        "completed",
      );
    });
    const conversation = runtime.getSnapshot().conversations.items[0]!;
    const bytes = (conversation.messages ?? []).reduce(
      (total, message) => total + Buffer.byteLength(message.text, "utf8"),
      0,
    );
    expect(bytes).toBeLessThanOrEqual(48);
    expect(conversation.transcriptTruncated).toBe(true);
  });

  it("truncates UTF-8 only at code point boundaries and stays within bytes", async () => {
    const { runtime } = setup(5);
    await runtime.dispatch({
      type: "start-agent",
      task: "unicode-A😀",
      cwd: process.cwd(),
    });
    await vi.waitFor(() => {
      expect(runtime.getSnapshot().conversations.items[0]?.status).toBe(
        "completed",
      );
    });
    const conversation = runtime.getSnapshot().conversations.items[0]!;
    const retained = conversation.messages?.at(-1)?.text;
    expect(retained).toBe("A😀");
    expect(Buffer.byteLength(retained ?? "", "utf8")).toBe(5);
    expect(retained).not.toContain("�");
  });

  it("marks a crashed persistent Session unavailable and fails follow-up loudly", async () => {
    const { runtime } = setup();
    await runtime.dispatch({
      type: "start-agent",
      task: "crash-now",
      label: "Crash worker",
      cwd: process.cwd(),
    });
    await vi.waitFor(() => {
      expect(runtime.getSnapshot().conversations.items[0]?.availability).toBe(
        "unavailable",
      );
    });
    const conversation = runtime.getSnapshot().conversations.items[0]!;
    const result = await runtime.dispatch({
      type: "send-agent",
      sessionId: conversation.id,
      message: "do not recreate context",
    });
    expect(result).toEqual({ ok: false, error: "session_unavailable" });
  });

  it("keeps workflow tasks queued until run admission", async () => {
    const { runtime, controller } = setup();
    await Promise.all([
      runtime.dispatch({
        type: "start-agent",
        task: "wait-for-abort",
        label: "Capacity blocker A",
        cwd: process.cwd(),
      }),
      runtime.dispatch({
        type: "start-agent",
        task: "wait-for-abort",
        label: "Capacity blocker B",
        cwd: process.cwd(),
      }),
    ]);
    await vi.waitFor(() => {
      expect(runtime.getSnapshot().conversations.running).toBe(2);
    });

    const workflow = controller.runWorkflow({
      label: "Admission projection",
      cwd: process.cwd(),
      stages: [{ tasks: [{ task: "admitted-later", cwd: process.cwd() }] }],
    });
    await vi.waitFor(() => {
      const task =
        runtime.getSnapshot().workflows.items[0]?.stages?.[0]?.tasks[0];
      expect(task).toMatchObject({ status: "queued" });
      expect(task?.sessionId).toBeUndefined();
      expect(task?.runId).toBeUndefined();
    });

    const blockers = runtime
      .getSnapshot()
      .conversations.items.filter((item) => !item.workflowId);
    await runtime.dispatch({
      type: "interrupt-agent",
      sessionId: blockers[0]!.id,
    });
    await expect(workflow).resolves.toMatchObject({ status: "completed" });
    await runtime.dispatch({
      type: "interrupt-agent",
      sessionId: blockers[1]!.id,
    });
  });

  it("runs workflow stages sequentially and tasks within a stage in parallel", async () => {
    const { runtime, controller } = setup();
    const result = await controller.runWorkflow({
      workflowId: "workflow-explicit",
      label: "Repository review",
      cwd: process.cwd(),
      stages: [
        {
          label: "Parallel inspect",
          tasks: [
            { task: "inspect-a", label: "Inspect A", cwd: process.cwd() },
            { task: "inspect-b", label: "Inspect B", cwd: process.cwd() },
          ],
        },
        {
          label: "Synthesize",
          tasks: [
            { task: "synthesize", label: "Synthesize", cwd: process.cwd() },
          ],
        },
      ],
    });

    expect(result.workflowId).toBe("workflow-explicit");
    expect(result.status).toBe("completed");
    expect(result.stages.map((stage) => stage.status)).toEqual([
      "completed",
      "completed",
    ]);
    expect(runtime.getSnapshot().workflows.items[0]).toMatchObject({
      id: result.workflowId,
      label: "Repository review",
      status: "completed",
      currentStage: 1,
    });
    expect(runtime.getSnapshot().conversations.items).toHaveLength(3);
    expect(
      runtime
        .getSnapshot()
        .conversations.items.every(
          (conversation) => conversation.workflowId === result.workflowId,
        ),
    ).toBe(true);
  });

  it("does not complete a Stage or Workflow after a late Abort", async () => {
    const { controller } = setup();
    const lateAbort = new AbortController();
    const originalStart = controller.service.start.bind(controller.service);
    vi.spyOn(controller.service, "start").mockImplementation(
      async (request) => {
        const result = await originalStart(request);
        if (request.workflowId) {
          lateAbort.abort(new Error("late workflow abort"));
        }
        return result;
      },
    );

    await expect(
      controller.runWorkflow({
        label: "Late abort",
        cwd: process.cwd(),
        signal: lateAbort.signal,
        stages: [{ tasks: [{ task: "fast-task", cwd: process.cwd() }] }],
      }),
    ).resolves.toMatchObject({
      status: "cancelled",
      stages: [
        {
          status: "cancelled",
          tasks: [{ status: "cancelled" }],
        },
      ],
    });
  });

  it("maps soft Run warnings to Direct and Workflow work handles without cancelling", async () => {
    const warnings: WorkbenchRunWarning[] = [];
    const { controller } = setup(
      1024 * 1024,
      undefined,
      16,
      2,
      {
        runIdleWarningMs: 50,
        runWallWarningMs: 1_000,
        warningRepeatMs: 1_000,
        hardRunWallTimeMs: 2_000,
      },
      (warning) => warnings.push(warning),
    );
    const direct = controller.submitAgent({
      task: "wait-for-abort",
      label: "Long Direct",
      cwd: process.cwd(),
    });
    await vi.waitFor(() => expect(warnings).toHaveLength(1));
    expect(warnings[0]).toMatchObject({
      workId: direct.handle.workId,
      kind: "agent",
      label: "Long Direct",
      warning: "idle",
    });
    expect(controller.getJobs([direct.handle.workId]).pending[0]).toMatchObject({
      status: "running",
    });
    expect(controller.pendingRunWarnings()).toHaveLength(1);
    expect(controller.markRunWarningDelivered(warnings[0]!.id)).toBe(true);
    controller.cancelJob(direct.handle.workId);
    await direct.completion.catch(() => undefined);

    const workflow = controller.submitWorkflow({
      label: "Long Workflow",
      cwd: process.cwd(),
      stages: [
        {
          tasks: [{ task: "wait-for-abort", cwd: process.cwd() }],
        },
      ],
    });
    await vi.waitFor(() =>
      expect(warnings.some((warning) => warning.workId === workflow.handle.workId)).toBe(true),
    );
    expect(
      warnings.find((warning) => warning.workId === workflow.handle.workId),
    ).toMatchObject({
      kind: "workflow",
      label: "Long Workflow",
      warning: "idle",
      workflowId: expect.any(String),
    });
    expect(controller.getJobs([workflow.handle.workId]).pending[0]).toMatchObject({
      status: "running",
    });
    controller.cancelJob(workflow.handle.workId);
    await workflow.completion.catch(() => undefined);
  });

  it("admits eight active Direct Agents and queues the ninth", async () => {
    const { runtime, controller } = setup(
      1024 * 1024,
      undefined,
      16,
      8,
    );
    for (let index = 0; index < 9; index++) {
      await runtime.dispatch({
        type: "start-agent",
        task: "wait-for-abort",
        label: `Concurrent ${index + 1}`,
        cwd: process.cwd(),
      });
    }

    await vi.waitFor(() => {
      expect(runtime.getSnapshot().governor).toMatchObject({
        active: 8,
        queued: 1,
        activeLimit: 8,
      });
      expect(controller.provider.snapshot()).toMatchObject({
        sessions: 8,
        active: 8,
        limit: 16,
      });
    });
  });

  it("cancels governor-queued Direct Agents when disposed", async () => {
    const { runtime, controller } = setup();
    for (const label of ["Active one", "Active two", "Queued three"]) {
      await runtime.dispatch({
        type: "start-agent",
        task: "wait-for-abort",
        label,
        cwd: process.cwd(),
      });
    }
    await vi.waitFor(() => {
      expect(runtime.getSnapshot().governor).toMatchObject({
        active: 2,
        queued: 1,
      });
    });

    await controller.dispose();

    await vi.waitFor(() => {
      expect(runtime.getSnapshot().governor).toMatchObject({
        active: 0,
        queued: 0,
      });
    });
  });

  it("rejects fuzzy model overrides before creating work", async () => {
    const { controller } = setup();
    const agentRequest = {
      task: "model-reference-check",
      cwd: process.cwd(),
    };

    expect(() =>
      controller.submitAgent({ ...agentRequest, model: "luna" }),
    ).toThrow(/exact provider\/model/);
    expect(controller.getJobs()).toMatchObject({ completed: [], pending: [] });

    expect(() =>
      controller.preflightWorkflow({
        cwd: process.cwd(),
        model: "luna",
        stages: [{ tasks: [{ task: "root-short-model", cwd: process.cwd() }] }],
      }),
    ).toThrow(/Workflow model must use an exact provider\/model/);
    expect(() =>
      controller.preflightWorkflow({
        cwd: process.cwd(),
        stages: [
          {
            tasks: [
              {
                task: "task-short-model",
                cwd: process.cwd(),
                model: "luna",
              },
            ],
          },
        ],
      }),
    ).toThrow(/Stage 1 task 1 model must use an exact provider\/model/);

    const exact = controller.submitAgent({
      ...agentRequest,
      model: "openai-codex/gpt-5.6-luna",
    });
    await expect(exact.completion).resolves.toMatchObject({
      output: expect.stringContaining("model-reference-check"),
    });
  });

  it("submits background work with a stable handle and collects its retained result", async () => {
    const { controller } = setup();
    const submission = controller.submitAgent({
      task: "retained-result",
      label: "Retained result",
      cwd: process.cwd(),
    });
    expect(submission.handle).toMatchObject({
      workId: expect.stringMatching(/^work_/),
      kind: "agent",
      status: "queued",
      background: true,
    });
    const result = await submission.completion;
    expect(result.output).toContain("retained-result");
    expect(controller.getJobs([submission.handle.workId])).toMatchObject({
      completed: [
        {
          workId: submission.handle.workId,
          status: "completed",
          result: expect.objectContaining({ output: expect.stringContaining("retained-result") }),
        },
      ],
      pending: [],
      missing: [],
    });
    expect(controller.collectJobs([submission.handle.workId]).completed[0]).toMatchObject({
      collectedAt: expect.any(Number),
    });
  });

  it("waits without cancelling unfinished background work and can cancel it explicitly", async () => {
    const { controller } = setup();
    const submission = controller.submitAgent({
      task: "wait-for-abort",
      label: "Cancellable job",
      cwd: process.cwd(),
    });
    const timeout = await controller.waitForJobs(
      [submission.handle.workId],
      "all",
      10,
    );
    expect(timeout.pending).toHaveLength(1);
    await vi.waitFor(() => {
      expect(controller.getJobs([submission.handle.workId]).pending[0]?.runId).toBeTruthy();
    });
    expect(controller.cancelJob(submission.handle.workId)).toMatchObject({
      workId: submission.handle.workId,
      status: "running",
    });
    await expect(submission.completion).rejects.toThrow("Cancelled by user.");
    await vi.waitFor(() => {
      expect(controller.getJobs([submission.handle.workId]).completed[0]).toMatchObject({
        status: "cancelled",
      });
    });
  });

  it("passes completed task outputs into later-stage inputs", async () => {
    const { controller } = setup();
    const result = await controller.runWorkflow({
      label: "Dataflow",
      cwd: process.cwd(),
      stages: [
        {
          label: "Produce",
          tasks: [
            {
              key: "producer",
              task: "source-value",
              cwd: process.cwd(),
            },
          ],
        },
        {
          label: "Consume",
          tasks: [
            {
              key: "consumer",
              inputs: ["producer"],
              task: "use-source",
              cwd: process.cwd(),
            },
          ],
        },
      ],
    });

    expect(result.status).toBe("completed");
    expect(result.stages[0]?.tasks[0]).toMatchObject({
      key: "producer",
      output: expect.stringContaining("source-value"),
    });
    expect(result.stages[1]?.tasks[0]).toMatchObject({
      key: "consumer",
      output: expect.stringContaining("Workflow input: producer"),
    });
    expect(result.stages[1]?.tasks[0]?.output).toContain("source-value");
  });

  it("parses and validates structured JSON task outputs", async () => {
    const { controller } = setup();
    const schema = {
      type: "object",
      properties: {
        country: { type: "string" },
        valid: { type: "boolean" },
      },
      required: ["country", "valid"],
      additionalProperties: false,
    };
    const valid = await controller.runWorkflow({
      label: "Structured output",
      cwd: process.cwd(),
      stages: [
        {
          tasks: [
            {
              key: "parsed",
              task: 'json-output:{"country":"IQ","valid":true}',
              outputSchema: schema,
              cwd: process.cwd(),
            },
          ],
        },
      ],
    });
    expect(valid).toMatchObject({
      status: "completed",
      stages: [
        {
          tasks: [
            {
              key: "parsed",
              json: { country: "IQ", valid: true },
            },
          ],
        },
      ],
    });

    const invalid = await controller.runWorkflow({
      label: "Invalid structured output",
      cwd: process.cwd(),
      stages: [
        {
          tasks: [
            {
              task: 'json-output:{"country":"IQ","valid":"yes"}',
              outputSchema: schema,
              cwd: process.cwd(),
            },
          ],
        },
      ],
    });
    expect(invalid).toMatchObject({
      status: "failed",
      stages: [
        {
          status: "failed",
          tasks: [
            {
              status: "failed",
              error: "Task JSON output does not match outputSchema.",
            },
          ],
        },
      ],
    });
  });

  it("resolves parameters, conditions, and bounded foreach fan-out", async () => {
    const { runtime, controller } = setup();
    const result = await controller.runWorkflow({
      label: "Declarative control",
      cwd: process.cwd(),
      parameters: {
        country: "IQ",
        enabled: true,
      },
      stages: [
        {
          tasks: [
            {
              key: "discover",
              task: 'json-output:{"documents":["passport","id-card"]}',
              outputSchema: {
                type: "object",
                properties: {
                  documents: {
                    type: "array",
                    items: { type: "string" },
                  },
                },
                required: ["documents"],
              },
              cwd: process.cwd(),
            },
          ],
        },
        {
          tasks: [
            {
              key: "disabled",
              when: "{{parameters.enabled}} == false",
              task: "must-not-run",
              cwd: process.cwd(),
            },
            {
              key: "inspect",
              when: "{{parameters.enabled}}",
              foreach: "{{tasks.discover.json.documents}}",
              maxItems: 2,
              task: "inspect {{item}} at {{index}} for {{parameters.country}}",
              label: "Inspect {{item}}",
              cwd: process.cwd(),
            },
          ],
        },
      ],
    });

    expect(result.status).toBe("completed");
    expect(result.stages[1]?.tasks[0]).toMatchObject({
      key: "disabled",
      status: "skipped",
    });
    expect(result.stages[1]?.tasks[1]).toMatchObject({
      key: "inspect",
      status: "completed",
      json: [
        expect.stringContaining("inspect passport at 0 for IQ"),
        expect.stringContaining("inspect id-card at 1 for IQ"),
      ],
      iterations: [
        {
          index: 0,
          item: "passport",
          status: "completed",
          output: expect.stringContaining("inspect passport at 0 for IQ"),
        },
        {
          index: 1,
          item: "id-card",
          status: "completed",
          output: expect.stringContaining("inspect id-card at 1 for IQ"),
        },
      ],
    });
    expect(
      runtime
        .getSnapshot()
        .conversations.items.some((conversation) =>
          conversation.label.includes("must-not-run"),
        ),
    ).toBe(false);
  });

  it("rejects same-stage inputs and capacity overflow before creating a job", () => {
    const { controller } = setup();
    const sameStage = {
      label: "Invalid dataflow",
      cwd: process.cwd(),
      stages: [
        {
          tasks: [
            { key: "first", task: "first", cwd: process.cwd() },
            {
              key: "second",
              inputs: ["first"],
              task: "second",
              cwd: process.cwd(),
            },
          ],
        },
      ],
    };
    expect(() => controller.submitWorkflow(sameStage)).toThrow(
      "must reference a task from an earlier stage",
    );

    const tooMany = {
      label: "Too large",
      cwd: process.cwd(),
      stages: [
        {
          tasks: Array.from({ length: 8 }, (_, index) => ({
            task: `first-${index}`,
            cwd: process.cwd(),
          })),
        },
        {
          tasks: Array.from({ length: 8 }, (_, index) => ({
            task: `second-${index}`,
            cwd: process.cwd(),
          })),
        },
        {
          tasks: [{ task: "seventeenth", cwd: process.cwd() }],
        },
      ],
    };
    expect(() => controller.submitWorkflow(tooMany)).toThrow(
      "Keep the entire workflow within 16 tasks",
    );
    expect(controller.getJobs()).toMatchObject({ completed: [], pending: [] });
  });

  it("reclaims the oldest idle Direct session when capacity is full", async () => {
    const { runtime, controller } = setup(1024 * 1024, undefined, 2);
    const oldest = await controller.runAgent({
      task: "oldest-idle-session",
      cwd: process.cwd(),
    });
    const newer = await controller.runAgent({
      task: "newer-idle-session",
      cwd: process.cwd(),
    });
    expect(controller.provider.snapshot()).toMatchObject({ sessions: 2, limit: 2 });

    const replacement = await controller.runAgent({
      task: "replacement-session",
      cwd: process.cwd(),
    });

    expect(controller.provider.snapshot()).toMatchObject({ sessions: 2, limit: 2 });
    expect(controller.provider.hasSession(oldest.sessionId)).toBe(false);
    expect(controller.provider.hasSession(newer.sessionId)).toBe(true);
    expect(controller.provider.hasSession(replacement.sessionId)).toBe(true);
    expect(
      runtime
        .getSnapshot()
        .conversations.items.find((item) => item.id === oldest.sessionId),
    ).toMatchObject({
      availability: "disposed",
      error: "Closed to free RPC provider capacity.",
    });
  });

  it("never reclaims a running Direct session", async () => {
    const { runtime, controller } = setup(1024 * 1024, undefined, 1);
    await runtime.dispatch({
      type: "start-agent",
      task: "wait-for-abort",
      label: "Protected active session",
      cwd: process.cwd(),
    });
    await vi.waitFor(() => {
      expect(controller.provider.snapshot()).toMatchObject({
        sessions: 1,
        active: 1,
        limit: 1,
      });
    });

    await expect(
      controller.runAgent({
        task: "must-not-evict-active-session",
        cwd: process.cwd(),
      }),
    ).rejects.toThrow("only 0 are available after reclaiming idle Direct sessions");
    expect(runtime.getSnapshot().conversations.items[0]).toMatchObject({
      label: "Protected active session",
      availability: "ready",
      status: "running",
    });
  });

  it("reclaims idle Direct sessions before a Workflow starts", async () => {
    const { runtime, controller } = setup(1024 * 1024, undefined, 2);
    const direct = await controller.runAgent({
      task: "reclaim-before-workflow",
      cwd: process.cwd(),
    });
    const request = {
      label: "Uses reclaimed capacity",
      cwd: process.cwd(),
      stages: [
        {
          tasks: Array.from({ length: 2 }, (_, index) => ({
            task: `workflow-${index}`,
            cwd: process.cwd(),
          })),
        },
      ],
    };

    expect(controller.preflightWorkflow(request).availableSessionSlots).toBe(2);
    await expect(controller.submitWorkflow(request).completion).resolves.toMatchObject({
      status: "completed",
    });
    expect(controller.provider.hasSession(direct.sessionId)).toBe(false);
    expect(
      runtime
        .getSnapshot()
        .conversations.items.find((item) => item.id === direct.sessionId),
    ).toMatchObject({ availability: "disposed" });
  });

  it("counts materialized Workflow reservations once while reclaiming Direct sessions", async () => {
    const { runtime, controller } = setup(1024 * 1024, undefined, 4);
    const blocking = controller.submitWorkflow({
      label: "Blocking workflow",
      cwd: process.cwd(),
      stages: [
        {
          tasks: [{ task: "wait-for-abort", cwd: process.cwd() }],
        },
      ],
    });
    await vi.waitFor(() => {
      expect(controller.provider.snapshot()).toMatchObject({
        sessions: 1,
        active: 1,
        limit: 4,
      });
    });

    const oldest = await controller.runAgent({
      task: "oldest-beside-workflow",
      cwd: process.cwd(),
    });
    const newer = await controller.runAgent({
      task: "newer-beside-workflow",
      cwd: process.cwd(),
    });
    const admitted = controller.submitWorkflow({
      label: "Fits after one reclaim",
      cwd: process.cwd(),
      stages: [
        {
          tasks: [
            { task: "fit-0", cwd: process.cwd() },
            { task: "fit-1", cwd: process.cwd() },
          ],
        },
      ],
    });

    await expect(admitted.completion).resolves.toMatchObject({
      status: "completed",
    });
    expect(controller.provider.hasSession(oldest.sessionId)).toBe(false);
    expect(controller.provider.hasSession(newer.sessionId)).toBe(true);
    expect(
      runtime
        .getSnapshot()
        .conversations.items.find((item) => item.id === oldest.sessionId),
    ).toMatchObject({ availability: "disposed" });

    controller.cancelJob(blocking.handle.workId);
    await blocking.completion.catch(() => undefined);
  });

  it("reserves provider slots across concurrently submitted workflows", async () => {
    const { controller } = setup(1024 * 1024, undefined, 8);
    const first = controller.submitWorkflow({
      label: "Reserved first",
      cwd: process.cwd(),
      stages: [
        {
          tasks: Array.from({ length: 4 }, (_, index) => ({
            task: `reserved-${index}`,
            cwd: process.cwd(),
          })),
        },
      ],
    });

    expect(() =>
      controller.submitWorkflow({
        label: "Would overbook",
        cwd: process.cwd(),
        stages: [
          {
            tasks: Array.from({ length: 5 }, (_, index) => ({
              task: `overbook-${index}`,
              cwd: process.cwd(),
            })),
          },
        ],
      }),
    ).toThrow("provider has 4 available session slots");
    await expect(first.completion).resolves.toMatchObject({
      status: "completed",
    });
  });

  it("pauses at a stage boundary, resumes, and retries from the retained definition", async () => {
    const { runtime, controller } = setup();
    const submission = controller.submitWorkflow({
      label: "Controllable",
      cwd: process.cwd(),
      stages: [
        {
          label: "Slow first",
          tasks: [{ task: "progress-for:80:10", cwd: process.cwd() }],
        },
        {
          label: "Second",
          tasks: [{ task: "after-resume", cwd: process.cwd() }],
        },
      ],
    });

    await vi.waitFor(() => {
      expect(runtime.getSnapshot().workflows.items[0]?.stages?.[0]?.status).toBe(
        "running",
      );
    });
    expect(controller.pauseWorkflowJob(submission.handle.workId)).toMatchObject({
      status: "paused",
    });
    await vi.waitFor(() => {
      const workflow = runtime.getSnapshot().workflows.items[0]!;
      expect(workflow.status).toBe("paused");
      expect(workflow.stages?.[0]?.status).toBe("completed");
      expect(workflow.stages?.[1]?.status).toBe("queued");
    });
    expect(controller.resumeWorkflowJob(submission.handle.workId)).toMatchObject({
      status: "running",
    });
    await expect(submission.completion).resolves.toMatchObject({
      status: "completed",
    });
    expect(controller.provider.snapshot().sessions).toBe(0);

    const retry = controller.retryWorkflowJob(submission.handle.workId);
    expect(retry?.handle).toMatchObject({
      kind: "workflow",
      status: "queued",
      background: true,
    });
    expect(retry?.handle.workId).not.toBe(submission.handle.workId);
    await expect(retry?.completion).resolves.toMatchObject({
      status: "completed",
    });
  });

  it("retries from the first incomplete Stage and reuses earlier outputs", async () => {
    const { runtime, controller } = setup();
    const first = controller.submitWorkflow({
      label: "Resume failed attempt",
      cwd: process.cwd(),
      stages: [
        {
          label: "Reusable",
          tasks: [
            { key: "source", task: "stable-source", cwd: process.cwd() },
            {
              key: "optional",
              when: false,
              task: "must-stay-skipped",
              cwd: process.cwd(),
            },
          ],
        },
        {
          label: "Interrupted",
          tasks: [{ task: "wait-for-abort", cwd: process.cwd() }],
        },
        {
          label: "After retry",
          tasks: [
            {
              inputs: ["source"],
              task: "consume-reused-source",
              cwd: process.cwd(),
            },
          ],
        },
      ],
    });
    await vi.waitFor(() => {
      const stages = runtime.getSnapshot().workflows.items[0]?.stages;
      expect(stages?.[0]?.status).toBe("completed");
      expect(stages?.[1]?.status).toBe("running");
    });
    controller.cancelJob(first.handle.workId, "retry test");
    const cancelled = await first.completion;
    expect(cancelled).toMatchObject({
      status: "cancelled",
      attempt: 1,
      stages: [
        { status: "completed" },
        { status: "cancelled" },
        { status: "cancelled" },
      ],
    });

    const startedTasks: string[] = [];
    const originalStart = controller.service.start.bind(controller.service);
    vi.spyOn(controller.service, "start").mockImplementation((request) => {
      startedTasks.push(request.task);
      return originalStart({
        ...request,
        task: request.task === "wait-for-abort" ? "recovered-stage" : request.task,
      });
    });
    const retry = controller.retryWorkflowJob(first.handle.workId)!;
    expect(controller.getJobs([retry.handle.workId]).pending[0]).toMatchObject({
      attempt: 2,
      sourceWorkId: first.handle.workId,
    });
    const retried = await retry.completion;

    expect(startedTasks).toEqual(["wait-for-abort", "consume-reused-source"]);
    expect(retried).toMatchObject({
      status: "completed",
      attempt: 2,
      sourceWorkId: first.handle.workId,
      resumedFromStage: 2,
      stages: [
        {
          status: "completed",
          reused: true,
          tasks: [
            {
              key: "source",
              reused: true,
              output: cancelled.stages[0]?.tasks[0]?.output,
            },
            {
              key: "optional",
              status: "skipped",
              reused: true,
            },
          ],
        },
        { status: "completed" },
        { status: "completed" },
      ],
    });
    expect(retried.stages[2]?.tasks[0]?.output).toContain("stable-source");
  });

  it("forwards only conclusions and absolute artifact paths through workflow inputs", async () => {
    const { controller } = setup();
    const result = await controller.runWorkflow({
      cwd: process.cwd(),
      stages: [
        {
          tasks: [
            {
              key: "produce",
              task: 'json-output:{"summary":"Source conclusion","artifacts":[{"path":"/tmp/workflow-report.md","description":"Detailed report"},"relative.txt"]}',
              cwd: process.cwd(),
            },
          ],
        },
        {
          tasks: [
            {
              key: "consume",
              inputs: ["produce"],
              task: "consume handoff",
              cwd: process.cwd(),
            },
          ],
        },
      ],
    });

    const producer = result.stages[0]!.tasks[0]!;
    const consumer = result.stages[1]!.tasks[0]!;
    expect(producer).toMatchObject({
      summary: "Source conclusion",
      artifacts: [
        { path: "/tmp/workflow-report.md", description: "Detailed report" },
      ],
    });
    expect(consumer.output).toContain("## Conclusion\nSource conclusion");
    expect(consumer.output).toContain("/tmp/workflow-report.md");
    expect(consumer.output).not.toContain('"summary"');
    expect(consumer.output).not.toContain("relative.txt");
  });

  it("retries one failed task without rerunning completed stage siblings", async () => {
    const { controller } = setup();
    const request = {
      label: "Retry one task",
      cwd: process.cwd(),
      stages: [
        {
          tasks: [
            { key: "stable", task: "stable sibling", cwd: process.cwd() },
            { key: "flaky", task: "flaky sibling", cwd: process.cwd() },
          ],
        },
      ],
    };
    const started: string[] = [];
    let failFlaky = true;
    const originalStart = controller.service.start.bind(controller.service);
    vi.spyOn(controller.service, "start").mockImplementation((agentRequest) => {
      started.push(agentRequest.task);
      if (agentRequest.task === "flaky sibling" && failFlaky) {
        return Promise.reject(new Error("planned flaky failure"));
      }
      return originalStart(agentRequest);
    });

    const first = await controller.runWorkflow(request);
    expect(first).toMatchObject({ status: "failed" });
    expect(first.stages[0]?.tasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "stable", status: "completed" }),
        expect.objectContaining({
          key: "flaky",
          status: "failed",
          error: "planned flaky failure",
        }),
      ]),
    );

    failFlaky = false;
    const retry = controller.retryWorkflowTaskFromResult(
      "work_failed_retry",
      request,
      first,
      "flaky",
    );
    const retried = await retry.completion;

    expect(started.filter((task) => task === "stable sibling")).toHaveLength(1);
    expect(started.filter((task) => task === "flaky sibling")).toHaveLength(2);
    expect(retried).toMatchObject({
      status: "completed",
      sourceWorkId: "work_failed_retry",
      stages: [
        {
          tasks: expect.arrayContaining([
            expect.objectContaining({ key: "stable", status: "completed", reused: true }),
            expect.objectContaining({ key: "flaky", status: "completed" }),
          ]),
        },
      ],
    });
  });

  it("interrupts an active workflow from the runtime command", async () => {
    const { runtime, controller } = setup();
    const running = controller.runWorkflow({
      label: "Interruptible",
      cwd: process.cwd(),
      stages: [
        {
          tasks: [
            {
              task: "wait-for-abort",
              label: "Slow task",
              cwd: process.cwd(),
            },
          ],
        },
      ],
    });
    await vi.waitFor(() => {
      expect(runtime.getSnapshot().workflows.active).toBe(1);
      expect(runtime.getSnapshot().conversations.running).toBe(1);
    });
    const activeWorkflow = runtime.getSnapshot().workflows.items[0]!;
    const workflowId = activeWorkflow.id;
    expect(activeWorkflow.stages?.[0]?.tasks[0]).toMatchObject({
      status: "running",
      sessionId: expect.any(String),
      runId: expect.any(String),
    });
    const workflowSessionId = activeWorkflow.stages?.[0]?.tasks[0]?.sessionId!;
    await expect(
      runtime.dispatch({
        type: "send-agent",
        sessionId: workflowSessionId,
        message: "must remain read-only",
      }),
    ).resolves.toEqual({ ok: false, error: "workflow_agent_read_only" });
    await expect(
      runtime.dispatch({ type: "interrupt-workflow", workflowId }),
    ).resolves.toEqual({ ok: true });
    await expect(running).resolves.toMatchObject({
      workflowId,
      status: "cancelled",
    });
    expect(runtime.getSnapshot().workflows.items[0]?.status).toBe("cancelled");
  });
});
