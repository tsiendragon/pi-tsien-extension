import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

import { getShellConfig } from "@earendil-works/pi-coding-agent";

import {
  MAX_FOREGROUND_OUTPUT_BYTES,
  normalizeCommandTitle,
  RunningCommandRegistry,
} from "../command-ui/command-registry.ts";
import { BackgroundOutputStore, type BackgroundOutputWriter } from "./output-store.ts";
import type {
  BackgroundCommandManagerOptions,
  BackgroundTaskEvent,
  BackgroundTaskExitReason,
  BackgroundTaskOutput,
  BackgroundTaskSnapshot,
  BackgroundTaskStartRequest,
  BackgroundTaskState,
  ForegroundCommandResult,
  ForegroundCommandStartRequest,
} from "./types.ts";

export const BACKGROUND_COMMAND_MANAGER_SYMBOL_KEY = "pi.tsien.background-command-manager.v1";
export const DEFAULT_MAX_BACKGROUND_TASKS = 4;
export const DEFAULT_MAX_BACKGROUND_OUTPUT_BYTES = 1024 * 1024 * 1024;
export const DEFAULT_BACKGROUND_TAIL_LINES = 200;
export const MAX_BACKGROUND_TAIL_LINES = 2_000;

const MAX_TIMEOUT_MS = 2_147_483_647;
const TERMINAL_STATES = new Set<BackgroundTaskState>([
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
]);

type EventListener = (event: BackgroundTaskEvent) => void;

interface RequestedTermination {
  state: Extract<BackgroundTaskState, "failed" | "cancelled" | "timed_out">;
  reason: BackgroundTaskExitReason;
  error?: string;
  suppressCompletion?: boolean;
}

interface RuntimeTask {
  id: string;
  mode?: "foreground" | "background";
  toolCallId?: string;
  sessionId: string;
  command: string;
  title: string;
  cwd: string;
  state: BackgroundTaskState;
  startedAt: number;
  endedAt?: number;
  pid?: number;
  exitCode?: number | null;
  exitSignal?: NodeJS.Signals | null;
  exitReason?: BackgroundTaskExitReason;
  timeoutMs?: number;
  error?: string;
  experimentalPlatform: boolean;
  child: ChildProcess;
  writer: BackgroundOutputWriter;
  abortController: AbortController;
  requestedTermination?: RequestedTermination;
  timeoutTimer?: ReturnType<typeof setTimeout>;
  forceKillTimer?: ReturnType<typeof setTimeout>;
  updateTimer?: ReturnType<typeof setTimeout>;
  finalized: boolean;
  processExited: boolean;
  completionDelivered: boolean;
  suppressCompletion: boolean;
  completion: Promise<BackgroundTaskSnapshot>;
  resolveCompletion: (task: BackgroundTaskSnapshot) => void;
  foregroundOnData?: (data: Buffer) => void;
  foregroundSignal?: AbortSignal;
  foregroundAbortListener?: () => void;
  foregroundSettled?: boolean;
  resolveForeground?: (result: ForegroundCommandResult) => void;
  rejectForeground?: (error: Error) => void;
}

function normalizeTimeoutMs(timeoutSeconds: number | undefined): number | undefined {
  if (timeoutSeconds === undefined) return undefined;
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    throw new Error("timeout must be a finite number greater than zero");
  }
  const timeoutMs = timeoutSeconds * 1_000;
  if (timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error(`timeout cannot exceed ${MAX_TIMEOUT_MS / 1_000} seconds`);
  }
  return timeoutMs;
}

function isTerminal(state: BackgroundTaskState): boolean {
  return TERMINAL_STATES.has(state);
}

function runtimeMode(task: RuntimeTask): "foreground" | "background" {
  return task.mode ?? "background";
}

function defaultTaskId(): string {
  return `bash-${randomBytes(2).toString("hex")}`;
}

function processGroupExists(pid: number): boolean {
  if (process.platform === "win32") return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function signalProcessTree(pid: number, signal: NodeJS.Signals): void {
  if (process.platform === "win32") {
    if (signal !== "SIGKILL") return;
    try {
      const killer = spawn("taskkill", ["/F", "/T", "/PID", String(pid)], {
        stdio: "ignore",
        detached: true,
        windowsHide: true,
      });
      killer.unref();
    } catch {
      // Windows support is explicitly experimental; final state is resolved by child close.
    }
    return;
  }

  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // The process may already have exited between state inspection and signalling.
    }
  }
}

