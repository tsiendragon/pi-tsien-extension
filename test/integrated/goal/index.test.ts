import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import goalExtension from "../../../extensions/goal/src/index.ts";

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
    expect(packageJson.pi.extensions).toEqual(["./extensions/*.ts"]);
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
