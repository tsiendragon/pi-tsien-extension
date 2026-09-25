import { describe, expect, it, vi } from "vitest";
import {
  ChildSessionOwnershipError,
  ProviderOutputError,
  SubagentExecutionError,
  SubagentInputError,
  SubagentService,
  emptyAgentResult,
  type ProviderRunRequest,
  type SubagentProvider,
} from "pi-tsien-subagent-workbench/src/subagent-service.ts";
import { WorkbenchRuntimeHost } from "pi-tsien-subagent-workbench/src/runtime.ts";

function provider(
  run: (request: ProviderRunRequest) => ReturnType<SubagentProvider["run"]>,
  overrides: Partial<SubagentProvider> = {},
): SubagentProvider {
  return {
    id: "edge-native",
    isolation: "native",
    capabilities: {
      contextModes: ["fresh", "explicit"],
      continuable: true,
      interruptible: true,
      structuredOutput: false,
    },
    run,
    ...overrides,
  };
}

describe("SubagentService edge cases", () => {
  it.each([
    ["null request", null, "invalid_request"],
    ["missing task", {}, "invalid_task"],
    ["numeric task", { task: 42 }, "invalid_task"],
    ["blank task", { task: "  \n" }, "invalid_task"],
    ["object context", { task: "ok", context: {} }, "invalid_context"],
    ["zero timeout", { task: "ok", timeoutMs: 0 }, "invalid_timeout"],
    ["NaN timeout", { task: "ok", timeoutMs: Number.NaN }, "invalid_timeout"],
    ["numeric parent", { task: "ok", parentId: 7 }, "invalid_parameter"],
  ])("rejects %s before creating a session", async (_name, request, code) => {
    const runtime = new WorkbenchRuntimeHost();
    const service = new SubagentService(runtime);
    const providerRun = vi.fn(async () => emptyAgentResult("never"));
    service.providers.register(provider(providerRun));

    await expect(service.start(request as never)).rejects.toMatchObject({
      name: "SubagentInputError",
      code,
    });
    expect(providerRun).not.toHaveBeenCalled();
    expect(service.listSessions()).toHaveLength(0);
    runtime.dispose();
  });

  it("accepts an exact task byte boundary and rejects one byte over it", async () => {
    const runtime = new WorkbenchRuntimeHost();
    const service = new SubagentService(runtime, { maxTaskBytes: 8 });
    const providerRun = vi.fn(async () => emptyAgentResult("ok"));
    service.providers.register(provider(providerRun));

    await expect(service.start({ task: "12345678" })).resolves.toMatchObject({
      output: "ok",
    });
    await expect(service.start({ task: "123456789" })).rejects.toMatchObject({
      name: "SubagentInputError",
      code: "task_too_large",
      field: "task",
      actualBytes: 9,
      limitBytes: 8,
    });
    expect(providerRun).toHaveBeenCalledTimes(1);
    expect(service.listSessions()).toHaveLength(1);
    runtime.dispose();
  });

  it("counts UTF-8 bytes rather than JavaScript characters", async () => {
    const runtime = new WorkbenchRuntimeHost();
    const service = new SubagentService(runtime, { maxTaskBytes: 4 });
    service.providers.register(provider(async () => emptyAgentResult("ok")));

    await expect(service.start({ task: "😀" })).resolves.toBeTruthy();
    await expect(service.start({ task: "😀😀" })).rejects.toMatchObject({
      code: "task_too_large",
      actualBytes: 8,
      limitBytes: 4,
    });
    runtime.dispose();
  });

  it("rejects oversized explicit context before provider admission", async () => {
    const runtime = new WorkbenchRuntimeHost();
    const service = new SubagentService(runtime, { maxContextBytes: 5 });
    const providerRun = vi.fn(async () => emptyAgentResult("never"));
    service.providers.register(provider(providerRun));

    await expect(
      service.start({ task: "ok", contextMode: "explicit", context: "123456" }),
    ).rejects.toMatchObject({
      name: "SubagentInputError",
      code: "context_too_large",
      actualBytes: 6,
      limitBytes: 5,
    });
    expect(providerRun).not.toHaveBeenCalled();
    expect(service.listSessions()).toHaveLength(0);
    runtime.dispose();
  });

  it("bounds provider output and releases the lease on rejection", async () => {
    const runtime = new WorkbenchRuntimeHost({ activeLimit: 1 });
    const service = new SubagentService(runtime, { maxOutputBytes: 4 });
    service.providers.register(provider(async () => emptyAgentResult("12345")));

    let caught: unknown;
    try {
      await service.start({ task: "output" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SubagentExecutionError);
    expect((caught as Error & { cause?: unknown }).cause).toBeInstanceOf(
      ProviderOutputError,
    );
    expect(
      (caught as Error & { cause?: ProviderOutputError }).cause,
    ).toMatchObject({
      code: "output_too_large",
      actualBytes: 5,
      limitBytes: 4,
    });
    expect(runtime.getSnapshot().governor).toMatchObject({
      active: 0,
      queued: 0,
    });
    runtime.dispose();
  });

  it("rejects malformed provider results without leaking a lease", async () => {
    const runtime = new WorkbenchRuntimeHost({ activeLimit: 1 });
    const service = new SubagentService(runtime);
    service.providers.register(provider(async () => ({ output: 7 }) as never));

    await expect(
      service.start({ task: "malformed output" }),
    ).rejects.toMatchObject({
      name: "SubagentExecutionError",
      cause: { name: "ProviderOutputError", code: "invalid_output" },
    });
    expect(runtime.getSnapshot().governor.active).toBe(0);
    runtime.dispose();
  });

  it("rejects invalid configured limits", () => {
    const runtime = new WorkbenchRuntimeHost();
    expect(() => new SubagentService(runtime, { maxTaskBytes: 0 })).toThrow(
      "maxTaskBytes must be a positive safe integer",
    );
    expect(
      () =>
        new SubagentService(runtime, {
          maxContextBytes: Number.POSITIVE_INFINITY,
        }),
    ).toThrow("maxContextBytes must be a positive safe integer");
    runtime.dispose();
  });

  it("rejects continuation ownership mismatches without governor admission", async () => {
    const runtime = new WorkbenchRuntimeHost({ activeLimit: 1, queueLimit: 0 });
    const service = new SubagentService(runtime);
    const nativeRun = vi.fn(async () => emptyAgentResult("native"));
    const unregisterNative = service.providers.register(provider(nativeRun));
    const first = await service.start({ task: "create session" });
    const acquire = vi.spyOn(runtime.governor, "acquire");
    const processRun = vi.fn(async () => emptyAgentResult("process"));
    service.providers.register(
      provider(processRun, { id: "edge-process", isolation: "process" }),
    );

    await expect(
      service.start({
        task: "wrong isolation",
        sessionId: first.sessionId,
        isolation: "process",
      }),
    ).rejects.toMatchObject({
      name: "ChildSessionOwnershipError",
      dimension: "isolation",
      expected: "native",
      requested: "process",
    });

    unregisterNative();
    const replacementRun = vi.fn(async () => emptyAgentResult("replacement"));
    service.providers.register(
      provider(replacementRun, { id: "edge-native-replacement" }),
    );
    const providerMismatch = service.start({
      task: "wrong provider",
      sessionId: first.sessionId,
    });
    await expect(providerMismatch).rejects.toBeInstanceOf(
      ChildSessionOwnershipError,
    );
    await expect(providerMismatch).rejects.toMatchObject({
      dimension: "provider",
      expected: "edge-native",
      requested: "edge-native-replacement",
    });

    expect(acquire).not.toHaveBeenCalled();
    expect(processRun).not.toHaveBeenCalled();
    expect(replacementRun).not.toHaveBeenCalled();
    expect(service.getSession(first.sessionId)?.runIds).toEqual([first.runId]);
    expect(runtime.getSnapshot().governor).toMatchObject({
      active: 0,
      queued: 0,
    });
    runtime.dispose();
  });

  it("does not invoke a provider for an already-aborted request", async () => {
    const runtime = new WorkbenchRuntimeHost();
    const service = new SubagentService(runtime);
    const providerRun = vi.fn(async () => emptyAgentResult("never"));
    service.providers.register(provider(providerRun));
    const controller = new AbortController();
    controller.abort("cancelled before start");

    await expect(
      service.start({ task: "cancelled", signal: controller.signal }),
    ).rejects.toMatchObject({ reason: "aborted" });
    expect(providerRun).not.toHaveBeenCalled();
    expect(service.listSessions()).toHaveLength(0);
    expect(runtime.getSnapshot().governor.active).toBe(0);
    runtime.dispose();
  });
});