function createEnvironment(request: BackgroundTaskStartRequest): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  const configuredDirectory = env.PI_CODING_AGENT_DIR;
  const agentDirectory = configuredDirectory
    ? configuredDirectory.replace(/^~(?=$|[\\/])/u, homedir())
    : join(homedir(), ".pi", "agent");
  const binDirectory = join(agentDirectory, "bin");
  const pathEntries = (env[pathKey] ?? "").split(delimiter).filter(Boolean);
  if (!pathEntries.includes(binDirectory)) {
    env[pathKey] = [binDirectory, ...pathEntries].join(delimiter);
  }
  delete env.PI_SESSION_ID;
  delete env.PI_SESSION_FILE;
  delete env.PI_PROVIDER;
  delete env.PI_MODEL;
  delete env.PI_REASONING_LEVEL;
  env.PI_SESSION_ID = request.sessionId;
  if (request.sessionFile) env.PI_SESSION_FILE = request.sessionFile;
  if (request.provider) env.PI_PROVIDER = request.provider;
  if (request.model) env.PI_MODEL = request.model;
  if (request.thinkingLevel) env.PI_REASONING_LEVEL = request.thinkingLevel;
  return env;
}

export class BackgroundCommandManager {
  readonly version = 1 as const;
  readonly registry: RunningCommandRegistry;

  /** Prototype capability markers used to upgrade the singleton during /reload. */
  get supportsTitles(): true {
    return true;
  }

  get supportsForegroundHandoff(): true {
    return true;
  }

  private readonly maxConcurrent: number;
  private readonly maxOutputBytes: number;
  private readonly maxTailBytes: number;
  private readonly killGraceMs: number;
  private readonly reloadGraceMs: number;
  private readonly updateThrottleMs: number;
  private readonly now: () => number;
  private readonly idFactory: () => string;
  private readonly outputStore: BackgroundOutputStore;
  private readonly tasks = new Map<string, RuntimeTask>();
  private readonly listeners = new Set<EventListener>();
  private foregroundTasksByToolCallId: Map<string, RuntimeTask> | undefined = new Map();
  private sessionId: string | undefined;
  private startingCount = 0;
  private startingBackgroundCount: number | undefined = 0;
  private sharedWorkdirNoticeShown = false;
  private toolsDisabledByConfig = false;
  private reloadCleanupTimer: ReturnType<typeof setTimeout> | undefined;
  private shutdownPromise: Promise<void> | undefined;
  private shuttingDown = false;

  constructor(options: BackgroundCommandManagerOptions = {}, registry = new RunningCommandRegistry()) {
    this.registry = registry;
    this.maxConcurrent = options.maxConcurrent ?? DEFAULT_MAX_BACKGROUND_TASKS;
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_BACKGROUND_OUTPUT_BYTES;
    this.maxTailBytes = options.maxTailBytes ?? MAX_FOREGROUND_OUTPUT_BYTES;
    this.killGraceMs = options.killGraceMs ?? 2_000;
    this.reloadGraceMs = options.reloadGraceMs ?? 10_000;
    this.updateThrottleMs = options.updateThrottleMs ?? 100;
    this.now = options.now ?? Date.now;
    this.idFactory = options.idFactory ?? defaultTaskId;
    this.outputStore = new BackgroundOutputStore(options.outputRoot);
    if (!Number.isInteger(this.maxConcurrent) || this.maxConcurrent < 1) {
      throw new Error("maxConcurrent must be a positive integer");
    }
    if (!Number.isSafeInteger(this.maxOutputBytes) || this.maxOutputBytes < 1) {
      throw new Error("maxOutputBytes must be a positive safe integer");
    }
    if (!Number.isSafeInteger(this.maxTailBytes) || this.maxTailBytes < 1) {
      throw new Error("maxTailBytes must be a positive safe integer");
    }
  }

  get activeCount(): number {
    return this.startingCount + [...this.tasks.values()].filter((task) => !isTerminal(task.state)).length;
  }

  get taskCount(): number {
    return [...this.tasks.values()].filter((task) => runtimeMode(task) === "background").length;
  }

  get foregroundCount(): number {
    return this.foregroundTasks.size;
  }

  get currentSessionId(): string | undefined {
    return this.sessionId;
  }

  upgradeForForegroundHandoff(): void {
    this.foregroundTasksByToolCallId ??= new Map();
    this.startingBackgroundCount ??= this.startingCount;
    for (const task of this.tasks.values()) task.mode ??= "background";
  }

