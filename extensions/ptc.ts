import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import {
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  budgetSnapshot,
  createBudgetState,
  createRunBudgetError,
  normalizeAndValidateResult,
  normalizeFencedJsonText,
  recordAssistantTokens,
  recordRunUsage,
  reserveNestedCall,
  reserveOuterRunCode,
  resolvePtcPolicy,
  retargetBudgetState,
  type PtcBudgetState,
} from "./ptc/policy.ts";

const TOOL_NAME = "run_code";
const STATUS_KEY = "ptc-experimental";
const READ_ONLY_TOOLS = ["read", "find", "grep", "ls"] as const;
const FULL_TOOLS = [...READ_ONLY_TOOLS, "write", "run"] as const;
const MAX_CODE_BYTES = 64 * 1024;
const MAX_PROTOCOL_BYTES = 256 * 1024;
const MAX_BINDING_RESULT_BYTES = 64 * 1024;
const MAX_WRITE_BYTES = 256 * 1024;
const MAX_RUN_OUTPUT_BYTES = 128 * 1024;
const MAX_SUB_CALLS = 32;
const RUNTIME_HEARTBEAT_GRACE_MS = 250;
const RUNTIME_WATCHDOG_INTERVAL_MS = 100;
const MAX_RUN_TIMEOUT_MS = 15_000;
const BLOCKED_WRITE_SEGMENTS = new Set([".git", ".pi", ".ssh", ".aws", ".gnupg", "node_modules"]);

type PtcMode = "off" | "ptc" | "both" | "full";
type BindingName = typeof FULL_TOOLS[number];

type RuntimeCallMessage = {
  type: "call";
  id: number;
  name: BindingName;
  args: unknown;
};

type RuntimeLogMessage = {
  type: "log";
  level: string;
  text: string;
};

type RuntimeHeartbeatMessage = {
  type: "heartbeat";
  computeTimeMs: number;
};

type RuntimeDoneMessage = {
  type: "done";
  result?: unknown;
  calls: number;
  toolCounts?: Record<string, number>;
  computeTimeMs?: number;
};

type RuntimeErrorMessage = {
  type: "error";
  code?: "compute_timeout";
  message: string;
  computeTimeMs?: number;
};

type RuntimeMessage = RuntimeCallMessage | RuntimeLogMessage | RuntimeHeartbeatMessage | RuntimeDoneMessage | RuntimeErrorMessage;

type RuntimeResult = {
  logs: string[];
  result?: unknown;
  calls: number;
  toolCounts: Record<string, number>;
  computeTimeMs: number;
};

type StructuredRunResult = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};

const READ_ONLY_SDK = `
## Experimental PTC mode

Use \`run_code\` to combine operations in one TypeScript program. The \`code\` argument is the BODY of an async function, so top-level \`await\` and \`return\` are available. Type annotations are allowed, but enums, namespaces, imports, and dynamic code generation are unavailable inside the PTC program.

Only values printed with \`console.log/info/warn/error/debug\` and the final returned lossless JSON value come back to the conversation. Keep intermediate data inside the program. Tool arguments and returned values must be lossless JSON: omit optional properties instead of setting them to \`undefined\`, and convert intentional missing values to \`null\`.

Use PTC for deterministic multi-step data flows: several related reads/searches followed by filtering, joining, aggregation, validation, or compact transformation. A single lookup, open-ended exploration where each result changes the next action, or a task that needs large raw outputs is usually better handled with ordinary tools when they are available.

All bindings return text. Parse \`tools.read\` as JSON only when the file is JSON, then validate whether the parsed value is an array or object and confirm required fields before iterating or dereferencing it. Treat \`find\` and \`ls\` results as newline-delimited text, not JSON. Results from a search rooted at \`path\` may be relative to that root, so join the root explicitly before reading; do not guess filenames or omit directory prefixes. When a manifest or prior result provides a path, use that exact path.

declare const tools: {
  read(args: { path: string; offset?: number; limit?: number }): Promise<string>;
  find(args: { path?: string; pattern: string; limit?: number }): Promise<string>;
  grep(args: { pattern: string; path?: string; glob?: string; ignoreCase?: boolean; literal?: boolean; context?: number; limit?: number }): Promise<string>;
  ls(args: { path?: string; limit?: number }): Promise<string>;
};

Run independent calls through a bounded \`Promise.all\` and preserve each result's association with its input path. Keep dependent calls sequential. Different \`run_code\` calls do not share variables or memory. If work must be split, return compact mergeable partials such as counts, totals, grouped values, candidates, and checksums so the next call does not repeat reads. A compute-only merge program still consumes one outer \`run_code\` call even when it invokes no tools; either reserve that call or merge prior partials inside the final data-reading batch.

Plan against the active policy before starting. Reserve headroom for discovery, validation, and one correction instead of filling the ${MAX_SUB_CALLS}-call hard limit. Use \`resultContract\` only when structure or invariant values are known independently, especially for side-effect-free computed summaries. Do not invent expected values, and do not apply \`exactKeys\` to a built-in binding result unless every documented key is included. Handle expected per-item failures with \`try/catch\`; do not hide budget or contract failures. Each program has independent compute-time and wall-time ceilings shown in the active policy; time spent by the model or ordinary tools does not consume them.
`;

