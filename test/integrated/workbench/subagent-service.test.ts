import { describe, expect, it, vi } from "vitest";
import {
  ProviderCapabilityError,
  ProviderUnavailableError,
  SubagentExecutionError,
  SubagentService,
  emptyAgentResult,
  type ProviderRunRequest,
  type SubagentProvider,
  type SubagentServiceEvent,
} from "pi-tsien-subagent-workbench/src/subagent-service.ts";
import { WorkbenchRuntimeHost } from "pi-tsien-subagent-workbench/src/runtime.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function provider(
  run: (request: ProviderRunRequest) => ReturnType<SubagentProvider["run"]>,
  overrides: Partial<SubagentProvider> = {},
): SubagentProvider {
  return {
    id: "native-test",
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

describe("SubagentService", () => {
  it("emits ordered immutable events with streaming provider messages", async () => {
    const runtime = new WorkbenchRuntimeHost();
    const service = new SubagentService(runtime);
    const finish = deferred<void>();
    const events: SubagentServiceEvent[] = [];
    service.subscribe((event) => events.push(event));
    service.providers.register(
      provider(async (request) => {
        request.emit({ type: "message", text: "partial answer" });
        await finish.promise;
        return emptyAgentResult("final answer");
      }),
    );

    const running = service.start({
      task: "show transcript",
      cwd: "/tmp/workbench",
      model: "test-model",
    });
    await vi.waitFor(() =>
      expect(events.map((event) => event.type)).toEqual([
        "run-started",
        "provider-event",
      ]),
    );

    const started = events[0]!;
    expect(started.type).toBe("run-started");
    if (started.type !== "run-started") throw new Error("unreachable");
    expect(started.task).toBe("show transcript");
    expect(started.config).toEqual({
      cwd: "/tmp/workbench",
      model: "test-model",
    });
    expect(started.run).toMatchObject({
      sessionId: started.session.id,
      status: "running",
      providerId: "native-test",
    });
    expect(started.session.runIds).toEqual([started.run.id]);
    expect(Object.isFrozen(started.session)).toBe(true);
    expect(Object.isFrozen(started.session.runIds)).toBe(true);
    expect(Object.isFrozen(started.run)).toBe(true);
    expect(Object.isFrozen(started.config)).toBe(true);

    const streamed = events[1]!;
    expect(streamed).toMatchObject({
      type: "provider-event",
      sessionId: started.session.id,
      runId: started.run.id,
      event: { type: "message", text: "partial answer" },
    });
    if (streamed.type !== "provider-event") throw new Error("unreachable");
    expect(Object.isFrozen(streamed.event)).toBe(true);

    finish.resolve();
    const result = await running;
    expect(events.map((event) => event.type)).toEqual([
      "run-started",
      "provider-event",
      "run-settled",
    ]);
    const settled = events[2]!;
    expect(settled.type).toBe("run-settled");
    if (settled.type !== "run-settled") throw new Error("unreachable");
    expect(settled.sessionId).toBe(started.session.id);
    expect(settled.run.status).toBe("completed");
    expect(settled.run.completedAt).toEqual(expect.any(Number));
    expect(settled.session.updatedAt).toBe(settled.run.completedAt);
    expect(settled.result).toEqual(result);
    expect(settled.error).toBeUndefined();
    expect(Object.isFrozen(settled.result)).toBe(true);
    expect(Object.isFrozen(settled.result?.usage)).toBe(true);
    runtime.dispose();
  });

  it("stops delivering events after unsubscribe", async () => {
    const runtime = new WorkbenchRuntimeHost();
    const service = new SubagentService(runtime);
    const events: SubagentServiceEvent[] = [];
    const unsubscribe = service.subscribe((event) => events.push(event));
    unsubscribe();
    unsubscribe();
    service.providers.register(
      provider(async (request) => {
        request.emit({ type: "message", text: "not observed" });
        return emptyAgentResult("done");
      }),
    );

    await service.start({ task: "silent" });
    expect(events).toEqual([]);
    runtime.dispose();
  });

  it("isolates throwing listeners from Runs and other listeners", async () => {
    const runtime = new WorkbenchRuntimeHost();
    const service = new SubagentService(runtime);
    const observed: SubagentServiceEvent[] = [];
    service.subscribe(() => {
      throw new Error("listener failed");
    });
    service.subscribe((event) => observed.push(event));
    service.providers.register(
      provider(async (request) => {
        request.emit({ type: "message", text: "still delivered" });
        return emptyAgentResult("done");
      }),
    );

    await expect(
      service.start({ task: "keep running" }),
    ).resolves.toMatchObject({
      output: "done",
      isError: false,
    });
    expect(observed.map((event) => event.type)).toEqual([
      "run-started",
      "provider-event",
      "run-settled",
    ]);
    runtime.dispose();
  });

  it("keeps one ChildSession across multiple Runs", async () => {
    const runtime = new WorkbenchRuntimeHost();
    const service = new SubagentService(runtime);
    service.providers.register(
      provider(async (request) => emptyAgentResult(`done:${request.task}`)),
    );

    const first = await service.start({ task: "first", label: "Worker" });
    const second = await service.start({
      task: "second",
      sessionId: first.sessionId,
    });

    expect(second.sessionId).toBe(first.sessionId);
    expect(second.runId).not.toBe(first.runId);
    expect(service.getSession(first.sessionId)).toMatchObject({
      providerId: "native-test",
      isolation: "native",
      runIds: [first.runId, second.runId],
    });
    expect(service.getRun(second.runId)?.status).toBe("completed");
    runtime.dispose();
  });

  it("uses the global governor before starting a provider Run", async () => {
    const runtime = new WorkbenchRuntimeHost({ activeLimit: 1, queueLimit: 2 });
    const service = new SubagentService(runtime);
    const gates = [deferred<void>(), deferred<void>()];
    const started: string[] = [];
    service.providers.register(
      provider(async (request) => {
        started.push(request.task);
        await gates[started.length - 1]!.promise;
        return emptyAgentResult(request.task);
      }),
    );

    const first = service.start({ task: "first" });
    await vi.waitFor(() => expect(started).toEqual(["first"]));
    const second = service.start({ task: "second" });
    await vi.waitFor(() =>
      expect(runtime.getSnapshot().governor).toMatchObject({
        active: 1,
        queued: 1,
      }),
    );
    expect(started).toEqual(["first"]);

    gates[0].resolve();
    await first;
    await vi.waitFor(() => expect(started).toEqual(["first", "second"]));
    gates[1].resolve();
    await second;
    expect(runtime.getSnapshot().governor.active).toBe(0);
    runtime.dispose();
  });

  it("interrupts the active Run without deleting its ChildSession", async () => {
    const runtime = new WorkbenchRuntimeHost();
    const service = new SubagentService(runtime);
    service.providers.register(
      provider(
        (request) =>
          new Promise((resolve, reject) => {
            request.signal.addEventListener(
              "abort",
              () => reject(request.signal.reason),
              { once: true },
            );
          }),
      ),
    );

    const running = service.start({ task: "wait", label: "Persistent" });
    await vi.waitFor(() =>
      expect(service.listSessions()[0]?.latestRunId).toBeTruthy(),
    );
    const session = service.listSessions()[0]!;
    expect(service.interrupt(session.latestRunId!)).toBe(true);

    await expect(running).rejects.toBeInstanceOf(SubagentExecutionError);
    expect(service.getRun(session.latestRunId!)?.status).toBe("interrupted");
    expect(service.getSession(session.id)?.label).toBe("Persistent");
    runtime.dispose();
  });

  it("refuses to interrupt a non-interruptible Run and lets it settle", async () => {
    const runtime = new WorkbenchRuntimeHost();
    const service = new SubagentService(runtime);
    const finish = deferred<void>();
    let signal: AbortSignal | undefined;
    const providerRun = vi.fn(async (request: ProviderRunRequest) => {
      signal = request.signal;
      await finish.promise;
      return emptyAgentResult("finished normally");
    });
    service.providers.register(
      provider(providerRun, {
        capabilities: {
          contextModes: ["fresh", "explicit"],
          continuable: true,
          interruptible: false,
          structuredOutput: false,
        },
      }),
    );

    const running = service.start({ task: "cannot interrupt" });
    await vi.waitFor(() => expect(providerRun).toHaveBeenCalledOnce());
    const runId = service.listSessions()[0]!.latestRunId!;

    expect(service.interrupt(runId)).toBe(false);
    expect(signal?.aborted).toBe(false);
    expect(service.getRun(runId)?.status).toBe("running");

    finish.resolve();
    await expect(running).resolves.toMatchObject({
      output: "finished normally",
    });
    expect(service.getRun(runId)?.status).toBe("completed");
    expect(service.interrupt(runId)).toBe(false);
    runtime.dispose();
  });

  it("fails loudly when a provider or capability is unavailable", async () => {
    const runtime = new WorkbenchRuntimeHost();
    const service = new SubagentService(runtime);

    await expect(
      service.start({ task: "missing", isolation: "process" }),
    ).rejects.toBeInstanceOf(ProviderUnavailableError);

    service.providers.register(
      provider(async () => emptyAgentResult("never"), {
        capabilities: {
          contextModes: ["fresh"],
          continuable: false,
          interruptible: true,
          structuredOutput: false,
        },
      }),
    );
    await expect(
      service.start({
        task: "unsupported",
        contextMode: "fork",
      }),
    ).rejects.toBeInstanceOf(ProviderCapabilityError);
    runtime.dispose();
  });
});
