import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import {
  PiRpcProcessProvider,
  PiRpcProviderError,
  defaultSubagentSessionDir,
  type PiRpcProcessProviderOptions,
} from "pi-tsien-subagent-workbench/src/providers/pi-rpc-process-provider.ts";
import {
  SubagentExecutionError,
  SubagentService,
} from "pi-tsien-subagent-workbench/src/subagent-service.ts";
import { WorkbenchRuntimeHost } from "pi-tsien-subagent-workbench/src/runtime.ts";

// Never write child sessions to the real agent dir during tests.
process.env.PI_SUBAGENT_SESSION_DIR = "off";

const fakeRpcPath = fileURLToPath(
  new URL("./fixtures/fake-pi-rpc.mjs", import.meta.url),
);

function harness(options: PiRpcProcessProviderOptions = {}) {
  const runtime = new WorkbenchRuntimeHost({ activeLimit: 4, queueLimit: 8 });
  const provider = new PiRpcProcessProvider({
    executable: process.execPath,
    baseArgs: [fakeRpcPath],
    commandTimeoutMs: 2_000,
    runIdleWarningMs: 5_000,
    hardRunWallTimeMs: 10_000,
    shutdownTimeoutMs: 500,
    heartbeatIntervalMs: 20,
    ...options,
  });
  const service = new SubagentService(runtime);
  service.providers.register(provider);
  return {
    runtime,
    provider,
    service,
    async dispose() {
      await provider.dispose();
      runtime.dispose();
    },
  };
}

async function executionCause(
  promise: Promise<unknown>,
): Promise<PiRpcProviderError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(SubagentExecutionError);
    const cause = (error as SubagentExecutionError).cause;
    expect(cause).toBeInstanceOf(PiRpcProviderError);
    return cause as PiRpcProviderError;
  }
  throw new Error("Expected SubagentExecutionError.");
}

