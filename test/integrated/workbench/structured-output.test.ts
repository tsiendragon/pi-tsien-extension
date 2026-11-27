import { describe, expect, it } from "vitest";

import {
  assertOutputSchema,
  structuredOutputInstruction,
  unfenceJson,
  validateStructuredOutput,
  withStructuredOutputInstruction,
} from "pi-tsien-subagent-workbench/src/structured-output.ts";

describe("structured output: schema validation", () => {
  const schema = {
    type: "object",
    properties: { country: { type: "string" }, valid: { type: "boolean" } },
    required: ["country", "valid"],
    additionalProperties: false,
  };

  it("accepts matching JSON, with or without a json fence", () => {
    expect(validateStructuredOutput('{"country":"IQ","valid":true}', schema)).toEqual({
      ok: true,
      value: { country: "IQ", valid: true },
    });
    expect(
      validateStructuredOutput('```json\n{"country":"IQ","valid":true}\n```', schema),
    ).toEqual({ ok: true, value: { country: "IQ", valid: true } });
  });

  it("reports schema mismatches with field paths instead of passing them", () => {
    const result = validateStructuredOutput('{"country":"IQ","valid":"yes"}', schema);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.code).toBe("schema_mismatch");
    expect(result.error).toContain("does not match outputSchema");
    // The violation must name the offending field, not just "mismatch".
    expect(result.error).toContain("/valid");
    expect(result.issues?.[0]).toContain("/valid");
  });

  it("rejects non-JSON output and prose around the JSON", () => {
    const plain = validateStructuredOutput("Here you go: everything passed", schema);
    expect(plain).toMatchObject({ ok: false, code: "invalid_json" });
    const chatty = validateStructuredOutput(
      'Sure!\n{"country":"IQ","valid":true}',
      schema,
    );
    expect(chatty).toMatchObject({ ok: false, code: "invalid_json" });
  });

  it("refuses unsupported schemas and oversized or non-object declarations", () => {
    expect(validateStructuredOutput("{}", { type: "nonsense" })).toMatchObject({
      ok: false,
      code: "unsupported_schema",
    });
    expect(() => assertOutputSchema([], "outputSchema")).toThrow(
      "outputSchema must be a JSON Schema object.",
    );
    expect(() => assertOutputSchema(undefined, "outputSchema")).toThrow(
      "outputSchema must be a JSON Schema object.",
    );
    expect(() => assertOutputSchema({ type: "string", x: "y".repeat(17 * 1024) })).toThrow(
      "exceeds",
    );
    expect(() => assertOutputSchema({ type: "object", bad: NaN })).toThrow(
      "finite JSON numbers",
    );
    expect(() => assertOutputSchema({ type: "object", ["__proto__"]: { a: 1 } })).toThrow(
      "forbidden key",
    );
  });

  it("returns a frozen clone so later mutation cannot weaken the check", () => {
    const source = { type: "object", properties: { a: { type: "string" } } };
    const frozen = assertOutputSchema(source);
    expect(Object.isFrozen(frozen)).toBe(true);
    source.properties.a.type = "number";
    expect(frozen).toEqual({ type: "object", properties: { a: { type: "string" } } });
  });

  it("appends the JSON-only requirement to the task and keeps the original text", () => {
    expect(withStructuredOutputInstruction("do the work", undefined)).toBe("do the work");
    const withSchema = withStructuredOutputInstruction("do the work", schema);
    expect(withSchema.startsWith("do the work")).toBe(true);
    expect(withSchema).toContain("<structured_output_required>");
    expect(withSchema).toContain(JSON.stringify(schema));
    expect(withSchema).toContain("Reply with the JSON only");
    expect(structuredOutputInstruction(schema)).toContain("MUST be a single JSON value");
  });

  it("unfences only a single whole-message code fence", () => {
    expect(unfenceJson('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(unfenceJson(' {"a":1} ')).toBe('{"a":1}');
    expect(unfenceJson('```json\n{"a":1}\n```\nmore')).toContain("more");
  });
});