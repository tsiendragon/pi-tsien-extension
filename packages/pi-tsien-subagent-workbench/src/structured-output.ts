/**
 * 子代理结构化输出（outputSchema）。
 *
 * 两处共用：
 *   - `subagent_workflow` 的 task（已有行为）：完成后用 `parseStructuredOutput` 校验 JSON。
 *   - `subagent_start`（本次新增）：把 schema 附进子代理任务说明，要求它最终只回符合
 *     schema 的 JSON；结果回到主 agent 前用同一套逻辑校验，失败给出明确错误。
 *
 * 约定（fail-closed）：
 *   - schema 必须是 JSON Schema 对象、只含 JSON 值、≤ 16 KiB；
 *   - 允许整段 ```json 围栏，但除围栏外不接受夹杂解释文字（否则视为不合法）；
 *   - schema 本身不受 typebox 支持时抛出 "not a supported JSON Schema"，而不是当成通过。
 */
import type { TSchema } from "typebox";
import { Check, Errors } from "typebox/value";

export const OUTPUT_SCHEMA_MAX_BYTES = 16 * 1024;

/**
 * 附在任务说明末尾的要求。写给子代理看：只回 JSON、不要解释、不要围栏外的文字。
 */
export function structuredOutputInstruction(
  schema: Readonly<Record<string, unknown>>,
): string {
  return [
    "",
    "<structured_output_required>",
    "Your final message MUST be a single JSON value that validates against this JSON Schema:",
    JSON.stringify(schema),
    "Reply with the JSON only: no prose, no headings, no markdown fences around extra text.",
    "If a field cannot be filled, use null or omit it when the schema allows; never invent data.",
    "</structured_output_required>",
  ].join("\n");
}

/** 把 schema 要求拼进任务说明；没有 schema 时原样返回。 */
export function withStructuredOutputInstruction(
  task: string,
  schema: Readonly<Record<string, unknown>> | undefined,
): string {
  return schema === undefined ? task : `${task}\n${structuredOutputInstruction(schema)}`;
}

/** JSON Schema type names this validator understands (draft 2020-12 core + typebox). */
const JSON_SCHEMA_TYPES: ReadonlySet<string> = new Set([
  "null",
  "boolean",
  "object",
  "array",
  "number",
  "string",
  "integer",
]);

/**
 * 递归检查 schema 的结构。typebox 的 `Check` 对无法识别的关键字（例如
 * `{type:"weird"}`、拼错的 `properties.a.type`）会**静默返回 true**，等于把
 * 写错的 schema 当成了“什么都通过”。所以在这里 fail-closed：类型名必须是
 * 已知值、pattern 必须能编译、数组/数值类关键字形状必须正确。
 */
function assertSupportedSchemaShape(
  schema: unknown,
  location: string,
  seen = new WeakSet<object>(),
): void {
  if (typeof schema === "boolean") return; // boolean schema is legal JSON Schema
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
    throw new TypeError(`${location} must be a JSON Schema object or boolean.`);
  }
  if (seen.has(schema)) return;
  seen.add(schema);
  const record = schema as Record<string, unknown>;

  const type = record.type;
  if (type !== undefined) {
    const names = Array.isArray(type) ? type : [type];
    if (names.length === 0) {
      throw new TypeError(`${location}.type must not be empty.`);
    }
    for (const name of names) {
      if (typeof name !== "string" || !JSON_SCHEMA_TYPES.has(name)) {
        throw new TypeError(
          `${location}.type must be one of ${[...JSON_SCHEMA_TYPES].join("|")}; got ${JSON.stringify(name)}.`,
        );
      }
    }
  }

  if (record.pattern !== undefined) {
    if (typeof record.pattern !== "string") {
      throw new TypeError(`${location}.pattern must be a string.`);
    }
    try {
      new RegExp(record.pattern);
    } catch (cause) {
      throw new TypeError(`${location}.pattern is not a valid regular expression.`, {
        cause,
      });
    }
  }

  if (record.required !== undefined) {
    const required = record.required;
    if (
      !Array.isArray(required) ||
      required.some((name) => typeof name !== "string")
    ) {
      throw new TypeError(`${location}.required must be an array of strings.`);
    }
  }

  for (const key of ["minItems", "maxItems", "minLength", "maxLength"]) {
    const value = record[key];
    if (
      value !== undefined &&
      (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    ) {
      throw new TypeError(`${location}.${key} must be a non-negative integer.`);
    }
  }
  for (const key of ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"]) {
    const value = record[key];
    if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value))) {
      throw new TypeError(`${location}.${key} must be a finite number.`);
    }
  }

  const properties = record.properties;
  if (properties !== undefined) {
    if (typeof properties !== "object" || properties === null || Array.isArray(properties)) {
      throw new TypeError(`${location}.properties must be an object.`);
    }
    for (const [name, child] of Object.entries(properties)) {
      assertSupportedSchemaShape(child, `${location}.properties.${name}`, seen);
    }
  }

  const additional = record.additionalProperties;
  if (additional !== undefined && typeof additional !== "boolean") {
    assertSupportedSchemaShape(additional, `${location}.additionalProperties`, seen);
  }

  for (const key of ["items", "contains", "not", "if", "then", "else", "propertyNames"]) {
    const value = record[key];
    if (value !== undefined) assertSupportedSchemaShape(value, `${location}.${key}`, seen);
  }

  for (const key of ["allOf", "anyOf", "oneOf", "prefixItems"] as const) {
    const value = record[key];
    if (value === undefined) continue;
    if (!Array.isArray(value)) {
      throw new TypeError(`${location}.${key} must be an array of schemas.`);
    }
    value.forEach((child, index) =>
      assertSupportedSchemaShape(child, `${location}.${key}[${index}]`, seen),
    );
  }

  const patternProperties = record.patternProperties;
  if (patternProperties !== undefined) {
    if (
      typeof patternProperties !== "object" ||
      patternProperties === null ||
      Array.isArray(patternProperties)
    ) {
      throw new TypeError(`${location}.patternProperties must be an object.`);
    }
    for (const [pattern, child] of Object.entries(patternProperties)) {
      try {
        new RegExp(pattern);
      } catch (cause) {
        throw new TypeError(
          `${location}.patternProperties key ${JSON.stringify(pattern)} is not a valid regular expression.`,
          { cause },
        );
      }
      assertSupportedSchemaShape(child, `${location}.patternProperties[${pattern}]`, seen);
    }
  }

  const definitions = record.$defs ?? record.definitions;
  if (definitions !== undefined && typeof definitions === "object" && definitions !== null) {
    for (const [name, child] of Object.entries(definitions)) {
      assertSupportedSchemaShape(child, `${location}.$defs.${name}`, seen);
    }
  }
  seen.delete(schema);
}

