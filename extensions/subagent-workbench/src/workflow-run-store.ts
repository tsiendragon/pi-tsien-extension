import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { WorkbenchWorkflowResult } from "./workbench-controller.ts";
import type { SavedWorkflowDefinition } from "./workflow-store.ts";

export const WORKFLOW_RUN_VERSION = 1 as const;
export type WorkflowRunMode = "metadata" | "full";

export interface WorkflowRunTaskMetadata {
  readonly key: string;
  readonly status: string;
  readonly reused?: boolean;
}

export interface WorkflowRunStageMetadata {
  readonly status: string;
  readonly reused?: boolean;
  readonly tasks: readonly WorkflowRunTaskMetadata[];
}

export interface WorkflowRunSummary {
  readonly workflowId: string;
  readonly status: string;
  readonly attempt: number;
  readonly sourceWorkId?: string;
  readonly resumedFromStage?: number;
  readonly stages: readonly WorkflowRunStageMetadata[];
}

interface WorkflowRunBase {
  readonly version: typeof WORKFLOW_RUN_VERSION;
  readonly workId: string;
  readonly savedAt: string;
  readonly mode: WorkflowRunMode;
}

export interface MetadataWorkflowRunRecord extends WorkflowRunBase {
  readonly mode: "metadata";
  readonly summary: WorkflowRunSummary;
}

export interface FullWorkflowRunRecord extends WorkflowRunBase {
  readonly mode: "full";
  readonly definition: SavedWorkflowDefinition;
  readonly result: WorkbenchWorkflowResult;
}

export type WorkflowRunRecord =
  | MetadataWorkflowRunRecord
  | FullWorkflowRunRecord;

const WORK_ID = /^work_[A-Za-z0-9_-]{1,80}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateWorkflowRunWorkId(workId: string): string {
  if (typeof workId !== "string" || !WORK_ID.test(workId)) {
    throw new TypeError(
      "Workflow run workId must match work_[A-Za-z0-9_-]{1,80}.",
    );
  }
  return workId;
}

export function workflowRunPath(cwd: string, workId: string): string {
  return path.resolve(
    cwd,
    ".pi",
    "workflow-runs",
    `${validateWorkflowRunWorkId(workId)}.json`,
  );
}

function runSummary(result: WorkbenchWorkflowResult): WorkflowRunSummary {
  return {
    workflowId: result.workflowId,
    status: result.status,
    attempt: result.attempt,
    ...(result.sourceWorkId ? { sourceWorkId: result.sourceWorkId } : {}),
    ...(result.resumedFromStage === undefined
      ? {}
      : { resumedFromStage: result.resumedFromStage }),
    stages: result.stages.map((stage) => ({
      status: stage.status,
      ...(stage.reused ? { reused: true } : {}),
      tasks: stage.tasks.map((task) => ({
        key: task.key,
        status: task.status,
        ...(task.reused ? { reused: true } : {}),
      })),
    })),
  };
}

function assertSummary(value: unknown): asserts value is WorkflowRunSummary {
  if (
    !isRecord(value) ||
    typeof value.workflowId !== "string" ||
    typeof value.status !== "string" ||
    !Number.isSafeInteger(value.attempt) ||
    !Array.isArray(value.stages)
  ) {
    throw new TypeError("Workflow run summary is invalid.");
  }
  for (const stage of value.stages) {
    if (
      !isRecord(stage) ||
      typeof stage.status !== "string" ||
      !Array.isArray(stage.tasks)
    ) {
      throw new TypeError("Workflow run Stage metadata is invalid.");
    }
    for (const task of stage.tasks) {
      if (
        !isRecord(task) ||
        typeof task.key !== "string" ||
        typeof task.status !== "string"
      ) {
        throw new TypeError("Workflow run task metadata is invalid.");
      }
    }
  }
}

function assertFullDefinition(
  value: unknown,
): asserts value is SavedWorkflowDefinition {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !Array.isArray(value.stages) ||
    value.stages.length === 0
  ) {
    throw new TypeError("Full Workflow run definition is invalid.");
  }
}

function assertFullResult(value: unknown): asserts value is WorkbenchWorkflowResult {
  if (!isRecord(value)) throw new TypeError("Full Workflow result is invalid.");
  assertSummary(value);
}

function assertWorkflowRunRecord(
  value: unknown,
  expectedWorkId: string,
): asserts value is WorkflowRunRecord {
  if (
    !isRecord(value) ||
    value.version !== WORKFLOW_RUN_VERSION ||
    value.workId !== expectedWorkId ||
    typeof value.savedAt !== "string" ||
    Number.isNaN(Date.parse(value.savedAt))
  ) {
    throw new TypeError("Workflow run record header is invalid.");
  }
  if (value.mode === "metadata") {
    assertSummary(value.summary);
    return;
  }
  if (value.mode === "full") {
    assertFullDefinition(value.definition);
    assertFullResult(value.result);
    return;
  }
  throw new TypeError("Workflow run mode is invalid.");
}

export async function saveWorkflowRun(
  cwd: string,
  workId: string,
  mode: WorkflowRunMode,
  definition: SavedWorkflowDefinition,
  result: WorkbenchWorkflowResult,
): Promise<string> {
  validateWorkflowRunWorkId(workId);
  if (mode !== "metadata" && mode !== "full") {
    throw new TypeError("Workflow run mode must be metadata or full.");
  }
  const destination = workflowRunPath(cwd, workId);
  const directory = path.dirname(destination);
  const temporary = path.join(
    directory,
    `.${workId}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
  );
  const savedAt = new Date().toISOString();
  const record: WorkflowRunRecord =
    mode === "full"
      ? {
          version: WORKFLOW_RUN_VERSION,
          workId,
          savedAt,
          mode,
          definition,
          result,
        }
      : {
          version: WORKFLOW_RUN_VERSION,
          workId,
          savedAt,
          mode,
          summary: runSummary(result),
        };
  await mkdir(directory, { recursive: true });
  try {
    await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, {
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

export async function loadWorkflowRun(
  cwd: string,
  workId: string,
): Promise<WorkflowRunRecord> {
  const validatedWorkId = validateWorkflowRunWorkId(workId);
  const source = workflowRunPath(cwd, validatedWorkId);
  const text = await readFile(source, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new SyntaxError(`Invalid Workflow run JSON: ${source}`, { cause });
  }
  assertWorkflowRunRecord(parsed, validatedWorkId);
  return parsed;
}
