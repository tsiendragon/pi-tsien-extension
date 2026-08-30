import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import runningCommandsExtension from "../extensions/running-commands.ts";
import { readBackgroundCommandsSettings } from "../extensions/lib/background-commands/config.ts";
import {
  BACKGROUND_COMMAND_MANAGER_SYMBOL_KEY,
  BackgroundCommandManager,
} from "../extensions/lib/background-commands/manager.ts";
import { registerBackgroundCommandTools } from "../extensions/lib/background-commands/tools.ts";
import { BackgroundCommandsDashboardAdapter } from "../extensions/lib/background-commands/dashboard-bridge.ts";
import { registerForegroundHandoffBashTool } from "../extensions/lib/background-commands/foreground-handoff.ts";

const cwd = "/mnt/workspace/lilong/repos/pi-tsien-extension";

async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`condition was not met within ${timeoutMs}ms`);
}

async function createManager(options: ConstructorParameters<typeof BackgroundCommandManager>[0] = {}) {
  const outputRoot = await mkdtemp(join(tmpdir(), "pi-background-test-"));
  let nextId = 0;
  const manager = new BackgroundCommandManager({
    outputRoot,
    killGraceMs: 100,
    reloadGraceMs: 100,
    updateThrottleMs: 10,
    idFactory: () => `bash-t${String(nextId++).padStart(3, "0")}`,
    ...options,
  });
  await manager.bindSession("session-test");
  return { manager, outputRoot };
}

async function cleanupManager(manager: BackgroundCommandManager, outputRoot: string): Promise<void> {
  await manager.shutdown();
  await rm(outputRoot, { recursive: true, force: true });
}

function startRequest(command: string, timeoutSeconds?: number, title?: string) {
  return {
    command,
    title,
    cwd,
    sessionId: "session-test",
    timeoutSeconds,
  };
}

interface ExecutableTool {
  readonly name: string;
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: unknown,
  ): Promise<{ content: Array<{ type: string; text: string }> }>;
}

function toolContext(notifications: string[] = []) {
  return {
    mode: "tui",
    hasUI: true,
    cwd,
    model: undefined,
    thinkingLevel: undefined,
    sessionManager: {
      getSessionId: () => "session-test",
      getSessionFile: () => undefined,
    },
    isProjectTrusted: () => true,
    ui: {
      notify: (message: string) => notifications.push(message),
    },
  };
}

test("start returns a running task promptly and persists complete output", async () => {
  const { manager, outputRoot } = await createManager();
  try {
    const started = performance.now();
    const task = await manager.start(startRequest(
      "printf 'first\\n'; sleep 0.25; printf 'done\\n'",
      undefined,
      "Linux build",
    ));
    assert.ok(performance.now() - started < 500, "start should return within 500ms");
    assert.equal(task.state, "running");
    assert.equal(task.title, "Linux build");
    assert.equal(manager.registry.snapshot()[0]?.title, "Linux build");
    assert.equal(task.owner, "agent-bash");
    assert.equal(task.mode, "background");
    assert.equal(manager.activeCount, 1);
    assert.equal(manager.registry.snapshot()[0]?.mode, "background");

    const finished = await manager.waitForTask(task.id);
    assert.equal(finished.state, "succeeded");
    assert.equal(finished.exitCode, 0);
    assert.equal(await readFile(finished.outputFile, "utf8"), "first\ndone\n");
    assert.equal((await stat(finished.outputFile)).mode & 0o777, 0o600);
    assert.match(manager.output(task.id).output, /first\ndone/u);
    assert.equal(manager.pendingCompletions().length, 1);
    manager.markCompletionDelivered(task.id);
    assert.equal(manager.pendingCompletions().length, 0);
  } finally {
    await cleanupManager(manager, outputRoot);
  }
});

