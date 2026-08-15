import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
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
const LEVELS = [
  { id: "F1", modules: 2, minimumWrites: 2, minimumPrograms: 1 },
  { id: "F2", modules: 6, minimumWrites: 6, minimumPrograms: 1 },
  { id: "F3", modules: 14, minimumWrites: 14, minimumPrograms: 1 },
  { id: "F4", modules: 28, minimumWrites: 28, minimumPrograms: 1 },
  { id: "F5", modules: 48, minimumWrites: 48, minimumPrograms: 2 },
  { id: "F6", modules: 80, minimumWrites: 80, minimumPrograms: 3 },
  { id: "F7", modules: 128, minimumWrites: 128, minimumPrograms: 5 },
];

function parseArgs(argv) {
  const options = {
    models: [...MODEL_IDS],
    levels: LEVELS.map((level) => level.id),
    modes: ["native", "ptc"],
    trials: 1,
    timeoutMs: 300_000,
    output: join(repoRoot, "docs", "ptc-full-tool-results.json"),
  };
  for (const argument of argv) {
    const [key, raw = ""] = argument.split("=", 2);
    if (key === "--models") options.models = raw.split(",").filter(Boolean);
    else if (key === "--levels") options.levels = raw.split(",").filter(Boolean);
    else if (key === "--modes") options.modes = raw.split(",").filter(Boolean);
    else if (key === "--trials") options.trials = Number.parseInt(raw, 10);
    else if (key === "--timeout-ms") options.timeoutMs = Number.parseInt(raw, 10);
    else if (key === "--output") options.output = resolve(raw);
    else if (key === "--help") {
      console.log("Usage: node scripts/ptc-full-tool-benchmark.mjs [--models=a,b] [--levels=F1,F2] [--modes=native,ptc] [--trials=1] [--timeout-ms=300000] [--output=path]");
      process.exit(0);
    } else throw new Error(`Unknown argument: ${argument}`);
  }
  for (const model of options.models) if (!MODEL_IDS.includes(model)) throw new Error(`Unsupported model: ${model}`);
  for (const level of options.levels) if (!LEVELS.some((item) => item.id === level)) throw new Error(`Unsupported level: ${level}`);
  for (const mode of options.modes) if (mode !== "native" && mode !== "ptc") throw new Error(`Unsupported mode: ${mode}`);
  if (!Number.isSafeInteger(options.trials) || options.trials < 1) throw new Error("--trials must be positive");
  return options;
}

function operationFor(index) {
  const mod = 97 + (index % 7) * 10;
  const kind = ["affine", "xor", "squareAdd", "digitSumAdd"][index % 4];
  if (kind === "affine") return { kind, a: 2 + (index % 9), b: 3 + index * 2, mod };
  if (kind === "xor") return { kind, mask: 11 + index * 7, mod };
  if (kind === "squareAdd") return { kind, offset: 5 + index * 3, mod };
  return { kind, offset: 7 + index * 5, mod };
}

function buildManifest(level) {
  return {
    version: 1,
    stages: Array.from({ length: level.modules }, (_, index) => ({
      id: index + 1,
      file: `src/stage-${String(index + 1).padStart(2, "0")}.mjs`,
      ...operationFor(index),
    })),
  };
}

function buildTestRunner() {
  return `import { readFile } from "node:fs/promises";
const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8"));
const modulo = (value, mod) => ((value % mod) + mod) % mod;
function expected(stage, value) {
  const n = Math.trunc(Number(value));
  if (stage.kind === "affine") return modulo(n * stage.a + stage.b, stage.mod);
  if (stage.kind === "xor") return modulo((n ^ stage.mask), stage.mod);
  if (stage.kind === "squareAdd") return modulo(n * n + stage.offset, stage.mod);
  if (stage.kind === "digitSumAdd") {
    const sum = String(Math.abs(n)).split("").reduce((total, digit) => total + Number(digit), 0);
    return modulo(sum + stage.offset, stage.mod);
  }
  throw new Error("Unknown kind: " + stage.kind);
}
const samples = [-123, -7, 0, 1, 2, 19, 57, 1234];
const loaded = [];
let assertions = 0;
for (const stage of manifest.stages) {
  const module = await import(new URL("../" + stage.file, import.meta.url));
  if (typeof module.apply !== "function") throw new Error(stage.file + " must export apply(value)");
  loaded.push({ stage, apply: module.apply });
  for (const sample of samples) {
    const actual = module.apply(sample);
    const wanted = expected(stage, sample);
    assertions += 1;
    if (actual !== wanted) throw new Error(stage.file + " input=" + sample + " expected=" + wanted + " actual=" + actual);
  }
}
for (const sample of samples) {
  let actual = sample;
  let wanted = sample;
  for (const item of loaded) {
    actual = item.apply(actual);
    wanted = expected(item.stage, wanted);
  }
  assertions += 1;
  if (actual !== wanted) throw new Error("pipeline input=" + sample + " expected=" + wanted + " actual=" + actual);
}
console.log(JSON.stringify({ ok: true, modules: manifest.stages.length, assertions }));
`;
}