  async bindSession(sessionId: string): Promise<void> {
    this.cancelReloadCleanup();
    if (this.sessionId === sessionId && this.outputStore.directory) return;
    if (this.activeCount > 0) {
      throw new Error("Cannot switch background command session while tasks are still active");
    }
    if (this.sessionId && this.sessionId !== sessionId) {
      await this.outputStore.cleanup();
      this.tasks.clear();
      this.foregroundTasks.clear();
      this.registry.clearBackground();
    }
    this.sessionId = sessionId;
    this.sharedWorkdirNoticeShown = false;
    await this.outputStore.initialize(sessionId);
  }

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  claimSharedWorkdirNotice(): boolean {
    if (this.sharedWorkdirNoticeShown) return false;
    this.sharedWorkdirNoticeShown = true;
    return true;
  }

  markToolsDisabledByConfig(): void {
    this.toolsDisabledByConfig = true;
  }

  consumeToolsDisabledByConfig(): boolean {
    const disabled = this.toolsDisabledByConfig;
    this.toolsDisabledByConfig = false;
    return disabled;
  }

  private get foregroundTasks(): Map<string, RuntimeTask> {
    return this.foregroundTasksByToolCallId ??= new Map();
  }

  private get backgroundActiveCount(): number {
    return (this.startingBackgroundCount ?? 0) + [...this.tasks.values()]
      .filter((task) => runtimeMode(task) === "background" && !isTerminal(task.state)).length;
  }

  list(): BackgroundTaskSnapshot[] {
    return [...this.tasks.values()]
      .filter((task) => runtimeMode(task) === "background")
      .sort((left, right) => left.startedAt - right.startedAt || left.id.localeCompare(right.id))
      .map((task) => this.snapshot(task));
  }

  get(taskId: string): BackgroundTaskSnapshot {
    const task = this.requireTask(taskId);
    return this.snapshot(task);
  }

  output(taskId: string, tailLines = DEFAULT_BACKGROUND_TAIL_LINES): BackgroundTaskOutput {
    const task = this.requireTask(taskId);
    if (!Number.isInteger(tailLines) || tailLines < 1 || tailLines > MAX_BACKGROUND_TAIL_LINES) {
      throw new Error(`tailLines must be an integer between 1 and ${MAX_BACKGROUND_TAIL_LINES}`);
    }
    const allLines = task.writer.outputTail.replace(/\r\n?/gu, "\n").split("\n");
    const selected = allLines.slice(-tailLines);
    const title = task.title || normalizeCommandTitle(undefined, task.command);
    return {
      taskId: task.id,
      title,
      command: task.command,
      state: task.state,
      output: selected.join("\n"),
      tailLines,
      outputBytes: task.writer.outputBytes,
      outputFile: task.writer.outputFile,
      truncated: task.writer.outputTruncated || allLines.length > tailLines,
    };
  }

  pendingCompletions(): BackgroundTaskSnapshot[] {
    return [...this.tasks.values()]
      .filter((task) => runtimeMode(task) === "background")
      .filter((task) => isTerminal(task.state) && !task.suppressCompletion && !task.completionDelivered)
      .map((task) => this.snapshot(task));
  }

  markCompletionDelivered(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (task && runtimeMode(task) === "background" && isTerminal(task.state)) task.completionDelivered = true;
  }

