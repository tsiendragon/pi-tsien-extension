import { describe, expect, it } from "vitest";
import {
  CompletionDedupe,
  DEFAULT_EXECUTION_MODEL,
  assertExecutionBudget,
  assertExactModelReference,
  assertResultBudget,
  executionDefaultModel,
  resultPreview,
  roleToolNames,
  selectExecution,
} from "../../../packages/pi-tsien-subagent-workbench/src/runner-stage.ts";

describe("runner stage", () => {
  it("selects task, workflow, and default models without implicit inheritance", () => {
    expect(selectExecution({ taskModel: "p/task", workflowModel: "p/workflow" })).toMatchObject({ model: "p/task", modelSource: "task", thinking: "medium" });
    expect(selectExecution({ workflowModel: "p/workflow" })).toMatchObject({ model: "p/workflow", modelSource: "workflow" });
    expect(selectExecution({ parentModel: "p/parent" })).toMatchObject({ model: DEFAULT_EXECUTION_MODEL, modelSource: "default" });
    expect(selectExecution({ parentModel: "p/parent", inheritModel: true })).toMatchObject({ model: "p/parent", modelSource: "inherited" });
    expect(executionDefaultModel({ PI_SUBAGENT_EXECUTION_MODEL: "azure-gateway/gpt-5.6-luna" })).toBe("azure-gateway/gpt-5.6-luna");
  });

  it("fails instead of truncating input or result budgets", () => {
    expect(() => assertExecutionBudget("x", "y", ["z"], 2)).toThrow(/input budget exceeded/);
    expect(() => assertResultBudget("😀", 1)).toThrow(/result budget exceeded/);
    expect(() => assertExactModelReference("gpt-5")).toThrow(/exact provider\/model/);
  });

  it("keeps role policy and result collection bounded", () => {
    expect(roleToolNames("read_only")).not.toContain("bash");
    expect(resultPreview("abcdef", 3)).toEqual({ resultPreview: "abc…", resultTruncated: true });
    const dedupe = new CompletionDedupe();
    expect(dedupe.claim("root:w:1")).toBe(true);
    expect(dedupe.claim("root:w:1")).toBe(false);
  });
});
