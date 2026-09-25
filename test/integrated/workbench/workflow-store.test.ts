import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  SAVED_WORKFLOW_VERSION,
  loadWorkflowDefinition,
  saveWorkflowDefinition,
  validateWorkflowName,
  workflowDefinitionPath,
  type SavedWorkflowDefinition,
} from "pi-tsien-subagent-workbench/src/workflow-store.ts";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "workflow-store-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("workflow definition store", () => {
  it("round-trips a versioned workflow with all task fields", async () => {
    const cwd = await temporaryDirectory();
    const definition: SavedWorkflowDefinition = {
      version: SAVED_WORKFLOW_VERSION,
      label: "Review pipeline",
      parameters: {
        country: "IQ",
        files: ["README.md", "package.json"],
      },
      stages: [
        {
          label: "Review",
          tasks: [
            {
              key: "review",
              task: "Review the implementation",
              label: "Reviewer",
              cwd: "/workspace/project",
              model: "provider/model",
              thinking: "high",
              context: "Focus on correctness.",
              inputs: ["implementation"],
              when: '{{parameters.country}} == "IQ"',
              foreach: "{{parameters.files}}",
              maxItems: 2,
              outputSchema: {
                type: "object",
                properties: { passed: { type: "boolean" } },
              },
            },
          ],
        },
      ],
    };

    const savedPath = await saveWorkflowDefinition(cwd, "review-flow", definition);

    expect(savedPath).toBe(path.join(cwd, ".pi", "workflows", "review-flow.json"));
    expect(path.isAbsolute(workflowDefinitionPath(cwd, "review-flow"))).toBe(true);
    expect(await loadWorkflowDefinition(cwd, "review-flow")).toEqual(definition);
    expect(await readFile(savedPath, "utf8")).toMatch(/\n$/);
  });

  it("rejects workflow names outside the portable filename grammar", () => {
    for (const name of [
      "",
      "-starts-with-dash",
      "has space",
      "../escape",
      "a".repeat(65),
    ]) {
      expect(() => validateWorkflowName(name)).toThrow(TypeError);
      expect(() => workflowDefinitionPath(".", name)).toThrow(TypeError);
    }

    expect(validateWorkflowName("A_1-valid")).toBe("A_1-valid");
  });

  it("rejects corrupt JSON and invalid workflow definitions", async () => {
    const cwd = await temporaryDirectory();
    const directory = path.join(cwd, ".pi", "workflows");
    await saveWorkflowDefinition(cwd, "seed", {
      version: SAVED_WORKFLOW_VERSION,
      stages: [{ tasks: [{ task: "seed" }] }],
    });

    const cases: [string, string][] = [
      ["corrupt", "{not json}\n"],
      ["wrong-version", JSON.stringify({ version: 2, stages: [{ tasks: [{ task: "x" }] }] })],
      ["empty-stages", JSON.stringify({ version: 1, stages: [] })],
      ["empty-tasks", JSON.stringify({ version: 1, stages: [{ tasks: [] }] })],
      [
        "bad-field",
        JSON.stringify({
          version: 1,
          stages: [{ tasks: [{ task: "x", inputs: ["valid", 1] }] }],
        }),
      ],
    ];

    for (const [name, content] of cases) {
      await writeFile(path.join(directory, `${name}.json`), content, "utf8");
      await expect(loadWorkflowDefinition(cwd, name)).rejects.toThrow();
    }
  });
});