  async start(request: BackgroundTaskStartRequest): Promise<BackgroundTaskSnapshot> {
    if (this.shuttingDown) throw new Error("Background command manager is shutting down");
    if (!this.sessionId || this.sessionId !== request.sessionId) {
      throw new Error("Background command manager is not bound to the current Session");
    }
    if (request.launchSignal?.aborted) throw new Error("Background command start aborted");
    if (!request.command.trim()) throw new Error("command must not be empty");
    const title = normalizeCommandTitle(request.title, request.command);
    if (this.backgroundActiveCount >= this.maxConcurrent) {
      throw new Error(
        `Cannot start background command: current Session already has ${this.maxConcurrent} active tasks`,
      );
    }
    const timeoutMs = normalizeTimeoutMs(request.timeoutSeconds);
    const taskId = this.allocateTaskId();
    this.startingCount += 1;
    this.startingBackgroundCount = (this.startingBackgroundCount ?? 0) + 1;

    let writer: BackgroundOutputWriter | undefined;
    let child: ChildProcess | undefined;
    try {
      await access(request.cwd);
      writer = await this.outputStore.createWriter(taskId, this.maxOutputBytes, this.maxTailBytes);
      if (this.shuttingDown) throw new Error("Background command manager is shutting down");
      const shell = getShellConfig();
      const commandFromStdin = shell.commandTransport === "stdin";
      child = spawn(
        shell.shell,
        commandFromStdin ? shell.args : [...shell.args, request.command],
        {
          cwd: request.cwd,
          detached: process.platform !== "win32",
          env: createEnvironment(request),
          stdio: [commandFromStdin ? "pipe" : "ignore", "pipe", "pipe"],
          windowsHide: true,
        },
      );
      if (commandFromStdin) {
        child.stdin?.on("error", () => {});
        child.stdin?.end(request.command);
      }
      await new Promise<void>((resolve, reject) => {
        const onSpawn = () => {
          child?.off("error", onError);
          resolve();
        };
        const onError = (error: Error) => {
          child?.off("spawn", onSpawn);
          reject(error);
        };
        child?.once("spawn", onSpawn);
        child?.once("error", onError);
      });
      if (!child.pid) throw new Error("Background command started without a PID");
      if (request.launchSignal?.aborted || this.shuttingDown) {
        throw new Error(
          request.launchSignal?.aborted
            ? "Background command start aborted"
            : "Background command manager is shutting down",
        );
      }

      let resolveCompletion!: (task: BackgroundTaskSnapshot) => void;
      const completion = new Promise<BackgroundTaskSnapshot>((resolve) => {
        resolveCompletion = resolve;
      });
      const runtime: RuntimeTask = {
        id: taskId,
        mode: "background",
        sessionId: request.sessionId,
        command: request.command,
        title,
        cwd: request.cwd,
        state: "running",
        startedAt: this.now(),
        pid: child.pid,
        timeoutMs,
        experimentalPlatform: process.platform === "win32",
        child,
        writer,
        abortController: new AbortController(),
        finalized: false,
        processExited: false,
        completionDelivered: false,
        suppressCompletion: false,
        completion,
        resolveCompletion,
      };
      this.tasks.set(taskId, runtime);
      this.registry.startBackground(this.commandView(runtime));
      this.attachRuntime(runtime);
      this.emit({ type: "started", task: this.snapshot(runtime) });
      return this.snapshot(runtime);
    } catch (error) {
      if (child?.pid) await this.terminateUnregisteredChild(child);
      if (writer) {
        await writer.close();
        await this.outputStore.removeTaskFile(writer.outputFile);
      }
      throw error;
    } finally {
      this.startingCount -= 1;
      this.startingBackgroundCount = Math.max(0, (this.startingBackgroundCount ?? 1) - 1);
    }
  }