test("foreground handoff keeps the same process and detaches the Tool abort signal", {
  skip: process.platform === "win32" ? "Windows process-tree support is experimental" : false,
}, async () => {
  const { manager, outputRoot } = await createManager();
  const controller = new AbortController();
  const foregroundOutput: Buffer[] = [];
  try {
    const foreground = manager.executeForeground({
      toolCallId: "foreground-handoff",
      command: "printf 'pid=%s\\n' \"$$\"; printf 'before\\n'; sleep 0.15; printf 'after\\n'",
      cwd,
      sessionId: "session-test",
      startedAt: 123,
      signal: controller.signal,
      onData: (data) => foregroundOutput.push(Buffer.from(data)),
    });
    await waitUntil(() => manager.foregroundCount === 1 && Buffer.concat(foregroundOutput).includes("before"));

    const task = manager.backgroundForeground("foreground-handoff");
    const released = await foreground;
    assert.equal(released.exitCode, 0);
    assert.equal(task.startedAt, 123);
    assert.equal(task.state, "running");
    assert.equal(manager.foregroundCount, 0);
    assert.equal(manager.taskCount, 1);
    assert.match(Buffer.concat(foregroundOutput).toString("utf8"), new RegExp(`Command moved to background as task ${task.id}`));

    controller.abort();
    const finished = await manager.waitForTask(task.id);
    assert.equal(finished.state, "succeeded");
    const output = await readFile(finished.outputFile, "utf8");
    assert.equal(output.match(/before/gu)?.length, 1);
    assert.equal(output.match(/after/gu)?.length, 1);
    assert.equal(output.includes("Command moved to background"), false);
    assert.equal(Number(/^pid=(\d+)/u.exec(output)?.[1]), task.pid);
  } finally {
    await cleanupManager(manager, outputRoot);
  }
});

test("foreground completion without handoff returns normally and leaves no background task", async () => {
  const { manager, outputRoot } = await createManager();
  const output: Buffer[] = [];
  try {
    const result = await manager.executeForeground({
      toolCallId: "foreground-natural",
      command: "printf 'natural\\n'",
      cwd,
      sessionId: "session-test",
      onData: (data) => output.push(Buffer.from(data)),
    });
    assert.equal(result.exitCode, 0);
    assert.equal(Buffer.concat(output).toString("utf8"), "natural\n");
    assert.equal(manager.foregroundCount, 0);
    assert.equal(manager.taskCount, 0);
    assert.deepEqual(manager.list(), []);
    assert.deepEqual(manager.pendingCompletions(), []);
  } finally {
    await cleanupManager(manager, outputRoot);
  }
});

test("controllable Bash Tool returns one successful handoff result and keeps the task running", async () => {
  const { manager, outputRoot } = await createManager();
  const tools = new Map<string, ExecutableTool>();
  const api = {
    registerTool(tool: ExecutableTool) {
      tools.set(tool.name, tool);
    },
  } as unknown as ExtensionAPI;
  const controller = new AbortController();
  try {
    registerForegroundHandoffBashTool(api, manager, cwd);
    const toolCallId = "bash-tool-handoff";
    manager.registry.start(toolCallId, { command: "printf 'tool-before\\n'; sleep 0.15; printf 'tool-after\\n'" }, 456);
    const execution = tools.get("bash")!.execute(
      toolCallId,
      { command: "printf 'tool-before\\n'; sleep 0.15; printf 'tool-after\\n'" },
      controller.signal,
      undefined,
      toolContext(),
    );
    await waitUntil(() => manager.foregroundCount === 1);
    const task = manager.backgroundForeground(toolCallId);
    const result = await execution;
    const resultText = result.content.map((part) => part.text).join("");
    assert.match(resultText, new RegExp(`Command moved to background as task ${task.id}`));
    assert.equal(resultText.includes("Use background_command_status"), true);

    controller.abort();
    const finished = await manager.waitForTask(task.id);
    assert.equal(finished.state, "succeeded");
    assert.match(manager.output(task.id).output, /tool-before\ntool-after/u);
  } finally {
    await cleanupManager(manager, outputRoot);
  }
});