async function hashFile(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function createFixture(root, level) {
  const cwd = join(root, level.id);
  await mkdir(join(cwd, "src"), { recursive: true });
  await mkdir(join(cwd, "tests"), { recursive: true });
  const manifest = buildManifest(level);
  const manifestPath = join(cwd, "manifest.json");
  const testPath = join(cwd, "tests", "run.mjs");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(testPath, buildTestRunner());
  for (const stage of manifest.stages) {
    await writeFile(join(cwd, stage.file), `// Incorrect placeholder for stage ${stage.id}\nexport function apply(value) {\n  return Math.trunc(Number(value));\n}\n`);
  }
  return {
    cwd,
    manifest,
    protectedHashes: {
      manifest: await hashFile(manifestPath),
      tests: await hashFile(testPath),
    },
    input: {
      modules: level.modules,
      assertions: level.modules * 8 + 8,
      minimumWrites: level.minimumWrites,
      minimumPrograms: level.minimumPrograms,
    },
  };
}

function buildPrompt(level, mode) {
  const toolInstructions = mode === "ptc"
    ? "Use run_code and the PTC tools. Read manifest.json and relevant source/test files."
    : "Use the top-level read/find/grep/ls/write tools. Use bash only for the exact purpose of running `node tests/run.mjs`; do not use shell redirection, inline scripts, or shell commands to read or write files.";
  const runInstruction = mode === "ptc"
    ? "You must call tools.run({ path: \"tests/run.mjs\" }) after writing. If it fails, inspect stderr, fix source files, and run again until exitCode is 0."
    : "After writing, you must use bash to run `node tests/run.mjs`. If it fails, inspect stderr, fix source files, and run again until the exit code is 0.";
  const batchingInstruction = mode === "ptc"
    ? "One run_code allows at most 32 sub-calls. If needed, split work across multiple run_code calls."
    : "Do not call run_code; it is not available in native mode.";
  return `This is a deterministic ${mode === "ptc" ? "PTC full-mode" : "native tool-mode"} repair benchmark at ${level.id}.

The workspace contains manifest.json, ${level.modules} incorrect src/stage-*.mjs modules, and tests/run.mjs.

Requirements:
1. ${toolInstructions}
2. Implement every manifest stage in its listed source file. Each module must export apply(value).
3. Semantics:
   - First convert input with Math.trunc(Number(value)).
   - modulo(x, mod) is ((x % mod) + mod) % mod.
   - affine: modulo(n * a + b, mod).
   - xor: modulo(n ^ mask, mod).
   - squareAdd: modulo(n * n + offset, mod).
   - digitSumAdd: sum decimal digits of Math.abs(n), then modulo(sum + offset, mod).
4. Do not modify manifest.json or tests/run.mjs.
5. ${runInstruction}
6. ${batchingInstruction}

Finally return exactly one JSON object with keys ok, modules, assertions. No Markdown or explanation.`;
}

function sumUsage(messages) {
  const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0, cost: 0 };
  for (const message of messages) {
    const usage = message.usage ?? {};
    for (const key of ["input", "output", "cacheRead", "cacheWrite", "reasoning", "totalTokens"]) total[key] += usage[key] ?? 0;
    total.cost += usage.cost?.total ?? 0;
  }
  return total;
}

function finalText(messages) {
  const message = messages.at(-1);
  return Array.isArray(message?.content)
    ? message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n").trim()
    : "";
}

