import { describe, expect, it } from "vitest";
import {
  CompletionDedupe,
  assertExecutionBudget,
  assertExactModelReference,
  assertResultBudget,
  resultPreview,
  roleToolNames,
} from "../../../packages/pi-tsien-subagent-workbench/src/runner-stage.ts";

describe("runner stage", () => {
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
