import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import ptcExtension from "pi-tsien-code-mode/src/index.ts";
import { compileProgram, isTypeStripperAvailable } from "pi-tsien-code-mode/src/typescript-strip.ts";

function createContext() {
  return {
    cwd: process.cwd(),
    model: { provider: "openai-codex", id: "model-flash-b" },
    hasUI: false,
    ui: {
      setStatus() {},
      theme: { fg: (_color: string, text: string) => text },
    },
  };
}

// Type stripping runs on the host (src/typescript-strip.ts), so this Node build no longer needs
// built-in TypeScript support; the suite is skipped only where no stripper exists at all.
const typeStripping = isTypeStripperAvailable();

function assertCodeModeUnavailable() {
  let start: ((event: unknown, ctx: unknown) => void) | undefined;
  ptcExtension({
    registerTool: () => assert.fail("must not expose run_code"),
    on: (event: string, handler: typeof start) => {
      assert.equal(event, "session_start", "only the startup diagnostic should be registered");
      start = handler;
    },
    setActiveTools: () => assert.fail("must not change other active tools"),
  } as any);
  assert.ok(start);
  const notices: Array<[string, string]> = [];
  const ctx = { hasUI: true, ui: { notify: (text: string, level: string) => notices.push([text, level]) } };
  start({}, ctx);
  start({}, ctx);
  assert.equal(notices.length, 1);
  assert.equal(notices[0][1], "warning");
  assert.match(notices[0][0], /run_code.*sandbox probe failed/);
  assert.ok(notices[0][0].includes("/reload does not switch Node"));
}

test("Code Mode is not exposed when no type stripping is available", {
  skip: typeStripping,
}, assertCodeModeUnavailable);

test("type stripping keeps line numbers and rejects non-erasable syntax", () => {
  assert.match(compileProgram("const value: number = 42; return value;"), /const value\s+= 42; return value;/);
  assert.doesNotMatch(compileProgram("const value: number = 42; return value;"), /: number/);
  assert.throws(() => compileProgram("enum E { A }"), /enum is not supported/i);
  assert.throws(() => compileProgram("const x: number = ;"), /line 1/);
});

test("Code Mode remains unavailable if the child cannot start", () => {
  const execPath = process.execPath;
  try {
    process.execPath = `${execPath}/missing-node`;
    assertCodeModeUnavailable();
  } finally {
    process.execPath = execPath;
  }
});

test("Code Mode on supported Node composes active tools and only advertises when active", {
  skip: !typeStripping,
}, async () => {
  let registeredTool: any;
  let commandRegistrations = 0;
  const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
  const nestedCalls: Array<{ name: string; args: unknown }> = [];
  const activeTools = ["read", "bash"];
  const allTools = [
    {
      name: "read",
      description: "Read a file",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      sourceInfo: { source: "builtin" },
    },
    {
      name: "bash",
      description: "Run a shell command",
      parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
      sourceInfo: { source: "builtin" },
    },
  ];
  const pi: any = {
    registerTool(definition: any) {
      registeredTool = definition;
    },
    registerCommand() {
      commandRegistrations += 1;
    },
    on(event: string, handler: (event: any, ctx: any) => any) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    getActiveTools: () => activeTools,
    getAllTools: () => allTools,
    async executeTool(name: string, args: unknown) {
      nestedCalls.push({ name, args });
      return {
        result: { content: [{ type: "text", text: name === "read" ? "file-content" : "shell-output" }] },
        isError: false,
      };
    },
  };

  ptcExtension(pi);
  assert.equal(registeredTool?.name, "run_code");
  assert.equal(commandRegistrations, 0);

  const ctx = createContext();
  const basePrompt = `BASE
Available tools:
- read: Read files
- bash: Run commands
- edit: Edit files
- write: Write files
- knowledge_search: Search knowledge
- run_code: old description

In addition to the tools above, you may have access to other custom tools depending on the project.`;
  const beforeAgentStart = handlers.get("before_agent_start")?.[0];
  assert.ok(beforeAgentStart);
  assert.equal(await beforeAgentStart({ systemPrompt: basePrompt.replace("- run_code: old description\n", "") }, ctx), undefined);
  activeTools.push("run_code");
  const prompt = await beforeAgentStart({ systemPrompt: basePrompt }, ctx);
  const writeIndex = prompt.systemPrompt.indexOf("- write:");
  const codeIndex = prompt.systemPrompt.indexOf("- run_code:");
  const customIndex = prompt.systemPrompt.indexOf("- knowledge_search:");
  assert.ok(writeIndex >= 0 && codeIndex > writeIndex && customIndex > codeIndex);
  assert.equal(prompt.systemPrompt.match(/^- run_code:/gm)?.length, 1);
  assert.match(prompt.systemPrompt, /默认首选/);
  assert.match(prompt.systemPrompt, /单条命令直接用 bash/);
  assert.match(registeredTool.description, /save a script and run the file/);

  const result = await registeredTool.execute(
    "outer-call",
    {
      description: "Read and run in one program",
      code: `
        const [file, shell]: [string, string] = await Promise.all([
          tools.read({ path: "README.md" }),
          tools.bash({ command: "printf shell-output" }),
        ]);
        return { file, shell };
      `,
    },
    undefined,
    undefined,
    ctx,
  );

  assert.deepEqual(nestedCalls.map((call) => call.name).sort(), ["bash", "read"]);
  assert.match(result.content[0].text, /file-content/);
  assert.match(result.content[0].text, /shell-output/);
  assert.equal(result.details.codeMode, true);
  assert.equal(result.details.availableTools, 2);
});