/**
 * 校验一个 outputSchema 声明；合法时返回冻结的副本，非法时抛 TypeError。
 * 只做结构性检查（对象 / JSON 值 / 体积 / 类型名与关关键字形状）。
 */
export function assertOutputSchema(
  value: unknown,
  location = "outputSchema",
): Readonly<Record<string, unknown>> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new TypeError(`${location} must be a JSON Schema object.`);
  }
  assertJsonValue(value, location);
  const bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
  if (bytes > OUTPUT_SCHEMA_MAX_BYTES) {
    throw new TypeError(
      `${location} exceeds ${OUTPUT_SCHEMA_MAX_BYTES} bytes (got ${bytes}).`,
    );
  }
  assertSupportedSchemaShape(value, location);
  try {
    // Compile-once check: a schema typebox rejects must fail here, not silently pass.
    Check(value as TSchema, {});
  } catch (cause) {
    throw new TypeError(`${location} is not a supported JSON Schema.`, { cause });
  }
  return Object.freeze(structuredClone(value) as Record<string, unknown>);
}

/** 只允许有限数字、纯 JSON 对象/数组，拒绝原型污染键与循环。 */
export function assertJsonValue(
  value: unknown,
  location: string,
  seen = new WeakSet<object>(),
): void {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(`${location} must contain finite JSON numbers.`);
    }
    return;
  }
  if (typeof value !== "object") {
    throw new TypeError(`${location} must contain only JSON values.`);
  }
  if (seen.has(value)) throw new TypeError(`${location} must not contain cycles.`);
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      assertJsonValue(item, `${location}[${index}]`, seen),
    );
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`${location} must contain only plain JSON objects.`);
    }
    for (const [key, item] of Object.entries(value)) {
      if (["__proto__", "prototype", "constructor"].includes(key)) {
        throw new TypeError(`${location} contains a forbidden key: ${key}.`);
      }
      assertJsonValue(item, `${location}.${key}`, seen);
    }
  }
  seen.delete(value);
}

/** 去掉唯一一层 ```json 围栏；其它情况原样返回并让 JSON.parse 去判定。 */
export function unfenceJson(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i);
  return fenced ? fenced[1]!.trim() : trimmed;
}

export interface StructuredOutputFailure {
  readonly ok: false;
  /** 面向主 agent 的一句话原因，明确指出是 JSON 还是 schema 不匹配。 */
  readonly error: string;
  /** 便于程序分支的机器码。 */
  readonly code: "invalid_json" | "unsupported_schema" | "schema_mismatch";
  /** 前几条校验错误（有的话），用于快速定位字段。 */
  readonly issues?: readonly string[];
}

export interface StructuredOutputSuccess {
  readonly ok: true;
  readonly value: unknown;
}

export type StructuredOutputResult =
  | StructuredOutputSuccess
  | StructuredOutputFailure;

function firstIssues(schema: TSchema, value: unknown, limit = 5): string[] {
  try {
    const issues: string[] = [];
    for (const issue of Errors(schema, value)) {
      const path = issue.instancePath || "(root)";
      issues.push(`${path}: ${issue.message}`);
      if (issues.length >= limit) break;
    }
    return issues;
  } catch {
    return [];
  }
}

/**
 * 校验子代理的最终输出。不抛异常，返回结构化结果，便于调用方决定
 * 是标成 failed 还是把错误原样回给主 agent。
 */
export function validateStructuredOutput(
  output: string,
  schema: Readonly<Record<string, unknown>>,
): StructuredOutputResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(unfenceJson(output));
  } catch (cause) {
    return {
      ok: false,
      code: "invalid_json",
      error: `Subagent output is not valid JSON for outputSchema: ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }
  let matches: boolean;
  try {
    // Re-validate shape: a stored/older schema may predate assertOutputSchema.
    assertSupportedSchemaShape(schema, "outputSchema");
    matches = Check(schema as TSchema, parsed);
  } catch (cause) {
    return {
      ok: false,
      code: "unsupported_schema",
      error: `outputSchema is not a supported JSON Schema: ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }
  if (matches) return { ok: true, value: parsed };
  const issues = firstIssues(schema as TSchema, parsed);
  return {
    ok: false,
    code: "schema_mismatch",
    error:
      "Subagent JSON output does not match outputSchema." +
      (issues.length ? ` First violations: ${issues.join("; ")}` : ""),
    ...(issues.length ? { issues } : {}),
  };
}

/**
 * 校验失败时重构出来的子代理结果：保留原始文本、usage 与会话信息，
 * 只把 isError 置为 true 并给出明确 errorMessage，绝不静默放过。
 */
export interface StructuredFailureText {
  readonly output: string;
  readonly errorMessage: string;
}