function parseFinalJson(text) {
  try { return { value: JSON.parse(text), strict: true }; } catch {}
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidate = fence?.[1] ?? text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  try { return { value: JSON.parse(candidate), strict: false }; } catch { return { value: null, strict: false }; }
}

function evaluateProject(fixture) {
  const testPath = join(fixture.cwd, "tests", "run.mjs");
  const run = spawnSync(process.execPath, [
    "--permission",
    `--allow-fs-read=${fixture.cwd}`,
    "--no-addons",
    "--no-warnings",
    "--disable-sigusr1",
    testPath,
  ], { cwd: fixture.cwd, env: {}, encoding: "utf8", timeout: 30_000 });
  let output = null;
  try { output = JSON.parse(run.stdout.trim().split(/\r?\n/).at(-1) ?? ""); } catch {}
  return {
    passed: run.status === 0 && output?.ok === true && output.modules === fixture.input.modules,
    exitCode: run.status,
    signal: run.signal,
    stdout: run.stdout,
    stderr: run.stderr,
    output,
  };
}

async function runCase({ model, mode, level, fixture, trial, timeoutMs, rawDirectory }) {
  const label = `${model.replaceAll("/", "_")}-${mode}-${level.id}-t${trial}`;
  const args = [
    "--mode", "rpc",
    "--no-session",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--approve",
    "--model", model,
  ];
  if (mode === "ptc") args.push("-e", ptcExtension);
  else args.push("--tools", "read,find,grep,ls,write,bash");
  const child = spawn("pi", args, { cwd: fixture.cwd, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
  const events = [];
  const messages = [];
  const outerCalls = [];
  const toolCounts = {};
  const toolErrors = [];
  let buffer = "";
  let stderr = "";
  let promptAt = 0;
  let settled = false;

  const sendPrompt = () => {
    promptAt = performance.now();
    child.stdin.write(`${JSON.stringify({ id: `${label}-prompt`, type: "prompt", message: buildPrompt(level, mode) })}\n`);
  };

  let runtimeError = null;
  try {
    await new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
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
          if (event.type === "message_end" && event.message?.role === "assistant") messages.push(event.message);
          if (event.type === "tool_execution_start") outerCalls.push({ name: event.toolName, args: event.args });
          if (event.type === "tool_execution_end") {
            if (event.isError) toolErrors.push({ name: event.toolName, result: event.result });
            for (const [name, count] of Object.entries(event.result?.details?.toolCounts ?? {})) {
              toolCounts[name] = (toolCounts[name] ?? 0) + count;
            }
          }
          if (event.type === "extension_error") toolErrors.push({ name: "extension", result: event.error ?? event });
          if (event.type === "agent_settled" && !settled) {
            settled = true;
            clearTimeout(timer);
            child.stdin.end();
            resolvePromise();
          }
        }
      });
      child.once("error", (error) => { clearTimeout(timer); rejectPromise(error); });
      child.once("exit", (code, signal) => {
        if (!settled) {
          clearTimeout(timer);
          rejectPromise(new Error(`Pi exited early: code=${code} signal=${signal}`));
        }
      });
      if (mode === "ptc") {
        child.stdin.write(`${JSON.stringify({ id: `${label}-init`, type: "prompt", message: "/ptc full" })}\n`);
      } else {
        sendPrompt();
      }
    });
  } catch (error) {
    runtimeError = error instanceof Error ? error.message : String(error);
    child.kill("SIGKILL");
  }

  await writeFile(join(rawDirectory, `${label}.jsonl`), events.map((event) => JSON.stringify(event)).join("\n") + (events.length ? "\n" : ""));
  const elapsedMs = promptAt ? Math.round(performance.now() - promptAt) : null;
  const project = evaluateProject(fixture);
  const protectedHashes = {
    manifest: await hashFile(join(fixture.cwd, "manifest.json")),
    tests: await hashFile(join(fixture.cwd, "tests", "run.mjs")),
  };
  const protectedUnchanged = protectedHashes.manifest === fixture.protectedHashes.manifest
    && protectedHashes.tests === fixture.protectedHashes.tests;
  const parsed = parseFinalJson(finalText(messages));
  const reportedCorrect = parsed.value?.ok === true
    && parsed.value?.modules === fixture.input.modules
    && parsed.value?.assertions === fixture.input.assertions;
  const nativeCounts = Object.fromEntries(
    ["read", "find", "grep", "ls", "write", "bash"].map((name) => [name, outerCalls.filter((call) => call.name === name).length]),
  );
  const nativeBashCompliant = outerCalls
    .filter((call) => call.name === "bash")
    .every((call) => /^node\s+(?:\.\/)?tests\/run\.mjs\s*$/.test(call.args?.command ?? ""));
  const allowedNativeTools = new Set(["read", "find", "grep", "ls", "write", "bash"]);
  const nativeToolsCompliant = outerCalls.every((call) => allowedNativeTools.has(call.name)) && nativeBashCompliant;
  const observedCounts = mode === "ptc" ? toolCounts : nativeCounts;
  const usedWriteAndRun = (observedCounts.write ?? 0) >= fixture.input.minimumWrites
    && (mode === "ptc" ? (observedCounts.run ?? 0) >= 1 : (observedCounts.bash ?? 0) >= 1);
  const toolCompliant = mode === "ptc"
    ? outerCalls.every((call) => call.name === "run_code")
    : nativeToolsCompliant;
  const semanticSuccess = project.passed && protectedUnchanged && usedWriteAndRun;
  const cleanRun = semanticSuccess && toolCompliant && parsed.strict && toolErrors.length === 0;
  const success = semanticSuccess;
  return {
    model,
    mode,
    level: level.id,
    trial,
    status: cleanRun ? "pass" : success ? "recovered" : runtimeError ? "error" : "fail",
    success,
    semanticSuccess,
    cleanRun,
    projectPassed: project.passed,
    protectedUnchanged,
    usedWriteAndRun,
    reportedCorrect,
    strictContract: parsed.strict,
    elapsedMs,
    modelTurns: messages.length,
    outerToolCalls: outerCalls.length,
    outerToolNames: outerCalls.map((call) => call.name),
    outerRunCodeCalls: outerCalls.filter((call) => call.name === "run_code").length,
    toolCompliant,
    toolCounts: observedCounts,
    toolErrorCount: toolErrors.length,
    toolErrors,
    usage: sumUsage(messages),
    input: fixture.input,
    evaluator: project,
    finalText: finalText(messages),
    runtimeError,
    stderr: stderr.trim(),
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const workspace = await mkdtemp(join(tmpdir(), "pi-ptc-full-benchmark-"));
  const rawDirectory = join(workspace, "raw");
  await mkdir(rawDirectory, { recursive: true });
  const results = [];
  for (const model of options.models) {
    for (const levelId of options.levels) {
      const level = LEVELS.find((item) => item.id === levelId);
      for (const mode of options.modes) {
        for (let trial = 1; trial <= options.trials; trial += 1) {
          const fixtureRoot = join(workspace, "fixtures", model.replaceAll("/", "_"), level.id, mode, `t${trial}`);
          const fixture = await createFixture(fixtureRoot, level);
          console.error(`[full-benchmark] start model=${model} mode=${mode} level=${level.id} trial=${trial}`);
          const result = await runCase({ model, mode, level, fixture, trial, timeoutMs: options.timeoutMs, rawDirectory });
          results.push(result);
          console.error(`[full-benchmark] ${result.status} model=${model} mode=${mode} level=${level.id} elapsed=${result.elapsedMs}ms tokens=${result.usage.totalTokens} writes=${result.toolCounts.write ?? 0} runs=${result.toolCounts.run ?? result.toolCounts.bash ?? 0}`);
          await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
        }
      }
    }
  }
  const report = {
    schema: "pi.ptc-full-tool-benchmark/v1",
    generatedAt: new Date().toISOString(),
    models: options.models,
    levels: LEVELS.filter((level) => options.levels.includes(level.id)),
    modes: options.modes,
    trials: options.trials,
    timeoutMs: options.timeoutMs,
    scoring: "Semantic success requires independent tests to pass, manifest/tests unchanged, observed write count >= module count, and at least one test run. Clean run additionally requires strict final JSON, no tool error, and mode-compliant tools. Native bash is limited to node tests/run.mjs.",
    temporaryWorkspace: workspace,
    results,
  };
  await mkdir(dirname(options.output), { recursive: true });
  await writeFile(options.output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ output: options.output, workspace, runs: results.length, passed: results.filter((result) => result.success).length }, null, 2));
}

await main();