test("parallel controllable Bash calls hand off only the selected toolCallId", async () => {
  const { manager, outputRoot } = await createManager();
  const tools = new Map<string, ExecutableTool>();
  const api = {
    registerTool(tool: ExecutableTool) {
      tools.set(tool.name, tool);
    },
  } as unknown as ExtensionAPI;
  try {
    registerForegroundHandoffBashTool(api, manager, cwd);
    const bash = tools.get("bash")!;
    manager.registry.start("parallel-a", { command: "printf 'A-start\\n'; sleep 0.3; printf 'A-end\\n'" }, 100);
    manager.registry.start("parallel-b", { command: "printf 'B-start\\n'; sleep 0.15; printf 'B-end\\n'" }, 200);
    const executionA = bash.execute(
      "parallel-a",
      { command: "printf 'A-start\\n'; sleep 0.3; printf 'A-end\\n'" },
      undefined,
      undefined,
      toolContext(),
    );
    const executionB = bash.execute(
      "parallel-b",
      { command: "printf 'B-start\\n'; sleep 0.15; printf 'B-end\\n'" },
      undefined,
      undefined,
      toolContext(),
    );
    await waitUntil(() => manager.foregroundCount === 2);

    const taskB = manager.backgroundForeground("parallel-b");
    const resultB = await executionB;
    assert.equal(resultB.content[0]?.text.includes(taskB.id), true);
    assert.equal(manager.foregroundCount, 1);
    assert.throws(() => manager.get(taskB.id.replace(/.$/u, "x")), /not found/u);

    const resultA = await executionA;
    assert.match(resultA.content[0]?.text ?? "", /A-start\nA-end/u);
    assert.equal((await manager.waitForTask(taskB.id)).state, "succeeded");
    assert.match(manager.output(taskB.id).output, /B-start\nB-end/u);
  } finally {
    await cleanupManager(manager, outputRoot);
  }
});

test("handoff rejection at the background limit leaves the command in foreground", async () => {
  const { manager, outputRoot } = await createManager({ maxConcurrent: 1 });
  try {
    const occupied = await manager.start(startRequest("sleep 30"));
    const foreground = manager.executeForeground({
      toolCallId: "handoff-at-limit",
      command: "printf 'still-foreground\\n'; sleep 0.1",
      cwd,
      sessionId: "session-test",
      onData() {},
    });
    await waitUntil(() => manager.foregroundCount === 1);
    assert.throws(
      () => manager.backgroundForeground("handoff-at-limit"),
      /already has 1 active tasks/u,
    );
    assert.equal(manager.foregroundCount, 1);
    assert.equal((await foreground).exitCode, 0);
    assert.equal(manager.foregroundCount, 0);
    assert.equal(manager.taskCount, 1);
    await manager.cancel(occupied.id);
  } finally {
    await cleanupManager(manager, outputRoot);
  }
});

test("foreground abort wins before Ctrl+B and creates no background task", async () => {
  const { manager, outputRoot } = await createManager();
  const controller = new AbortController();
  try {
    const execution = manager.executeForeground({
      toolCallId: "abort-before-handoff",
      command: "sleep 30",
      cwd,
      sessionId: "session-test",
      signal: controller.signal,
      onData() {},
    });
    await waitUntil(() => manager.foregroundCount === 1);
    controller.abort();
    await assert.rejects(execution, /aborted/u);
    assert.throws(
      () => manager.backgroundForeground("abort-before-handoff"),
      /no longer running/u,
    );
    assert.equal(manager.foregroundCount, 0);
    assert.equal(manager.taskCount, 0);
  } finally {
    await cleanupManager(manager, outputRoot);
  }
});

