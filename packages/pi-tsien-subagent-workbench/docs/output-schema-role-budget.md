# 子代理 outputSchema + 每角色预算（验收记录）

日期：2026-11-27
范围：`pi-tsien-extension/packages/pi-tsien-subagent-workbench`（未改其他包，未提交 git）

## 1) subagent_start 结构化输出

**结论**：`subagent_start` 原本**不支持** `outputSchema`（只有 `subagent_workflow` 的 task 支持）。现已补上。

实现：

- 新增 `src/structured-output.ts`（两处共用，fail-closed）：
  - `assertOutputSchema`：对象 / 纯 JSON / ≤16 KiB / 类型名与关键字形状校验（typebox 的 `Check`
    对 `{type:"weird"}` 之类会**静默返回 true**，因此自己再做结构校验）；
  - `validateStructuredOutput`：返回 `{ok, code, error, issues}`，`code ∈
    {invalid_json, unsupported_schema, schema_mismatch}`；
  - `withStructuredOutputInstruction`：把 `<structured_output_required>` 块（只回 JSON、
    不要解释、不要围栏外文字、schema 原文）附到任务说明末尾。
- `src/workbench-controller.ts`：
  - `WorkbenchAgentRequest.outputSchema`；`executeAgent` 先校验声明再拼进任务，返回前
    `enforceStructuredOutput`；
  - 校验失败**不放过**：`isError=true`、`errorMessage` 指明是哪一类失败，字段不匹配时附前 5 条
    `instancePath: message`；保留原始 `output` 取证；机器码在 `structuredOutputError`；
  - workflow 侧改用同一 validator，历史错误文案保持不变。
- `src/index.ts`：`subagent_start` 暴露 `outputSchema` 参数并透传。
- `src/subagent-service.ts`：`AgentResult.structuredOutputError`。

## 2) 每角色预算

**结论**：角色文件和 `subagent-models.json` 都没有预算字段。已按角色文件实现（RoleProfile），
不改 `subagent-models.json`（避免过度设计）。

实现：

- `src/roles-registry.ts`：`RoleBudget {maxTurns?, maxTokens?}`，frontmatter 解析进
  `RoleProfile.budget`；**非法值（0/负数/非整数/非数字）标记 invalid 并丢弃该字段**，
  不会变成"无限制"；`roleValidationReport()` / 人类可读清单 / `roles-cli --json` 都会带出预算。
- 新增 `src/role-budget.ts`：阈值换算（80% 提醒点）、`budgetPromptDirective`（把预算写进任务）、
  `budgetHandoffMessage`（收尾指令）、`budgetExhaustedMessage`（耗尽时要求交部分产物）。
- `src/workbench-controller.ts`：`startRouted` 读取角色预算；`maxTurns` 收紧
  `maxModelCalls`（与全局 `budgets.maxModelCallsPerTask` 取更小值，只收紧不放宽），
  `maxTokens` 传新参数。
- `src/providers/pi-rpc-process-provider.ts`：
  - 累计 input+output token；到上限走 `settleBudget`——**停止子进程但带回部分 output/usage**
    （不再抛错丢产物），`budgetStop` 标注是哪个维度；
  - 到 80% 发一次 `run-warning: budget`，同时 `steer` 一条收尾指令，要求写盘并交
    已完成部分 / 产物路径 / 未验证项 / 剩余工作；
  - 新增 `PiRpcClient.steer()`（RPC `steer` 命令）。
- `src/index.ts`：`budget` 警告单独成文，以 `nextTurn` 信息性投递（不打断主 agent 当前轮）。
- 角色侧落地：`~/.pi/agent/subagents/{code,review}.md` 加预算；模板
  `custom-example.md.template` 说明用法；`~/.pi/agent/rules/build.py` 同步校验预算字段
  （`--strict`/角色清单/`roles-validation.json` 一致）。

## 验收

- 类型检查（只统计本包）：`node node_modules/typescript/bin/tsc --noEmit` → 本包 **0 错误**。
- 新增测试：`test/integrated/workbench/{structured-output,role-budget,subagent-start-schema-budget}.test.ts`
  → **29 passed**。
- `npm run test:node` → **357 pass / 0 fail / 3 skip（既有）**。
- workbench vitest 全套 → **441 passed / 2 failed**，两个失败均为**前序未提交改动**导致，与本任务无关：
  1. `goal/index.test.ts`：`packages/pi-tsien-context-slim/` 缺 `package.json`（该包为未跟踪目录）。
  2. `model-router.test.ts > rejects duplicates...`：工作区既有改动把跨档去重放宽了
     （`seen` 从全局改为每档内），用 HEAD 版本 + 仅本任务的正则改动可复现 22/22 通过。

测试需清掉会话环境变量（否则干扰）：

```bash
env -u PI_SUBAGENT_WORKBENCH_CHILD -u PI_SUBAGENT_ROLES_DIR -u PI_SUBAGENT_PROMPT_DIR \
    -u PI_TRACE_CONTEXT -u PI_SESSION_FILE -u PI_SLOT_KEY \
  node node_modules/vitest/vitest.mjs run --config vitest.integrated.config.ts
```