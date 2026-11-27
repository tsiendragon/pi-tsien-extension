/**
 * 每角色预算（maxTurns / maxTokens）。
 *
 * 目标：让子代理有明确的回合与 token 上限，接近上限时被要求**先交部分产物与当前进展**，
 * 而不是无限跑下去。只做可控的一档实现：
 *
 *   - 来源：角色文件 frontmatter（`maxTurns:` / `maxTokens:`），经 roles-registry 解析进
 *     `RoleProfile.budget`；任务级 `subagent-models.json` 不需要新字段（角色优先）。
 *   - 硬上限：`maxTurns` 映射到 provider 的 `maxModelCalls`，`maxTokens` 映射到累计
 *     input+output token 上限；到上限即停，并把"交出部分产物"写进错误原因。
 *   - 软提醒：到 `BUDGET_NOTICE_RATIO` 时发一次 `run-warning: budget`，同时向子会话
 *     steer 一条收尾指令，要求它立刻写盘并交出部分产物与进展。
 *
 * 未声明预算 = 没有角色级上限（沿用配置里的全局 maxModelCallsPerTask）。
 */
import { roleProfile, type RoleBudget } from "./roles-registry.ts";

export type { RoleBudget } from "./roles-registry.ts";

/** 到 80% 就提醒收尾：留出写盘与汇报的余量。 */
export const BUDGET_NOTICE_RATIO = 0.8;

export interface ResolvedBudget {
  /** 模型回合上限（provider 的 maxModelCalls）。 */
  readonly maxTurns?: number;
  /** 累计 token 上限（input + output）。 */
  readonly maxTokens?: number;
  /** 触发软提醒的回合数。 */
  readonly noticeAtTurn?: number;
  /** 触发软提醒的累计 token 数。 */
  readonly noticeAtTokens?: number;
}

/** 把声明的预算换算成运行时阈值；非法值由 roles-registry 拒绝，这里只做换算。 */
export function resolveBudgetThresholds(
  budget: RoleBudget | undefined,
): ResolvedBudget {
  if (!budget) return {};
  const noticeAtTurn =
    budget.maxTurns === undefined
      ? undefined
      : Math.max(1, Math.floor(budget.maxTurns * BUDGET_NOTICE_RATIO));
  const noticeAtTokens =
    budget.maxTokens === undefined
      ? undefined
      : Math.max(1, Math.floor(budget.maxTokens * BUDGET_NOTICE_RATIO));
  return {
    ...(budget.maxTurns === undefined ? {} : { maxTurns: budget.maxTurns }),
    ...(budget.maxTokens === undefined ? {} : { maxTokens: budget.maxTokens }),
    ...(noticeAtTurn === undefined ? {} : { noticeAtTurn }),
    ...(noticeAtTokens === undefined ? {} : { noticeAtTokens }),
  };
}

/** 读取角色文件里的预算；角色不存在或未声明时返回 undefined。 */
export function roleBudget(role: string | undefined): RoleBudget | undefined {
  if (!role) return undefined;
  return roleProfile(role)?.budget;
}

/** 角色预算 → 运行时阈值。 */
export function roleBudgetThresholds(role: string | undefined): ResolvedBudget {
  return resolveBudgetThresholds(roleBudget(role));
}

/** 写进任务说明的前置要求：预算多少、接近时该做什么。 */
export function budgetPromptDirective(budget: RoleBudget): string {
  const limits: string[] = [];
  if (budget.maxTurns !== undefined) limits.push(`${budget.maxTurns} assistant turns`);
  if (budget.maxTokens !== undefined) limits.push(`${budget.maxTokens} tokens (input + output)`);
  if (limits.length === 0) return "";
  return [
    "",
    "<budget>",
    `This task has a hard budget of ${limits.join(" and ")}.`,
    `Near the limit (about ${Math.round(BUDGET_NOTICE_RATIO * 100)}%) you will be told to wrap up.`,
    "When that happens, stop exploring: write your partial artifacts to disk,",
    "then reply with what is finished, the artifact paths, what remains, and the next concrete step.",
    "Never spend the last turns starting new work you cannot hand over.",
    "</budget>",
  ].join("\n");
}

/** 把预算要求拼到任务说明里；没有预算时原样返回。 */
export function withBudgetDirective(task: string, budget: RoleBudget | undefined): string {
  if (!budget) return task;
  const directive = budgetPromptDirective(budget);
  return directive ? `${task}${directive}` : task;
}

/** 发给子会话的收尾指令（软提醒时 steer）。 */
export function budgetHandoffMessage(used: {
  readonly modelCalls?: number;
  readonly tokens?: number;
  readonly maxTurns?: number;
  readonly maxTokens?: number;
}): string {
  const parts: string[] = [];
  if (used.maxTurns !== undefined) parts.push(`turn ${used.modelCalls ?? 0}/${used.maxTurns}`);
  if (used.maxTokens !== undefined) parts.push(`tokens ${used.tokens ?? 0}/${used.maxTokens}`);
  return [
    `<budget_notice>${parts.join(", ")}</budget_notice>`,
    "You are close to this task's hard budget. Stop exploring now.",
    "1) Write the partial result to a file if you have not already.",
    "2) Reply with: finished parts and artifact paths, what is unverified,",
    "   what remains, and the single next step a fresh run should take.",
    "Do not start new work.",
  ].join("\n");
}

/** 硬预算耗尽时的错误原因：明确要求交部分产物，而不是当作普通失败。 */
export function budgetExhaustedMessage(
  kind: "maxTurns" | "maxTokens",
  limit: number,
): string {
  const what =
    kind === "maxTurns"
      ? `model call budget (${limit} calls)`
      : `token budget (${limit} tokens)`;
  return (
    `reached its ${what}; stopped so the main agent can decide whether to continue. ` +
    "Deliver partial artifacts and progress first, then split the remaining work."
  );
}

export interface BudgetProgress {
  readonly used: number;
  readonly limit: number;
  readonly remaining: number;
  readonly nearLimit: boolean;
  readonly exhausted: boolean;
}

/** 单一维度的进度（回合或 token）。 */
export function budgetProgress(
  used: number,
  limit: number | undefined,
): BudgetProgress | undefined {
  if (limit === undefined) return undefined;
  const remaining = Math.max(0, limit - used);
  return {
    used,
    limit,
    remaining,
    nearLimit: used >= Math.max(1, Math.floor(limit * BUDGET_NOTICE_RATIO)),
    exhausted: used >= limit,
  };
}