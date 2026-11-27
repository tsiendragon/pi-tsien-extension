import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PiRpcProcessProvider } from "pi-tsien-subagent-workbench/src/providers/pi-rpc-process-provider.ts";
import { WorkbenchRuntimeHost } from "pi-tsien-subagent-workbench/src/runtime.ts";
import {
  WorkbenchController,
  type WorkbenchRunWarning,
} from "pi-tsien-subagent-workbench/src/workbench-controller.ts";
import { ModelRouter } from "pi-tsien-subagent-workbench/src/model-router.ts";
import { clearRoleCache } from "pi-tsien-subagent-workbench/src/roles-registry.ts";

process.env.PI_SUBAGENT_SESSION_DIR = "off";

const fixture = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures/fake-pi-rpc.mjs",
);

/** Hermetic router: no config file, one legacy model, explicit models allowed as-is. */
const testRouter = (): ModelRouter =>
  new ModelRouter({
    configPath: path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "missing-subagent-models.json",
    ),
    environment: { PI_SUBAGENT_EXECUTION_MODEL: "fake/fake-rpc" },
  });

const controllers: WorkbenchController[] = [];
const tempDirs: string[] = [];
const savedRoles = process.env.PI_SUBAGENT_ROLES_DIR;
const savedPrompts = process.env.PI_SUBAGENT_PROMPT_DIR;

function setup(onRunWarning?: (warning: WorkbenchRunWarning) => void): WorkbenchController {
  const runtime = new WorkbenchRuntimeHost({ activeLimit: 2, queueLimit: 8 });
  const provider = new PiRpcProcessProvider({
    executable: process.execPath,
    baseArgs: [fixture],
    commandTimeoutMs: 2_000,
    startupTimeoutMs: 2_000,
    runTimeoutMs: 5_000,
    shutdownTimeoutMs: 500,
    heartbeatIntervalMs: 50,
  });
  const controller = new WorkbenchController(runtime, {
    provider,
    router: testRouter(),
    // Never append to the real ~/.pi/agent/subagent-jobs.jsonl.
    jobLedger: null,
    ...(onRunWarning === undefined ? {} : { onRunWarning }),
  });
  controllers.push(controller);
  return controller;
}

function roleFile(name: string, frontmatter: string): void {
  const dir = tempDirs[0]!;
  writeFileSync(path.join(dir, `${name}.md`), `---\n${frontmatter}\n---\n\nbody\n`);
}

beforeEach(() => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "workbench-budget-"));
  tempDirs.push(dir);
  process.env.PI_SUBAGENT_ROLES_DIR = dir;
  process.env.PI_SUBAGENT_PROMPT_DIR = dir;
  clearRoleCache();
});

afterEach(async () => {
  await Promise.all(controllers.splice(0).map((controller) => controller.dispose()));
  clearRoleCache();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  if (savedRoles === undefined) delete process.env.PI_SUBAGENT_ROLES_DIR;
  else process.env.PI_SUBAGENT_ROLES_DIR = savedRoles;
  if (savedPrompts === undefined) delete process.env.PI_SUBAGENT_PROMPT_DIR;
  else process.env.PI_SUBAGENT_PROMPT_DIR = savedPrompts;
});

const schema = {
  type: "object",
  properties: { country: { type: "string" }, valid: { type: "boolean" } },
  required: ["country", "valid"],
  additionalProperties: false,
};