test("foreground timeout remains active after handoff", async () => {
  const { manager, outputRoot } = await createManager();
  try {
    const foreground = manager.executeForeground({
      toolCallId: "timeout-after-handoff",
      command: "sleep 30",
      cwd,
      sessionId: "session-test",
      timeoutSeconds: 0.05,
      onData() {},
    });
    await waitUntil(() => manager.foregroundCount === 1);
    const task = manager.backgroundForeground("timeout-after-handoff");
    assert.equal((await foreground).exitCode, 0);
    const finished = await manager.waitForTask(task.id);
    assert.equal(finished.state, "timed_out");
    assert.equal(finished.exitReason, "timeout");
    assert.equal(finished.timeoutMs, 50);
  } finally {
    await cleanupManager(manager, outputRoot);
  }
});

test("non-zero exit and timeout produce distinct terminal states", async () => {
  const { manager, outputRoot } = await createManager();
  try {
    const failed = await manager.start(startRequest("printf 'bad\\n' >&2; exit 7"));
    const failedResult = await manager.waitForTask(failed.id);
    assert.equal(failedResult.state, "failed");
    assert.equal(failedResult.exitCode, 7);
    assert.equal(failedResult.exitReason, "exit");

    const timed = await manager.start(startRequest("sleep 30", 0.05));
    const timedResult = await manager.waitForTask(timed.id);
    assert.equal(timedResult.state, "timed_out");
    assert.equal(timedResult.exitReason, "timeout");
  } finally {
    await cleanupManager(manager, outputRoot);
  }
});

test("output limit terminates the task and caps the log file", async () => {
  const { manager, outputRoot } = await createManager({ maxOutputBytes: 1_024, maxTailBytes: 256 });
  try {
    const task = await manager.start(startRequest("head -c 8192 /dev/zero | tr '\\0' x"));
    const result = await manager.waitForTask(task.id);
    assert.equal(result.state, "failed");
    assert.equal(result.exitReason, "output_limit");
    assert.equal(result.outputBytes, 1_024);
    assert.equal((await stat(result.outputFile)).size, 1_024);
    assert.ok(Buffer.byteLength(result.outputTail, "utf8") <= 256);
    assert.equal(result.outputTruncated, true);
  } finally {
    await cleanupManager(manager, outputRoot);
  }
});

test("concurrency limit rejects instead of silently queueing", async () => {
  const { manager, outputRoot } = await createManager({ maxConcurrent: 1 });
  try {
    const first = await manager.start(startRequest("sleep 30"));
    await assert.rejects(
      manager.start(startRequest("sleep 30")),
      /already has 1 active tasks/u,
    );
    await manager.cancel(first.id);
  } finally {
    await cleanupManager(manager, outputRoot);
  }
});

test("cancel terminates the shell process group including child processes", {
  skip: process.platform === "win32" ? "Windows process-tree support is experimental" : false,
}, async () => {
  const { manager, outputRoot } = await createManager();
  try {
    const task = await manager.start(startRequest("sleep 30 & child=$!; printf '%s\\n' \"$child\"; wait"));
    let childPid = 0;
    await waitUntil(() => {
      const firstLine = manager.output(task.id, 10).output.trim().split("\n")[0];
      childPid = Number(firstLine);
      return Number.isSafeInteger(childPid) && childPid > 0;
    });

    const result = await manager.cancel(task.id);
    assert.equal(result.state, "cancelled");
    await waitUntil(() => {
      try {
        process.kill(childPid, 0);
        return false;
      } catch {
        return true;
      }
    });
  } finally {
    await cleanupManager(manager, outputRoot);
  }
});