  async executeForeground(request: ForegroundCommandStartRequest): Promise<ForegroundCommandResult> {
    if (this.shuttingDown) throw new Error("Background command manager is shutting down");
    if (!this.sessionId || this.sessionId !== request.sessionId) {
      throw new Error("Foreground command manager is not bound to the current Session");
    }
    if (request.signal?.aborted) throw new Error("aborted");
    if (!request.command.trim()) throw new Error("command must not be empty");
    if (this.foregroundTasks.has(request.toolCallId)) {
      throw new Error(`Foreground command already exists: ${request.toolCallId}`);
    }

    const timeoutMs = normalizeTimeoutMs(request.timeoutSeconds);
    const taskId = this.allocateTaskId();
    this.startingCount += 1;
    let writer: BackgroundOutputWriter | undefined;
    let child: ChildProcess | undefined;
    let result: Promise<ForegroundCommandResult> | undefined;
    try {
      await access(request.cwd);
      writer = await this.outputStore.createWriter(taskId, this.maxOutputBytes, this.maxTailBytes);
      if (this.shuttingDown || request.signal?.aborted) {
        throw new Error(request.signal?.aborted ? "aborted" : "Background command manager is shutting down");
      }
      const shell = getShellConfig();
      const commandFromStdin = shell.commandTransport === "stdin";
      child = spawn(
        shell.shell,
        commandFromStdin ? shell.args : [...shell.args, request.command],
        {
          cwd: request.cwd,
          detached: process.platform !== "win32",
          env: request.env ?? process.env,
          stdio: [commandFromStdin ? "pipe" : "ignore", "pipe", "pipe"],
          windowsHide: true,
        },
      );
      if (commandFromStdin) {
        child.stdin?.on("error", () => {});
        child.stdin?.end(request.command);
      }
      await new Promise<void>((resolve, reject) => {
        const onSpawn = () => {
          child?.off("error", onError);
          resolve();
        };
        const onError = (error: Error) => {
          child?.off("spawn", onSpawn);
          reject(error);
        };
        child?.once("spawn", onSpawn);
        child?.once("error", onError);
      });
      if (!child.pid) throw new Error("Foreground command started without a PID");
      if (this.shuttingDown || request.signal?.aborted) {
        throw new Error(request.signal?.aborted ? "aborted" : "Background command manager is shutting down");
      }

      let resolveCompletion!: (task: BackgroundTaskSnapshot) => void;
      const completion = new Promise<BackgroundTaskSnapshot>((resolve) => {
        resolveCompletion = resolve;
      });
      let resolveForeground!: (value: ForegroundCommandResult) => void;
      let rejectForeground!: (error: Error) => void;
      result = new Promise<ForegroundCommandResult>((resolve, reject) => {
        resolveForeground = resolve;
        rejectForeground = reject;
      });
      const runtime: RuntimeTask = {
        id: taskId,
        mode: "foreground",
        toolCallId: request.toolCallId,
        sessionId: request.sessionId,
        command: request.command,
        title: normalizeCommandTitle(undefined, request.command),
        cwd: request.cwd,
        state: "running",
        startedAt: request.startedAt ?? this.now(),
        pid: child.pid,
        timeoutMs,
        experimentalPlatform: process.platform === "win32",
        child,
        writer,
        abortController: new AbortController(),
        finalized: false,
        processExited: false,
        completionDelivered: false,
        suppressCompletion: false,
        completion,
        resolveCompletion,
        foregroundOnData: request.onData,
        foregroundSignal: request.signal,
        foregroundSettled: false,
        resolveForeground,
        rejectForeground,
      };
      this.tasks.set(taskId, runtime);
      this.foregroundTasks.set(request.toolCallId, runtime);
      this.attachRuntime(runtime);
    } catch (error) {
      if (child?.pid) await this.terminateUnregisteredChild(child);
      if (writer) {
        await writer.close();
        await this.outputStore.removeTaskFile(writer.outputFile);
      }
      throw error;
    } finally {
      this.startingCount -= 1;
    }
    return result!;
  }

  backgroundForeground(toolCallId: string): BackgroundTaskSnapshot {
    const task = this.foregroundTasks.get(toolCallId);
    if (!task || runtimeMode(task) !== "foreground" || task.finalized) {
      throw new Error(`Foreground command is no longer running: ${toolCallId}`);
    }
    if (this.shuttingDown) throw new Error("Background command manager is shutting down");
    if (task.requestedTermination) throw new Error(`Foreground command is already stopping: ${toolCallId}`);
    if (this.backgroundActiveCount >= this.maxConcurrent) {
      throw new Error(`Cannot move command to background: already has ${this.maxConcurrent} active tasks`);
    }

    const handoffText = `${task.writer.outputBytes > 0 ? "\n\n" : ""}Command moved to background as task ${task.id}.\nUse background_command_status or background_command_output to inspect it.\n`;
    task.mode = "background";
    this.detachForegroundSignal(task);
    this.foregroundTasks.delete(toolCallId);
    task.foregroundOnData?.(Buffer.from(handoffText));
    task.foregroundOnData = undefined;
    this.registry.end(toolCallId);
    this.registry.startBackground(this.commandView(task));
    const snapshot = this.snapshot(task);
    this.emit({ type: "started", task: snapshot });
    this.resolveForeground(task, { exitCode: 0 });
    return snapshot;
  }

  async cancel(taskId: string): Promise<BackgroundTaskSnapshot> {
    const task = this.requireTask(taskId);
    if (isTerminal(task.state)) return this.snapshot(task);
    if (task.processExited && (!task.pid || !processGroupExists(task.pid))) return task.completion;
    this.requestTermination(task, {
      state: "cancelled",
      reason: "signal",
    });
    return task.completion;
  }

  waitForTask(taskId: string): Promise<BackgroundTaskSnapshot> {
    return this.requireTask(taskId).completion;
  }

  scheduleReloadCleanup(): void {
    if (this.reloadCleanupTimer) return;
    this.reloadCleanupTimer = setTimeout(() => {
      this.reloadCleanupTimer = undefined;
      void this.shutdown("session_shutdown");
    }, this.reloadGraceMs);
    this.reloadCleanupTimer.unref?.();
  }

