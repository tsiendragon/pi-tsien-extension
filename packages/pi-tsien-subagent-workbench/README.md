# pi-tsien-subagent-workbench

进程隔离的子代理与可恢复的 Workflow（编排、重试、结果收集），可由 dashboard 的 Workbench 面板查看。

## 工具

- `subagent_cancel`
- `subagent_results`
- `subagent_start`
- `subagent_workflow`
- `subagent_workflow_control`

## 命令

- `/subagent-workbench`
- `/subagent-models`：查看各档模型及状态（可用 / 暂停 / 停用）；`/subagent-models reload` 重新读取配置，`/subagent-models enable <provider/model>` 恢复被停用的模型

## 事件钩子

`session_shutdown`、`session_start`

## 配置

- 模型档位文件 `<agent dir>/subagent-models.json`（或 `PI_SUBAGENT_MODEL_CONFIG` 指定路径）：四档 `light/medium/heavy/ultra`，每档一个有序候选列表；另有角色默认档、档内全部不可用时的处理（`wait` / `wait_then_escalate` / `escalate` / `fail`，自动升档只到 light/medium）、`timeouts.workHardMs`（默认 72h，上限 `workHardMaxMs` 14d）与 `budgets.maxModelCallsPerTask`（默认 2000）。每次选模型前按文件修改时间自动重读；文件写坏时沿用上一份有效配置。
- 主 Agent 只选 `tier`（或不填用角色默认）；程序按顺序取第一个可用模型，遇到限流、额度用完、服务繁忙、网络中断、模型不存在、缺凭证时自动换下一个（每个任务最多换 3 次），并在结果 `routing.attempts` 里记录每次尝试。已经执行过工具的 `code` 任务不会自动换模型重做。
- `model` 只能是档位文件里出现过的模型，固定使用、不换，除非 `allowFallback: true`；`inheritModel` 只有 `allowInherit: true` 时可用。
- 没有档位文件时退回旧变量 `PI_SUBAGENT_EXECUTION_MODEL`（当作只有一个候选的 medium 档）；两者都没有则直接报错，不再有内置默认模型。

## 局限

- 第一期只在“启动失败 / 尚未执行工具”时自动换模型；运行中途换模型、跨会话记住限流状态在后续阶段。模型调用次数达到上限时任务直接结束并报错，而不是暂停。
- 输入预算包含 task、context 和工作流输入，默认硬限 9 MiB；结果默认硬限 8 MiB，超限会明确失败，不截断关键输入或原始结果。
- `read_only`、`research`、`code` 角色在工具事件入口拦截不允许的工具；底层 Pi 的扩展和项目规则仍会加载，不使用 `--no-extensions`。如果底层运行时已经执行了不可逆外部副作用，工作台不能撤销它。
- `resultPreview` 只是有限预览，原始结果仍保存在工作台，可再次 collect；重复完成不会重复通知。对于背景命令或交接状态不明的外部清理，本包目前不提供自动判断，调用方必须自行确认后清理，不能把它当作已完成。
- 一次性任务默认关闭子会话；只有显式 `retainSession` 才保留。当前实现不承诺跨进程恢复未持久化的实时流。

## 依赖

- 内部：无
- peer：`@earendil-works/pi-coding-agent`

## 说明

依赖 `pi-tsien-shared`；被 `pi-tsien-memory` 依赖。

## 加载

在 `settings.json` 里列出包，或写进 `extensions.config.json` 的 `loadOrder`；
Pi 会直接加载本包的 TS 入口（`package.json` 的 `pi.extensions`），不需要编译。