test("cancel still kills descendants after the shell exit event but before stdio close", {
  skip: process.platform === "win32" ? "Windows process-tree support is experimental" : false,
}, async () => {
  const { manager, outputRoot } = await createManager();
  try {
    const task = await manager.start(startRequest("sleep 30 & child=$!; printf '%s\\n' \"$child\"; exit 0"));
    let childPid = 0;
    await waitUntil(() => {
      childPid = Number(manager.output(task.id, 10).output.trim().split("\n")[0]);
      return Number.isSafeInteger(childPid) && childPid > 0;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const result = await Promise.race([
      manager.cancel(task.id),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error("cancel waited for the 30-second child")), 2_000);
      }),
    ]);
    assert.equal(result.state, "cancelled");
    await waitUntil(() => {
      try {
        process.kill(childPid, 0);
        return false;
      } catch {
        return true;
      }
    });
  } finally {
    await cleanupManager(manager, outputRoot);
  }
});

test("reload grace keeps rebound tasks and cleans up an unbound manager", async () => {
  const { manager, outputRoot } = await createManager();
  try {
    const kept = await manager.start(startRequest("sleep 30"));
    manager.scheduleReloadCleanup();
    await new Promise((resolve) => setTimeout(resolve, 30));
    manager.cancelReloadCleanup();
    assert.equal(manager.get(kept.id).state, "running");
    await manager.cancel(kept.id);

    const abandoned = await manager.start(startRequest("sleep 30"));
    const outputFile = abandoned.outputFile;
    manager.scheduleReloadCleanup();
    await waitUntil(() => manager.taskCount === 0 && manager.currentSessionId === undefined, 2_000);
    await assert.rejects(access(outputFile));
    assert.deepEqual(await readdir(outputRoot), []);
  } finally {
    await cleanupManager(manager, outputRoot);
  }
});

test("shutdown wins a race with an in-flight start", async () => {
  const { manager, outputRoot } = await createManager();
  try {
    const starting = manager.start(startRequest("sleep 30"));
    const shuttingDown = manager.shutdown();
    await assert.rejects(starting, /shutting down/u);
    await shuttingDown;
    assert.equal(manager.taskCount, 0);
    assert.equal(manager.activeCount, 0);
  } finally {
    await cleanupManager(manager, outputRoot);
  }
});

test("output store rejects a symlink root", async () => {
  const base = await mkdtemp(join(tmpdir(), "pi-background-symlink-test-"));
  const target = join(base, "target");
  const link = join(base, "link");
  await mkdir(target);
  await symlink(target, link, "dir");
  const manager = new BackgroundCommandManager({ outputRoot: link });
  try {
    await assert.rejects(manager.bindSession("session-test"), /not a private directory/u);
  } finally {
    await manager.shutdown();
    await rm(base, { recursive: true, force: true });
  }
});