const FULL_SDK = `
## Experimental PTC full mode

Full mode additionally exposes workspace-confined write and structured Node execution:

declare const tools: {
  write(args: { path: string; content: string }): Promise<string>;
  run(args: { path: string; args?: string[]; timeoutMs?: number }): Promise<{
    exitCode: number | null;
    signal: string | null;
    stdout: string;
    stderr: string;
  }>;
};

\`write\` creates or completely overwrites one workspace file. It rejects .git, .pi, credential directories, and node_modules. \`run\` only executes a .js or .mjs entry file inside the workspace using a fresh permission-constrained Node process. That process may read the workspace but cannot write files and has no network, child-process, Worker, addon, inspector, or ambient environment access. A non-zero exit code is returned normally so you can inspect failures and iterate. Shell commands and arbitrary executables are not available.

Use full mode for an explicitly authorized workspace workflow that benefits from manifest-driven or otherwise repetitive writes plus a Node test loop. Prefer workspace-relative paths. Read and parse manifests before constructing dependent paths; validate the actual path property present in each entry instead of assuming a field such as \`source\` or guessing generated filenames. If the schema is still unclear, return the parsed manifest for the next turn rather than trying a speculative path. Parallelize writes only when they target different files and are independent. Keep writes to the same path and all test runs sequential.

Write one complete, internally consistent batch, then run the provided test entry. Do not run the test after every individual file write. Check the returned \`exitCode\` and parse only the test's documented stdout format. For result validation, prefer returning your own small summary after the write/run completes; do not place a brittle \`exactKeys\` contract on the raw structured run object. If the test fails, inspect its stdout/stderr, change only the related files, and run it again. Do not modify tests unless the user explicitly requests it. Return a concise final result.
`;

const toolCache = new Map<string, ReturnType<typeof createWorkspaceTools>>();

function createWorkspaceTools(cwd: string) {
  return {
    read: createReadTool(cwd),
    find: createFindTool(cwd),
    grep: createGrepTool(cwd),
    ls: createLsTool(cwd),
    write: createWriteTool(cwd),
  };
}

function getWorkspaceTools(cwd: string) {
  let tools = toolCache.get(cwd);
  if (!tools) {
    tools = createWorkspaceTools(cwd);
    toolCache.set(cwd, tools);
  }
  return tools;
}

function textFromToolResult(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content
    .filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text as string)
    .join("\n");
}

function truncateBindingResult(value: string): string {
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes <= MAX_BINDING_RESULT_BYTES) return value;
  const prefix = Buffer.from(value, "utf8").subarray(0, MAX_BINDING_RESULT_BYTES).toString("utf8");
  return `${prefix}\n[PTC binding result truncated at ${MAX_BINDING_RESULT_BYTES} bytes]`;
}

