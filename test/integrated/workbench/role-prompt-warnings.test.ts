import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PiRpcProcessProvider } from "pi-tsien-subagent-workbench/src/providers/pi-rpc-process-provider.ts";
import { clearRoleCache } from "pi-tsien-subagent-workbench/src/roles-registry.ts";
import { SubagentService } from "pi-tsien-subagent-workbench/src/subagent-service.ts";
import { WorkbenchRuntimeHost } from "pi-tsien-subagent-workbench/src/runtime.ts";

// Never write child sessions to the real agent dir during tests.
process.env.PI_SUBAGENT_SESSION_DIR = "off";

const fakeRpcPath = fileURLToPath(
  new URL("./fixtures/fake-pi-rpc.mjs", import.meta.url),
);

const tempDirs: string[] = [];
let rolesDir = "";
let promptDir = "";
let genericPromptPath = "";
const savedEnv = {
  roles: process.env.PI_SUBAGENT_ROLES_DIR,
  prompts: process.env.PI_SUBAGENT_PROMPT_DIR,
  generic: process.env.PI_SUBAGENT_SYSTEM_PROMPT,
  mainContext: process.env.PI_SUBAGENT_MAIN_CONTEXT,
};

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function roleFile(name: string, frontmatter: string): void {
  writeFileSync(
    path.join(rolesDir, `${name}.md`),
    `---\n${frontmatter}\n---\n\nrole body\n`,
  );
}

function harness(genericPromptPath?: string) {
  const runtime = new WorkbenchRuntimeHost({ activeLimit: 4, queueLimit: 8 });
  const provider = new PiRpcProcessProvider({
    executable: process.execPath,
    baseArgs: [fakeRpcPath],
    ...(genericPromptPath ? { genericPromptPath } : {}),
    commandTimeoutMs: 5_000,
    hardRunWallTimeMs: 20_000,
    shutdownTimeoutMs: 500,
    heartbeatIntervalMs: 20,
  });
  const service = new SubagentService(runtime);
  service.providers.register(provider);
  return {
    provider,
    service,
    async dispose() {
      await provider.dispose();
      runtime.dispose();
    },
  };
}

function argvOf(output: string): string[] {
  return JSON.parse(output) as string[];
}

beforeEach(() => {
  rolesDir = tempDir("roles-");
  promptDir = tempDir("role-prompts-");
  genericPromptPath = path.join(tempDir("generic-"), "subagent-system.md");
  process.env.PI_SUBAGENT_ROLES_DIR = rolesDir;
  process.env.PI_SUBAGENT_PROMPT_DIR = promptDir;
  process.env.PI_SUBAGENT_SYSTEM_PROMPT = genericPromptPath;
  delete process.env.PI_SUBAGENT_MAIN_CONTEXT;
  clearRoleCache();
});

afterEach(() => {
  clearRoleCache();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  const restore = (key: string, value: string | undefined): void => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };
  restore("PI_SUBAGENT_ROLES_DIR", savedEnv.roles);
  restore("PI_SUBAGENT_PROMPT_DIR", savedEnv.prompts);
  restore("PI_SUBAGENT_SYSTEM_PROMPT", savedEnv.generic);
  restore("PI_SUBAGENT_MAIN_CONTEXT", savedEnv.mainContext);
});

