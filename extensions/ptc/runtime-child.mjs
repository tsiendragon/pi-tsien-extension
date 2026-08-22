import { stripTypeScriptTypes } from "node:module";
import { performance } from "node:perf_hooks";
import { createInterface } from "node:readline";
import vm from "node:vm";

const SUPPORTED_TOOLS = new Set(["read", "find", "grep", "ls", "write", "run"]);
let allowedTools = new Set(["read", "find", "grep", "ls"]);
const pendingCalls = new Map();
let started = false;
let settled = false;
let nextCallId = 1;
let maxCalls = 32;
let maxComputeTimeMs = 15_000;
let computeBaseline;
let heartbeat;
const toolCounts = Object.create(null);

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function exitWith(message, code) {
  if (settled) return;
  settled = true;
  if (heartbeat) clearInterval(heartbeat);
  const payload = `${JSON.stringify(message)}\n`;
  process.stdout.write(payload, () => process.exit(code));
}

function currentComputeTimeMs() {
  if (!computeBaseline) return 0;
  return Math.max(0, performance.eventLoopUtilization(computeBaseline).active);
}

function startComputeHeartbeat() {
  computeBaseline = performance.eventLoopUtilization();
  send({ type: "heartbeat", computeTimeMs: 0 });
  heartbeat = setInterval(() => {
    const computeTimeMs = currentComputeTimeMs();
    if (computeTimeMs > maxComputeTimeMs) {
      exitWith({
        type: "error",
        code: "compute_timeout",
        message: `PTC program exceeded ${maxComputeTimeMs} ms compute-time limit`,
        computeTimeMs,
      }, 1);
      return;
    }
    send({ type: "heartbeat", computeTimeMs });
  }, 100);
  heartbeat.unref();
}

function cloneLosslessJson(value, label) {
  if (value === undefined) return undefined;

  const stack = [value];
  const seen = new WeakSet();
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === null) continue;

    const kind = typeof current;
    if (kind === "string" || kind === "boolean") continue;
    if (kind === "number") {
      if (!Number.isFinite(current) || Object.is(current, -0)) {
        throw new TypeError(`${label} contains a non-lossless number`);
      }
      continue;
    }
    if (kind !== "object") {
      throw new TypeError(`${label} contains unsupported ${kind}`);
    }

    if (seen.has(current)) throw new TypeError(`${label} contains a cycle`);
    seen.add(current);

    if (Array.isArray(current)) {
      for (let index = 0; index < current.length; index += 1) {
        if (!(index in current)) throw new TypeError(`${label} contains a sparse array`);
        stack.push(current[index]);
      }
      continue;
    }

    const prototype = Object.getPrototypeOf(current);
    const prototypeParent = prototype === null ? null : Object.getPrototypeOf(prototype);
    if (prototype !== null && prototypeParent !== null) {
      throw new TypeError(`${label} contains a non-plain object`);
    }
    for (const item of Object.values(current)) stack.push(item);
  }

  return JSON.parse(JSON.stringify(value));
}

function formatLogValue(value) {
  if (typeof value === "string") return value;
  try {
    const cloned = cloneLosslessJson(value, "console value");
    return cloned === undefined ? "undefined" : JSON.stringify(cloned);
  } catch {
    return String(value);
  }
}

const safeConsole = Object.freeze({
  log: (...values) => send({ type: "log", level: "log", text: values.map(formatLogValue).join(" ") }),
  info: (...values) => send({ type: "log", level: "info", text: values.map(formatLogValue).join(" ") }),
  warn: (...values) => send({ type: "log", level: "warn", text: values.map(formatLogValue).join(" ") }),
  error: (...values) => send({ type: "log", level: "error", text: values.map(formatLogValue).join(" ") }),
  debug: (...values) => send({ type: "log", level: "debug", text: values.map(formatLogValue).join(" ") }),
});

function callTool(name, args) {
  if (!allowedTools.has(name)) {
    return Promise.reject(new Error(`PTC tool is not available: ${name}`));
  }
  if (nextCallId > maxCalls) {
    return Promise.reject(new Error(`PTC sub-call limit exceeded (${maxCalls})`));
  }

  let safeArgs;
  try {
    safeArgs = cloneLosslessJson(args ?? {}, `${name} arguments`);
  } catch (error) {
    return Promise.reject(error);
  }

  const id = nextCallId;
  nextCallId += 1;
  toolCounts[name] = (toolCounts[name] ?? 0) + 1;
  return new Promise((resolve, reject) => {
    pendingCalls.set(id, { resolve, reject });
    send({ type: "call", id, name, args: safeArgs });
  });
}

const tools = new Proxy(Object.create(null), {
  get(_target, property) {
    if (property === "then") return undefined;
    if (typeof property !== "string" || !allowedTools.has(property)) return undefined;
    return (args) => callTool(property, args);
  },
  ownKeys() {
    return [...allowedTools];
  },
  getOwnPropertyDescriptor(_target, property) {
    if (typeof property === "string" && allowedTools.has(property)) {
      return { configurable: true, enumerable: true };
    }
    return undefined;
  },
});

async function runProgram(message) {
  maxCalls = Number.isSafeInteger(message.maxCalls) && message.maxCalls > 0 ? message.maxCalls : maxCalls;
  maxComputeTimeMs = Number.isSafeInteger(message.maxComputeTimeMs) && message.maxComputeTimeMs > 0
    ? message.maxComputeTimeMs
    : maxComputeTimeMs;
  if (Array.isArray(message.allowedTools)) {
    allowedTools = new Set(message.allowedTools.filter((name) => typeof name === "string" && SUPPORTED_TOOLS.has(name)));
  }
  const code = typeof message.code === "string" ? message.code : "";
  if (!code.trim()) throw new Error("PTC program is empty");

  const wrapped = `async function __ptc_main(tools, console) {\n${code}\n}`;
  const stripped = stripTypeScriptTypes(wrapped, { mode: "strip" });
  const context = vm.createContext(
    { tools, console: safeConsole },
    { codeGeneration: { strings: false, wasm: false }, name: "pi-ptc-experimental" },
  );
  const script = new vm.Script(`${stripped}\n__ptc_main(tools, console)`, {
    filename: "ptc-program.ts",
  });
  startComputeHeartbeat();
  const result = await script.runInContext(context, { timeout: maxComputeTimeMs });
  return cloneLosslessJson(result, "PTC result");
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    exitWith({ type: "error", message: "Invalid host protocol message" }, 1);
    return;
  }

  if (message.type === "run") {
    if (started) {
      exitWith({ type: "error", message: "PTC runtime accepts one program per process" }, 1);
      return;
    }
    started = true;
    void runProgram(message).then(
      (result) => exitWith({
        type: "done",
        result,
        calls: nextCallId - 1,
        toolCounts,
        computeTimeMs: currentComputeTimeMs(),
      }, 0),
      (error) => exitWith({
        type: "error",
        code: error?.code === "ERR_SCRIPT_EXECUTION_TIMEOUT" ? "compute_timeout" : undefined,
        message: error instanceof Error ? error.message : String(error),
        computeTimeMs: currentComputeTimeMs(),
      }, 1),
    );
    return;
  }

  if (message.type === "result" && Number.isSafeInteger(message.id)) {
    const pending = pendingCalls.get(message.id);
    if (!pending) return;
    pendingCalls.delete(message.id);
    if (message.ok) pending.resolve(message.value);
    else pending.reject(new Error(typeof message.error === "string" ? message.error : "PTC tool call failed"));
  }
});

input.on("close", () => {
  if (!settled) exitWith({ type: "error", message: "Host closed the PTC protocol" }, 1);
});
