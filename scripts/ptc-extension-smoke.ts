import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ptcExtension from "../extensions/ptc.ts";

let registeredTool: any;
let registeredCommand: any;
const handlers = new Map<string, Function[]>();
const statusTexts: Array<string | undefined> = [];
let activeTools = ["read", "bash", "edit", "write"];

const pi = {
  registerTool(tool: any) {
    registeredTool = tool;
  },
  registerCommand(_name: string, command: any) {
    registeredCommand = command;
  },
  on(event: string, handler: Function) {
    const existing = handlers.get(event) ?? [];
    existing.push(handler);
    handlers.set(event, existing);
  },
  getActiveTools() {
    return [...activeTools];
  },
  setActiveTools(names: string[]) {
    activeTools = [...names];
  },
  getAllTools() {
    return ["read", "bash", "edit", "write", "run_code"].map((name) => ({ name }));
  },
} as any;

const ui = {
  notify() {},
  setStatus(_key: string, text: string | undefined) { statusTexts.push(text); },
  theme: { fg: (_color: string, value: string) => value },
};
const ctx = {
  cwd: process.cwd(),
  mode: "rpc",
  hasUI: true,
  ui,
  model: { provider: "openai-codex", id: "gpt-5.6-sol" },
  isProjectTrusted: () => true,
  abort() {},
} as any;

ptcExtension(pi);
for (const handler of handlers.get("session_start") ?? []) await handler({}, ctx);
await registeredCommand.handler("on", ctx);

const activeStatus = statusTexts.at(-1) ?? "";
if (!activeStatus.includes("PTC strict · calls 0/4") || activeStatus.includes("gpt-5.6-sol")) {
  throw new Error(`PTC status duplicates model information or omits call budget: ${activeStatus}`);
}
if (activeTools.join(",") !== "run_code") {
  throw new Error(`PTC strict mode did not select run_code: ${activeTools.join(",")}`);
}

let strictSystemPrompt = "";
for (const handler of handlers.get("before_agent_start") ?? []) {
  const replacement = await handler({ systemPrompt: "BASE" }, ctx);
  if (replacement?.systemPrompt) strictSystemPrompt = replacement.systemPrompt;
}
if (
  !strictSystemPrompt.includes("validate whether the parsed value is an array or object")
  || !strictSystemPrompt.includes("compute-only merge program still consumes one outer")
  || !strictSystemPrompt.includes("strict read-only PTC mode")
) {
  throw new Error("PTC strict system prompt is missing usage or budget guidance");
}
for (const handler of handlers.get("agent_settled") ?? []) await handler({}, ctx);
await registeredCommand.handler("on", ctx);

const result = await registeredTool.execute(
  "smoke-call",
  {
    description: "Read package metadata",
    code: `
      const text: string = await tools.read({ path: "package.json", offset: 1, limit: 8 });
      return {
        sawPackage: text.includes("pi-tsien-extension"),
        processType: typeof process,
        fetchType: typeof fetch,
      };
    `,
    resultContract: {
      kind: "object",
      requiredKeys: ["sawPackage", "processType", "fetchType"],
      exactKeys: true,
    },
  },
  new AbortController().signal,
  undefined,
  ctx,
);

const text = result.content.find((item: any) => item.type === "text")?.text ?? "";
if (
  !text.includes('"sawPackage": true')
  || !text.includes('"processType": "undefined"')
  || !text.includes('"fetchType": "undefined"')
) {
  throw new Error(`Unexpected run_code result: ${text}`);
}
if (result.details?.subCalls !== 1) {
  throw new Error(`Unexpected sub-call count: ${String(result.details?.subCalls)}`);
}
if (result.details?.resultValidation?.contractApplied !== true || result.details?.budget?.policySource !== "configured") {
  throw new Error(`PTC policy or result contract was not applied: ${JSON.stringify(result.details)}`);
}

let rejectedWrite = false;
try {
  await registeredTool.execute(
    "forbidden-call",
    { description: "Reject write", code: "await tools.write({ path: 'x', content: 'x' });" },
    new AbortController().signal,
    undefined,
    ctx,
  );
} catch {
  rejectedWrite = true;
}
if (!rejectedWrite) throw new Error("PTC runtime unexpectedly exposed a write tool");

let rejectedOutsideRead = false;
try {
  await registeredTool.execute(
    "outside-read",
    { description: "Reject outside read", code: "await tools.read({ path: '/etc/hostname' });" },
    new AbortController().signal,
    undefined,
    ctx,
  );
} catch {
  rejectedOutsideRead = true;
}
if (!rejectedOutsideRead) throw new Error("PTC runtime read outside the current workspace");