describe("PiRpcProcessProvider role prompt diagnostics", () => {
  it("uses a role prompt silently when the file exists", async () => {
    roleFile("reviewer", "description: review\nbase: read_only\ntier: light");
    writeFileSync(path.join(promptDir, "reviewer.md"), "REVIEW_ROLE_PROMPT\n");
    const test = harness();
    try {
      const result = await test.service.start({
        task: "report-argv",
        isolation: "process",
        cwd: process.cwd(),
        role: "reviewer",
      });
      const args = argvOf(result.output);
      expect(args[args.indexOf("--append-system-prompt") + 1]).toBe("REVIEW_ROLE_PROMPT\n");
      expect(result.warnings ?? []).toEqual([]);
    } finally {
      await test.dispose();
    }
  });

  it("warns with the role name, the missing path, and the prompt used instead", async () => {
    roleFile("reviewer", "description: review\nbase: read_only\ntier: light");
    writeFileSync(genericPromptPath, "GENERIC_PROMPT\n");
    const test = harness();
    try {
      const result = await test.service.start({
        task: "report-argv",
        isolation: "process",
        cwd: process.cwd(),
        role: "reviewer",
      });
      const warnings = result.warnings ?? [];
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("reviewer");
      expect(warnings[0]).toContain(path.join(promptDir, "reviewer.md"));
      expect(warnings[0]).toMatch(/不存在/);
      expect(warnings[0]).toContain("build.py");
      // The fallback that actually ran must be named too.
      expect(warnings[0]).toContain(genericPromptPath);

      const args = argvOf(result.output);
      expect(args[args.indexOf("--append-system-prompt") + 1]).toBe("GENERIC_PROMPT\n");
    } finally {
      await test.dispose();
    }
  });

  it("treats a whitespace-only role prompt as empty and says so", async () => {
    roleFile("reviewer", "description: review\nbase: read_only\ntier: light");
    writeFileSync(path.join(promptDir, "reviewer.md"), "  \n\n");
    writeFileSync(genericPromptPath, "GENERIC_PROMPT\n");
    const test = harness();
    try {
      const result = await test.service.start({
        task: "report-argv",
        isolation: "process",
        cwd: process.cwd(),
        role: "reviewer",
      });
      const warnings = result.warnings ?? [];
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("reviewer");
      expect(warnings[0]).toMatch(/为空/);
      expect(warnings[0]).not.toMatch(/不存在/);
    } finally {
      await test.dispose();
    }
  });

  it("warns when the role itself is unknown and when its role file is invalid", async () => {
    writeFileSync(genericPromptPath, "GENERIC_PROMPT\n");
    roleFile("badbase", "description: bad\nbase: admin\ntier: light");
    const test = harness();
    try {
      const unknown = await test.service.start({
        task: "report-argv",
        isolation: "process",
        cwd: process.cwd(),
        role: "nosuchrole",
      });
      const unknownWarnings = unknown.warnings ?? [];
      expect(unknownWarnings.join(" ")).toContain("nosuchrole");
      expect(unknownWarnings.join(" ")).toContain("没有角色定义文件");

      const invalid = await test.service.start({
        task: "report-argv",
        isolation: "process",
        cwd: process.cwd(),
        role: "badbase",
      });
      const invalidWarnings = invalid.warnings ?? [];
      expect(invalidWarnings.join(" ")).toContain("badbase");
      expect(invalidWarnings.join(" ")).toMatch(/定义非法/);
      expect(invalidWarnings.join(" ")).toContain("admin");
    } finally {
      await test.dispose();
    }
  });

  it("surfaces all prompt sources missing instead of silently running bare", async () => {
    roleFile("reviewer", "description: review\nbase: read_only\ntier: light");
    // Point the generic prompt at a non-existent file so the test does not
    // depend on the machine's ~/.pi/agent/rules/subagent-system.md.
    genericPromptPath = path.join(tempDir("no-generic-"), "absent.md");
    const test = harness(genericPromptPath);
    try {
      // No role prompt, no PI_SUBAGENT_SYSTEM_PROMPT, no generic prompt file.
      const result = await test.service.start({
        task: "report-argv",
        isolation: "process",
        cwd: process.cwd(),
        role: "reviewer",
      });
      const joined = (result.warnings ?? []).join(" ");
      expect(joined).toContain("reviewer");
      expect(joined).toMatch(/所有子代理 prompt 来源都不可用/);
      const args = argvOf(result.output);
      // loadContextFiles defaults to true, so the documented fallback is loading
      // cwd context files; the point is that no prompt is passed silently.
      expect(args).not.toContain("--append-system-prompt");
    } finally {
      await test.dispose();
    }
  });

  it("warns when PI_SUBAGENT_MAIN_CONTEXT=1 skips the role prompt", async () => {
    roleFile("reviewer", "description: review\nbase: read_only\ntier: light");
    writeFileSync(path.join(promptDir, "reviewer.md"), "REVIEW_ROLE_PROMPT\n");
    process.env.PI_SUBAGENT_MAIN_CONTEXT = "1";
    const test = harness();
    try {
      const result = await test.service.start({
        task: "report-argv",
        isolation: "process",
        cwd: process.cwd(),
        role: "reviewer",
      });
      const joined = (result.warnings ?? []).join(" ");
      expect(joined).toContain("PI_SUBAGENT_MAIN_CONTEXT=1");
      expect(joined).toContain("reviewer");
      const args = argvOf(result.output);
      expect(args).not.toContain("--append-system-prompt");
    } finally {
      await test.dispose();
    }
  });
});