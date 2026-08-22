import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentThinkingLevel } from "./subagent-service.ts";

export const SAVED_WORKFLOW_VERSION = 1 as const;

export interface SavedWorkflowTask {
  readonly key?: string;
  readonly task: string;
  readonly label?: string;
  readonly cwd?: string;
  readonly model?: string;
  readonly thinking?: AgentThinkingLevel;
  readonly context?: string;
  readonly inputs?: readonly string[];
  readonly outputSchema?: Readonly<Record<string, unknown>>;
  readonly when?: boolean | string;
  readonly foreach?: string;
  readonly maxItems?: number;
}

export interface SavedWorkflowStage {
  readonly label?: string;
  readonly tasks: readonly SavedWorkflowTask[];
}

export interface SavedWorkflowDefinition {
  readonly version: typeof SAVED_WORKFLOW_VERSION;
  readonly label?: string;
  readonly parameters?: Readonly<Record<string, unknown>>;
  readonly stages: readonly SavedWorkflowStage[];
}

const WORKFLOW_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const THINKING_LEVELS = new Set<AgentThinkingLevel>([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertOptionalString(
  record: Record<string, unknown>,
  field: string,
  location: string,
): void {
  if (record[field] !== undefined && typeof record[field] !== "string") {
    throw new TypeError(`${location}.${field} must be a string.`);
  }
}

function assertJsonValue(
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
    for (const [key, item] of Object.entries(value)) {
      if (["__proto__", "prototype", "constructor"].includes(key)) {
        throw new TypeError(`${location} contains a forbidden key: ${key}.`);
      }
      assertJsonValue(item, `${location}.${key}`, seen);
    }
  }
  seen.delete(value);
}

function assertJsonRecord(value: unknown, location: string): void {
  if (!isRecord(value)) throw new TypeError(`${location} must be a JSON object.`);
  assertJsonValue(value, location);
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > 16 * 1024) {
    throw new TypeError(`${location} exceeds 16 KiB.`);
  }
}

function assertTask(value: unknown, location: string): asserts value is SavedWorkflowTask {
  if (!isRecord(value)) throw new TypeError(`${location} must be an object.`);
  if (typeof value.task !== "string" || !value.task.trim()) {
    throw new TypeError(`${location}.task must be a non-empty string.`);
  }

  for (const field of [
    "key",
    "label",
    "cwd",
    "model",
    "context",
    "foreach",
  ] as const) {
    assertOptionalString(value, field, location);
  }

  if (
    value.thinking !== undefined &&
    (typeof value.thinking !== "string" ||
      !THINKING_LEVELS.has(value.thinking as AgentThinkingLevel))
  ) {
    throw new TypeError(`${location}.thinking is invalid.`);
  }
  if (
    value.inputs !== undefined &&
    (!Array.isArray(value.inputs) ||
      value.inputs.some((input) => typeof input !== "string"))
  ) {
    throw new TypeError(`${location}.inputs must be an array of strings.`);
  }
  if (
    value.when !== undefined &&
    typeof value.when !== "boolean" &&
    typeof value.when !== "string"
  ) {
    throw new TypeError(`${location}.when must be a boolean or string.`);
  }
  if (
    value.foreach !== undefined &&
    (typeof value.foreach !== "string" || !value.foreach.trim())
  ) {
    throw new TypeError(`${location}.foreach must not be empty.`);
  }
  if (
    value.maxItems !== undefined &&
    (typeof value.maxItems !== "number" ||
      !Number.isSafeInteger(value.maxItems) ||
      value.maxItems < 0 ||
      value.maxItems > 8)
  ) {
    throw new TypeError(`${location}.maxItems must be between zero and eight.`);
  }
  if (value.maxItems !== undefined && value.foreach === undefined) {
    throw new TypeError(`${location}.maxItems requires foreach.`);
  }
  if (value.outputSchema !== undefined) {
    assertJsonRecord(value.outputSchema, `${location}.outputSchema`);
  }
}

function assertWorkflowDefinition(
  value: unknown,
): asserts value is SavedWorkflowDefinition {
  if (!isRecord(value)) {
    throw new TypeError("Workflow definition must be an object.");
  }
  if (value.version !== SAVED_WORKFLOW_VERSION) {
    throw new TypeError(
      `Unsupported workflow definition version: ${String(value.version)}.`,
    );
  }
  assertOptionalString(value, "label", "workflow");
  if (value.parameters !== undefined) {
    assertJsonRecord(value.parameters, "workflow.parameters");
  }
  if (!Array.isArray(value.stages) || value.stages.length === 0) {
    throw new TypeError("Workflow definition requires at least one stage.");
  }

  value.stages.forEach((stage, stageIndex) => {
    const location = `workflow.stages[${stageIndex}]`;
    if (!isRecord(stage)) throw new TypeError(`${location} must be an object.`);
    assertOptionalString(stage, "label", location);
    if (!Array.isArray(stage.tasks) || stage.tasks.length === 0) {
      throw new TypeError(`${location} requires at least one task.`);
    }
    stage.tasks.forEach((task, taskIndex) =>
      assertTask(task, `${location}.tasks[${taskIndex}]`),
    );
  });
}

export function validateWorkflowName(name: string): string {
  if (typeof name !== "string" || !WORKFLOW_NAME.test(name)) {
    throw new TypeError(
      "Workflow name must match [A-Za-z0-9][A-Za-z0-9_-]{0,63}.",
    );
  }
  return name;
}

export function workflowDefinitionPath(cwd: string, name: string): string {
  return path.resolve(cwd, ".pi", "workflows", `${validateWorkflowName(name)}.json`);
}

export async function saveWorkflowDefinition(
  cwd: string,
  name: string,
  definition: SavedWorkflowDefinition,
): Promise<string> {
  assertWorkflowDefinition(definition);
  const destination = workflowDefinitionPath(cwd, name);
  const directory = path.dirname(destination);
  const temporary = path.join(
    directory,
    `.${name}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
  );
  await mkdir(directory, { recursive: true });

  try {
    await writeFile(temporary, `${JSON.stringify(definition, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    await rename(temporary, destination);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }

  return destination;
}

export async function loadWorkflowDefinition(
  cwd: string,
  name: string,
): Promise<SavedWorkflowDefinition> {
  const source = workflowDefinitionPath(cwd, name);
  const text = await readFile(source, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new SyntaxError(`Invalid workflow JSON: ${source}`, { cause });
  }
  assertWorkflowDefinition(parsed);
  return parsed;
}
