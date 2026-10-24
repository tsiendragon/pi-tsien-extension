import type { AgentThinkingLevel } from "./subagent-service.ts";

export const DEFAULT_EXECUTION_THINKING: AgentThinkingLevel = "medium";
export const DEFAULT_MAX_INPUT_BUDGET_BYTES = 9 * 1024 * 1024;
export const DEFAULT_MAX_RESULT_BYTES = 8 * 1024 * 1024;
export const DEFAULT_RESULT_PREVIEW_CHARS = 2_000;

export type ExecutionRole = "read_only" | "code" | "research";

export function assertExactModelReference(model: string, field = "model"): void {
  if (!/^[^/\s]+\/\S+$/.test(model)) {
    throw new Error(`${field} must be an exact provider/model reference; no fallback is available.`);
  }
}

export function executionInputBytes(
  task: string,
  context?: string,
  workflowInputs: readonly string[] = [],
): number {
  return Buffer.byteLength(
    [task, context ?? "", ...workflowInputs].filter(Boolean).join("\n"),
    "utf8",
  );
}

export function assertExecutionBudget(
  task: string,
  context: string | undefined,
  workflowInputs: readonly string[] = [],
  limitBytes = DEFAULT_MAX_INPUT_BUDGET_BYTES,
): void {
  const actualBytes = executionInputBytes(task, context, workflowInputs);
  if (actualBytes > limitBytes) {
    throw new Error(
      `Subagent input budget exceeded: ${actualBytes} bytes > ${limitBytes} bytes; key inputs were not truncated.`,
    );
  }
}

export function assertResultBudget(
  output: string,
  limitBytes = DEFAULT_MAX_RESULT_BYTES,
): void {
  const actualBytes = Buffer.byteLength(output, "utf8");
  if (actualBytes > limitBytes) {
    throw new Error(
      `Subagent result budget exceeded: ${actualBytes} bytes > ${limitBytes} bytes; raw result was not truncated.`,
    );
  }
}

const ROLE_TOOLS: Readonly<Record<ExecutionRole, readonly string[]>> = {
  read_only: ["read", "multi_tool_use_parallel", "knowledge_search", "knowledge_symbol_search"],
  code: ["read", "write", "edit", "bash", "multi_tool_use_parallel", "run_code"],
  research: ["read", "multi_tool_use_parallel", "knowledge_search", "knowledge_symbol_search", "WebSearch", "WebFetch"],
};

export function roleToolNames(role: ExecutionRole): readonly string[] {
  return ROLE_TOOLS[role];
}

export function isToolAllowed(role: ExecutionRole, toolName: string): boolean {
  if (role === "code" && toolName === "run_code") {
    return true;
  }
  return roleToolNames(role).includes(toolName);
}

export function resultPreview(
  output: string,
  maxChars = DEFAULT_RESULT_PREVIEW_CHARS,
): { readonly resultPreview: string; readonly resultTruncated: boolean } {
  if (output.length <= maxChars) return { resultPreview: output, resultTruncated: false };
  return { resultPreview: `${output.slice(0, maxChars)}…`, resultTruncated: true };
}

export function completionKey(
  parentScope: string | undefined,
  workId: string,
  attempt = 1,
): string {
  return `${parentScope ?? "root"}:${workId}:${attempt}`;
}

export class CompletionDedupe {
  private readonly delivered = new Set<string>();

  claim(key: string): boolean {
    if (this.delivered.has(key)) return false;
    this.delivered.add(key);
    return true;
  }
}
