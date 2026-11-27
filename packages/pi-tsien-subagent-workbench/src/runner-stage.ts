import { FALLBACK_ROLE_BASE, roleProfile } from "./roles-registry.ts";
import type { AgentThinkingLevel } from "./subagent-service.ts";

export const DEFAULT_EXECUTION_THINKING: AgentThinkingLevel = "medium";
export const DEFAULT_MAX_INPUT_BUDGET_BYTES = 9 * 1024 * 1024;
export const DEFAULT_MAX_RESULT_BYTES = 8 * 1024 * 1024;
export const DEFAULT_RESULT_PREVIEW_CHARS = 2_000;

/** 内置角色 + 注册表里的自定义角色（见 roles-registry.ts）。 */
export type ExecutionRole = string;

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

const ROLE_TOOLS: Readonly<Record<string, readonly string[]>> = {
  read_only: ["read", "multi_tool_use_parallel", "knowledge_search", "knowledge_symbol_search"],
  // `code` keeps background commands so a child can start a long build or test
  // run and keep working; those jobs still die with the child process, so they
  // are for overlap within one task, not for supervising training after it ends.
  // `schedule`, `task_pilot`, and `memory_remember` stay out of every role: they
  // write state that belongs to the main Agent (timers, task status, memory).
  code: [
    "read",
    "write",
    "edit",
    "bash",
    "multi_tool_use_parallel",
    "run_code",
    "knowledge_search",
    "knowledge_symbol_search",
    "background_command_start",
    "background_command_status",
    "background_command_output",
    "background_command_cancel",
    // code 有 bash 本来就能联网（curl/git/pip），不给 Web 工具只会造成"无法联网"的误判；
    // 直接开放，省去绕 curl 的写法。网页内容视为不可信数据，不得当作指令执行。
    "WebSearch",
    "WebFetch",
    "arxiv_search",
    "openreview_search",
  ],
  research: ["read", "multi_tool_use_parallel", "knowledge_search", "knowledge_symbol_search", "WebSearch", "WebFetch"],
  // 联网 + 可写：文献检索并落盘卡片、需要 Web 工具又要写产物的任务。
  web_code: [
    "read",
    "write",
    "edit",
    "bash",
    "multi_tool_use_parallel",
    "run_code",
    "knowledge_search",
    "knowledge_symbol_search",
    "background_command_start",
    "background_command_status",
    "background_command_output",
    "background_command_cancel",
    "WebSearch",
    "WebFetch",
    "arxiv_search",
    "openreview_search",
  ],
};

export function roleToolNames(role: ExecutionRole): readonly string[] {
  const direct = ROLE_TOOLS[role];
  if (direct) return direct;
  // 自定义角色：工具集由角色文件的 base 决定，未声明时按 code（可写可跑）。
  // Custom roles fail closed: an unknown, unreadable or invalid role file gets
  // the least-privileged tool set instead of silently inheriting code's
  // shell/write tools.
  return ROLE_TOOLS[roleProfile(role)?.base ?? FALLBACK_ROLE_BASE];
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