test("Code Mode isolates nested budgets, preserving receipts and same-turn recovery", {
  skip: !typeStripping,
}, async () => {
  let registeredTool: any;
  let writes = 0;
  const handlers = new Map<string, (event: any, ctx: any) => any>();
  ptcExtension({
    registerTool(definition: any) { registeredTool = definition; },
    on(event: string, handler: any) { handlers.set(event, handler); },
    getActiveTools: () => ["run_code", "write"],
    async executeTool(name: string) {
      assert.equal(name, "write");
      writes++;
      return { result: { content: [{ type: "text", text: "mock write ok" }] }, isError: false };
    },
  } as any);
  const ctx = { ...createContext(), model: { provider: "test-provider", id: "isolated-budget-test" } };
  const execute = (n: number) => registeredTool.execute("budget-test", {
    code: `for (let i = 0; i < ${n}; i++) await tools.write({ path: 'mock', content: 'data' }); return true;`,
    description: "Exercise independent run budgets",
  }, undefined, undefined, ctx);
  handlers.get("before_agent_start")!({ systemPrompt: "" }, ctx);
  handlers.get("message_end")!({ message: { role: "assistant", usage: { output: 60_001 }, content: [] } }, ctx);
  await execute(20);
  const second = await execute(20);
  assert.equal(second.details.budget.nestedWrites.used, 40);
  assert.ok(second.details.budget.advisories.some((text: string) => text.startsWith("output tokens")));
  await assert.rejects(() => execute(33), (error: Error) => {
    assert.match(error.message, /PTC_BUDGET_EXCEEDED/);
    assert.match(error.message, /succeeded: #1 write/);
    assert.match(error.message, /not dispatched: #33 write/);
    return true;
  });
  assert.equal(writes, 72);
  const recovered = await execute(1);
  assert.equal(writes, 73);
  assert.equal(recovered.details.budget.outerRunCodeCalls.used, 4);
});

test("Code Mode distinguishes compile, execution, and nested tool failures", {
  skip: !typeStripping,
}, async () => {
  let registeredTool: any;
  let nestedCalls = 0;
  ptcExtension({
    registerTool(definition: any) { registeredTool = definition; },
    on() {},
    getActiveTools: () => ["run_code", "bash"],
    async executeTool() {
      nestedCalls += 1;
      return {
        result: { content: [{
          type: "text",
          text: `Python SyntaxError: unterminated string literal\n${"x".repeat(80_000)}\nCommand exited with code 2`,
        }] },
        isError: true,
      };
    },
  } as any);
  const execute = (code: string) => registeredTool.execute(
    "diagnostic-test", { code, description: "Test diagnostics" }, undefined, undefined, createContext(),
  );

  await assert.rejects(() => execute('await tools.bash({ command: "unused" }); const x: number = ;'),
    /script compilation failed \(no tools ran\)/);
  assert.equal(nestedCalls, 0);
  await assert.rejects(() => execute('throw new Error("bad script state")'), /script execution failed[\s\S]*bad script state/);
  assert.equal(nestedCalls, 0);
  await assert.rejects(() => execute('await tools.bash({ command: "fake command" })'), (error: Error) => {
    assert.match(error.message, /nested tool "bash" failed/);
    assert.match(error.message, /Python SyntaxError: unterminated string literal/);
    assert.match(error.message, /omitted middle of tool error/);
    assert.match(error.message, /Command exited with code 2$/);
    assert.ok(error.message.length < 5000);
    return true;
  });
  assert.equal(nestedCalls, 1, "failed tool was not retried");
  const caught = await execute('try { await tools.bash({ command: "fake command" }); } catch (error) { return String(error).includes("Command exited with code 2"); }');
  assert.match(caught.content[0].text, /true/);
  assert.equal(nestedCalls, 2);
});