describe("PiRpcProcessProvider", () => {
  it("keeps one RPC process and conversation across ChildSession Runs", async () => {
    const test = harness();
    try {
      const first = await test.service.start({
        task: "remember: RPC_SECRET_42",
        isolation: "process",
        cwd: process.cwd(),
      });
      const firstPid = test.provider.snapshot().processIds[0];
      const second = await test.service.start({
        task: "what was remembered",
        sessionId: first.sessionId,
        isolation: "process",
        cwd: process.cwd(),
      });

      expect(second.output).toBe("RPC_SECRET_42");
      expect(second.sessionId).toBe(first.sessionId);
      expect(test.provider.snapshot()).toMatchObject({
        sessions: 1,
        active: 0,
        unavailable: 0,
        processIds: [firstPid],
      });
      expect(second.usage).toEqual({
        input: 10,
        output: 2,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0.001,
      });
    } finally {
      await test.dispose();
    }
  });

  it("exposes only the role's tools to the child process", async () => {
    const test = harness();
    try {
      const result = await test.service.start({
        task: "report-argv",
        isolation: "process",
        cwd: process.cwd(),
        allowedTools: ["read", "bash"],
      });
      const args = JSON.parse(result.output) as string[];
      expect(args[args.indexOf("--tools") + 1]).toBe("read,bash");
    } finally {
      await test.dispose();
    }
  });

  it("persists child sessions under the agent dir unless told otherwise", () => {
    expect(
      defaultSubagentSessionDir({ PI_CODING_AGENT_DIR: "/tmp/agent" }),
    ).toBe(path.join("/tmp/agent", "subagent-sessions"));
    expect(
      defaultSubagentSessionDir({
        PI_CODING_AGENT_DIR: "/tmp/agent",
        PI_SUBAGENT_SESSION_DIR: "off",
      }),
    ).toBeUndefined();
    expect(
      defaultSubagentSessionDir({
        PI_CODING_AGENT_DIR: "/tmp/agent",
        PI_SUBAGENT_SESSION_DIR: "/mnt/data/subs",
      }),
    ).toBe("/mnt/data/subs");
  });

  it("passes --session-dir so child tool calls stay readable", async () => {
    const test = harness({ sessionDir: "/tmp/child-sessions" });
    try {
      const result = await test.service.start({
        task: "report-argv",
        isolation: "process",
        cwd: process.cwd(),
      });
      const args = JSON.parse(result.output) as string[];
      expect(args).not.toContain("--no-session");
      expect(args[args.indexOf("--session-dir") + 1]).toBe("/tmp/child-sessions");
    } finally {
      await test.dispose();
    }
  });

  it("stays ephemeral when sessionDir is null", async () => {
    const test = harness({ sessionDir: null });
    try {
      const result = await test.service.start({
        task: "report-argv",
        isolation: "process",
        cwd: process.cwd(),
      });
      const args = JSON.parse(result.output) as string[];
      expect(args).toContain("--no-session");
      expect(args).not.toContain("--session-dir");
    } finally {
      await test.dispose();
    }
  });

  it("loads tools, extensions, skills, and templates by default", async () => {
    const test = harness();
    try {
      const result = await test.service.start({
        task: "report-argv",
        isolation: "process",
        cwd: process.cwd(),
        thinking: "high",
      });
      const args = JSON.parse(result.output) as string[];
      expect(args).not.toContain("--no-tools");
      expect(args).not.toContain("--no-extensions");
      expect(args).not.toContain("--no-skills");
      expect(args).not.toContain("--no-prompt-templates");
      // Children get the role/generic subagent prompt instead of the main
      // agent's context files, so --no-context-files is expected here.
      expect(args).toContain("--no-context-files");
      expect(args).toContain("--append-system-prompt");
      expect(args).toContain("--thinking");
      expect(args).toContain("high");
      await expect(
        test.service.start({
          task: "report-argv",
          sessionId: result.sessionId,
          isolation: "process",
          cwd: process.cwd(),
          thinking: "low",
        }),
      ).rejects.toMatchObject({
        cause: expect.objectContaining({ code: "session_configuration_mismatch" }),
      });
    } finally {
      await test.dispose();
    }
  });

  it("supports an explicitly restricted child runtime", async () => {
    const runtime = new WorkbenchRuntimeHost();
    const provider = new PiRpcProcessProvider({
      executable: process.execPath,
      baseArgs: [fakeRpcPath],
      allowTools: false,
      loadExtensions: false,
      loadSkills: false,
      loadPromptTemplates: false,
      loadContextFiles: false,
      commandTimeoutMs: 2_000,
      runTimeoutMs: 5_000,
      shutdownTimeoutMs: 500,
    });
    const service = new SubagentService(runtime);
    service.providers.register(provider);
    try {
      const result = await service.start({
        task: "report-argv",
        isolation: "process",
        cwd: process.cwd(),
      });
      const args = JSON.parse(result.output) as string[];
      expect(args).toEqual(
        expect.arrayContaining([
          "--no-tools",
          "--no-extensions",
          "--no-skills",
          "--no-prompt-templates",
          "--no-context-files",
        ]),
      );
    } finally {
      await provider.dispose();
      runtime.dispose();
    }
  });

  it("uses a separate startup timeout for cold RPC readiness", async () => {
    const runtime = new WorkbenchRuntimeHost();
    const provider = new PiRpcProcessProvider({
      executable: process.execPath,
      baseArgs: [fakeRpcPath],
      environment: { FAKE_RPC_STARTUP_DELAY_MS: "60" },
      commandTimeoutMs: 20,
      startupTimeoutMs: 1_000,
      runTimeoutMs: 2_000,
      shutdownTimeoutMs: 500,
    });
    const service = new SubagentService(runtime);
    service.providers.register(provider);
    try {
      const result = await service.start({
        task: "cold-start-ready",
        isolation: "process",
        cwd: process.cwd(),
      });
      expect(result.output).toContain("cold-start-ready");
      expect(provider.snapshot().acceptedRuns).toBe(1);
    } finally {
      await provider.dispose();
      runtime.dispose();
    }
  });

  it("atomically reserves a session before cold RPC startup", async () => {
    const test = harness({
      environment: { FAKE_RPC_STARTUP_DELAY_MS: "150" },
      startupTimeoutMs: 1_000,
    });
    try {
      const first = test.service.start({
        task: "cold-owner",
        isolation: "process",
        cwd: process.cwd(),
      });
      await vi.waitFor(() =>
        expect(test.provider.snapshot()).toMatchObject({
          sessions: 1,
          active: 1,
          acceptedRuns: 0,
        }),
      );
      const session = test.service.listSessions()[0]!;

      const busy = await executionCause(
        test.service.start({
          task: "must-not-share-cold-start",
          sessionId: session.id,
          isolation: "process",
          cwd: process.cwd(),
        }),
      );
      expect(busy.code).toBe("session_busy");
      await expect(first).resolves.toMatchObject({ sessionId: session.id });
      expect(test.provider.snapshot()).toMatchObject({
        sessions: 1,
        active: 0,
        acceptedRuns: 1,
      });
    } finally {
      await test.dispose();
    }
  });

  it("does not resurrect or leak a session closed during startup", async () => {
    const test = harness({
      environment: { FAKE_RPC_STARTUP_DELAY_MS: "200" },
      startupTimeoutMs: 1_000,
    });
    try {
      const starting = test.service.start({
        task: "close-during-startup",
        isolation: "process",
        cwd: process.cwd(),
      });
      await vi.waitFor(() =>
        expect(test.provider.snapshot()).toMatchObject({
          sessions: 1,
          active: 1,
        }),
      );
      const session = test.service.listSessions()[0]!;

      await expect(
        test.provider.closeSession(session.id, "Closed during startup."),
      ).resolves.toBe(true);
      await expect(starting).rejects.toBeInstanceOf(SubagentExecutionError);
      expect(test.provider.snapshot()).toMatchObject({
        sessions: 0,
        active: 0,
        unavailable: 1,
        processIds: [],
      });

      const unavailable = await executionCause(
        test.service.start({
          task: "must-not-resurrect",
          sessionId: session.id,
          isolation: "process",
          cwd: process.cwd(),
        }),
      );
      expect(unavailable.code).toBe("session_unavailable");
    } finally {
      await test.dispose();
    }
  });

  it("does not resurrect or leak a session when dispose races startup", async () => {
    const test = harness({
      environment: { FAKE_RPC_STARTUP_DELAY_MS: "200" },
      startupTimeoutMs: 1_000,
    });
    try {
      const starting = test.service.start({
        task: "dispose-during-startup",
        isolation: "process",
        cwd: process.cwd(),
      });
      await vi.waitFor(() =>
        expect(test.provider.snapshot()).toMatchObject({
          sessions: 1,
          active: 1,
        }),
      );

      const disposing = test.provider.dispose();
      await expect(starting).rejects.toBeInstanceOf(SubagentExecutionError);
      await disposing;
      expect(test.provider.snapshot()).toMatchObject({
        sessions: 0,
        active: 0,
        unavailable: 1,
        processIds: [],
      });
    } finally {
      await test.dispose();
    }
  });

  it("passes explicit context through a bounded envelope", async () => {
    const test = harness();
    try {
      const result = await test.service.start({
        task: "use context",
        contextMode: "explicit",
        context: "EXPLICIT_VALUE",
        isolation: "process",
        cwd: process.cwd(),
      });
      expect(result.output).toBe("context:EXPLICIT_VALUE");
    } finally {
      await test.dispose();
    }
  });

  it("fails loudly instead of overlapping Runs in one RPC session", async () => {
    const test = harness();
    try {
      const first = test.service.start({
        task: "wait-for-abort",
        isolation: "process",
        cwd: process.cwd(),
      });
      await vi.waitFor(() => expect(test.provider.snapshot().active).toBe(1));
      const session = test.service.listSessions()[0]!;
      const busy = await executionCause(
        test.service.start({
          task: "must-not-overlap",
          sessionId: session.id,
          isolation: "process",
          cwd: process.cwd(),
        }),
      );
      expect(busy.code).toBe("session_busy");

      const updatedSession = test.service.getSession(session.id)!;
      expect(test.service.interrupt(updatedSession.latestRunId!)).toBe(false);
      const runningRun = session.runIds[0]!;
      expect(test.service.interrupt(runningRun)).toBe(true);
      await expect(first).rejects.toBeInstanceOf(SubagentExecutionError);
      expect(test.provider.snapshot().active).toBe(0);
      expect(test.runtime.getSnapshot().governor.active).toBe(0);
    } finally {
      await test.dispose();
    }
  });

  it("maps abort to interrupted while preserving the ChildSession", async () => {
    const test = harness();
    try {
      const running = test.service.start({
        task: "wait-for-abort",
        label: "RPC persistent",
        isolation: "process",
        cwd: process.cwd(),
      });
      await vi.waitFor(() => expect(test.provider.snapshot().active).toBe(1));
      const session = test.service.listSessions()[0]!;
      expect(test.service.interrupt(session.latestRunId!)).toBe(true);
      await expect(running).rejects.toBeInstanceOf(SubagentExecutionError);
      expect(test.service.getRun(session.latestRunId!)?.status).toBe(
        "interrupted",
      );
      expect(test.service.getSession(session.id)?.label).toBe("RPC persistent");
      expect(test.provider.snapshot().sessions).toBe(1);
    } finally {
      await test.dispose();
    }
  });

  it.each([
    ["write failure", "wait-for-abort-write-failure", 2_000],
    ["timeout", "wait-for-abort-timeout", 30],
  ])(
    "keeps an Abort %s Run active until process exit is confirmed",
    async (_failure, task, commandTimeoutMs) => {
      const test = harness({
        environment: { FAKE_RPC_SIGTERM_DELAY_MS: "300" },
        commandTimeoutMs,
        shutdownTimeoutMs: 1_000,
      });
      try {
        const running = test.service.start({
          task,
          isolation: "process",
          cwd: process.cwd(),
        });
        const settled = running.catch((error: unknown) => error);
        await vi.waitFor(() =>
          expect(test.provider.snapshot()).toMatchObject({
            active: 1,
            acceptedRuns: 1,
          }),
        );
        const session = test.service.listSessions()[0]!;
        expect(test.service.interrupt(session.latestRunId!)).toBe(true);

        await vi.waitFor(
          () => expect(test.provider.snapshot().unavailable).toBe(1),
          { timeout: Math.max(2_000, commandTimeoutMs + 1_000) },
        );
        expect(test.provider.snapshot()).toMatchObject({
          sessions: 1,
          active: 1,
          unavailable: 1,
        });

        expect(await settled).toBeInstanceOf(SubagentExecutionError);
        expect(test.provider.snapshot()).toMatchObject({
          sessions: 0,
          active: 0,
          unavailable: 1,
          processIds: [],
        });
        expect(test.runtime.getSnapshot().governor.active).toBe(0);
      } finally {
        await test.dispose();
      }
    },
  );

  it("tombstones a crashed process so continuation cannot lose context silently", async () => {
    const test = harness();
    try {
      let sessionId = "";
      try {
        await test.service.start({
          task: "crash-now",
          isolation: "process",
          cwd: process.cwd(),
        });
      } catch (error) {
        expect(error).toBeInstanceOf(SubagentExecutionError);
        sessionId = (error as SubagentExecutionError).sessionId;
        expect((error as SubagentExecutionError).cause).toBeInstanceOf(
          PiRpcProviderError,
        );
      }
      expect(sessionId).not.toBe("");
      expect(test.provider.snapshot()).toMatchObject({
        sessions: 0,
        unavailable: 1,
      });

      const unavailable = await executionCause(
        test.service.start({
          task: "continue-after-crash",
          sessionId,
          isolation: "process",
          cwd: process.cwd(),
        }),
      );
      expect(unavailable.code).toBe("session_unavailable");
      expect(test.runtime.getSnapshot().governor.active).toBe(0);
    } finally {
      await test.dispose();
    }
  });

  it("allows meaningful RPC progress to defer idle warnings", async () => {
    const runtime = new WorkbenchRuntimeHost();
    const provider = new PiRpcProcessProvider({
      executable: process.execPath,
      baseArgs: [fakeRpcPath],
      commandTimeoutMs: 2_000,
      runIdleWarningMs: 100,
      runWallWarningMs: 1_000,
      warningRepeatMs: 1_000,
      hardRunWallTimeMs: 2_000,
      timeoutAbortGraceMs: 100,
      shutdownTimeoutMs: 500,
      heartbeatIntervalMs: 20,
    });
    const service = new SubagentService(runtime);
    service.providers.register(provider);
    const warnings: unknown[] = [];
    service.subscribe((event) => {
      if (event.type === "provider-event" && event.event.type === "run-warning") {
        warnings.push(event.event);
      }
    });
    try {
      const result = await service.start({
        task: "progress-for:260:20",
        isolation: "process",
        cwd: process.cwd(),
      });
      expect(result.output).toBe("progress complete");
      expect(warnings).toEqual([]);
      expect(provider.snapshot()).toMatchObject({
        sessions: 1,
        active: 0,
        unavailable: 0,
      });
    } finally {
      await provider.dispose();
      runtime.dispose();
    }
  });

  it("warns repeatedly for an idle Run without letting RPC heartbeats mask it", async () => {
    const runtime = new WorkbenchRuntimeHost();
    const provider = new PiRpcProcessProvider({
      executable: process.execPath,
      baseArgs: [fakeRpcPath],
      commandTimeoutMs: 2_000,
      runIdleWarningMs: 50,
      runWallWarningMs: 1_000,
      warningRepeatMs: 40,
      hardRunWallTimeMs: false,
      timeoutAbortGraceMs: 100,
      shutdownTimeoutMs: 500,
      heartbeatIntervalMs: 20,
    });
    const service = new SubagentService(runtime);
    service.providers.register(provider);
    const abort = new AbortController();
    const warnings: Array<{ warning: string; idleMs?: number }> = [];
    service.subscribe((event) => {
      if (event.type === "provider-event" && event.event.type === "run-warning") {
        warnings.push(event.event);
      }
    });
    try {
      const run = service.start({
        task: "wait-for-abort",
        isolation: "process",
        cwd: process.cwd(),
        signal: abort.signal,
      });
      await vi.waitFor(() => expect(warnings.length).toBeGreaterThanOrEqual(2));
      expect(warnings[0]).toMatchObject({ warning: "idle" });
      expect(warnings[0]!.idleMs).toBeGreaterThanOrEqual(40);
      expect(provider.snapshot()).toMatchObject({
        sessions: 1,
        active: 1,
        unavailable: 0,
      });
      abort.abort(new Error("warning test complete"));
      await expect(run).rejects.toThrow("Run interrupted");
      expect(runtime.getSnapshot().governor.active).toBe(0);
    } finally {
      await provider.dispose();
      runtime.dispose();
    }
  });

  it("forces shutdown only at the hard wall limit when abort does not respond", async () => {
    const runtime = new WorkbenchRuntimeHost();
    const provider = new PiRpcProcessProvider({
      executable: process.execPath,
      baseArgs: [fakeRpcPath],
      commandTimeoutMs: 2_000,
      runIdleWarningMs: 30,
      runWallWarningMs: 40,
      warningRepeatMs: 1_000,
      hardRunWallTimeMs: 100,
      timeoutAbortGraceMs: 30,
      shutdownTimeoutMs: 500,
      heartbeatIntervalMs: 20,
    });
    const service = new SubagentService(runtime);
    service.providers.register(provider);
    try {
      const timeout = await executionCause(
        service.start({
          task: "wait-for-abort-timeout",
          isolation: "process",
          cwd: process.cwd(),
        }),
      );
      expect(timeout.code).toBe("run_wall_timeout");
      expect(timeout.message).toContain("hard wall time 100 ms");
      expect(provider.snapshot()).toMatchObject({
        sessions: 0,
        active: 0,
        unavailable: 1,
      });
      expect(runtime.getSnapshot().governor.active).toBe(0);
    } finally {
      await provider.dispose();
      runtime.dispose();
    }
  });

  it("emits a wall warning before enforcing the hard wall limit", async () => {
    const runtime = new WorkbenchRuntimeHost();
    const provider = new PiRpcProcessProvider({
      executable: process.execPath,
      baseArgs: [fakeRpcPath],
      commandTimeoutMs: 2_000,
      runIdleWarningMs: 500,
      runWallWarningMs: 50,
      warningRepeatMs: 1_000,
      hardRunWallTimeMs: 120,
      timeoutAbortGraceMs: 100,
      shutdownTimeoutMs: 500,
      heartbeatIntervalMs: 20,
    });
    const service = new SubagentService(runtime);
    service.providers.register(provider);
    const warnings: Array<{ warning: string; elapsedMs: number }> = [];
    service.subscribe((event) => {
      if (event.type === "provider-event" && event.event.type === "run-warning") {
        warnings.push(event.event);
      }
    });
    try {
      const timeout = await executionCause(
        service.start({
          task: "continuous-progress:20",
          isolation: "process",
          cwd: process.cwd(),
        }),
      );
      expect(warnings).toEqual([
        expect.objectContaining({ warning: "wall", elapsedMs: expect.any(Number) }),
      ]);
      expect(timeout.code).toBe("run_wall_timeout");
      expect(timeout.message).toContain("hard wall time 120 ms");
      expect(provider.snapshot()).toMatchObject({
        sessions: 0,
        active: 0,
        unavailable: 1,
      });
      expect(runtime.getSnapshot().governor.active).toBe(0);
    } finally {
      await provider.dispose();
      runtime.dispose();
    }
  });

  it("emits one soft deadline for a bounded child before enforcing the unchanged hard limit", async () => {
    const runtime = new WorkbenchRuntimeHost();
    const provider = new PiRpcProcessProvider({
      executable: process.execPath, baseArgs: [fakeRpcPath], commandTimeoutMs: 2_000,
      runIdleWarningMs: 10_000, runWallWarningMs: 10_000, timeoutAbortGraceMs: 100,
      shutdownTimeoutMs: 500, heartbeatIntervalMs: 20,
    });
    const service = new SubagentService(runtime);
    service.providers.register(provider);
    const events: unknown[] = [];
    service.subscribe(event => {
      if (event.type === "provider-event" && event.event.type === "run-warning") events.push(event.event);
    });
    try {
      const timeout = await executionCause(service.start({
        task: "continuous-progress:20", isolation: "process", cwd: process.cwd(), hardWallTimeMs: 1_200,
      }));
      expect(events).toEqual([expect.objectContaining({ warning: "soft-deadline", deadlineAt: expect.any(Number) })]);
      expect(timeout.code).toBe("run_wall_timeout");
      expect(timeout.message).toContain("hard wall time 1200 ms");
    } finally {
      await provider.dispose();
      runtime.dispose();
    }
  });

  it("extends the same live RPC run once, rejects excess, and enforces the new cutoff", async () => {
    const runtime = new WorkbenchRuntimeHost();
    const provider = new PiRpcProcessProvider({
      executable: process.execPath, baseArgs: [fakeRpcPath], commandTimeoutMs: 2_000,
      runIdleWarningMs: 10_000, runWallWarningMs: 10_000, timeoutAbortGraceMs: 100,
      shutdownTimeoutMs: 500, heartbeatIntervalMs: 20,
    });
    const service = new SubagentService(runtime);
    service.providers.register(provider);
    let runId: string | undefined;
    const extensions: unknown[] = [];
    service.subscribe(event => {
      if (event.type !== "provider-event" || event.event.type !== "run-warning" || event.event.warning !== "soft-deadline") return;
      runId = event.runId;
      extensions.push(provider.extendRunDeadline(runId, 401));
      extensions.push(provider.extendRunDeadline(runId, 400));
      extensions.push(provider.extendRunDeadline(runId, 1));
    });
    try {
      const timeout = await executionCause(service.start({
        task: "continuous-progress:20", isolation: "process", cwd: process.cwd(), hardWallTimeMs: 1_200, hardWallMaxMs: 2_400, workExtensionMaxMs: 400,
      }));
      expect(extensions).toEqual([
        expect.objectContaining({ ok: false, reason: expect.stringContaining("400 ms") }),
        expect.objectContaining({ ok: true, extendMs: 400 }),
        expect.objectContaining({ ok: false, reason: expect.stringContaining("already been extended") }),
      ]);
      expect(timeout.message).toContain("hard wall time 1600 ms");
      expect(provider.extendRunDeadline(runId!, 1).ok).toBe(false);
      expect(provider.snapshot()).toMatchObject({ active: 0 });
    } finally {
      await provider.dispose();
      runtime.dispose();
    }
  });

  it("honors a configured extension above five minutes without restarting the run", async () => {
    const runtime = new WorkbenchRuntimeHost();
    const provider = new PiRpcProcessProvider({
      executable: process.execPath, baseArgs: [fakeRpcPath], commandTimeoutMs: 2_000,
      runIdleWarningMs: 10_000, runWallWarningMs: 10_000, shutdownTimeoutMs: 500,
    });
    const service = new SubagentService(runtime);
    service.providers.register(provider);
    const abort = new AbortController();
    let available: number | undefined;
    let extension: ReturnType<typeof provider.extendRunDeadline> | undefined;
    service.subscribe(event => {
      if (event.type !== "provider-event" || event.event.type !== "run-warning" || event.event.warning !== "soft-deadline") return;
      available = event.event.maxExtensionMs;
      extension = provider.extendRunDeadline(event.runId, 360_000);
      abort.abort(new Error("test completed"));
    });
    try {
      await service.start({
        task: "continuous-progress:20", isolation: "process", cwd: process.cwd(), signal: abort.signal,
        hardWallTimeMs: 1_200, hardWallMaxMs: 361_200, workExtensionMaxMs: 600_000,
      }).catch(() => undefined);
      expect(available).toBe(360_000);
      expect(extension).toMatchObject({ ok: true, extendMs: 360_000 });
    } finally {
      await provider.dispose();
      runtime.dispose();
    }
  });

  it("bounds retained RPC processes with a fail-loud session limit", async () => {
    const runtime = new WorkbenchRuntimeHost({ activeLimit: 2 });
    const provider = new PiRpcProcessProvider({
      executable: process.execPath,
      baseArgs: [fakeRpcPath],
      maxSessions: 1,
      commandTimeoutMs: 2_000,
      runTimeoutMs: 5_000,
      shutdownTimeoutMs: 500,
    });
    const service = new SubagentService(runtime);
    service.providers.register(provider);
    try {
      const first = await service.start({
        task: "first",
        isolation: "process",
        cwd: process.cwd(),
      });
      const capacity = await executionCause(
        service.start({
          task: "second-session",
          isolation: "process",
          cwd: process.cwd(),
        }),
      );
      expect(capacity.code).toBe("provider_capacity");
      expect(provider.snapshot()).toMatchObject({ sessions: 1, limit: 1 });

      expect(await provider.closeSession(first.sessionId)).toBe(true);
      const replacement = await service.start({
        task: "replacement",
        isolation: "process",
        cwd: process.cwd(),
      });
      expect(replacement.output).toContain("replacement");
      expect(provider.snapshot().sessions).toBe(1);
    } finally {
      await provider.dispose();
      runtime.dispose();
    }
  });

  it("stops all persistent processes idempotently", async () => {
    const test = harness();
    await test.service.start({
      task: "first",
      isolation: "process",
      cwd: process.cwd(),
    });
    expect(test.provider.snapshot().processIds).toHaveLength(1);

    await test.provider.dispose();
    await test.provider.dispose();
    expect(test.provider.snapshot()).toMatchObject({
      sessions: 0,
      active: 0,
      unavailable: 1,
      processIds: [],
    });
    test.runtime.dispose();
  });
});

