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

## 超时排查与恢复

- 带硬时限的子任务在截止前会发一次软截止提醒（提前三分之一的预算，最多 60 秒）。Workbench 尝试把已有的有限文本片段推送给主 Agent，标记为未验证；没有文本不代表没有落盘产物。主 Agent 可以等待、按 workId 取消，或在当前截止前用 `subagent_extend` 提交 `workId`、提醒里的 `runId`、`extendMs` 和理由。延期只作用于该子进程本轮，最多一次，由主 Agent 选择实际时长。默认上限 5 分钟，可在 `subagent-models.json` 的 `timeouts.workExtensionMaxMs` 配置（毫秒，例如 `900000` 表示 15 分钟，`0` 禁用延期）。可用延期还受 `timeouts.workHardMaxMs` 的剩余预算约束；会话记录保留理由和新旧截止时间。不自动延期，不保证正在调用工具的子 Agent 能及时产出报告；到截止仍未完成时，先尝试正常中止，再按原规则终止。

- `timeoutMs` 是整个子任务的墙钟预算，包含读材料、推理、执行和交付。短时限只派一个可验证的核查点；多步推导可先试 4–6 分钟的预算，但仍应拆阶段，不能仅靠延长时限。长实验分开准备、后台执行和验收，并事先约定可复核的落盘产物。
- `subagent_results` 对已识别的失败返回 `details.completed[].failure`。`timeout` 的 `checkpoint: "unknown"` 不代表没产物，先核对已有文件和后台进程；`quota_exhausted` / `rate_limited` 则先查 `/subagent-models` 的额度和冷却状态。诊断不会自动重跑或切换成更贵的档位。
- 比较调整前后时，同时记录可复核交付率和每份交付的时间、成本。不要把失败率降低等同于效率提升，也不要把超时当作对研究假设的反证。

## 局限

- 第一期只在“启动失败 / 尚未执行工具”时自动换模型；运行中途换模型、跨会话记住限流状态在后续阶段。模型调用次数达到上限时任务直接结束并报错，而不是暂停。
- 输入预算包含 task、context 和工作流输入，默认硬限 9 MiB；结果默认硬限 8 MiB，超限会明确失败，不截断关键输入或原始结果。
- `read_only`、`research`、`code` 角色在工具事件入口拦截不允许的工具；底层 Pi 的扩展和项目规则仍会加载，不使用 `--no-extensions`。如果底层运行时已经执行了不可逆外部副作用，工作台不能撤销它。
- `resultPreview` 只是有限预览，原始结果仍保存在工作台，可再次 collect；重复完成不会重复通知。对于背景命令或交接状态不明的外部清理，本包目前不提供自动判断，调用方必须自行确认后清理，不能把它当作已完成。
- 一次性任务默认关闭子会话；只有显式 `retainSession` 才保留。当前实现不承诺跨进程恢复未持久化的实时流。
- `subagent_results` 可用 `mode: "status"`、明确的 `workIds` 和 `includePartial: true` 查看运行中或未正常完成的任务最近的回复文本，不必等待。`partialMaxChars` 默认每个任务 2000 字符，最多 8000；不包含思考、提示或工具数据。这只是当前会话内的未验证输出，不保证重启后可查，也不能替代落盘检查点或最终结果。
- `subagent_workflow_control action=retry_task` 只重跑指定的失败 task，在新的 workId 下运行；同一 Stage 里已完成或已跳过的兄弟 task、之前各 Stage 都直接复用，原运行记录（`.pi/workflow-runs/<源 workId>.json`）不会被改写。可选 `timeoutMs` 只对这个 task 生效，覆盖它原来的设置，仍受 `workHardMaxMs` 上限约束；可选 `resumeContext`（最多 4000 字符）会附加到这个 task 的上下文末尾。重跑**不是在原进程里接着跑**：会开一个全新的子会话，失败那次的内存、对话和工具状态都不保留。长任务应定期把进度写入检查点文件，`resumeContext` 里写明这些文件的绝对路径和剩余工作；子代理会先核对检查点，再继续。这次重跑用到的覆盖项记录在结果的 `retriedTask` 字段中。

## 依赖

- 内部：无
- peer：`@earendil-works/pi-coding-agent`

## 说明

依赖 `pi-tsien-shared`；被 `pi-tsien-memory` 依赖。

## 加载

在 `settings.json` 里列出包，或写进 `extensions.config.json` 的 `loadOrder`；
Pi 会直接加载本包的 TS 入口（`package.json` 的 `pi.extensions`），不需要编译。
