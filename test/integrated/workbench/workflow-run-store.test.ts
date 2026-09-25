import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadWorkflowRun,
  saveWorkflowRun,
  validateWorkflowRunWorkId,
  workflowRunPath,
} from "pi-tsien-subagent-workbench/src/workflow-run-store.ts";
import type { WorkbenchWorkflowResult } from "pi-tsien-subagent-workbench/src/workbench-controller.ts";
import type { SavedWorkflowDefinition } from "pi-tsien-subagent-workbench/src/workflow-store.ts";

const directories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "workflow-run-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

const definition: SavedWorkflowDefinition = {
  version: 1,
  label: "Sensitive definition",
  parameters: { tokenLikeValue: "must-not-leak-in-metadata" },
  origin: {
    language: "javascript",
    source: 'workflow.stage("Inspect").task({ task: "private task body" })',
  },
  stages: [
    {
      tasks: [
        {
          key: "inspect",
          task: "private task body",
          context: "private context",
          outputSchema: { type: "object" },
        },
      ],
    },
  ],
};

const result: WorkbenchWorkflowResult = {
  workflowId: "workflow_test",
  label: "Sensitive definition",
  status: "completed",
  attempt: 2,
  sourceWorkId: "work_source",
  resumedFromStage: 2,
  stages: [
    {
      id: "stage-1",
      label: "Inspect",
      status: "completed",
      reused: true,
      tasks: [
        {
          id: "task-1",
          key: "inspect",
          label: "Inspector",
          status: "completed",
          reused: true,
          sessionId: "session-secret",
          runId: "run-secret",
          output: "private output",
          json: { private: true },
        },
      ],
    },
  ],
};

describe("Workflow run store", () => {
  it("stores metadata without task bodies, outputs, parameters, or process IDs", async () => {
    const cwd = await temporaryDirectory();
    const saved = await saveWorkflowRun(
      cwd,
      "work_metadata",
      "metadata",
      definition,
      result,
    );
    const text = await readFile(saved, "utf8");

    expect(text).toContain('"mode": "metadata"');
    for (const secret of [
      "Sensitive definition",
      "Inspector",
      "must-not-leak-in-metadata",
      "workflow.stage",
      "private task body",
      "private context",
      "private output",
      "session-secret",
      "run-secret",
    ]) {
      expect(text).not.toContain(secret);
    }
    await expect(loadWorkflowRun(cwd, "work_metadata")).resolves.toMatchObject({
      mode: "metadata",
      summary: {
        attempt: 2,
        sourceWorkId: "work_source",
        stages: [
          {
            reused: true,
            tasks: [{ key: "inspect", status: "completed", reused: true }],
          },
        ],
      },
    });
  });

  it("round-trips an explicitly full record for cross-session retry", async () => {
    const cwd = await temporaryDirectory();
    const saved = await saveWorkflowRun(
      cwd,
      "work_full",
      "full",
      definition,
      result,
    );

    expect(saved).toBe(
      path.join(cwd, ".pi", "workflow-runs", "work_full.json"),
    );
    expect(path.isAbsolute(workflowRunPath(cwd, "work_full"))).toBe(true);
    await expect(loadWorkflowRun(cwd, "work_full")).resolves.toEqual({
      version: 1,
      workId: "work_full",
      savedAt: expect.any(String),
      mode: "full",
      definition,
      result,
    });
  });

  it("rejects unsafe work IDs and corrupt or unsupported records", async () => {
    for (const workId of ["", "workflow_x", "work_../escape", "work_a/b"]) {
      expect(() => validateWorkflowRunWorkId(workId)).toThrow(TypeError);
    }

    const cwd = await temporaryDirectory();
    const directory = path.join(cwd, ".pi", "workflow-runs");
    await saveWorkflowRun(cwd, "work_seed", "metadata", definition, result);
    await writeFile(path.join(directory, "work_corrupt.json"), "{bad", "utf8");
    await writeFile(
      path.join(directory, "work_version.json"),
      JSON.stringify({ version: 2, workId: "work_version" }),
      "utf8",
    );

    await expect(loadWorkflowRun(cwd, "work_corrupt")).rejects.toThrow(
      SyntaxError,
    );
    await expect(loadWorkflowRun(cwd, "work_version")).rejects.toThrow(
      /header/,
    );
  });
});
