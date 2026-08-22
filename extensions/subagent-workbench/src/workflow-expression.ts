export type WorkflowJsonPrimitive = string | number | boolean | null;

export interface WorkflowExpressionTaskResult {
  readonly output: unknown;
}

export interface WorkflowExpressionContext {
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly tasks: Readonly<Record<string, WorkflowExpressionTaskResult>>;
}

export interface ResolveWorkflowTemplateOptions {
  /** Return the referenced value unchanged when the whole template is one reference. */
  readonly preserveSingleReference?: boolean;
}

export type WorkflowWhenExpression = boolean | string | undefined;

const TEMPLATE = /{{\s*([^{}]+?)\s*}}/g;
const SINGLE_TEMPLATE = /^{{\s*([^{}]+?)\s*}}$/;
const COMPARISON = /^({{\s*[^{}]+?\s*}})\s*(==|!=)\s*(.+)$/s;
const FORBIDDEN_PATH_SEGMENTS = new Set([
  "__proto__",
  "prototype",
  "constructor",
]);

function expressionError(message: string): TypeError {
  return new TypeError(`Invalid workflow expression: ${message}`);
}

function assertSafeSegments(reference: string, segments: readonly string[]): void {
  if (
    segments.some(
      (segment) => !segment || FORBIDDEN_PATH_SEGMENTS.has(segment),
    )
  ) {
    throw expressionError(`unsafe or empty path in reference "${reference}".`);
  }
}

function ownValue(
  container: unknown,
  key: string,
  reference: string,
): unknown {
  if (
    (typeof container !== "object" || container === null) &&
    typeof container !== "function"
  ) {
    throw expressionError(`unknown reference "${reference}".`);
  }
  if (!Object.prototype.hasOwnProperty.call(container, key)) {
    throw expressionError(`unknown reference "${reference}".`);
  }
  return (container as Record<string, unknown>)[key];
}

function parseTaskJson(output: unknown, reference: string): unknown {
  if (typeof output !== "string") {
    throw expressionError(
      `task JSON source for "${reference}" must be a JSON string.`,
    );
  }
  try {
    return JSON.parse(output) as unknown;
  } catch {
    throw expressionError(`task output for "${reference}" is not valid JSON.`);
  }
}

export function resolveWorkflowReference(
  reference: string,
  context: WorkflowExpressionContext,
): unknown {
  const normalized = reference.trim();
  const segments = normalized.split(".");
  assertSafeSegments(normalized, segments);

  if (segments[0] === "parameters" && segments.length === 2) {
    return ownValue(context.parameters, segments[1]!, normalized);
  }

  if (segments[0] === "tasks" && segments.length >= 3) {
    const task = ownValue(context.tasks, segments[1]!, normalized) as
      | WorkflowExpressionTaskResult
      | undefined;
    if (typeof task !== "object" || task === null) {
      throw expressionError(`unknown reference "${normalized}".`);
    }
    const output = ownValue(task, "output", normalized);
    if (segments[2] === "output" && segments.length === 3) return output;
    if (segments[2] !== "json" || segments.length < 4) {
      throw expressionError(`unsupported reference "${normalized}".`);
    }

    let value = parseTaskJson(output, normalized);
    for (const segment of segments.slice(3)) {
      value = ownValue(value, segment, normalized);
    }
    return value;
  }

  throw expressionError(`unsupported reference "${normalized}".`);
}

function stringifyTemplateValue(value: unknown): string {
  return String(value);
}

export function resolveWorkflowTemplate(
  template: string,
  context: WorkflowExpressionContext,
  options: ResolveWorkflowTemplateOptions = {},
): unknown {
  if (typeof template !== "string") {
    throw expressionError("template must be a string.");
  }

  const single = SINGLE_TEMPLATE.exec(template);
  if (single && options.preserveSingleReference) {
    return resolveWorkflowReference(single[1]!, context);
  }

  TEMPLATE.lastIndex = 0;
  const resolved = template.replace(TEMPLATE, (_match, reference: string) =>
    stringifyTemplateValue(resolveWorkflowReference(reference, context)),
  );
  TEMPLATE.lastIndex = 0;
  if (resolved.includes("{{") || resolved.includes("}}")) {
    throw expressionError("malformed template.");
  }
  return resolved;
}

function parseJsonPrimitive(literal: string): WorkflowJsonPrimitive {
  let value: unknown;
  try {
    value = JSON.parse(literal) as unknown;
  } catch {
    throw expressionError(
      `condition literal ${JSON.stringify(literal)} is not valid JSON.`,
    );
  }
  if (
    value !== null &&
    typeof value !== "string" &&
    typeof value !== "number" &&
    typeof value !== "boolean"
  ) {
    throw expressionError("condition comparison requires a JSON primitive literal.");
  }
  return value;
}

export function evaluateWorkflowWhen(
  when: WorkflowWhenExpression,
  context: WorkflowExpressionContext,
): boolean {
  if (when === undefined) return true;
  if (typeof when === "boolean") return when;
  if (typeof when !== "string") {
    throw expressionError("when must be omitted, a boolean, or a string.");
  }

  const expression = when.trim();
  if (expression === "true") return true;
  if (expression === "false") return false;

  const single = SINGLE_TEMPLATE.exec(expression);
  if (single) return Boolean(resolveWorkflowReference(single[1]!, context));

  const comparison = COMPARISON.exec(expression);
  if (comparison) {
    const left = resolveWorkflowTemplate(comparison[1]!, context, {
      preserveSingleReference: true,
    });
    const right = parseJsonPrimitive(comparison[3]!.trim());
    return comparison[2] === "==" ? left === right : left !== right;
  }

  throw expressionError(
    "when supports only booleans, one template reference, or ==/!= with a JSON primitive literal.",
  );
}

export function resolveWorkflowForeach(
  foreach: string,
  context: WorkflowExpressionContext,
  maxItems: number,
): unknown[] {
  if (!Number.isSafeInteger(maxItems) || maxItems < 0) {
    throw expressionError("maxItems must be a non-negative safe integer.");
  }
  const value = resolveWorkflowTemplate(foreach, context, {
    preserveSingleReference: true,
  });
  if (!Array.isArray(value)) {
    throw expressionError("foreach must resolve to a JSON array.");
  }
  if (value.length > maxItems) {
    throw expressionError(
      `foreach resolved to ${value.length} items, exceeding maxItems ${maxItems}.`,
    );
  }
  return [...value];
}