const earlyReturn = await registeredTool.execute(
  "early-return",
  {
    description: "Return while unawaited reads are still settling",
    code: `
      for (let index = 0; index < 16; index += 1) {
        void tools.read({ path: "package.json" });
      }
      return { finished: true };
    `,
  },
  new AbortController().signal,
  undefined,
  ctx,
);
const earlyReturnText = earlyReturn.content.find((item: any) => item.type === "text")?.text ?? "";
if (!earlyReturnText.includes('"finished": true')) {
  throw new Error(`PTC early-return regression failed: ${earlyReturnText}`);
}

const fullWorkspace = await mkdtemp(join(tmpdir(), "pi-ptc-full-smoke-"));
const fullCtx = { ...ctx, cwd: fullWorkspace };
await registeredCommand.handler("full", fullCtx);
const fullResult = await registeredTool.execute(
  "full-mode",
  {
    description: "Write and run a workspace Node program",
    code: `
      await tools.write({
        path: "generated.mjs",
        content: "console.log(JSON.stringify({ answer: 6 * 7 }));\\n",
      });
      const execution = await tools.run({ path: "generated.mjs", timeoutMs: 5000 });
      return execution;
    `,
  },
  new AbortController().signal,
  undefined,
  fullCtx,
);
const fullText = fullResult.content.find((item: any) => item.type === "text")?.text ?? "";
if (!fullText.includes('\\"answer\\":42') || !fullText.includes('"exitCode": 0')) {
  throw new Error(`PTC full-mode write/run failed: ${fullText}`);
}
const generated = await readFile(join(fullWorkspace, "generated.mjs"), "utf8");
if (!generated.includes("6 * 7")) throw new Error("PTC full-mode write did not reach the workspace");

let rejectedOutsideWrite = false;
try {
  await registeredTool.execute(
    "outside-write",
    { description: "Reject outside write", code: "await tools.write({ path: '../escape.mjs', content: 'x' });" },
    new AbortController().signal,
    undefined,
    fullCtx,
  );
} catch {
  rejectedOutsideWrite = true;
}
if (!rejectedOutsideWrite) throw new Error("PTC full mode wrote outside the workspace");

const deniedResult = await registeredTool.execute(
  "permission-denial",
  {
    description: "Verify executed code cannot read outside the workspace",
    code: `
      await tools.write({
        path: "denied.mjs",
        content: "import { readFileSync } from 'node:fs'; readFileSync('/etc/hostname', 'utf8');\\n",
      });
      return tools.run({ path: "denied.mjs", timeoutMs: 5000 });
    `,
  },
  new AbortController().signal,
  undefined,
  fullCtx,
);
const deniedText = deniedResult.content.find((item: any) => item.type === "text")?.text ?? "";
if (deniedText.includes('"exitCode": 0') || !deniedText.includes("ERR_ACCESS_DENIED")) {
  throw new Error(`PTC run permission boundary failed: ${deniedText}`);
}

