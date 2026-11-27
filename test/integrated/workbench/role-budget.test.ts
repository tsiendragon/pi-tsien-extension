import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  BUDGET_NOTICE_RATIO,
  budgetExhaustedMessage,
  budgetHandoffMessage,
  budgetProgress,
  resolveBudgetThresholds,
  roleBudget,
  roleBudgetThresholds,
  withBudgetDirective,
} from "pi-tsien-subagent-workbench/src/role-budget.ts";
import {
  clearRoleCache,
  formatRoleValidationReport,
  parseRoleProfile,
  roleProfile,
  roleValidationReport,
} from "pi-tsien-subagent-workbench/src/roles-registry.ts";

const tempDirs: string[] = [];
let rolesDir = "";
let promptDir = "";
const savedEnv = {
  roles: process.env.PI_SUBAGENT_ROLES_DIR,
  prompts: process.env.PI_SUBAGENT_PROMPT_DIR,
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

beforeEach(() => {
  rolesDir = tempDir("roles-budget-");
  promptDir = tempDir("role-budget-prompts-");
  process.env.PI_SUBAGENT_ROLES_DIR = rolesDir;
  process.env.PI_SUBAGENT_PROMPT_DIR = promptDir;
  clearRoleCache();
});

afterEach(() => {
  clearRoleCache();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  if (savedEnv.roles === undefined) delete process.env.PI_SUBAGENT_ROLES_DIR;
  else process.env.PI_SUBAGENT_ROLES_DIR = savedEnv.roles;
  if (savedEnv.prompts === undefined) delete process.env.PI_SUBAGENT_PROMPT_DIR;
  else process.env.PI_SUBAGENT_PROMPT_DIR = savedEnv.prompts;
});

describe("role budget frontmatter", () => {
  it("parses maxTurns and maxTokens into RoleProfile.budget", () => {
    roleFile("review", "description: strict\nbase: code\ntier: light\nmaxTurns: 40\nmaxTokens: 250000");
    const profile = roleProfile("review");
    expect(profile).toBeDefined();
    expect(profile!.invalid).toBe(false);
    expect(profile!.budget).toEqual({ maxTurns: 40, maxTokens: 250000 });
    expect(Object.isFrozen(profile!.budget)).toBe(true);
  });

  it("supports declaring only one dimension", () => {
    roleFile("turnonly", "description: t\nbase: read_only\nmaxTurns: 12");
    roleFile("tokenonly", "description: k\nbase: read_only\nmaxTokens: 9000");
    expect(roleProfile("turnonly")!.budget).toEqual({ maxTurns: 12 });
    expect(roleProfile("tokenonly")!.budget).toEqual({ maxTokens: 9000 });
  });

  it("leaves budget undefined when the role declares nothing", () => {
    roleFile("plain", "description: p\nbase: read_only\ntier: light");
    const profile = roleProfile("plain")!;
    expect(profile.budget).toBeUndefined();
    expect(profile.invalid).toBe(false);
  });

  it("rejects invalid budgets instead of silently treating them as unlimited", () => {
    for (const [field, value] of [
      ["maxTurns", "0"],
      ["maxTurns", "-3"],
      ["maxTurns", "many"],
      ["maxTurns", "2.5"],
      ["maxTokens", "0"],
      ["maxTokens", "lots"],
    ] as const) {
      const name = `bad-${field}-${value.replace(/[^a-z0-9]/gi, "")}`;
      roleFile(name, `description: bad\nbase: read_only\n${field}: ${value}`);
      const profile = roleProfile(name)!;
      expect(profile.budget).toBeUndefined();
      expect(profile.invalid).toBe(true);
      expect(profile.issues.some((issue) => issue.field === field)).toBe(true);
      expect(profile.invalidReason).toContain(field);
    }
  });

  it("keeps a valid budget while still reporting an unrelated base error", () => {
    const profile = parseRoleProfile(
      "mixed",
      (() => {
        roleFile("mixed", "description: m\nbase: admin\nmaxTurns: 30");
        return path.join(rolesDir, "mixed.md");
      })(),
    )!;
    expect(profile.budget).toEqual({ maxTurns: 30 });
    expect(profile.invalid).toBe(true);
    expect(profile.issues.some((issue) => issue.field === "base")).toBe(true);
  });

  it("surfaces budgets in the validation report and its human format", () => {
    roleFile("withbudget", "description: b\nbase: code\nmaxTurns: 25\nmaxTokens: 60000");
    const report = roleValidationReport();
    const entry = report.roles.find((role) => role.name === "withbudget")!;
    expect(entry.budget).toEqual({ maxTurns: 25, maxTokens: 60000 });
    const text = formatRoleValidationReport(report);
    expect(text).toContain("maxTurns 25");
    expect(text).toContain("maxTokens 60000");
  });
});

describe("budget thresholds and handoff prompts", () => {
  it("derives near-limit thresholds from the declared budget", () => {
    expect(resolveBudgetThresholds(undefined)).toEqual({});
    expect(resolveBudgetThresholds({ maxTurns: 40, maxTokens: 1000 })).toEqual({
      maxTurns: 40,
      maxTokens: 1000,
      noticeAtTurn: 32,
      noticeAtTokens: 800,
    });
    expect(BUDGET_NOTICE_RATIO).toBe(0.8);
    // Tiny budgets must still produce a usable (>=1) notice point.
    expect(resolveBudgetThresholds({ maxTurns: 1 }).noticeAtTurn).toBe(1);
  });

  it("reads thresholds from a role file", () => {
    roleFile("bounded", "description: b\nbase: code\nmaxTurns: 20\nmaxTokens: 100000");
    expect(roleBudget("bounded")).toEqual({ maxTurns: 20, maxTokens: 100000 });
    expect(roleBudgetThresholds("bounded")).toMatchObject({
      maxTurns: 20,
      maxTokens: 100000,
      noticeAtTurn: 16,
      noticeAtTokens: 80000,
    });
    expect(roleBudgetThresholds("no-such-role")).toEqual({});
    expect(roleBudgetThresholds(undefined)).toEqual({});
  });

  it("computes progress with a clear near-limit and exhausted flag", () => {
    expect(budgetProgress(10, undefined)).toBeUndefined();
    expect(budgetProgress(8, 10)).toEqual({
      used: 8,
      limit: 10,
      remaining: 2,
      nearLimit: true,
      exhausted: false,
    });
    expect(budgetProgress(10, 10)).toMatchObject({ nearLimit: true, exhausted: true });
    expect(budgetProgress(2, 10)).toMatchObject({ nearLimit: false, exhausted: false });
  });

  it("asks the child to hand off partial artifacts at the notice point", () => {
    const message = budgetHandoffMessage({
      modelCalls: 32,
      tokens: 800,
      maxTurns: 40,
      maxTokens: 1000,
    });
    expect(message).toContain("<budget_notice>turn 32/40, tokens 800/1000</budget_notice>");
    expect(message).toContain("Stop exploring");
    expect(message).toContain("artifact paths");
    expect(message).toContain("Do not start new work.");
  });

  it("states the budget in the task and demands a partial handoff at exhaustion", () => {
    const directive = withBudgetDirective("do the work", { maxTurns: 10 });
    expect(directive.startsWith("do the work")).toBe(true);
    expect(directive).toContain("10 assistant turns");
    expect(directive).toContain("partial artifacts");
    expect(withBudgetDirective("do the work", undefined)).toBe("do the work");

    expect(budgetExhaustedMessage("maxTurns", 10)).toContain("10 calls");
    expect(budgetExhaustedMessage("maxTurns", 10)).toContain("Deliver partial artifacts");
    expect(budgetExhaustedMessage("maxTokens", 5000)).toContain("5000 tokens");
  });
});