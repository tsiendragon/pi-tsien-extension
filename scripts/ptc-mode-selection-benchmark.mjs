import { spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ptcExtension = join(repoRoot, "extensions", "ptc.ts");

const MODEL_IDS = [
  "openai-codex/gpt-5.6-sol",
  "openai-codex/gpt-5.6-terra",
  "openai-codex/gpt-5.6-luna",
  "dashscope/deepseek-v4-flash",
  "dashscope/deepseek-v4-pro",
];

const CASE_IDS = ["simple", "batch"];
const DIRECT_READ_TOOLS = new Set(["read", "find", "grep", "ls"]);

function usage() {
  return "Usage: node scripts/ptc-mode-selection-benchmark.mjs [--models=a,b] [--cases=simple,batch] [--trials=1] [--timeout-ms=300000] [--output=path]";
}

function parseArgs(argv) {
  const options = {
    models: [...MODEL_IDS],
    cases: [...CASE_IDS],
    trials: 1,
    timeoutMs: 300_000,
    output: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") {
      console.log(usage());
      process.exit(0);
    }
    const equals = argument.indexOf("=");
    const key = equals >= 0 ? argument.slice(0, equals) : argument;
    let value = equals >= 0 ? argument.slice(equals + 1) : null;
    if (!["--models", "--cases", "--trials", "--timeout-ms", "--output"].includes(key)) {
      throw new Error(`Unknown argument: ${argument}`);
    }
    if (value === null) {
      index += 1;
      value = argv[index];
      if (value === undefined || value.startsWith("--")) throw new Error(`${key} requires a value`);
    }
    if (key === "--models") options.models = value.split(",").map((item) => item.trim()).filter(Boolean);
    else if (key === "--cases") options.cases = value.split(",").map((item) => item.trim()).filter(Boolean);
    else if (key === "--trials") options.trials = Number.parseInt(value, 10);
    else if (key === "--timeout-ms") options.timeoutMs = Number.parseInt(value, 10);
    else options.output = resolve(value);
  }

  if (options.models.length === 0) throw new Error("--models must contain at least one model");
  for (const model of options.models) {
    if (!MODEL_IDS.includes(model)) throw new Error(`Unsupported model: ${model}`);
  }
  if (options.cases.length === 0) throw new Error("--cases must contain at least one case");
  for (const caseId of options.cases) {
    if (!CASE_IDS.includes(caseId)) throw new Error(`Unsupported case: ${caseId}`);
  }
  if (!Number.isSafeInteger(options.trials) || options.trials < 1) {
    throw new Error("--trials must be a positive integer");
  }
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1_000) {
    throw new Error("--timeout-ms must be >= 1000");
  }
  return options;
}

function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalize(value[key])]));
  }
  return value;
}

function equalJson(left, right) {
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

function parseFinalJson(text) {
  try {
    return { value: JSON.parse(text), strictJson: true, parseError: null };
  } catch (strictError) {
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    const firstBrace = text.indexOf("{");
    const lastBrace = text.lastIndexOf("}");
    const candidate = fence?.[1] ?? (firstBrace >= 0 && lastBrace >= firstBrace ? text.slice(firstBrace, lastBrace + 1) : "");
    try {
      return { value: JSON.parse(candidate), strictJson: false, parseError: null };
    } catch {
      return {
        value: null,
        strictJson: false,
        parseError: strictError instanceof Error ? strictError.message : String(strictError),
      };
    }
  }
}

function sumUsage(messages) {
  const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0, cost: 0 };
  for (const message of messages) {
    const usage = message.usage ?? {};
    for (const key of ["input", "output", "cacheRead", "cacheWrite", "reasoning", "totalTokens"]) {
      total[key] += usage[key] ?? 0;
    }
    total.cost += usage.cost?.total ?? 0;
  }
  return total;
}