describe("PiRpcProcessProvider activity keys", () => {
  it("keys a workflow task run by its taskId, not by the parent job", async () => {
    const { jobActivityTracker } = await import(
      "pi-tsien-subagent-workbench/src/job-activity.ts"
    );
    const test = harness();
    const activityKey = "workflow_test:task:1:1";
    const parentWorkId = "work_parent";
    const started = test.service.start({
      task: "progress-for:3:300",
      isolation: "process",
      cwd: process.cwd(),
      traceContext: {
        parentSessionId: "session_parent",
        parentToolCallId: "call_parent",
        workflowId: "workflow_test",
        workId: parentWorkId,
        taskId: activityKey,
        taskKey: "first",
        stageIndex: 0,
      },
    } as never);
    try {
      // Observed while the run is still emitting progress.
      await vi.waitFor(
        () => {
          expect(jobActivityTracker().get(activityKey)?.eventCount).toBeGreaterThan(0);
        },
        { timeout: 15_000, interval: 20 },
      );
      // The parent job key saw nothing: a busy sibling can no longer mask this
      // task's own idle time.
      expect(jobActivityTracker().get(parentWorkId)).toBeUndefined();

      const result = await started;
      expect(result.isError).toBe(false);
      // A settled run leaves nothing behind, so a restart cannot resurrect it.
      expect(jobActivityTracker().get(activityKey)).toBeUndefined();
    } finally {
      await started.catch(() => undefined);
      await test.dispose();
    }
  }, 30_000);
});