function requireRecord(value: unknown, toolName: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${toolName} arguments must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(args: Record<string, unknown>, key: string, toolName: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${toolName}.${key} must be a non-empty string`);
  }
  return value;
}

function checkOptionalType(
  args: Record<string, unknown>,
  key: string,
  expected: "string" | "boolean" | "integer" | "stringArray",
  minimum = 0,
): void {
  const value = args[key];
  if (value === undefined) return;
  const valid = expected === "integer"
    ? Number.isSafeInteger(value) && (value as number) >= minimum
    : expected === "stringArray"
      ? Array.isArray(value) && value.every((item) => typeof item === "string")
      : typeof value === expected;
  if (!valid) throw new Error(`${key} must be ${expected}${expected === "integer" ? ` >= ${minimum}` : ""}`);
}

function assertAllowedKeys(name: BindingName, args: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(args)) {
    if (!allowedSet.has(key)) throw new Error(`${name} does not accept argument: ${key}`);
  }
}

function assertInside(root: string, target: string, label: string): void {
  const fromRoot = relative(root, target);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error(`${label} must stay inside the current workspace`);
  }
}

async function resolveExistingWorkspacePath(cwd: string, requestedPath: string, label: string): Promise<{ root: string; target: string }> {
  const root = await realpath(cwd);
  const target = await realpath(resolve(root, requestedPath));
  assertInside(root, target, label);
  return { root, target };
}

async function resolveWritableWorkspacePath(cwd: string, requestedPath: string): Promise<{ root: string; target: string }> {
  const root = await realpath(cwd);
  const lexicalTarget = resolve(root, requestedPath);
  assertInside(root, lexicalTarget, "write.path");

  let target: string;
  try {
    target = await realpath(lexicalTarget);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    let ancestor = dirname(lexicalTarget);
    while (true) {
      try {
        const realAncestor = await realpath(ancestor);
        target = resolve(realAncestor, relative(ancestor, lexicalTarget));
        break;
      } catch (ancestorError) {
        if ((ancestorError as NodeJS.ErrnoException).code !== "ENOENT") throw ancestorError;
        const parent = dirname(ancestor);
        if (parent === ancestor) throw ancestorError;
        ancestor = parent;
      }
    }
  }
  assertInside(root, target, "write.path");
  const segments = relative(root, target).split(sep).map((segment) => segment.toLowerCase());
  if (segments.some((segment) => BLOCKED_WRITE_SEGMENTS.has(segment))) {
    throw new Error("write.path targets a protected workspace directory");
  }
  return { root, target };
}

async function validateReadOnlyArgs(cwd: string, call: RuntimeCallMessage): Promise<Record<string, unknown>> {
  const args = requireRecord(call.args, call.name);
  const allowedKeys: Record<"read" | "find" | "grep" | "ls", readonly string[]> = {
    read: ["path", "offset", "limit"],
    find: ["path", "pattern", "limit"],
    grep: ["path", "pattern", "glob", "ignoreCase", "literal", "context", "limit"],
    ls: ["path", "limit"],
  };
  const name = call.name as keyof typeof allowedKeys;
  assertAllowedKeys(call.name, args, allowedKeys[name]);
  if (name === "read") requireString(args, "path", name);
  if (name === "find" || name === "grep") requireString(args, "pattern", name);
  checkOptionalType(args, "path", "string");
  checkOptionalType(args, "glob", "string");
  checkOptionalType(args, "ignoreCase", "boolean");
  checkOptionalType(args, "literal", "boolean");
  checkOptionalType(args, "offset", "integer", 1);
  checkOptionalType(args, "context", "integer", 0);
  checkOptionalType(args, "limit", "integer", 1);
  const requestedPath = typeof args.path === "string" && args.path.trim() ? args.path : ".";
  const { target } = await resolveExistingWorkspacePath(cwd, requestedPath, `${name}.path`);
  return { ...args, path: target };
}

async function validateWriteArgs(cwd: string, call: RuntimeCallMessage): Promise<Record<string, unknown>> {
  const args = requireRecord(call.args, call.name);
  assertAllowedKeys(call.name, args, ["path", "content"]);
  const path = requireString(args, "path", call.name);
  const content = args.content;
  if (typeof content !== "string") throw new Error("write.content must be a string");
  if (Buffer.byteLength(content, "utf8") > MAX_WRITE_BYTES) {
    throw new Error(`write.content exceeds ${MAX_WRITE_BYTES} bytes`);
  }
  const { target } = await resolveWritableWorkspacePath(cwd, path);
  return { path: target, content };
}

async function executeStructuredRun(
  cwd: string,
  call: RuntimeCallMessage,
  signal: AbortSignal,
): Promise<StructuredRunResult> {
  const args = requireRecord(call.args, call.name);
  assertAllowedKeys(call.name, args, ["path", "args", "timeoutMs"]);
  const requestedPath = requireString(args, "path", call.name);
  checkOptionalType(args, "args", "stringArray");
  checkOptionalType(args, "timeoutMs", "integer", 1);
  const timeoutMs = Math.min((args.timeoutMs as number | undefined) ?? 10_000, MAX_RUN_TIMEOUT_MS);
  const scriptArgs = (args.args as string[] | undefined) ?? [];
  if (scriptArgs.length > 32 || scriptArgs.some((item) => Buffer.byteLength(item, "utf8") > 4_096)) {
    throw new Error("run.args exceeds the argument count or size limit");
  }
  const { root, target } = await resolveExistingWorkspacePath(cwd, requestedPath, "run.path");
  if (!new Set([".js", ".mjs"]).has(extname(target).toLowerCase())) {
    throw new Error("run.path must be a .js or .mjs file inside the workspace");
  }

  return new Promise<StructuredRunResult>((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [
      "--permission",
      `--allow-fs-read=${root}`,
      "--no-addons",
      "--no-warnings",
      "--disable-sigusr1",
      "--max-old-space-size=128",
      target,
      ...scriptArgs,
    ], {
      cwd: root,
      env: {},
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let outputBytes = 0;
    let forcedError: Error | undefined;
    let finished = false;

    const terminate = (error: Error) => {
      if (finished || forcedError) return;
      forcedError = error;
      child.kill("SIGKILL");
    };
    const collect = (chunks: Buffer[], chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_RUN_OUTPUT_BYTES) {
        terminate(new Error(`run output exceeds ${MAX_RUN_OUTPUT_BYTES} bytes`));
        return;
      }
      chunks.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => collect(stdoutChunks, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(stderrChunks, chunk));
    const timer = setTimeout(() => terminate(new Error(`run exceeded ${timeoutMs} ms`)), timeoutMs);
    const onAbort = () => terminate(new Error("run was cancelled"));
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();

    child.once("error", (error) => terminate(error));
    child.once("exit", (exitCode, exitSignal) => {
      finished = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      if (forcedError) {
        rejectPromise(forcedError);
        return;
      }
      resolvePromise({
        exitCode,
        signal: exitSignal,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
      });
    });
  });
}

async function executeBinding(
  cwd: string,
  call: RuntimeCallMessage,
  signal: AbortSignal,
  fullMode: boolean,
  budget: PtcBudgetState,
): Promise<unknown> {
  if (!fullMode && (call.name === "write" || call.name === "run")) {
    throw new Error(`PTC tool is not available in read-only mode: ${call.name}`);
  }
  reserveNestedCall(budget, call.name);
  if (call.name === "run") return executeStructuredRun(cwd, call, signal);

  const tools = getWorkspaceTools(cwd);
  const callId = `ptc:${call.id}`;
  if (call.name === "write") {
    const safeArgs = await validateWriteArgs(cwd, call);
    const result = await tools.write.execute(callId, safeArgs as never, signal, undefined);
    return truncateBindingResult(textFromToolResult(result));
  }

  if (!READ_ONLY_TOOLS.includes(call.name as typeof READ_ONLY_TOOLS[number])) {
    throw new Error(`PTC tool is not allowed: ${String(call.name)}`);
  }
  const safeArgs = await validateReadOnlyArgs(cwd, call);
  let result;
  switch (call.name) {
    case "read":
      result = await tools.read.execute(callId, safeArgs as never, signal, undefined);
      break;
    case "find":
      result = await tools.find.execute(callId, safeArgs as never, signal, undefined);
      break;
    case "grep":
      result = await tools.grep.execute(callId, safeArgs as never, signal, undefined);
      break;
    case "ls":
      result = await tools.ls.execute(callId, safeArgs as never, signal, undefined);
      break;
    default:
      throw new Error(`PTC tool is not allowed: ${String(call.name)}`);
  }
  return truncateBindingResult(textFromToolResult(result));
}

function parseRuntimeMessage(line: string): RuntimeMessage {
  const value = JSON.parse(line) as Partial<RuntimeMessage>;
  if (value.type === "call" && Number.isSafeInteger(value.id) && typeof value.name === "string") {
    return value as RuntimeCallMessage;
  }
  if (value.type === "log" && typeof value.text === "string") return value as RuntimeLogMessage;
  if (value.type === "heartbeat" && Number.isFinite(value.computeTimeMs)) return value as RuntimeHeartbeatMessage;
  if (value.type === "done" && Number.isSafeInteger(value.calls)) return value as RuntimeDoneMessage;
  if (value.type === "error" && typeof value.message === "string") return value as RuntimeErrorMessage;
  throw new Error("Invalid PTC runtime protocol message");
}

async function runPtcProgram(
  code: string,
  cwd: string,
  outerSignal: AbortSignal | undefined,
  fullMode: boolean,
  budget: PtcBudgetState,
): Promise<RuntimeResult> {
  if (Buffer.byteLength(code, "utf8") > MAX_CODE_BYTES) {
    throw new Error(`PTC program exceeds ${MAX_CODE_BYTES} bytes`);
  }

  const runnerPath = fileURLToPath(new URL("./ptc/runtime-child.mjs", import.meta.url));
  const child = spawn(process.execPath, [
    "--permission",
    "--no-warnings",
    "--disable-sigusr1",
    "--max-old-space-size=128",
    runnerPath,
  ], {
    cwd,
    env: {},
    stdio: ["pipe", "pipe", "pipe"],
  });

  const nestedAbort = new AbortController();
  const logs: string[] = [];
  const inFlight = new Set<Promise<void>>();
  let protocolBytes = 0;
  let stderr = "";
  let finalMessage: RuntimeDoneMessage | RuntimeErrorMessage | undefined;
  let forcedError: Error | undefined;
  let settled = false;
  const runStartedAt = performance.now();
  let lastHeartbeatAt = runStartedAt;
  let reportedComputeTimeMs = 0;

  const send = (message: unknown) => {
    if (child.stdin.destroyed || child.stdin.writableEnded || !child.stdin.writable) return;
    child.stdin.write(`${JSON.stringify(message)}\n`);
  };
  const terminate = (error: Error) => {
    if (settled || forcedError) return;
    forcedError = error;
    nestedAbort.abort(error);
    child.kill("SIGKILL");
  };
  child.stdin.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "ERR_STREAM_WRITE_AFTER_END" && (settled || child.stdin.writableEnded)) return;
    terminate(error);
  });

  const wallTimeoutMs = budget.policy.maxRunWallTimeMs;
  const computeTimeoutMs = budget.policy.maxRunComputeTimeMs;
  const timeout = setTimeout(() => terminate(createRunBudgetError(
    budget,
    "runWallTimeMs",
    Math.ceil(performance.now() - runStartedAt),
    wallTimeoutMs,
  )), wallTimeoutMs);
  const computeWatchdog = setInterval(() => {
    const heartbeatSilenceMs = performance.now() - lastHeartbeatAt;
    if (heartbeatSilenceMs <= computeTimeoutMs + RUNTIME_HEARTBEAT_GRACE_MS) return;
    terminate(createRunBudgetError(
      budget,
      "runComputeTimeMs",
      Math.ceil(heartbeatSilenceMs - RUNTIME_HEARTBEAT_GRACE_MS),
      computeTimeoutMs,
    ));
  }, RUNTIME_WATCHDOG_INTERVAL_MS);
  computeWatchdog.unref();
  const onOuterAbort = () => terminate(new Error("PTC program was cancelled"));
  outerSignal?.addEventListener("abort", onOuterAbort, { once: true });
  if (outerSignal?.aborted) onOuterAbort();

  child.stdout.on("data", (chunk: Buffer) => {
    protocolBytes += chunk.length;
    if (protocolBytes > MAX_PROTOCOL_BYTES) terminate(new Error(`PTC protocol output exceeded ${MAX_PROTOCOL_BYTES} bytes`));
  });
  child.stderr.on("data", (chunk: Buffer) => {
    if (Buffer.byteLength(stderr, "utf8") < 16 * 1024) stderr += chunk.toString("utf8");
  });

  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on("line", (line) => {
    if (forcedError) return;
    let message: RuntimeMessage;
    try {
      message = parseRuntimeMessage(line);
    } catch (error) {
      terminate(error instanceof Error ? error : new Error(String(error)));
      return;
    }

    if (message.type === "heartbeat") {
      lastHeartbeatAt = performance.now();
      reportedComputeTimeMs = Math.max(reportedComputeTimeMs, message.computeTimeMs);
      if (reportedComputeTimeMs > computeTimeoutMs) {
        terminate(createRunBudgetError(
          budget,
          "runComputeTimeMs",
          Math.ceil(reportedComputeTimeMs),
          computeTimeoutMs,
        ));
      }
      return;
    }
    if (message.type === "log") {
      logs.push(`[${message.level}] ${message.text}`);
      return;
    }
    if (message.type === "done" || message.type === "error") {
      finalMessage = message;
      child.stdin.end();
      return;
    }
    if (message.type === "call") {
      if (message.id < 1 || message.id > MAX_SUB_CALLS) {
        send({ type: "result", id: message.id, ok: false, error: "Invalid PTC sub-call id" });
        return;
      }
      const task = executeBinding(cwd, message, nestedAbort.signal, fullMode, budget)
        .then(
          (value) => send({ type: "result", id: message.id, ok: true, value }),
          (error) => send({
            type: "result",
            id: message.id,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          }),
        )
        .finally(() => inFlight.delete(task));
      inFlight.add(task);
    }
  });

  send({
    type: "run",
    code,
    maxCalls: MAX_SUB_CALLS,
    maxComputeTimeMs: computeTimeoutMs,
    allowedTools: fullMode ? FULL_TOOLS : READ_ONLY_TOOLS,
  });

  return new Promise<RuntimeResult>((resolvePromise, rejectPromise) => {
    child.once("error", (error) => terminate(error));
    child.once("exit", async (exitCode, exitSignal) => {
      settled = true;
      clearTimeout(timeout);
      clearInterval(computeWatchdog);
      outerSignal?.removeEventListener("abort", onOuterAbort);
      nestedAbort.abort();
      await Promise.allSettled([...inFlight]);

      if (forcedError) {
        rejectPromise(forcedError);
        return;
      }
      if (budget.violation) {
        rejectPromise(budget.violation);
        return;
      }
      if (finalMessage?.type === "error") {
        if (finalMessage.code === "compute_timeout") {
          rejectPromise(createRunBudgetError(
            budget,
            "runComputeTimeMs",
            Math.ceil(finalMessage.computeTimeMs ?? computeTimeoutMs + 1),
            computeTimeoutMs,
          ));
        } else {
          rejectPromise(new Error(finalMessage.message));
        }
        return;
      }
      if (finalMessage?.type !== "done" || exitCode !== 0 || exitSignal) {
        const suffix = stderr.trim() ? `: ${stderr.trim()}` : "";
        rejectPromise(new Error(`PTC runtime exited unexpectedly (code=${exitCode}, signal=${exitSignal})${suffix}`));
        return;
      }
      resolvePromise({
        logs,
        result: finalMessage.result,
        calls: finalMessage.calls,
        toolCounts: finalMessage.toolCounts ?? {},
        computeTimeMs: Math.max(reportedComputeTimeMs, finalMessage.computeTimeMs ?? 0),
      });
    });
  });
}

export function runPtcProgramForTest(
  code: string,
  cwd: string,
  signal: AbortSignal | undefined,
  fullMode: boolean,
  budget: PtcBudgetState,
): Promise<RuntimeResult> {
  return runPtcProgram(code, cwd, signal, fullMode, budget);
}

function renderRuntimeResult(result: RuntimeResult): string {
  const sections: string[] = [];
  if (result.logs.length > 0) sections.push(result.logs.join("\n"));
  if (result.result !== undefined) {
    sections.push(typeof result.result === "string" ? result.result : JSON.stringify(result.result, null, 2));
  }
  if (sections.length === 0) sections.push("(run_code completed with no output)");
  return sections.join("\n\n");
}

function updateStatus(ctx: ExtensionContext, mode: PtcMode, budget?: PtcBudgetState): void {
  if (!ctx.hasUI) return;
  if (mode === "off") {
    ctx.ui.setStatus(STATUS_KEY, undefined);
    return;
  }
  const label = mode === "ptc" ? "strict" : mode === "full" ? "full-rwx" : "both";
  const calls = budget ? `${budget.outerRunCodeCalls}/${budget.policy.maxOuterRunCodeCalls}` : "0/?";
  ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("warning", `PTC ${label} · calls ${calls}`));
}

const RESULT_CONTRACT_SCHEMA = Type.Optional(Type.Object({
  kind: Type.Optional(Type.Union([Type.Literal("object"), Type.Literal("array")])),
  requiredKeys: Type.Optional(Type.Array(Type.String(), { maxItems: 64 })),
  exactKeys: Type.Optional(Type.Boolean()),
  expectedIntegers: Type.Optional(Type.Array(Type.Object({
    key: Type.String(),
    value: Type.Integer(),
  }), { maxItems: 64 })),
  expectedArrayLengths: Type.Optional(Type.Array(Type.Object({
    key: Type.String(),
    length: Type.Integer({ minimum: 0 }),
  }), { maxItems: 64 })),
}, { additionalProperties: false }));

export default function ptcExtension(pi: ExtensionAPI): void {
  let mode: PtcMode = "off";
  let previousTools: string[] | undefined;
  let budget: PtcBudgetState | undefined;

  const policyMode = () => mode === "full" ? "full" as const : "readOnly" as const;
  const resetBudget = (ctx: ExtensionContext) => {
    if (mode === "off") {
      budget = undefined;
      return undefined;
    }
    budget = createBudgetState(resolvePtcPolicy(policyMode(), ctx.model));
    updateStatus(ctx, mode, budget);
    return budget;
  };
  const ensureBudget = (ctx: ExtensionContext) => {
    const expected = resolvePtcPolicy(policyMode(), ctx.model);
    if (!budget) budget = createBudgetState(expected);
    else if (budget.policy.modelKey !== expected.modelKey || budget.policy.mode !== expected.mode) {
      budget = retargetBudgetState(budget, expected);
    }
    return budget;
  };

  const restoreTools = () => {
    if (!previousTools) return;
    const available = new Set(pi.getAllTools().map((tool) => tool.name));
    pi.setActiveTools(previousTools.filter((name) => available.has(name) && name !== TOOL_NAME));
    previousTools = undefined;
  };

  const setMode = (nextMode: PtcMode, ctx: ExtensionContext) => {
    if (nextMode === "off") {
      restoreTools();
      mode = "off";
      budget = undefined;
      updateStatus(ctx, mode);
      ctx.ui.notify("PTC 模式已关闭", "info");
      return;
    }
    if (nextMode === "full" && typeof ctx.isProjectTrusted === "function" && !ctx.isProjectTrusted()) {
      ctx.ui.notify("PTC full 模式要求当前项目已被 Pi 信任", "error");
      return;
    }

    if (!previousTools) previousTools = pi.getActiveTools().filter((name) => name !== TOOL_NAME);
    mode = nextMode;
    pi.setActiveTools(nextMode === "both" ? [...previousTools, TOOL_NAME] : [TOOL_NAME]);
    resetBudget(ctx);
    const message = nextMode === "ptc"
      ? "PTC 严格只读模式已启用：模型仅看到 run_code"
      : nextMode === "both"
        ? "PTC both 模式已启用：保留原工具并增加只读 run_code"
        : "PTC full 实验模式已启用：允许工作区写入和受限 Node 运行";
    ctx.ui.notify(message, "warning");
  };

  pi.registerTool({
    name: TOOL_NAME,
    label: "PTC run_code (experimental)",
    description: "Run one TypeScript program against the experimental PTC SDK. Full mode adds workspace-confined write and permission-constrained Node execution.",
    promptSnippet: "run_code: combine PTC read operations, or in explicit full mode perform workspace-confined write/run workflows",
    promptGuidelines: [
      "In mixed mode use ordinary tools for one-file lookups, and start deterministic three-or-more-call aggregation with run_code.",
      "Keep intermediate data inside the program, parallelize only independent calls, and preserve path/result associations.",
      "Treat find/ls output as newline-delimited text and use manifest paths exactly instead of guessing filenames.",
      "In PTC full mode, complete one consistent write batch before running the provided Node test entry.",
    ],
    parameters: Type.Object({
      code: Type.String({ description: "Body of an async TypeScript function with top-level await/return" }),
      description: Type.String({ description: "Short description of what the program does" }),
      resultContract: RESULT_CONTRACT_SCHEMA,
    }, { additionalProperties: false }),
    executionMode: "sequential",
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (mode === "off") throw new Error("PTC mode is disabled; run /ptc on, /ptc both, or /ptc full first");
      const fullMode = mode === "full";
      const activeBudget = ensureBudget(ctx);
      reserveOuterRunCode(activeBudget);
      updateStatus(ctx, mode, activeBudget);
      const runStartedAt = performance.now();
      let result: RuntimeResult | undefined;
      try {
        result = await runPtcProgram(params.code, ctx.cwd, signal, fullMode, activeBudget);
      } finally {
        recordRunUsage(activeBudget, {
          computeTimeMs: result?.computeTimeMs,
          wallTimeMs: performance.now() - runStartedAt,
        });
        updateStatus(ctx, mode, activeBudget);
      }
      if (!result) throw new Error("PTC runtime completed without a result");
      const validated = normalizeAndValidateResult(
        result.result,
        activeBudget.policy.normalizeJsonFence,
        params.resultContract,
      );
      const rendered = renderRuntimeResult({ ...result, result: validated.value });
      return {
        content: [{ type: "text", text: rendered }],
        details: {
          experimental: true,
          readOnly: !fullMode,
          fullMode,
          description: params.description,
          subCalls: result.calls,
          toolCounts: result.toolCounts,
          logs: result.logs.length,
          resultValidation: {
            contractApplied: validated.contractApplied,
            normalizedJson: validated.normalized,
            passed: true,
          },
          budget: budgetSnapshot(activeBudget),
        },
      };
    },
  });

  pi.registerCommand("ptc", {
    description: "实验性 PTC 模式：/ptc on|both|full|off|status",
    handler: async (args, ctx) => {
      let action = args.trim().toLowerCase();
      if (!action && ctx.hasUI) {
        action = (await ctx.ui.select("PTC 模式", ["on", "both", "full", "off", "status"])) ?? "";
      }
      if (action === "on") setMode("ptc", ctx);
      else if (action === "both") setMode("both", ctx);
      else if (action === "full") setMode("full", ctx);
      else if (action === "off") setMode("off", ctx);
      else if (action === "status") {
        const snapshot = budgetSnapshot(mode === "off" ? undefined : ensureBudget(ctx));
        ctx.ui.notify(`PTC 当前状态：${mode}${snapshot ? `\n${JSON.stringify(snapshot, null, 2)}` : ""}`, "info");
      } else ctx.ui.notify("用法：/ptc on|both|full|off|status", "warning");
    },
  });

  pi.on("before_agent_start", (event, ctx) => {
    if (mode === "off") return undefined;
    const activeBudget = resetBudget(ctx);
    const fullPrompt = mode === "full" ? FULL_SDK : "\nFilesystem writes, process execution, network access, and shell commands are unavailable.\n";
    const modePrompt = mode === "both"
      ? "\nThis is mixed PTC mode. For one file read/search with no cross-file processing, use the ordinary tool directly and do not use run_code. For deterministic filtering, joining, aggregation, or transformation across three or more related files/calls, use run_code as the first data-access tool. After a failed approach, a focused ordinary read is allowed for diagnosis before retrying."
      : mode === "full"
        ? "\nThis is strict PTC full mode. Call only run_code directly. If the task needs a shell, a non-Node executable, unsupported patch semantics, or capabilities outside the declared SDK, stop and explain that the user should switch modes instead of attempting a workaround."
        : "\nThis is strict read-only PTC mode. Call only run_code directly. If the task is not a read-only deterministic workflow supported by the declared SDK, stop and explain that the user should switch modes instead of attempting a workaround.";
    const policyPrompt = `\nActive model policy: ${JSON.stringify(budgetSnapshot(activeBudget))}. `
      + "These limits are enforced. Compute and wall ceilings apply independently to each run_code execution; model thinking and ordinary tools do not consume them. Reserve call, sub-call, and token headroom for one correction. Use resultContract only for independently known structure/invariants; avoid brittle exact-key contracts around side-effecting write/run workflows.";
    return { systemPrompt: `${event.systemPrompt}\n${READ_ONLY_SDK}${fullPrompt}${modePrompt}${policyPrompt}` };
  });

  pi.on("message_end", (event, ctx) => {
    if (mode === "off" || event.message.role !== "assistant") return undefined;
    const activeBudget = ensureBudget(ctx);
    // Provider totalTokens includes the full input context on every turn. Charging it
    // would make PTC unusable in long or compacted sessions, so only new output counts.
    recordAssistantTokens(activeBudget, event.message.usage?.output);
    updateStatus(ctx, mode, activeBudget);
    if (!activeBudget.policy.normalizeJsonFence || !Array.isArray(event.message.content)) return undefined;
    if (event.message.content.some((part) => part.type === "toolCall")) return undefined;
    const textIndices = event.message.content
      .map((part, index) => part.type === "text" ? index : -1)
      .filter((index) => index >= 0);
    if (textIndices.length !== 1) return undefined;
    const textIndex = textIndices[0];
    const textPart = event.message.content[textIndex];
    if (textPart.type !== "text") return undefined;
    const normalized = normalizeFencedJsonText(textPart.text);
    if (!normalized || normalized === textPart.text) return undefined;
    const content = [...event.message.content];
    content[textIndex] = { ...textPart, text: normalized };
    return { message: { ...event.message, content } };
  });

  pi.on("model_select", (event, ctx) => {
    if (mode === "off") return;
    const expected = resolvePtcPolicy(policyMode(), event.model);
    budget = budget ? retargetBudgetState(budget, expected) : createBudgetState(expected);
    updateStatus(ctx, mode, budget);
  });

  pi.on("agent_settled", (_event, ctx) => {
    if (mode !== "off") updateStatus(ctx, mode, budget);
  });

  pi.on("session_start", (_event, ctx) => {
    mode = "off";
    previousTools = undefined;
    budget = undefined;
    const active = pi.getActiveTools();
    if (active.includes(TOOL_NAME)) pi.setActiveTools(active.filter((name) => name !== TOOL_NAME));
    updateStatus(ctx, mode);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    restoreTools();
    mode = "off";
    budget = undefined;
    updateStatus(ctx, mode);
  });
}
