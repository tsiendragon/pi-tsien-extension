import assert from "node:assert/strict";
import test from "node:test";

import ptcExtension from "../extensions/ptc.ts";

function createContext() {
  return {
    cwd: process.cwd(),
    model: { provider: "dashscope", id: "deepseek-v4-flash" },
    hasUI: false,
    ui: {
      setStatus() {},
      theme: { fg: (_color: string, text: string) => text },
    },
  };
}

test("Code Mode is always available and composes active tools", async () => {
  let registeredTool: any;
  let commandRegistrations = 0;
  const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
  const nestedCalls: Array<{ name: string; args: unknown }> = [];
  const activeTools = ["read", "bash", "run_code"];
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
  const prompt = await handlers.get("before_agent_start")?.[0]?.({ systemPrompt: basePrompt }, ctx);
  const writeIndex = prompt.systemPrompt.indexOf("- write:");
  const codeIndex = prompt.systemPrompt.indexOf("- run_code:");
  const customIndex = prompt.systemPrompt.indexOf("- knowledge_search:");
  assert.ok(writeIndex >= 0 && codeIndex > writeIndex && customIndex > codeIndex);
  assert.equal(prompt.systemPrompt.match(/^- run_code:/gm)?.length, 1);
  assert.match(prompt.systemPrompt, /默认首选/);

  const result = await registeredTool.execute(
    "outer-call",
    {
      description: "Read and run in one program",
      code: `
        const [file, shell] = await Promise.all([
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
