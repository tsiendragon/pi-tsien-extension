import { Script, createContext } from "node:vm";
import {
  SAVED_WORKFLOW_VERSION,
  type SavedWorkflowDefinition,
  type SavedWorkflowStage,
  type SavedWorkflowTask,
} from "./workflow-store.ts";

export const MAX_WORKFLOW_JAVASCRIPT_BYTES = 16 * 1024;
const MAX_STAGES = 8;
const MAX_TASKS_PER_STAGE = 8;
const FORBIDDEN_JAVASCRIPT = /\b(?:async|await|Promise|import|require|process|globalThis|global|Function|eval|WebAssembly|setTimeout|setInterval|queueMicrotask)\b/;

interface WorkflowBuilder {
  stage(label?: string): {
    task(task: SavedWorkflowTask): void;
  };
}

function cloneJson<T>(value: T, location: string): T {
  let text: string | undefined;
  try {
    text = JSON.stringify(value);
  } catch (error) {
    throw new TypeError(`${location} must be JSON-serializable.`, { cause: error });
  }
  if (text === undefined) {
    throw new TypeError(`${location} must be JSON-serializable.`);
  }
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new TypeError(`${location} must be valid JSON.`, { cause: error });
  }
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child);
  }
  return value;
}

/**
 * Compiles a trusted, temporary JavaScript plan into the normal persisted
 * Workflow definition. The script is a synchronous builder only: it has no
 * filesystem, process, network, timer, import, or agent-execution capability.
 */
export function compileWorkflowJavaScript(
  source: string,
  parameters?: Readonly<Record<string, unknown>>,
): SavedWorkflowDefinition {
  if (typeof source !== "string" || !source.trim()) {
    throw new TypeError("Workflow javascript must be a non-empty string.");
  }
  if (Buffer.byteLength(source, "utf8") > MAX_WORKFLOW_JAVASCRIPT_BYTES) {
    throw new TypeError(
      `Workflow javascript exceeds ${MAX_WORKFLOW_JAVASCRIPT_BYTES} bytes.`,
    );
  }
  const forbidden = source.match(FORBIDDEN_JAVASCRIPT)?.[0];
  if (forbidden) {
    throw new TypeError(
      `Workflow javascript cannot use ${forbidden}; it may only build stages and tasks synchronously.`,
    );
  }

  const stages: SavedWorkflowStage[] = [];
  const workflow: WorkflowBuilder = Object.freeze({
    stage(label?: string) {
      if (label !== undefined && typeof label !== "string") {
        throw new TypeError("workflow.stage(label) requires a string label.");
      }
      if (stages.length >= MAX_STAGES) {
        throw new TypeError(`Workflow javascript can create at most ${MAX_STAGES} stages.`);
      }
      const tasks: SavedWorkflowTask[] = [];
      stages.push({ ...(label?.trim() ? { label: label.trim() } : {}), tasks });
      return Object.freeze({
        task(task: SavedWorkflowTask): void {
          if (tasks.length >= MAX_TASKS_PER_STAGE) {
            throw new TypeError(
              `Workflow javascript can create at most ${MAX_TASKS_PER_STAGE} tasks per stage.`,
            );
          }
          tasks.push(cloneJson(task, "workflow.stage().task"));
        },
      });
    },
  });
  const safeParameters = deepFreeze(cloneJson(parameters ?? {}, "parameters"));
  const sandbox = Object.create(null) as Record<string, unknown>;
  sandbox.__workflowInput = Object.freeze({
    parameters: safeParameters,
    workflow,
  });
  const context = createContext(sandbox, {
    name: "subagent-workbench-workflow-plan",
    codeGeneration: { strings: false, wasm: false },
    microtaskMode: "afterEvaluate",
  });
  const script = new Script(
    `"use strict"; (function ({ parameters, workflow }) {\n${source}\n})(__workflowInput);`,
    { filename: "workflow-plan.js" },
  );
  const returned = script.runInContext(context, { timeout: 50 });
  if (returned && typeof (returned as { then?: unknown }).then === "function") {
    throw new TypeError("Workflow javascript must be synchronous.");
  }
  if (stages.length === 0) {
    throw new TypeError("Workflow javascript must create at least one stage.");
  }
  if (stages.some((stage) => stage.tasks.length === 0)) {
    throw new TypeError("Workflow javascript cannot create an empty stage.");
  }

  return {
    version: SAVED_WORKFLOW_VERSION,
    parameters: safeParameters,
    stages: cloneJson(stages, "Workflow javascript result"),
  };
}