const runWriteDenied = await registeredTool.execute(
  "run-write-denial",
  {
    description: "Verify executed code cannot bypass the checked write binding",
    code: `
      await tools.write({
        path: "write-denied.mjs",
        content: "import { writeFileSync } from 'node:fs'; writeFileSync('bypass.txt', 'x');\\n",
      });
      return tools.run({ path: "write-denied.mjs", timeoutMs: 5000 });
    `,
  },
  new AbortController().signal,
  undefined,
  fullCtx,
);
const runWriteDeniedText = runWriteDenied.content.find((item: any) => item.type === "text")?.text ?? "";
if (runWriteDeniedText.includes('"exitCode": 0') || !runWriteDeniedText.includes("ERR_ACCESS_DENIED")) {
  throw new Error(`PTC run bypassed checked writes: ${runWriteDeniedText}`);
}
try {
  await readFile(join(fullWorkspace, "bypass.txt"));
  throw new Error("PTC run created bypass.txt despite read-only run permissions");
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
await rm(fullWorkspace, { recursive: true, force: true });
await registeredCommand.handler("on", ctx);

let rejectedContract = false;
try {
  await registeredTool.execute(
    "result-contract-failure",
    {
      description: "Reject a wrong count/checksum result",
      code: "return { count: 2, checksum: 41, ids: ['a', 'b'] };",
      resultContract: {
        kind: "object",
        requiredKeys: ["count", "checksum", "ids"],
        exactKeys: true,
        expectedIntegers: [{ key: "count", value: 2 }, { key: "checksum", value: 42 }],
        expectedArrayLengths: [{ key: "ids", length: 2 }],
      },
    },
    new AbortController().signal,
    undefined,
    ctx,
  );
} catch (error) {
  rejectedContract = error instanceof Error && error.message.includes("PTC_RESULT_VALIDATION_FAILED");
}
if (!rejectedContract) throw new Error("PTC result contract accepted a wrong checksum");

const deepSeekCtx = { ...ctx, model: { provider: "dashscope", id: "deepseek-v4-flash" } };
for (const handler of handlers.get("model_select") ?? []) {
  await handler({ model: deepSeekCtx.model, previousModel: ctx.model, source: "set" }, deepSeekCtx);
}
await registeredCommand.handler("on", deepSeekCtx);
const fencedResult = await registeredTool.execute(
  "fenced-result",
  {
    description: "Normalize a fenced JSON result",
    code: "return '```json\\n{\\\"ok\\\":true,\\\"count\\\":2}\\n```';",
    resultContract: {
      kind: "object",
      requiredKeys: ["ok", "count"],
      exactKeys: true,
      expectedIntegers: [{ key: "count", value: 2 }],
    },
  },
  new AbortController().signal,
  undefined,
  deepSeekCtx,
);
if (fencedResult.details?.resultValidation?.normalizedJson !== true) {
  throw new Error(`PTC fenced tool result was not normalized: ${JSON.stringify(fencedResult.details)}`);
}

let normalizedAssistant: any;
for (const handler of handlers.get("message_end") ?? []) {
  const replacement = await handler({
    message: {
      role: "assistant",
      content: [{ type: "text", text: "结果如下：\n```json\n{\"ok\":true,\"count\":2}\n```" }],
      // A long input context must not consume the per-task PTC generation budget.
      usage: { input: 126_617, output: 100, totalTokens: 126_717 },
    },
  }, deepSeekCtx);
  if (replacement?.message) normalizedAssistant = replacement.message;
}
if (normalizedAssistant?.content?.[0]?.text !== '{"ok":true,"count":2}') {
  throw new Error(`PTC assistant fence was not normalized: ${JSON.stringify(normalizedAssistant)}`);
}

await registeredTool.execute(
  "budget-prefill",
  {
    description: "Consume nested-call budget before testing an uncatchable violation",
    code: `
      await Promise.all(Array.from({ length: 9 }, () => tools.read({ path: "package.json", offset: 1, limit: 1 })));
      return { calls: 9 };
    `,
  },
  new AbortController().signal,
  undefined,
  deepSeekCtx,
);

let rejectedCaughtBudget = false;
try {
  await registeredTool.execute(
    "caught-budget-violation",
    {
      description: "Ensure a program cannot swallow a nested-call budget violation",
      code: `
        for (let index = 0; index < 32; index += 1) {
          try { await tools.read({ path: "package.json", offset: 1, limit: 1 }); } catch {}
        }
        return { swallowed: true };
      `,
    },
    new AbortController().signal,
    undefined,
    deepSeekCtx,
  );
} catch (error) {
  rejectedCaughtBudget = error instanceof Error && error.message.includes("PTC_BUDGET_EXCEEDED");
}
if (!rejectedCaughtBudget) throw new Error("PTC program swallowed a nested-call budget violation");
await registeredCommand.handler("on", ctx);

const cancellation = new AbortController();
const cancelTimer = setTimeout(() => cancellation.abort(), 150);
let cancelledLoop = false;
try {
  await registeredTool.execute(
    "cancel-call",
    { description: "Cancel loop", code: "while (true) {}" },
    cancellation.signal,
    undefined,
    ctx,
  );
} catch (error) {
  cancelledLoop = error instanceof Error && error.message.includes("cancelled");
} finally {
  clearTimeout(cancelTimer);
}
if (!cancelledLoop) throw new Error("PTC runtime did not cancel an infinite loop cleanly");

await registeredCommand.handler("both", ctx);
let mixedSystemPrompt = "";
for (const handler of handlers.get("before_agent_start") ?? []) {
  const replacement = await handler({ systemPrompt: "BASE" }, ctx);
  if (replacement?.systemPrompt) mixedSystemPrompt = replacement.systemPrompt;
}
if (
  !mixedSystemPrompt.includes("For one file read/search")
  || !mixedSystemPrompt.includes("across three or more related files/calls")
  || !mixedSystemPrompt.includes("focused ordinary read is allowed for diagnosis")
) {
  throw new Error("PTC mixed-mode selection guidance is missing");
}
for (const handler of handlers.get("agent_settled") ?? []) await handler({}, ctx);
await registeredCommand.handler("off", ctx);
for (const handler of handlers.get("session_shutdown") ?? []) await handler({}, ctx);

console.log("PTC extension smoke test passed");
