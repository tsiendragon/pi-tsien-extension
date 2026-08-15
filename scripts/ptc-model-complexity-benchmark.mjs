import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ptcExtension = join(repoRoot, "extensions", "ptc.ts");
const packageEntry = join(repoRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js");

const MODEL_IDS = [
  "openai-codex/gpt-5.6-sol",
  "openai-codex/gpt-5.6-terra",
  "openai-codex/gpt-5.6-luna",
  "dashscope/deepseek-v4-flash",
  "dashscope/deepseek-v4-pro",
];

const LEVELS = [
  { id: "C1", shardFiles: 2, recordsPerShard: 16, estimatedSubCalls: 5 },
  { id: "C2", shardFiles: 6, recordsPerShard: 24, estimatedSubCalls: 9 },
  { id: "C3", shardFiles: 14, recordsPerShard: 28, estimatedSubCalls: 17 },
  { id: "C4", shardFiles: 28, recordsPerShard: 32, estimatedSubCalls: 31 },
  { id: "C5", shardFiles: 48, recordsPerShard: 32, estimatedSubCalls: 51 },
  { id: "C6", shardFiles: 80, recordsPerShard: 32, estimatedSubCalls: 83 },
];

function parseArgs(argv) {
  const options = {
    models: [...MODEL_IDS],
    levels: LEVELS.map((level) => level.id),
    modes: ["native", "ptc"],
    trials: 1,
    timeoutMs: 300_000,
    output: join(repoRoot, "docs", "ptc-model-complexity-results.json"),
  };
  for (const argument of argv) {
    const [key, rawValue = ""] = argument.split("=", 2);
    if (key === "--models") options.models = rawValue.split(",").filter(Boolean);
    else if (key === "--levels") options.levels = rawValue.split(",").filter(Boolean);
    else if (key === "--modes") options.modes = rawValue.split(",").filter(Boolean);
    else if (key === "--trials") options.trials = Number.parseInt(rawValue, 10);
    else if (key === "--timeout-ms") options.timeoutMs = Number.parseInt(rawValue, 10);
    else if (key === "--output") options.output = resolve(rawValue);
    else if (key === "--help") {
      console.log("Usage: node scripts/ptc-model-complexity-benchmark.mjs [--models=a,b] [--levels=C1,C2] [--modes=native,ptc] [--trials=1] [--timeout-ms=300000] [--output=path]");
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (!Number.isSafeInteger(options.trials) || options.trials < 1) throw new Error("--trials must be a positive integer");
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1_000) throw new Error("--timeout-ms must be >= 1000");
  for (const model of options.models) if (!MODEL_IDS.includes(model)) throw new Error(`Unsupported model: ${model}`);
  for (const level of options.levels) if (!LEVELS.some((item) => item.id === level)) throw new Error(`Unsupported level: ${level}`);
  for (const mode of options.modes) if (mode !== "native" && mode !== "ptc") throw new Error(`Unsupported mode: ${mode}`);
  return options;
}

function buildRecord(levelIndex, shardIndex, recordIndex) {
  const serial = (levelIndex + 1) * 100_000 + shardIndex * 1_000 + recordIndex;
  const categories = ["alpha", "beta", "gamma", "delta", "epsilon"];
  const regions = ["apac", "emea", "latam", "na"];
  return {
    id: `R${String(serial).padStart(7, "0")}`,
    serial,
    active: serial % 5 !== 0,
    category: categories[(serial * 7 + shardIndex) % categories.length],
    region: regions[(serial * 7 + shardIndex * 3 + recordIndex * 2) % regions.length],
    score: (serial * 17 + shardIndex * 13 + recordIndex * 3) % 101,
    amount: 10 + ((serial * 19 + recordIndex * 23) % 991),
  };
}

function computeExpected(rules, overrides, records) {
  const qualified = [];
  const byRegion = Object.fromEntries(rules.regions.map((region) => [region, 0]));
  let weightedTotal = 0;
  let checksum = 0;

  for (const record of records) {
    const weight = rules.categoryWeights[record.category];
    if (!record.active || weight === undefined || record.score < rules.minimumScore) continue;
    const multiplier = overrides[record.id] ?? 1;
    const contribution = (record.amount * weight + record.score * rules.scoreBonus) * multiplier;
    weightedTotal += contribution;
    byRegion[record.region] += contribution;
    checksum = (checksum + ((record.serial * 31 + contribution * 7) % 1_000_003)) % 1_000_003;
    qualified.push({ id: record.id, contribution });
  }

  qualified.sort((left, right) => right.contribution - left.contribution || left.id.localeCompare(right.id));
  return {
    matchedCount: qualified.length,
    weightedTotal,
    byRegion,
    topIds: qualified.slice(0, 7).map((item) => item.id),
    checksum,
  };
}

async function createFixture(root, level, levelIndex) {
  const cwd = join(root, level.id);
  const shardDirectory = join(cwd, "shards");
  await mkdir(shardDirectory, { recursive: true });
  const rules = {
    minimumScore: 43 + levelIndex * 2,
    scoreBonus: 3 + levelIndex,
    categoryWeights: { alpha: 2, beta: 5, delta: 7, epsilon: 3 },
    regions: ["apac", "emea", "latam", "na"],
  };
  const records = [];
  for (let shardIndex = 0; shardIndex < level.shardFiles; shardIndex += 1) {
    const shard = [];
    for (let recordIndex = 0; recordIndex < level.recordsPerShard; recordIndex += 1) {
      shard.push(buildRecord(levelIndex, shardIndex, recordIndex));
    }
    records.push(...shard);
    await writeFile(join(shardDirectory, `shard-${String(shardIndex + 1).padStart(2, "0")}.json`), `${JSON.stringify(shard, null, 2)}\n`);
  }
  const overrides = {};
  for (const record of records) {
    if (record.serial % 17 === 0) overrides[record.id] = 3;
    else if (record.serial % 11 === 0) overrides[record.id] = 2;
  }
  await writeFile(join(cwd, "rules.json"), `${JSON.stringify(rules, null, 2)}\n`);
  await writeFile(join(cwd, "overrides.json"), `${JSON.stringify(overrides, null, 2)}\n`);
  return {
    cwd,
    expected: computeExpected(rules, overrides, records),
    input: {
      shardFiles: level.shardFiles,
      recordsPerShard: level.recordsPerShard,
      totalRecords: records.length,
      estimatedSubCalls: level.estimatedSubCalls,
      inputBytes: Buffer.byteLength(JSON.stringify({ rules, overrides, records }), "utf8"),
    },
  };
}

function buildPrompt(level) {
  return `This is a deterministic read-only benchmark at complexity ${level.id}. You must actually use only read/find/grep/ls. In PTC mode, call those bindings only inside run_code. Never use bash or write tools.

Workspace files:
- rules.json
- overrides.json
- shards/*.json (${level.shardFiles} shard files)

Compute the answer exactly:
1. Read rules.json and overrides.json, find every shards/*.json file, and read every shard.
2. Keep a record only when active is true, its category exists in categoryWeights, and score >= minimumScore.
3. multiplier = overrides[id] when present, otherwise 1.
4. contribution = (amount * categoryWeights[category] + score * scoreBonus) * multiplier.
5. matchedCount is the number of kept records.
6. weightedTotal is the sum of contribution.
7. byRegion must contain every region listed in rules.regions, including zero totals.
8. topIds contains the first 7 IDs after sorting by contribution descending, then ID ascending.
9. checksum starts at 0. For each kept record, add ((serial * 31 + contribution * 7) modulo 1000003), then take the final sum modulo 1000003.

In PTC mode, one run_code program allows at most 32 tool sub-calls. If all files do not fit, split the shards across multiple run_code programs. Each program should return mergeable partial counts, totals, regional totals, top-7 candidates, and checksum; merge those partials exactly in the final response.

Return exactly one JSON object with keys matchedCount, weightedTotal, byRegion, topIds, checksum. No Markdown and no explanation.`;
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

function parseAnswer(text) {
  try {
    return { value: JSON.parse(text), strictContract: true, parseError: null };
  } catch (strictError) {
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    const candidate = fence?.[1] ?? text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
    try {
      return { value: JSON.parse(candidate), strictContract: false, parseError: null };
    } catch {
      return {
        value: null,
        strictContract: false,
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
  return message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n").trim();
}

async function runRpcCase({ model, mode, level, fixture, trial, controlExtension, timeoutMs, rawDirectory }) {
  const label = `${model.replaceAll("/", "_")}-${mode}-${level.id}-t${trial}`;
  const args = [
    "--mode", "rpc",
    "--no-session",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--model", model,
    "-e", mode === "ptc" ? ptcExtension : controlExtension,
  ];
  const child = spawn("pi", args, { cwd: fixture.cwd, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
  const events = [];
  const assistantMessages = [];
  const toolStarts = [];
  const toolErrors = [];
  const ptcSubCalls = [];
  let buffer = "";
  let stderr = "";
  let promptStartedAt = 0;
  let promptSent = false;
  let settled = false;

  const sendPrompt = () => {
    if (promptSent) return;
    promptSent = true;
    promptStartedAt = performance.now();
    child.stdin.write(`${JSON.stringify({ id: `${label}-prompt`, type: "prompt", message: buildPrompt(level) })}\n`);
  };

  try {
    const timing = await new Promise((resolvePromise, rejectPromise) => {
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        rejectPromise(new Error(`Timed out after ${timeoutMs} ms`));
      }, timeoutMs);

      child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
      child.stdout.on("data", (chunk) => {
        buffer += chunk.toString();
        while (true) {
          const newline = buffer.indexOf("\n");
          if (newline < 0) break;
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (!line) continue;
          let event;
          try { event = JSON.parse(line); } catch { continue; }
          events.push(event);
          if (event.type === "response" && event.id === `${label}-init`) sendPrompt();
          if (event.type === "message_end" && event.message?.role === "assistant") assistantMessages.push(event.message);
          if (event.type === "tool_execution_start") toolStarts.push({ name: event.toolName, args: event.args });
          if (event.type === "tool_execution_end") {
            if (event.isError) toolErrors.push({ name: event.toolName, result: event.result });
            if (event.toolName === "run_code" && Number.isSafeInteger(event.result?.details?.subCalls)) {
              ptcSubCalls.push(event.result.details.subCalls);
            }
          }
          if (event.type === "extension_error") toolErrors.push({ name: "extension", result: event.error ?? event });
          if (event.type === "agent_settled" && !settled) {
            settled = true;
            clearTimeout(timeout);
            child.stdin.end();
            resolvePromise({ elapsedMs: Math.round(performance.now() - promptStartedAt) });
          }
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

      if (mode === "ptc") {
        child.stdin.write(`${JSON.stringify({ id: `${label}-init`, type: "prompt", message: "/ptc on" })}\n`);
      } else {
        sendPrompt();
      }
    });

    await writeFile(join(rawDirectory, `${label}.jsonl`), events.map((event) => JSON.stringify(event)).join("\n") + "\n");
    const text = finalAssistantText(assistantMessages);
    const parsed = parseAnswer(text);
    const answerCorrect = parsed.parseError === null && equalJson(parsed.value, fixture.expected);
    const allowedOuterTools = mode === "ptc" ? new Set(["run_code"]) : new Set(["read", "find", "grep", "ls"]);
    const toolCompliant = toolStarts.every((tool) => allowedOuterTools.has(tool.name));
    const cleanRun = answerCorrect && parsed.strictContract && toolCompliant && toolErrors.length === 0;
    return {
      model,
      mode,
      level: level.id,
      trial,
      status: cleanRun ? "pass" : answerCorrect ? "recovered" : "fail",
      answerCorrect,
      strictContract: parsed.strictContract,
      cleanRun,
      toolCompliant,
      expected: fixture.expected,
      answer: parsed.value,
      answerText: text,
      parseError: parsed.parseError,
      elapsedMs: timing.elapsedMs,
      modelTurns: assistantMessages.length,
      outerToolCalls: toolStarts.length,
      outerToolNames: toolStarts.map((tool) => tool.name),
      ptcSubCalls: ptcSubCalls.reduce((sum, count) => sum + count, 0),
      toolErrors,
      usage: sumUsage(assistantMessages),
      stderr: stderr.trim(),
      input: fixture.input,
    };
  } catch (error) {
    child.kill("SIGKILL");
    await writeFile(join(rawDirectory, `${label}.jsonl`), events.map((event) => JSON.stringify(event)).join("\n") + (events.length ? "\n" : ""));
    return {
      model,
      mode,
      level: level.id,
      trial,
      status: "error",
      answerCorrect: false,
      strictContract: false,
      cleanRun: false,
      toolCompliant: false,
      expected: fixture.expected,
      answer: null,
      answerText: finalAssistantText(assistantMessages),
      parseError: null,
      elapsedMs: promptStartedAt ? Math.round(performance.now() - promptStartedAt) : null,
      modelTurns: assistantMessages.length,
      outerToolCalls: toolStarts.length,
      outerToolNames: toolStarts.map((tool) => tool.name),
      ptcSubCalls: ptcSubCalls.reduce((sum, count) => sum + count, 0),
      toolErrors,
      usage: sumUsage(assistantMessages),
      stderr: stderr.trim(),
      input: fixture.input,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const workspace = await mkdtemp(join(tmpdir(), "pi-ptc-complexity-benchmark-"));
  const rawDirectory = join(workspace, "raw");
  await mkdir(rawDirectory, { recursive: true });
  const controlExtension = join(workspace, "native-readonly-tools.ts");
  await writeFile(controlExtension, `import { createFindTool, createGrepTool, createLsTool } from ${JSON.stringify(packageEntry)};\nexport default function (pi) {\n  pi.registerTool(createFindTool(process.cwd()));\n  pi.registerTool(createGrepTool(process.cwd()));\n  pi.registerTool(createLsTool(process.cwd()));\n  pi.on("session_start", () => pi.setActiveTools(["read", "find", "grep", "ls"]));\n}\n`);

  const fixtures = new Map();
  for (const levelId of options.levels) {
    const levelIndex = LEVELS.findIndex((level) => level.id === levelId);
    const level = LEVELS[levelIndex];
    fixtures.set(levelId, await createFixture(workspace, level, levelIndex));
  }

  const results = [];
  for (const model of options.models) {
    for (const levelId of options.levels) {
      const level = LEVELS.find((item) => item.id === levelId);
      const fixture = fixtures.get(levelId);
      for (let trial = 1; trial <= options.trials; trial += 1) {
        for (const mode of options.modes) {
          console.error(`[benchmark] start model=${model} level=${level.id} trial=${trial} mode=${mode}`);
          const result = await runRpcCase({ model, mode, level, fixture, trial, controlExtension, timeoutMs: options.timeoutMs, rawDirectory });
          results.push(result);
          console.error(`[benchmark] ${result.status} model=${model} level=${level.id} mode=${mode} elapsed=${result.elapsedMs}ms tokens=${result.usage.totalTokens}`);
          await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
        }
      }
    }
  }

  const report = {
    schema: "pi.ptc-model-complexity-benchmark/v1",
    generatedAt: new Date().toISOString(),
    models: options.models,
    modes: options.modes,
    trials: options.trials,
    levels: LEVELS.filter((level) => options.levels.includes(level.id)),
    scoring: {
      answerCorrect: "The final JSON value exactly equals local ground truth; a single Markdown JSON fence is tolerated for semantic scoring.",
      strictContract: "The entire final response parses directly as JSON with no wrapper text or Markdown.",
      cleanRun: "answerCorrect and strictContract are true, all outer tools are mode-compliant, and no tool/extension error occurred.",
      status: "pass=cleanRun; recovered=correct final answer with format violation or recovered tool error; fail/error=incorrect or incomplete.",
      timing: "Milliseconds from prompt submission to agent_settled; PTC mode activation and process startup are excluded.",
      usage: "Sum of usage from every assistant message_end event in the run.",
    },
    temporaryWorkspace: workspace,
    results,
  };
  await mkdir(dirname(options.output), { recursive: true });
  await writeFile(options.output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({
    output: options.output,
    workspace,
    runs: results.length,
    passed: results.filter((result) => result.status === "pass").length,
    recovered: results.filter((result) => result.status === "recovered").length,
  }, null, 2));
}

await main();
