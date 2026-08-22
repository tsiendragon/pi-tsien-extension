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
}

export interface SavedWorkflowStage {
  readonly label?: string;
  readonly tasks: readonly SavedWorkflowTask[];
}

export interface SavedWorkflowDefinition {
  readonly version: typeof SAVED_WORKFLOW_VERSION;
  readonly label?: string;
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

function assertTask(value: unknown, location: string): asserts value is SavedWorkflowTask {
  if (!isRecord(value)) throw new TypeError(`${location} must be an object.`);
  if (typeof value.task !== "string" || !value.task.trim()) {
    throw new TypeError(`${location}.task must be a non-empty string.`);
  }

  for (const field of ["key", "label", "cwd", "model", "context"] as const) {
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