test("backgroundCommands.enabled supports global disable and project override", async () => {
  const base = await mkdtemp(join(tmpdir(), "pi-background-config-test-"));
  const agentDirectory = join(base, "agent");
  const projectDirectory = join(base, "project");
  const projectSettingsDirectory = join(projectDirectory, ".pi");
  const previous = process.env.PI_CODING_AGENT_DIR;
  await mkdir(agentDirectory, { recursive: true });
  await mkdir(projectSettingsDirectory, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = agentDirectory;
  try {
    await writeFile(join(agentDirectory, "settings.json"), JSON.stringify({
      backgroundCommands: { enabled: false },
    }));
    assert.equal(readBackgroundCommandsSettings(projectDirectory).enabled, false);
    await writeFile(join(projectSettingsDirectory, "settings.json"), JSON.stringify({
      backgroundCommands: { enabled: true },
    }));
    assert.equal(readBackgroundCommandsSettings(projectDirectory).enabled, false);
    assert.equal(readBackgroundCommandsSettings(projectDirectory, true).enabled, true);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(base, { recursive: true, force: true });
  }
});

test("disabled background Tools reject without starting a process", async () => {
  const { manager, outputRoot } = await createManager();
  const tools = new Map<string, ExecutableTool>();
  const api = {
    registerTool(tool: ExecutableTool) {
      tools.set(tool.name, tool);
    },
  } as unknown as ExtensionAPI;
  try {
    registerBackgroundCommandTools(api, manager, () => false);
    await assert.rejects(
      tools.get("background_command_start")!.execute(
        "disabled-start",
        { command: "sleep 30" },
        undefined,
        undefined,
        toolContext(),
      ),
      /disabled by backgroundCommands.enabled/u,
    );
    assert.equal(manager.taskCount, 0);
  } finally {
    await cleanupManager(manager, outputRoot);
  }
});

test("Extension config disable removes Tools and a later enable restores them", async () => {
  const { manager, outputRoot } = await createManager();
  const globals = globalThis as unknown as Record<symbol, unknown>;
  const managerSymbol = Symbol.for(BACKGROUND_COMMAND_MANAGER_SYMBOL_KEY);
  globals[managerSymbol] = { version: 1, manager };
  const configRoot = await mkdtemp(join(tmpdir(), "pi-background-toggle-test-"));
  const agentDirectory = join(configRoot, "agent");
  const projectDirectory = join(configRoot, "project");
  await mkdir(agentDirectory, { recursive: true });
  await mkdir(projectDirectory, { recursive: true });
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDirectory;
  type Handler = (event: Record<string, unknown>, ctx: unknown) => unknown;
  const handlers = new Map<string, Handler>();
  const tools = new Map<string, ExecutableTool>();
  let activeTools: string[] = [];
  const api = {
    on(name: string, handler: Handler) {
      handlers.set(name, handler);
    },
    registerTool(tool: ExecutableTool) {
      tools.set(tool.name, tool);
    },
    sendMessage() {},
    getActiveTools() {
      return [...activeTools];
    },
    setActiveTools(names: string[]) {
      activeTools = [...names];
    },
  } as unknown as ExtensionAPI;
  const ctx = {
    ...toolContext(),
    hasUI: false,
    cwd: projectDirectory,
  };

  try {
    await writeFile(join(agentDirectory, "settings.json"), JSON.stringify({
      backgroundCommands: { enabled: false },
    }));
    runningCommandsExtension(api);
    activeTools = ["read", ...tools.keys()];
    await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);
    assert.deepEqual(activeTools, ["read"]);
    assert.equal(manager.taskCount, 0);

    await writeFile(join(agentDirectory, "settings.json"), JSON.stringify({
      backgroundCommands: { enabled: true },
    }));
    await handlers.get("session_start")?.({ type: "session_start", reason: "reload" }, ctx);
    assert.deepEqual(
      activeTools.filter((name) => name.startsWith("background_command_")).sort(),
      [...tools.keys()].sort(),
    );
    await handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" }, ctx);
  } finally {
    await manager.shutdown();
    delete globals[managerSymbol];
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(configRoot, { recursive: true, force: true });
    await rm(outputRoot, { recursive: true, force: true });
  }
});