  cancelReloadCleanup(): void {
    if (this.reloadCleanupTimer) clearTimeout(this.reloadCleanupTimer);
    this.reloadCleanupTimer = undefined;
  }

  async shutdown(reason: "session_shutdown" = "session_shutdown"): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shutdownPromise = this.performShutdown(reason).finally(() => {
      this.shutdownPromise = undefined;
    });
    return this.shutdownPromise;
  }

  private async performShutdown(reason: "session_shutdown"): Promise<void> {
    this.cancelReloadCleanup();
    this.shuttingDown = true;
    while (this.startingCount > 0) await delay(10);
    const active = [...this.tasks.values()].filter((task) => !isTerminal(task.state));
    for (const task of active) {
      task.suppressCompletion = true;
      if (task.requestedTermination) task.requestedTermination.suppressCompletion = true;
      if (!task.processExited || (task.pid !== undefined && processGroupExists(task.pid))) {
        this.requestTermination(task, {
          state: "cancelled",
          reason,
          suppressCompletion: true,
        });
      }
    }
    await Promise.allSettled(active.map((task) => task.completion));
    await this.outputStore.cleanup();
    this.tasks.clear();
    this.foregroundTasks.clear();
    this.registry.clearBackground();
    this.registry.clearForeground();
    this.sessionId = undefined;
    this.sharedWorkdirNoticeShown = false;
    this.shuttingDown = false;
  }

  private attachRuntime(task: RuntimeTask): void {
    const handleData = (value: Buffer | string) => {
      if (task.finalized || task.requestedTermination?.reason === "output_limit") return;
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      const appended = task.writer.append(chunk);
      if (runtimeMode(task) === "foreground") {
        task.foregroundOnData?.(chunk);
      } else {
        this.registry.updateBackground(this.commandView(task));
        this.scheduleUpdatedEvent(task);
      }
      if (task.writer.error) {
        this.requestTermination(task, {
          state: "failed",
          reason: "log_error",
          error: task.writer.error.message,
        });
        return;
      }
      if (appended.backpressured) {
        task.child.stdout?.pause();
        task.child.stderr?.pause();
        task.writer.onDrain(() => {
          if (task.finalized) return;
          task.child.stdout?.resume();
          task.child.stderr?.resume();
        });
      }
      if (appended.limitReached) {
        this.requestTermination(task, {
          state: "failed",
          reason: "output_limit",
          error: `Background command exceeded the ${this.maxOutputBytes}-byte output limit`,
        });
      }
    };

    task.child.stdout?.on("data", handleData);
    task.child.stderr?.on("data", handleData);
    task.child.on("error", (error) => {
      this.requestTermination(task, {
        state: "failed",
        reason: "signal",
        error: error.message,
      });
    });
    task.writer.onError((error) => {
      this.requestTermination(task, {
        state: "failed",
        reason: "log_error",
        error: error.message,
      });
    });
    task.child.once("exit", () => {
      task.processExited = true;
    });
    task.child.once("close", (exitCode, exitSignal) => {
      void this.finalize(task, exitCode, exitSignal);
    });
    task.abortController.signal.addEventListener("abort", () => {
      if (!task.pid) return;
      signalProcessTree(task.pid, process.platform === "win32" ? "SIGKILL" : "SIGTERM");
      if (process.platform !== "win32") {
        task.forceKillTimer = setTimeout(() => {
          if (task.pid && processGroupExists(task.pid)) signalProcessTree(task.pid, "SIGKILL");
        }, this.killGraceMs);
        task.forceKillTimer.unref?.();
      }
    }, { once: true });

    if (runtimeMode(task) === "foreground" && task.foregroundSignal) {
      const onAbort = () => {
        if (runtimeMode(task) !== "foreground") return;
        this.requestTermination(task, {
          state: "cancelled",
          reason: "signal",
          error: "Command aborted",
        });
      };
      task.foregroundAbortListener = onAbort;
      if (task.foregroundSignal.aborted) onAbort();
      else task.foregroundSignal.addEventListener("abort", onAbort, { once: true });
    }

    if (task.timeoutMs !== undefined) {
      task.timeoutTimer = setTimeout(() => {
        if (task.processExited && (!task.pid || !processGroupExists(task.pid))) return;
        this.requestTermination(task, {
          state: "timed_out",
          reason: "timeout",
          error: `Background command timed out after ${task.timeoutMs}ms`,
        });
      }, task.timeoutMs);
      task.timeoutTimer.unref?.();
    }
  }

  private requestTermination(task: RuntimeTask, requested: RequestedTermination): void {
    if (task.finalized || isTerminal(task.state) || task.requestedTermination) return;
    task.requestedTermination = requested;
    task.suppressCompletion = requested.suppressCompletion === true;
    task.abortController.abort(requested.reason);
  }

  private detachForegroundSignal(task: RuntimeTask): void {
    if (task.foregroundSignal && task.foregroundAbortListener) {
      task.foregroundSignal.removeEventListener("abort", task.foregroundAbortListener);
    }
    task.foregroundSignal = undefined;
    task.foregroundAbortListener = undefined;
  }

  private resolveForeground(task: RuntimeTask, result: ForegroundCommandResult): void {
    if (task.foregroundSettled) return;
    task.foregroundSettled = true;
    task.resolveForeground?.(result);
    task.resolveForeground = undefined;
    task.rejectForeground = undefined;
  }

  private rejectForeground(task: RuntimeTask, error: Error): void {
    if (task.foregroundSettled) return;
    task.foregroundSettled = true;
    task.rejectForeground?.(error);
    task.resolveForeground = undefined;
    task.rejectForeground = undefined;
  }

  private async finalize(
    task: RuntimeTask,
    exitCode: number | null,
    exitSignal: NodeJS.Signals | null,
  ): Promise<void> {
    if (task.finalized) return;
    task.finalized = true;
    const completedInForeground = runtimeMode(task) === "foreground";
    if (task.timeoutTimer) clearTimeout(task.timeoutTimer);
    if (task.updateTimer) clearTimeout(task.updateTimer);
    task.timeoutTimer = undefined;
    task.updateTimer = undefined;

    const lingeringProcessGroup = await this.ensureProcessGroupExited(task);
    if (task.forceKillTimer) clearTimeout(task.forceKillTimer);
    task.forceKillTimer = undefined;
    await task.writer.close();
    task.endedAt = this.now();
    task.exitCode = exitCode;
    task.exitSignal = exitSignal;

    const requested = task.requestedTermination;
    if (task.writer.error && !requested) {
      task.state = "failed";
      task.exitReason = "log_error";
      task.error = task.writer.error.message;
    } else if (lingeringProcessGroup && !requested) {
      task.state = "failed";
      task.exitReason = "signal";
      task.error = "Child processes outlived the background command shell and were terminated";
    } else if (requested) {
      task.state = requested.state;
      task.exitReason = requested.reason;
      task.error = requested.error;
    } else if (exitCode === 0) {
      task.state = "succeeded";
      task.exitReason = "exit";
    } else {
      task.state = "failed";
      task.exitReason = exitSignal ? "signal" : "exit";
    }

    const snapshot = this.snapshot(task);
    if (completedInForeground) {
      if (task.toolCallId) this.foregroundTasks.delete(task.toolCallId);
      this.detachForegroundSignal(task);
      task.foregroundOnData = undefined;
      this.tasks.delete(task.id);
      await this.outputStore.removeTaskFile(task.writer.outputFile);
      if (requested?.reason === "timeout") {
        this.rejectForeground(task, new Error(`timeout:${(task.timeoutMs ?? 0) / 1_000}`));
      } else if (requested?.state === "cancelled") {
        this.rejectForeground(task, new Error("aborted"));
      } else if (task.state === "failed" && requested) {
        this.rejectForeground(task, new Error(task.error ?? "Foreground command failed"));
      } else if (task.writer.error || lingeringProcessGroup) {
        this.rejectForeground(task, new Error(task.error ?? "Foreground command cleanup failed"));
      } else {
        this.resolveForeground(task, { exitCode });
      }
      task.resolveCompletion(snapshot);
      return;
    }

    this.registry.endBackground(task.id);
    this.emit({ type: "finished", task: snapshot });
    task.resolveCompletion(snapshot);
  }

  private async terminateUnregisteredChild(child: ChildProcess): Promise<void> {
    const pid = child.pid;
    if (!pid) return;
    signalProcessTree(pid, "SIGKILL");
    if (child.exitCode === null && child.signalCode === null) {
      await Promise.race([
        once(child, "close").catch(() => []),
        delay(this.killGraceMs + 500),
      ]);
    }
    if (process.platform !== "win32" && processGroupExists(pid)) {
      signalProcessTree(pid, "SIGKILL");
      const deadline = Date.now() + 500;
      while (Date.now() < deadline && processGroupExists(pid)) await delay(25);
    }
  }

  private async ensureProcessGroupExited(task: RuntimeTask): Promise<boolean> {
    if (!task.pid || process.platform === "win32") return false;
    await delay(25);
    if (!processGroupExists(task.pid)) return false;

    signalProcessTree(task.pid, "SIGTERM");
    const deadline = Date.now() + this.killGraceMs;
    while (Date.now() < deadline) {
      await delay(25);
      if (!processGroupExists(task.pid)) return true;
    }
    signalProcessTree(task.pid, "SIGKILL");
    const killDeadline = Date.now() + 500;
    while (Date.now() < killDeadline) {
      await delay(25);
      if (!processGroupExists(task.pid)) break;
    }
    return true;
  }

  private scheduleUpdatedEvent(task: RuntimeTask): void {
    if (task.updateTimer || task.finalized) return;
    task.updateTimer = setTimeout(() => {
      task.updateTimer = undefined;
      if (!task.finalized) this.emit({ type: "updated", task: this.snapshot(task) });
    }, this.updateThrottleMs);
    task.updateTimer.unref?.();
  }

  private snapshot(task: RuntimeTask): BackgroundTaskSnapshot {
    const title = task.title || normalizeCommandTitle(undefined, task.command);
    return {
      id: task.id,
      owner: "agent-bash",
      mode: "background",
      sessionId: task.sessionId,
      command: task.command,
      title,
      cwd: task.cwd,
      state: task.state,
      startedAt: task.startedAt,
      endedAt: task.endedAt,
      pid: task.pid,
      exitCode: task.exitCode,
      exitSignal: task.exitSignal,
      exitReason: task.exitReason,
      outputFile: task.writer.outputFile,
      outputBytes: task.writer.outputBytes,
      outputTail: task.writer.outputTail,
      outputTruncated: task.writer.outputTruncated,
      timeoutMs: task.timeoutMs,
      error: task.error,
      experimentalPlatform: task.experimentalPlatform,
    };
  }

  private commandView(task: RuntimeTask) {
    const title = task.title || normalizeCommandTitle(undefined, task.command);
    return {
      taskId: task.id,
      command: task.command,
      title,
      startedAt: task.startedAt,
      outputTail: task.writer.outputTail,
      outputTruncated: task.writer.outputTruncated,
      outputFile: task.writer.outputFile,
    };
  }

  private allocateTaskId(): string {
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const id = this.idFactory();
      if (/^bash-[a-z0-9]{4,16}$/u.test(id) && !this.tasks.has(id)) return id;
    }
    throw new Error("Unable to allocate a unique background task ID");
  }

  private requireTask(taskId: string): RuntimeTask {
    if (!/^bash-[a-z0-9]{4,16}$/u.test(taskId)) throw new Error("Invalid background task ID");
    const task = this.tasks.get(taskId);
    if (!task || runtimeMode(task) !== "background" || task.sessionId !== this.sessionId) {
      throw new Error(`Background task not found in current Session: ${taskId}`);
    }
    return task;
  }

  private emit(event: BackgroundTaskEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // UI/event consumers must never affect process ownership.
      }
    }
  }
}

