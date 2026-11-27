import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  FALLBACK_ROLE_BASE,
  clearRoleCache,
  formatRoleValidationReport,
  parseRoleProfile,
  roleProfile,
  roleValidationReport,
} from "../../../packages/pi-tsien-subagent-workbench/src/roles-registry.ts";
import { roleToolNames } from "../../../packages/pi-tsien-subagent-workbench/src/runner-stage.ts";

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

function promptFile(name: string, body: string): void {
  writeFileSync(path.join(promptDir, `${name}.md`), body);
}

beforeEach(() => {
  rolesDir = tempDir("roles-");
  promptDir = tempDir("role-prompts-");
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

describe("roles registry: fail-closed frontmatter", () => {
  it("marks an unknown base and falls back to the least-privileged tool set", () => {
    roleFile("badbase", "description: bad\nbase: admin\ntier: light");
    const profile = roleProfile("badbase");

    expect(profile?.invalid).toBe(true);
    expect(profile?.base).toBe(FALLBACK_ROLE_BASE);
    expect(profile?.base).not.toBe("code");
    expect(profile?.invalidReason).toContain("admin");
    expect(profile?.issues).toEqual([
      expect.objectContaining({ field: "base", value: "admin" }),
    ]);
    // An invalid role must not inherit code's shell/write tools.
    expect(roleToolNames("badbase")).not.toContain("bash");
    expect(roleToolNames("badbase")).not.toContain("write");
  });

  it("marks an unknown tier, drops it, and leaves the router default in charge", () => {
    roleFile("badtier", "description: bad tier\nbase: research\ntier: turbo");
    const profile = roleProfile("badtier");

    expect(profile?.invalid).toBe(true);
    expect(profile?.tier).toBeUndefined();
    expect(profile?.base).toBe("research");
    expect(profile?.invalidReason).toContain("turbo");
    expect(profile?.issues).toEqual([
      expect.objectContaining({ field: "tier", value: "turbo" }),
    ]);
  });

  it("marks a missing base as invalid instead of assuming code", () => {
    roleFile("nobase", "description: no base");
    const profile = roleProfile("nobase");

    expect(profile?.invalid).toBe(true);
    expect(profile?.base).toBe(FALLBACK_ROLE_BASE);
    expect(profile?.invalidReason).toContain("no base");
  });

  it("keeps valid roles unchanged and undeclared tiers non-fatal", () => {
    roleFile("good", "description: ok\nbase: code\ntier: light");
    roleFile("notier", "description: ok\nbase: read_only");
    expect(roleProfile("good")).toMatchObject({
      base: "code",
      tier: "light",
      invalid: false,
    });
    expect(roleProfile("notier")).toMatchObject({ base: "read_only", invalid: false });
    expect(roleProfile("notier")?.invalidReason).toBeUndefined();
  });

  it("gives unknown custom roles the least-privileged tools instead of code's", () => {
    // No role file at all: a typo must not grant write/shell access.
    expect(roleProfile("nosuchrole")).toBeUndefined();
    expect(roleToolNames("nosuchrole")).not.toContain("bash");
    expect(roleToolNames("nosuchrole")).not.toContain("write");
    expect(roleToolNames("nosuchrole")).toEqual(roleToolNames("read_only"));

    // Built-in roles keep their documented tool sets.
    expect(roleToolNames("code")).toContain("write");
    expect(roleToolNames("research")).not.toContain("write");
  });

  it("reports unreadable role files as invalid rather than dropping them", () => {
    const profile = parseRoleProfile("ghost", path.join(rolesDir, "ghost.md"));
    expect(profile?.invalid).toBe(true);
    expect(profile?.base).toBe(FALLBACK_ROLE_BASE);
    expect(profile?.issues[0]?.field).toBe("frontmatter");
  });
});

describe("roles registry: machine-readable validation report", () => {
  it("lists invalid roles with reasons and missing prompts", () => {
    roleFile("badbase", "description: bad\nbase: admin");
    roleFile("good", "description: ok\nbase: code\ntier: light");
    promptFile("good", "generated prompt\n");

    const report = roleValidationReport();
    expect(report.version).toBe(1);
    expect(report.invalid).toEqual(["badbase"]);
    expect(report.missingPrompts).toEqual(["badbase"]);

    const bad = report.roles.find((role) => role.name === "badbase");
    expect(bad).toMatchObject({ valid: false, base: FALLBACK_ROLE_BASE });
    expect(bad?.invalidReason).toContain("admin");
    expect(bad?.promptState).toBe("missing");

    const good = report.roles.find((role) => role.name === "good");
    expect(good).toMatchObject({ valid: true, base: "code", tier: "light", promptState: "present" });

    const human = formatRoleValidationReport(report);
    expect(human).toContain("INVALID · badbase");
    expect(human).toContain("admin");
    expect(human).toContain("ok · good");
  });

  it("distinguishes empty prompts from missing ones", () => {
    roleFile("emptyprompt", "description: ok\nbase: read_only");
    promptFile("emptyprompt", "   \n\n");
    const report = roleValidationReport();
    expect(report.invalid).toEqual([]);
    expect(report.missingPrompts).toEqual(["emptyprompt"]);
    expect(report.roles[0]?.promptState).toBe("empty");
  });
});