test("four Tools provide consistent start, status, output, and cancel behavior", async () => {
  const { manager, outputRoot } = await createManager();
  const tools = new Map<string, ExecutableTool>();
  const api = {
    registerTool(tool: ExecutableTool) {
      tools.set(tool.name, tool);
    },
  } as unknown as ExtensionAPI;
  const notifications: string[] = [];
  const ctx = toolContext(notifications);

  try {
    registerBackgroundCommandTools(api, manager);
    assert.deepEqual([...tools.keys()].sort(), [
      "background_command_cancel",
      "background_command_output",
      "background_command_start",
      "background_command_status",
    ]);
    const startTool = tools.get("background_command_start")!;
    const statusTool = tools.get("background_command_status")!;
    const outputTool = tools.get("background_command_output")!;
    const cancelTool = tools.get("background_command_cancel")!;

    const startResult = await startTool.execute(
      "tool-start",
      {
        command: "printf '\\033[31mhello\\033[0m\\n'; sleep 30",
        title: "Linux tests",
      },
      undefined,
      undefined,
      ctx,
    );
    const started = JSON.parse(startResult.content[0]!.text) as { taskId: string; status: string; title: string };
    assert.equal(started.status, "running");
    assert.equal(started.title, "Linux tests");
    await waitUntil(() => manager.output(started.taskId).output.includes("hello"));

    const otherSessionContext = {
      ...ctx,
      sessionManager: {
        getSessionId: () => "other-session",
        getSessionFile: () => undefined,
      },
    };
    await assert.rejects(
      statusTool.execute(
        "cross-session-status",
        { taskId: started.taskId },
        undefined,
        undefined,
        otherSessionContext,
      ),
      /limited to the current Session/u,
    );
    await assert.rejects(
      outputTool.execute(
        "cross-session-output",
        { taskId: started.taskId },
        undefined,
        undefined,
        otherSessionContext,
      ),
      /limited to the current Session/u,
    );
    await assert.rejects(
      cancelTool.execute(
        "cross-session-cancel",
        { taskId: started.taskId },
        undefined,
        undefined,
        otherSessionContext,
      ),
      /limited to the current Session/u,
    );
    assert.equal(manager.get(started.taskId).state, "running");

    const statusResult = await statusTool.execute(
      "tool-status",
      { taskId: started.taskId },
      undefined,
      undefined,
      ctx,
    );
    const status = JSON.parse(statusResult.content[0]!.text) as { status: string; title: string };
    assert.equal(status.status, "running");
    assert.equal(status.title, "Linux tests");

    const outputResult = await outputTool.execute(
      "tool-output",
      { taskId: started.taskId, tailLines: 10 },
      undefined,
      undefined,
      ctx,
    );
    const output = JSON.parse(outputResult.content[0]!.text) as { output: string; title: string; command: string };
    assert.equal(output.title, "Linux tests");
    assert.equal(output.command, "printf '\\033[31mhello\\033[0m\\n'; sleep 30");
    assert.equal(output.output, "hello\n");
    assert.equal(output.output.includes("\u001b"), false);

    const cancelResult = await cancelTool.execute(
      "tool-cancel",
      { taskId: started.taskId },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(JSON.parse(cancelResult.content[0]!.text).status, "cancelled");
    assert.equal(notifications.filter((message) => message.includes("共享当前工作目录")).length, 1);
  } finally {
    await cleanupManager(manager, outputRoot);
  }
});

test("terminal completions wake the agent exactly once with concise follow-up summaries", async () => {
  const { manager, outputRoot } = await createManager();
  const globals = globalThis as unknown as Record<symbol, unknown>;
  const managerSymbol = Symbol.for(BACKGROUND_COMMAND_MANAGER_SYMBOL_KEY);
  globals[managerSymbol] = { version: 1, manager };
  type Handler = (event: Record<string, unknown>, ctx: unknown) => unknown;
  const handlers = new Map<string, Handler>();
  const tools = new Map<string, ExecutableTool>();
  const sent: Array<{ message: Record<string, unknown>; options: Record<string, unknown> }> = [];
  const notifications: string[] = [];
  const api = {
    on(name: string, handler: Handler) {
      handlers.set(name, handler);
    },
    registerTool(tool: ExecutableTool) {
      tools.set(tool.name, tool);
    },
    sendMessage(message: Record<string, unknown>, options: Record<string, unknown>) {
      sent.push({ message, options });
    },
  } as unknown as ExtensionAPI;
  const baseContext = toolContext(notifications);
  const ctx = {
    ...baseContext,
    hasUI: false,
    ui: {
      notify(message: string) {
        notifications.push(message);
        if (message.includes("Background task finished")) {
          throw new Error("stale UI context");
        }
      },
    },
  };

  try {
    runningCommandsExtension(api);
    await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);
    const startAndWait = async (toolCallId: string, command: string, title: string, timeout?: number) => {
      const startResult = await tools.get("background_command_start")!.execute(
        toolCallId,
        { command, title, ...(timeout === undefined ? {} : { timeout }) },
        undefined,
        undefined,
        ctx,
      );
      const taskId = (JSON.parse(startResult.content[0]!.text) as { taskId: string }).taskId;
      await manager.waitForTask(taskId);
      return taskId;
    };

    const successfulTaskId = await startAndWait(
      "summary-success",
      "printf 'complete\\n'",
      "Quick health check",
    );
    const failedTaskId = await startAndWait(
      "summary-failed",
      "printf 'failure\\n' >&2; exit 2",
      "Leak scan",
    );
    const timedOutTaskId = await startAndWait(
      "summary-timeout",
      "sleep 30",
      "Slow scan",
      0.05,
    );
    const cancelledStartResult = await tools.get("background_command_start")!.execute(
      "summary-cancelled",
      { command: "sleep 30", title: "Cancelled scan" },
      undefined,
      undefined,
      ctx,
    );
    const cancelledTaskId = (JSON.parse(cancelledStartResult.content[0]!.text) as { taskId: string }).taskId;
    await manager.cancel(cancelledTaskId);

    const expectedCompletions = [
      { taskId: successfulTaskId, title: "Quick health check", result: "exit=0" },
      { taskId: failedTaskId, title: "Leak scan", result: "exit=2" },
      { taskId: timedOutTaskId, title: "Slow scan", result: "timed out" },
      { taskId: cancelledTaskId, title: "Cancelled scan", result: "cancelled" },
    ];
    assert.equal(sent.length, expectedCompletions.length);
    for (const [index, expected] of expectedCompletions.entries()) {
      const delivery = sent[index];
      assert.equal(delivery?.message.customType, "background-command-completion");
      const completionContent = String(delivery?.message.content);
      assert.equal(completionContent.includes(expected.taskId), true);
      assert.equal(completionContent.includes(expected.title), true);
      assert.equal(completionContent.includes(expected.result), true);
      assert.equal(completionContent.includes("background_command_output"), true);
      assert.equal(completionContent.includes("output="), false);
      assert.equal(delivery?.message.display, false);
      assert.deepEqual(delivery?.options, { triggerTurn: true, deliverAs: "followUp" });
    }
    assert.equal(manager.pendingCompletions().length, 0);

    await handlers.get("session_start")?.({ type: "session_start", reason: "reload" }, ctx);
    assert.equal(sent.length, expectedCompletions.length, "rebinding must not duplicate completion summaries");
    await handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" }, ctx);
  } finally {
    await manager.shutdown();
    delete globals[managerSymbol];
    await rm(outputRoot, { recursive: true, force: true });
  }
});

test("dashboard adapter streams public snapshots and only allows refresh/output/cancel", async () => {
  const { manager, outputRoot } = await createManager();
  const adapter = new BackgroundCommandsDashboardAdapter(manager);
  const snapshots: unknown[] = [];
  const unsubscribe = adapter.subscribe((snapshot) => snapshots.push(snapshot));
  try {
    const started = await manager.start(startRequest("printf 'dashboard-output\\n'", undefined, "Dashboard task"));
    await manager.waitForTask(started.id);
    await waitUntil(() => snapshots.length > 0);

    const snapshot = adapter.getSnapshot();
    assert.equal(snapshot.tasks.length, 1);
    assert.equal(snapshot.tasks[0]?.taskId, started.id);
    assert.equal(snapshot.tasks[0]?.outputTail.includes("dashboard-output"), true);

    const output = await adapter.dispatch({ type: "output", taskId: started.id, tailLines: 20 }) as { output: string };
    assert.equal(output.output.includes("dashboard-output"), true);
    await assert.rejects(() => adapter.dispatch({ type: "start", command: "echo forbidden" }), /invalid_background_command/);
  } finally {
    unsubscribe();
    adapter.dispose();
    await cleanupManager(manager, outputRoot);
  }
});