interface GlobalBackgroundManagerV1 {
  readonly version: 1;
  readonly manager: BackgroundCommandManager;
}

export function getBackgroundCommandManager(): BackgroundCommandManager {
  const symbol = Symbol.for(BACKGROUND_COMMAND_MANAGER_SYMBOL_KEY);
  const globals = globalThis as unknown as Record<symbol, unknown>;
  const candidate = globals[symbol] as Partial<GlobalBackgroundManagerV1> | undefined;
  if (
    candidate?.version === 1
    && candidate.manager
    && typeof candidate.manager.bindSession === "function"
    && typeof candidate.manager.start === "function"
    && typeof candidate.manager.shutdown === "function"
  ) {
    if (candidate.manager.supportsForegroundHandoff !== true) {
      // /reload keeps the global manager instance; upgrade its prototype and
      // lazy state without losing already running background tasks.
      Object.setPrototypeOf(candidate.manager.registry, RunningCommandRegistry.prototype);
      Object.setPrototypeOf(candidate.manager, BackgroundCommandManager.prototype);
      candidate.manager.upgradeForForegroundHandoff();
    }
    return candidate.manager;
  }
  const manager = new BackgroundCommandManager();
  globals[symbol] = { version: 1, manager } satisfies GlobalBackgroundManagerV1;
  return manager;
}
