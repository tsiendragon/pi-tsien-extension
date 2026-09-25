import { describe, expect, it } from "vitest";
import {
  compileWorkflowJavaScript,
  MAX_WORKFLOW_JAVASCRIPT_BYTES,
} from "pi-tsien-subagent-workbench/src/workflow-javascript.ts";

describe("Workflow JavaScript compiler", () => {
  it("compiles a bounded synchronous builder into persisted stages", () => {
    const definition = compileWorkflowJavaScript(
      `
        const stage = workflow.stage("Inspect");
        for (const file of parameters.files) {
          stage.task({ key: file.replace(".", "_"), task: "Inspect " + file });
        }
      `,
      { files: ["a.ts", "b.ts"] },
    );

    expect(definition).toEqual({
      version: 1,
      parameters: { files: ["a.ts", "b.ts"] },
      stages: [
        {
          label: "Inspect",
          tasks: [
            { key: "a_ts", task: "Inspect a.ts" },
            { key: "b_ts", task: "Inspect b.ts" },
          ],
        },
      ],
    });
  });

  it("rejects host access, asynchronous code, and oversized source", () => {
    expect(() => compileWorkflowJavaScript("process.cwd()")).toThrow(
      /cannot use process/,
    );
    expect(() => compileWorkflowJavaScript("return Promise.resolve()"))
      .toThrow(/cannot use Promise/);
    expect(() => compileWorkflowJavaScript("x".repeat(MAX_WORKFLOW_JAVASCRIPT_BYTES + 1)))
      .toThrow(/exceeds/);
  });
});
