import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import goalExtension from "pi-tsien-goal/src/index.ts";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function createPiStub() {
  const commands = new Map<
    string,
    {
      description?: string;
      handler: (args: string, ctx: { ui: { notify: ReturnType<typeof vi.fn> } }) => Promise<void>;
    }
  >();
  const pi = {
    registerCommand: vi.fn((name, options) => {
      commands.set(name, options);
    }),
    registerTool: vi.fn(),
    on: vi.fn(),
  } as unknown as ExtensionAPI;

  return { pi, commands };
}

describe("goalExtension", () => {
  it("registers a loadable /goal command", () => {
    const { pi, commands } = createPiStub();
    goalExtension(pi);

    expect(commands.has("goal")).toBe(true);
    expect(pi.registerCommand).toHaveBeenCalledWith(
      "goal",
      expect.objectContaining({ description: expect.stringContaining("long-running task") }),
    );
  });

  it("keeps the migrated goal entry aligned with the unified Pi package", () => {
    const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
      name: string;
      pi: { extensions: string[] };
      dependencies: Record<string, string>;
      scripts: Record<string, string>;
    };

    expect(packageJson.name).toBe("pi-tsien-extension");
    // The repo root is an umbrella package: `pi install git:github.com/tsiendragon/pi-tsien-extension`
    // loads every extension in the monorepo. Keep the list in sync with the packages on disk.
    expect(packageJson.pi.extensions.length).toBeGreaterThan(20);
    expect(packageJson.pi.extensions).not.toContain("./extensions/*.ts");
    const listed = packageJson.pi.extensions.map((entry) => entry.replace(/^\.\//, ""));
    // Every declared entry exists, every extension package is covered, and the library is not listed.
    for (const entry of listed) expect(existsSync(entry)).toBe(true);
    const packagesDir = readdirSync("packages").filter((name) => name.startsWith("pi-tsien-"));
    for (const name of packagesDir) {
      const manifest = JSON.parse(readFileSync(`packages/${name}/package.json`, "utf8")) as {
        pi?: { extensions?: string[] };
      };
      const declared = manifest.pi?.extensions ?? [];
      if (declared.length === 0) {
        expect(listed).not.toContain(`packages/${name}/src/index.ts`);
        continue;
      }
      expect(listed).toContain(`packages/${name}/${declared[0]!.replace(/^\.\//, "")}`);
    }
    expect(packageJson.dependencies).toMatchObject({
      jiti: expect.any(String),
      "pi-compact-thinking": expect.any(String),
      typebox: expect.any(String),
    });
    expect(packageJson.scripts).toMatchObject({
      test: expect.stringContaining("test:node"),
      "test:vitest": expect.stringContaining("vitest.integrated.config.ts"),
    });
  });
});