describe("subagent_start outputSchema", () => {
  it("passes a matching JSON result through untouched", async () => {
    const controller = setup();
    const result = await controller.runAgent({
      task: 'json-output:{"country":"IQ","valid":true}',
      cwd: process.cwd(),
      role: "read_only",
      outputSchema: schema,
    });
    expect(result.isError).toBe(false);
    expect(result.output).toBe('{"country":"IQ","valid":true}');
    expect(result.structuredOutputError).toBeUndefined();
  });

  it("fails instead of passing a schema mismatch, naming the offending field", async () => {
    const controller = setup();
    const result = await controller.runAgent({
      task: 'json-output:{"country":"IQ","valid":"yes"}',
      cwd: process.cwd(),
      role: "read_only",
      outputSchema: schema,
    });
    expect(result.isError).toBe(true);
    expect(result.errorMessage).toContain("does not match outputSchema");
    expect(result.errorMessage).toContain("/valid");
    expect(result.structuredOutputError).toBe("schema_mismatch");
    // The raw child text is preserved so the main agent can still inspect it.
    expect(result.output).toContain('"valid":"yes"');
  });

  it("fails on non-JSON output with a distinct reason", async () => {
    const controller = setup();
    const result = await controller.runAgent({
      task: "this is prose, not JSON",
      cwd: process.cwd(),
      role: "read_only",
      outputSchema: schema,
    });
    expect(result.isError).toBe(true);
    expect(result.structuredOutputError).toBe("invalid_json");
    expect(result.errorMessage).toContain("not valid JSON");
  });

  it("appends the JSON-only requirement to the child's task", async () => {
    const controller = setup();
    // This task echoes the received prompt, so we can see what the child got.
    const result = await controller.runAgent({
      task: "echo-the-task",
      cwd: process.cwd(),
      role: "read_only",
      outputSchema: schema,
    });
    expect(result.output).toContain("<structured_output_required>");
    expect(result.output).toContain(JSON.stringify(schema));
    expect(result.output).toContain("Reply with the JSON only");
    // The echo is not JSON, so the job must be marked failed.
    expect(result.isError).toBe(true);
  });

  it("rejects an invalid schema before any child is started", async () => {
    const controller = setup();
    await expect(
      controller.runAgent({
        task: "noop",
        cwd: process.cwd(),
        role: "read_only",
        outputSchema: [] as unknown as Record<string, unknown>,
      }),
    ).rejects.toThrow("outputSchema must be a JSON Schema object.");
  });

  it("marks the background job failed so subagent_results cannot miss it", async () => {
    const controller = setup();
    const submission = controller.submitAgent(
      {
        task: 'json-output:{"country":"IQ"}',
        cwd: process.cwd(),
        role: "read_only",
        outputSchema: schema,
      },
      true,
    );
    const result = await submission.completion;
    expect(result.isError).toBe(true);
    const job = controller.getJobs().completed.find(
      (candidate) => candidate.workId === submission.handle.workId,
    );
    expect(job?.status).toBe("failed");
    expect(job?.error).toContain("outputSchema");
  });
});

describe("role budget enforcement", () => {
  it("stops a child at maxTurns and keeps partial output", async () => {
    roleFile("bounded", "description: bounded\nbase: read_only\nmaxTurns: 3");
    const controller = setup();
    const result = await controller.runAgent({
      task: "turns:10",
      cwd: process.cwd(),
      role: "bounded",
    });
    expect(result.isError).toBe(true);
    expect(result.errorMessage).toContain("model call budget (3 calls)");
    expect(result.errorMessage).toContain("Deliver partial artifacts");
    // The three completed turns are still in the collected output.
    expect(result.output).toContain("turn 3");
    expect(result.usage.input).toBeGreaterThan(0);
  });

  it("stops a child at maxTokens", async () => {
    roleFile("tight", "description: tight\nbase: read_only\nmaxTokens: 25");
    const controller = setup();
    const result = await controller.runAgent({
      task: "turns:10:10",
      cwd: process.cwd(),
      role: "tight",
    });
    expect(result.isError).toBe(true);
    expect(result.errorMessage).toContain("token budget (25 tokens)");
  });

  it("warns near the limit and asks the child to hand off progress", async () => {
    roleFile("notice", "description: notice\nbase: read_only\nmaxTurns: 5");
    const warnings: WorkbenchRunWarning[] = [];
    const controller = setup((warning) => warnings.push(warning));
    const result = await controller.runAgent({
      task: "turns:10",
      cwd: process.cwd(),
      role: "notice",
    });
    expect(result.isError).toBe(true);
    const budgetWarning = warnings.find((warning) => warning.warning === "budget");
    expect(budgetWarning).toBeDefined();
    expect(budgetWarning!.budget).toEqual({ kind: "maxTurns", used: 4, limit: 5 });
    expect(budgetWarning!.message).toContain("asked the child to hand off partial artifacts");
  });

  it("does not warn when the child finishes well inside budget", async () => {
    roleFile("roomy", "description: roomy\nbase: read_only\nmaxTurns: 50");
    const warnings: WorkbenchRunWarning[] = [];
    const controller = setup((warning) => warnings.push(warning));
    const result = await controller.runAgent({
      task: "turns:3",
      cwd: process.cwd(),
      role: "roomy",
    });
    expect(result.isError).toBe(false);
    expect(warnings.filter((warning) => warning.warning === "budget")).toEqual([]);
  });

  it("leaves roles without a budget on the global limit", async () => {
    roleFile("nobudget", "description: none\nbase: read_only");
    const controller = setup();
    const result = await controller.runAgent({
      task: "turns:4",
      cwd: process.cwd(),
      role: "nobudget",
    });
    expect(result.isError).toBe(false);
    expect(result.output).toContain("turn 4");
  });
});