function finalAssistantText(messages) {
  const message = messages.at(-1);
  if (!message || !Array.isArray(message.content)) return "";
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function safeLabel(model, trial, caseId) {
  return `${model.replaceAll("/", "_")}-t${trial}-${caseId}`.replaceAll(/[^A-Za-z0-9_.-]/g, "_");
}

function buildBatchExpected(parts) {
  const records = parts.flatMap((part) => part.records).filter((record) => record.active);
  const byCategory = { alpha: 0, beta: 0, gamma: 0 };
  for (const record of records) byCategory[record.category] += record.amount;
  const maxRecord = [...records].sort((left, right) => right.amount - left.amount || left.id.localeCompare(right.id))[0];
  return {
    activeCount: records.length,
    totalAmount: records.reduce((sum, record) => sum + record.amount, 0),
    byCategory,
    maxRecord: { id: maxRecord.id, amount: maxRecord.amount },
  };
}

async function createFixture(workspace, label, caseId) {
  const cwd = join(workspace, "cases", label);
  await mkdir(cwd, { recursive: true });

  if (caseId === "simple") {
    const metadata = {
      name: "ptc-mode-selection-fixture",
      version: "7.3.1",
      private: true,
      description: "Deterministic single-file lookup fixture",
      engines: { node: ">=22.0.0" },
      benchmark: { suite: "mode-selection", revision: 4 },
    };
    await writeFile(join(cwd, "package.json"), `${JSON.stringify(metadata, null, 2)}\n`);
    return {
      cwd,
      expected: { name: metadata.name, version: metadata.version, nodeEngine: metadata.engines.node },
      prompt: `Read package.json in the current workspace. Return exactly one JSON object with keys name, version, and nodeEngine, where nodeEngine is the package engines.node value. Do not use Markdown or add an explanation.`,
    };
  }

  const parts = [
    { records: [
      { id: "A-101", category: "alpha", active: true, amount: 17 },
      { id: "B-104", category: "beta", active: false, amount: 91 },
      { id: "G-109", category: "gamma", active: true, amount: 34 },
    ] },
    { records: [
      { id: "B-202", category: "beta", active: true, amount: 48 },
      { id: "A-207", category: "alpha", active: true, amount: 63 },
      { id: "G-211", category: "gamma", active: false, amount: 75 },
    ] },
    { records: [
      { id: "G-303", category: "gamma", active: true, amount: 52 },
      { id: "A-308", category: "alpha", active: false, amount: 86 },
      { id: "B-314", category: "beta", active: true, amount: 29 },
    ] },
    { records: [
      { id: "A-402", category: "alpha", active: true, amount: 41 },
      { id: "G-405", category: "gamma", active: true, amount: 63 },
      { id: "B-417", category: "beta", active: false, amount: 99 },
    ] },
  ];
  const dataDirectory = join(cwd, "data");
  await mkdir(dataDirectory, { recursive: true });
  await Promise.all(parts.map((part, index) => writeFile(
    join(dataDirectory, `part-${index + 1}.json`),
    `${JSON.stringify(part, null, 2)}\n`,
  )));
  return {
    cwd,
    expected: buildBatchExpected(parts),
    prompt: `Read data/part-1.json, data/part-2.json, data/part-3.json, and data/part-4.json. Each file is a JSON object with a records array. Combine those arrays, keep only records whose active value is true, and compute:
- activeCount: number of kept records
- totalAmount: sum of their amount values
- byCategory: amount totals with exactly the keys alpha, beta, gamma
- maxRecord: the kept record with greatest amount as an object with id and amount; break ties by id ascending
Return exactly one JSON object with keys activeCount, totalAmount, byCategory, and maxRecord. Do not use Markdown or add an explanation.`,
  };
}

function selectionDetails(caseId, outerToolNames) {
  const runCodeCalls = outerToolNames.filter((name) => name === "run_code").length;
  const directReadToolNames = outerToolNames.filter((name) => DIRECT_READ_TOOLS.has(name));
  const firstDataAccessTool = outerToolNames.find((name) => name === "run_code" || DIRECT_READ_TOOLS.has(name)) ?? null;
  if (caseId === "simple") {
    return {
      compliant: outerToolNames.includes("read") && runCodeCalls === 0,
      rule: "simple requires an ordinary outer read call and no run_code call",
      runCodeCalls,
      directReadToolNames,
      firstDataAccessTool,
    };
  }
  return {
    compliant: runCodeCalls > 0 && firstDataAccessTool === "run_code",
    rule: "batch requires run_code as the first data-access tool; focused ordinary reads are allowed only after a failed attempt",
    runCodeCalls,
    directReadToolNames,
    firstDataAccessTool,
  };
}

function mergeToolCounts(target, source) {
  for (const [name, count] of Object.entries(source ?? {})) target[name] = (target[name] ?? 0) + count;
}

async function runRpcCase({ model, trial, caseId, fixture, timeoutMs, rawDirectory }) {
  const label = safeLabel(model, trial, caseId);
  const rawRpcPath = join(rawDirectory, `${label}.jsonl`);
  const args = [
    "--mode", "rpc",
    "--no-session",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--model", model,
    "-e", ptcExtension,
  ];
  const child = spawn("pi", args, { cwd: fixture.cwd, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
  const events = [];
  const rawLines = [];
  const assistantMessages = [];
  const outerTools = [];
  const runCodeSubCalls = [];
  const runCodeToolCounts = {};
  const runtimeErrors = [];
  let stdoutBuffer = "";
  let stderr = "";
  let taskStartedAt = 0;
  let taskSent = false;
  let settled = false;

  const sendTask = () => {
    if (taskSent) return;
    taskSent = true;
    taskStartedAt = performance.now();
    child.stdin.write(`${JSON.stringify({ id: `${label}-task`, type: "prompt", message: fixture.prompt })}\n`);
  };

  const consumeLine = (line) => {
    if (!line) return;
    rawLines.push(line);
    let event;
    try {
      event = JSON.parse(line);
    } catch (error) {
      runtimeErrors.push({ type: "invalid_rpc_json", message: error instanceof Error ? error.message : String(error), line });
      return;
    }
    events.push(event);
    if (event.type === "response" && event.id === `${label}-init`) sendTask();
    if (taskSent && event.type === "message_end" && event.message?.role === "assistant") assistantMessages.push(event.message);
    if (taskSent && event.type === "tool_execution_start") {
      outerTools.push({ name: event.toolName, args: event.args });
    }
    if (taskSent && event.type === "tool_execution_end") {
      if (event.isError) runtimeErrors.push({ type: "tool_error", toolName: event.toolName, result: event.result });
      if (event.toolName === "run_code") {
        if (Number.isSafeInteger(event.result?.details?.subCalls)) runCodeSubCalls.push(event.result.details.subCalls);
        mergeToolCounts(runCodeToolCounts, event.result?.details?.toolCounts);
      }
    }
    if (taskSent && event.type === "extension_error") {
      runtimeErrors.push({ type: "extension_error", error: event.error ?? event });
    }
    if (taskSent && event.type === "response" && event.id === `${label}-task` && event.success === false) {
      runtimeErrors.push({ type: "rpc_error", error: event.error ?? event });
    }
  };

  let elapsedMs = null;
  let processError = null;
  try {
    elapsedMs = await new Promise((resolvePromise, rejectPromise) => {
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        rejectPromise(new Error(`Timed out after ${timeoutMs} ms`));
      }, timeoutMs);

      child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
      child.stdout.on("data", (chunk) => {
        stdoutBuffer += chunk.toString();
        while (true) {
          const newline = stdoutBuffer.indexOf("\n");
          if (newline < 0) break;
          const line = stdoutBuffer.slice(0, newline);
          stdoutBuffer = stdoutBuffer.slice(newline + 1);
          consumeLine(line);
        }
      });
      child.once("error", (error) => {
        clearTimeout(timeout);
        rejectPromise(error);
      });
      child.once("exit", (code, signal) => {
        if (!settled) {
          clearTimeout(timeout);
          rejectPromise(new Error(`Pi exited before agent_settled: code=${code} signal=${signal}`));
        }
      });

      const settleWatcher = setInterval(() => {
        const settledEvent = events.find((event) => taskSent && event.type === "agent_settled");
        if (!settledEvent || settled) return;
        settled = true;
        clearInterval(settleWatcher);
        clearTimeout(timeout);
        child.stdin.end();
        resolvePromise(Math.round(performance.now() - taskStartedAt));
      }, 10);
      child.once("close", () => clearInterval(settleWatcher));
      child.stdin.write(`${JSON.stringify({ id: `${label}-init`, type: "prompt", message: "/ptc both" })}\n`);
    });
  } catch (error) {
    processError = error instanceof Error ? error.message : String(error);
    runtimeErrors.push({ type: "process_error", message: processError });
    child.kill("SIGKILL");
  }

  if (stdoutBuffer.trim()) consumeLine(stdoutBuffer.trim());
  await writeFile(rawRpcPath, rawLines.length > 0 ? `${rawLines.join("\n")}\n` : "");

  const finalText = finalAssistantText(assistantMessages);
  const parsed = parseFinalJson(finalText);
  const semanticSuccess = parsed.parseError === null && equalJson(parsed.value, fixture.expected);
  const outerToolNames = outerTools.map((tool) => tool.name);
  const selection = selectionDetails(caseId, outerToolNames);
  const cleanRun = semanticSuccess && parsed.strictJson && selection.compliant && runtimeErrors.length === 0;

  return {
    model,
    trial,
    case: caseId,
    status: cleanRun ? "pass" : semanticSuccess ? "selection_or_cleanliness_failure" : processError ? "error" : "semantic_failure",
    semanticSuccess,
    selectionCompliant: selection.compliant,
    strictJson: parsed.strictJson,
    cleanRun,
    selectionRule: selection.rule,
    expected: fixture.expected,
    answer: parsed.value,
    finalText,
    parseError: parsed.parseError,
    outerToolNames,
    outerToolCalls: outerTools.length,
    directReadToolNames: selection.directReadToolNames,
    firstDataAccessTool: selection.firstDataAccessTool,
    runCodeCalls: selection.runCodeCalls,
    runCodeSubCalls,
    runCodeSubCallTotal: runCodeSubCalls.reduce((sum, count) => sum + count, 0),
    runCodeToolCounts,
    usage: sumUsage(assistantMessages),
    elapsedMs,
    stderr: stderr.trim(),
    runtimeErrors,
    rawRpcPath,
  };
}

function summarize(results) {
  const count = (predicate) => results.filter(predicate).length;
  const byCase = Object.fromEntries(CASE_IDS.map((caseId) => {
    const cases = results.filter((result) => result.case === caseId);
    return [caseId, {
      cases: cases.length,
      semanticSuccesses: cases.filter((result) => result.semanticSuccess).length,
      selectionCompliant: cases.filter((result) => result.selectionCompliant).length,
      strictJson: cases.filter((result) => result.strictJson).length,
      cleanRuns: cases.filter((result) => result.cleanRun).length,
    }];
  }));
  return {
    cases: results.length,
    semanticSuccesses: count((result) => result.semanticSuccess),
    selectionCompliant: count((result) => result.selectionCompliant),
    strictJson: count((result) => result.strictJson),
    cleanRuns: count((result) => result.cleanRun),
    runtimeErrorCases: count((result) => result.runtimeErrors.length > 0),
    byCase,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const workspace = await mkdtemp(join(tmpdir(), "pi-ptc-mode-selection-benchmark-"));
  const rawDirectory = join(workspace, "raw");
  await mkdir(rawDirectory, { recursive: true });
  const output = options.output ?? join(workspace, "ptc-mode-selection-results.json");
  const results = [];

  for (const model of options.models) {
    for (let trial = 1; trial <= options.trials; trial += 1) {
      for (const caseId of options.cases) {
        const label = safeLabel(model, trial, caseId);
        const fixture = await createFixture(workspace, label, caseId);
        console.error(`[benchmark] start model=${model} trial=${trial} case=${caseId}`);
        const result = await runRpcCase({
          model,
          trial,
          caseId,
          fixture,
          timeoutMs: options.timeoutMs,
          rawDirectory,
        });
        results.push(result);
        console.error(`[benchmark] ${result.status} model=${model} trial=${trial} case=${caseId} semantic=${result.semanticSuccess} selection=${result.selectionCompliant} strict=${result.strictJson} clean=${result.cleanRun} elapsed=${result.elapsedMs}ms tokens=${result.usage.totalTokens}`);
      }
    }
  }

  const report = {
    schema: "pi.ptc-mode-selection-benchmark/v1",
    generatedAt: new Date().toISOString(),
    mode: "both",
    models: options.models,
    cases: options.cases,
    trials: options.trials,
    timeoutMs: options.timeoutMs,
    temporaryWorkspace: workspace,
    rawRpcDirectory: rawDirectory,
    scoring: {
      semanticSuccess: "The parsed final JSON value exactly equals locally computed ground truth; wrapped JSON may pass semantic scoring.",
      strictJson: "The entire final assistant response parses directly as JSON without Markdown or explanatory text.",
      selectionCompliant: "Simple uses an outer read and no run_code. Batch starts data access with run_code; focused ordinary reads after a failed attempt are allowed for diagnosis.",
      cleanRun: "semanticSuccess, strictJson, and selectionCompliant are true, with no RPC, process, extension, or tool runtime error.",
      elapsedMs: "Time from task prompt submission after /ptc both initialization until agent_settled.",
      usage: "Sum of token usage from all assistant message_end events for the task.",
    },
    summary: summarize(results),
    results,
  };

  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ output, workspace, summary: report.summary }, null, 2));
}

await main();
