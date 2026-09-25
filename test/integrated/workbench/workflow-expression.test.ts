import { describe, expect, it } from "vitest";
import {
  evaluateWorkflowWhen,
  resolveWorkflowForeach,
  resolveWorkflowTemplate,
  type WorkflowExpressionContext,
} from "pi-tsien-subagent-workbench/src/workflow-expression.ts";

const context: WorkflowExpressionContext = {
  parameters: {
    country: "SG",
    enabled: true,
    retries: 2,
    empty: "",
    items: ["passport", "id-card"],
  },
  tasks: {
    collect: {
      output: JSON.stringify({ result: { count: 2, ok: true }, items: [1, 2] }),
      json: { result: { count: 2, ok: true }, items: [1, 2] },
    },
    summary: { output: "ready" },
    invalidJson: { output: "not-json" },
  },
};

describe("workflow expressions", () => {
  it("resolves parameter, task output, and task JSON templates", () => {
    expect(
      resolveWorkflowTemplate(
        "country={{parameters.country}} status={{tasks.summary.output}} count={{tasks.collect.json.result.count}}",
        context,
      ),
    ).toBe("country=SG status=ready count=2");

    expect(
      resolveWorkflowTemplate("{{parameters.retries}}", context),
    ).toBe("2");
    expect(
      resolveWorkflowTemplate("{{parameters.items}}", context, {
        preserveSingleReference: true,
      }),
    ).toBe(context.parameters.items);
  });

  it("evaluates omitted, boolean, truthy, falsey, and primitive comparisons", () => {
    expect(evaluateWorkflowWhen(undefined, context)).toBe(true);
    expect(evaluateWorkflowWhen(false, context)).toBe(false);
    expect(evaluateWorkflowWhen("{{parameters.enabled}}", context)).toBe(true);
    expect(evaluateWorkflowWhen("{{parameters.empty}}", context)).toBe(false);
    expect(
      evaluateWorkflowWhen('{{parameters.country}} == "SG"', context),
    ).toBe(true);
    expect(
      evaluateWorkflowWhen("{{tasks.collect.json.result.count}} != 3", context),
    ).toBe(true);
    expect(
      evaluateWorkflowWhen("{{tasks.collect.json.result.ok}} == true", context),
    ).toBe(true);
  });

  it("resolves foreach item and index without executing code", () => {
    expect(
      resolveWorkflowTemplate("inspect {{item}} at {{index}}", {
        ...context,
        item: { file: "README.md" },
        index: 3,
      }),
    ).toBe('inspect {"file":"README.md"} at 3');
  });

  it("returns foreach arrays without exposing the context array to mutation", () => {
    const items = resolveWorkflowForeach("{{parameters.items}}", context, 2);
    expect(items).toEqual(["passport", "id-card"]);
    expect(items).not.toBe(context.parameters.items);

    expect(
      resolveWorkflowForeach("{{tasks.collect.json.items}}", context, 2),
    ).toEqual([1, 2]);
  });

  it("rejects unknown references and invalid task JSON", () => {
    expect(() =>
      resolveWorkflowTemplate("{{parameters.missing}}", context),
    ).toThrow(TypeError);
    expect(() =>
      resolveWorkflowTemplate("{{tasks.missing.output}}", context),
    ).toThrow(/unknown reference/);
    expect(() =>
      resolveWorkflowTemplate("{{tasks.invalidJson.json.value}}", context),
    ).toThrow(/not valid JSON/);
  });

  it("rejects unsupported or malformed conditions", () => {
    for (const when of [
      "{{parameters.enabled}} && true",
      "({{parameters.enabled}})",
      "{{parameters.country}} == SG",
      "{{parameters.country}} == {}",
    ]) {
      expect(() => evaluateWorkflowWhen(when, context)).toThrow(TypeError);
    }
  });

  it("rejects foreach non-arrays and maxItems overflow", () => {
    expect(() =>
      resolveWorkflowForeach("{{parameters.country}}", context, 2),
    ).toThrow(/JSON array/);
    expect(() =>
      resolveWorkflowForeach("{{parameters.items}}", context, 1),
    ).toThrow(/exceeding maxItems 1/);
    expect(() =>
      resolveWorkflowForeach("{{parameters.items}}", context, -1),
    ).toThrow(/maxItems/);
  });

  it("rejects prototype-pollution paths at every reference level", () => {
    for (const template of [
      "{{parameters.__proto__}}",
      "{{parameters.constructor}}",
      "{{tasks.__proto__.output}}",
      "{{tasks.collect.json.__proto__.polluted}}",
      "{{tasks.collect.json.result.constructor}}",
    ]) {
      expect(() => resolveWorkflowTemplate(template, context)).toThrow(
        /unsafe or empty path/,
      );
    }
  });
});
