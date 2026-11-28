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

- 模型档位文件 `<agent dir>/subagent-models.json`（或 `PI_SUBAGENT_MODEL_CONFIG` 指定路径）：五档 `micro/light/medium/heavy/ultra`，每档一个有序候选列表；`micro` 是最低档，只适合机械、简单的活（例如 MiniMax-M3），默认不分配给任何角色，用完直接失败而不升档；另有角色默认档、档内全部不可用时的处理（`wait` / `wait_then_escalate` / `escalate` / `fail`，自动升档只到 light/medium）、`timeouts.workHardMs`（默认 72h，上限 `workHardMaxMs` 14d）与 `budgets.maxModelCallsPerTask`（默认 2000）。每次选模型前按文件修改时间自动重读；文件写坏时沿用上一份有效配置。
- 主 Agent 只选 `tier`（或不填用角色默认）；程序按顺序取第一个可用模型，遇到限流、额度用完、服务繁忙、网络中断、模型不存在、缺凭证时自动换下一个（每个任务最多换 3 次），并在结果 `routing.attempts` 里记录每次尝试。已经执行过工具的 `code` 任务不会自动换模型重做。
- `model` 只能是档位文件里出现过的模型，固定使用、不换，除非 `allowFallback: true`；`inheritModel` 只有 `allowInherit: true` 时可用。
- 没有档位文件时退回旧变量 `PI_SUBAGENT_EXECUTION_MODEL`（当作只有一个候选的 medium 档）；两者都没有则直接报错，不再有内置默认模型。

## 超时排查与恢复

- 带硬时限的子任务在截止前会发一次软截止提醒（提前三分之一的预算，最多 60 秒）。Workbench 尝试把已有的有限文本片段推送给主 Agent，标记为未验证；没有文本不代表没有落盘产物。主 Agent 可以等待、按 workId 取消，或在当前截止前用 `subagent_extend` 提交 `workId`、提醒里的 `runId`、`extendMs` 和理由。延期只作用于该子进程本轮，最多一次，由主 Agent 选择实际时长。默认上限 5 分钟，可在 `subagent-models.json` 的 `timeouts.workExtensionMaxMs` 配置（毫秒，例如 `900000` 表示 15 分钟，`0` 禁用延期）。可用延期还受 `timeouts.workHardMaxMs` 的剩余预算约束；会话记录保留理由和新旧截止时间。不自动延期，不保证正在调用工具的子 Agent 能及时产出报告；到截止仍未完成时，先尝试正常中止，再按原规则终止。

- `timeoutMs` 是整个子任务的墙钟预算，包含读材料、推理、执行和交付。短时限只派一个可验证的核查点；多步推导可先试 4–6 分钟的预算，但仍应拆阶段，不能仅靠延长时限。长实验分开准备、后台执行和验收，并事先约定可复核的落盘产物。
- `subagent_results` 对已识别的失败返回 `details.completed[].failure`。`timeout` 的 `checkpoint: "unknown"` 不代表没产物，先核对已有文件和后台进程；`quota_exhausted` / `rate_limited` 则先查 `/subagent-models` 的额度和冷却状态。诊断不会自动重跑或切换成更贵的档位。
- 比较调整前后时，同时记录可复核交付率和每份交付的时间、成本。不要把失败率降低等同于效率提升，也不要把超时当作对研究假设的反证。

## 评分台账（仅记录）

- `subagent_rate` 给已完成的 `workId` 记 1–5 分：5 = 可直接使用、无需返工；3 = 修正后可用；1 = 不可用或结论错误。可附最多 8 个短标签（如 `proof-check`、`literature`、`numeric`、`refactor`）和一句理由。
- 记录写入 `<agent dir>/subagent-ratings.jsonl`，每行一条：`{v, at, workId, score, tags?, note?, kind?, status?}`。评分**只做绩效留档**，不会改变路由、预算、重试或下次选用的模型。
- 复盘时用 `workId` 关联 `subagent-jobs.jsonl` 的 `model`、`tier`、`usage`、`toolCalls`、`modelCalls` 与耗时，再看同一模型在不同标签上的平均分与返工率，然后才调整派遣规范或档位配置。
- 子 Agent 的 thinking 默认是 `medium`，主会话的 thinking 档和 `settings.json` 的 `modelThinkingLevels` 都不会传给子进程；需要低档或高档时，在 `subagent_start` 传 `thinking`，或在 `subagent-models.json` 的候选上固定 `thinking`。

## 结构化输出（outputSchema）

- `subagent_start` 与 `subagent_workflow` 的 task 都支持可选 `outputSchema`（JSON Schema 对象，≤ 16 KiB，需被 typebox 支持）。
- `subagent_start` 会把 schema 作为硬要求附在任务说明末尾（`<structured_output_required>` 块：只回 JSON、不要解释、不要围栏外的文字），并在结果回到主 agent 前校验。
- 校验失败**不会静默放过**：任务标记为 `failed`，`errorMessage` 指出是 JSON 解析失败、schema 不受支持还是字段不匹配，不匹配时附前几条 `instancePath: message`；原始 `output` 仍保留，便于取证。机器可读原因在 `structuredOutputError`（`invalid_json` / `unsupported_schema` / `schema_mismatch`）。
- 允许整段 ```json 围栏，但不接受 JSON 之外的夹杂文字。两处共用 `src/structured-output.ts`，workflow 的历史错误文案保持不变。

## 每角色预算（maxTurns / maxTokens）

- 角色 frontmatter 可写 `maxTurns:`（模型回合数）和/或 `maxTokens:`（累计 input+output token），解析进 `RoleProfile.budget`。未写即没有角色级上限。
- 写错（0、负数、非整数）会让角色 `invalid` 并丢弃该字段，不会静默变成“无限制”。
- 硬上限：`maxTurns` 收紧 provider 的 `maxModelCalls`（仍受 `budgets.maxModelCallsPerTask` 全局保护约束，取更小值），`maxTokens` 触发 `token_budget` 停止。两者都会保留已有输出与产物。
- 软提醒：到 80% 时发一次 `run-warning: budget`，同时向子会话 steer 一条收尾指令，要求它停止探索、写盘、交出已完成部分 / 产物路径 / 未验证项 / 剩余工作。主 agent 收到的是信息性通知（不打断当前轮），提醒去 `subagent_results` 收取，且不要把未完成部分当成已通过。

## 自定义角色（fail-closed）

- 角色定义在 `<agent dir>/subagents/<name>.md`，frontmatter 写 `description` / `base` / `tier`（可用 `PI_SUBAGENT_ROLES_DIR` 改目录）。`base` 决定工具集，`tier` 只给路由一个默认档。
- `base` 必须是 `read_only` / `code` / `research` / `web_code`，`tier` 必须是 `micro` / `light` / `medium` / `heavy` / `ultra`。写错**不会**静默退回权限最大的 `code`：该角色被标记 `invalid`（`RoleProfile.invalid` + `invalidReason`），工具集按最小权限 `read_only` 处理；写错的 `tier` 直接丢弃，改用 `subagent-models.json` 的 `defaultTier`。未写的 `tier` 不算错误。
- 未知角色名（`~/.pi/agent/subagents/` 里没有对应文件）同样按 `read_only` 处理，不再默认给 `code` 工具集。
- 角色清单校验：`rolesValidationReport()` 返回机器可读的 `{ roles, invalid, missingPrompts }`，`formatRoleValidationReport()` 返回人类可读清单；`node --import tsx src/roles-cli.ts --json [--strict]` 是 CLI 形式（`--strict` 在有非法角色或缺失 prompt 时退出码 1）。`rules/build.py` 会用同一套规则校验，在 `AGENTS.md` 的角色清单里给非法角色标 `INVALID` 并写原因，同时生成 `rules/roles-validation.json`。
- 子代理的 role prompt 由 `rules/build.py` 生成到 `rules/subagent-prompts/<name>.md`。文件缺失/为空/不可读时 provider 不再静默回退：诊断写进 Run 结果的 `warnings`（同时也打到 stderr），内容包含哪个角色的 prompt 有问题、路径、具体状态（不存在/为空/不可读）以及实际回退到了哪个 prompt。`PI_SUBAGENT_MAIN_CONTEXT=1` 跳过角色 prompt 时也会告警。通用 prompt 路径可用 `PiRpcProcessProvider` 的 `genericPromptPath` 覆盖（默认 `rules/subagent-system.md`）。

## 局限

- 第一期只在“启动失败 / 尚未执行工具”时自动换模型；运行中途换模型、跨会话记住限流状态在后续阶段。模型调用次数达到上限时任务直接结束并报错，而不是暂停。
- 输入预算包含 task、context 和工作流输入，默认硬限 9 MiB；结果默认硬限 8 MiB，超限会明确失败，不截断关键输入或原始结果。
- `read_only`、`research`、`code` 角色在工具事件入口拦截不允许的工具；底层 Pi 的扩展和项目规则仍会加载，不使用 `--no-extensions`。如果底层运行时已经执行了不可逆外部副作用，工作台不能撤销它。
- `resultPreview` 只是有限预览，原始结果仍保存在工作台，可再次 collect；重复完成不会重复通知。对于背景命令或交接状态不明的外部清理，本包目前不提供自动判断，调用方必须自行确认后清理，不能把它当作已完成。
- 一次性任务默认关闭子会话；只有显式 `retainSession` 才保留。当前实现不承诺跨进程恢复未持久化的实时流。
- `subagent_results` 可用 `mode: "status"`、明确的 `workIds` 和 `includePartial: true` 查看运行中或未正常完成的任务最近的回复文本，不必等待。`partialMaxChars` 默认每个任务 2000 字符，最多 8000；不包含思考、提示或工具数据。这只是当前会话内的未验证输出，不保证重启后可查，也不能替代落盘检查点或最终结果。
- pending 任务会附带活跃度后缀：`busy`（有工具调用或模型请求在飞）、`active (idle Ns)`、`stalled?`（无活动超过阈值）。阈值可用 `PI_SUBAGENT_IDLE_MS` 覆盖，默认 300000 ms。**stalled 的 pending 任务会自动附带一段受限的部分产物摘要**（约 600 字符，保留最新尾部文本，标注 `unverified`），因此一次 `subagent_results` 调用就足以判断是否取消，不必再多查一轮；若该 workId 已通过 `includePartial` 完整渲染，则不重复附。
- `busy` 会按“该活动已持续 T 秒”升级：某个工具调用或模型请求持续在飞超过 `PI_SUBAGENT_BUSY_MAX_MS`（默认 600000 ms = 10 分钟）**且**这段时间完全没有任何子进程事件时，升级为 `stalled?` 候选，用于识别等 stdin 的 bash、挂死的网络读取等。两个条件同时成立才升级，所以持续输出进度的长命令、以及一串短工具的忙碌状态都不会被误判。
- 活跃度按**任务粒度**计：workflow 的每个 task run 用自己的稳定 key `taskId`（`workflow_*:task:S:T`），单个 agent job 用 `workId`，无 trace 的直接 provider 调用才回退 `runId`。因此一个 task 真卡住时不会被同 Stage 里仍在跑的兄弟 task 掩盖；pending workflow 行会写明是哪个 task（`work_xxx · task <taskKey> · workflow · running`），并只取该 task 的部分产物摘要。
- 心跳（`lastActivityAt`）会以节流间隔（`PI_SUBAGENT_ACTIVITY_PERSIST_MS`，默认 15000 ms）追加到 job ledger：`<agent dir>/subagent-jobs.jsonl` 中带 `event: "heartbeat"` 的独立行（含 `activityKey` / `workId` / `lastActivityAt` / `busy`，任务级还带 `taskId` / `taskKey`）。这些行**没有 `status` 字段**，所以 dashboard 等按 launch/settlement 统计的消费者会自动跳过它们。tracker 启动时用 `readJobLedgerActivity()` + `restoreFromLedger()` 从 ledger 恢复心跳，重启后仍能判断任务空闲时长；恢复只还原 `lastActivityAt`/`eventCount`，in-flight 状态不可恢复（视为不 busy），已结算的 key 带 `settled: true` 不会复活。
- `subagent_workflow_control action=retry_task` 只重跑指定的失败 task，在新的 workId 下运行；同一 Stage 里已完成或已跳过的兄弟 task、之前各 Stage 都直接复用，原运行记录（`.pi/workflow-runs/<源 workId>.json`）不会被改写。可选 `timeoutMs` 只对这个 task 生效，覆盖它原来的设置，仍受 `workHardMaxMs` 上限约束；可选 `resumeContext`（最多 4000 字符）会附加到这个 task 的上下文末尾。重跑**不是在原进程里接着跑**：会开一个全新的子会话，失败那次的内存、对话和工具状态都不保留。长任务应定期把进度写入检查点文件，`resumeContext` 里写明这些文件的绝对路径和剩余工作；子代理会先核对检查点，再继续。这次重跑用到的覆盖项记录在结果的 `retriedTask` 字段中。

## 依赖

- 内部：无
- peer：`@earendil-works/pi-coding-agent`

## 说明

依赖 `pi-tsien-shared`；被 `pi-tsien-memory` 依赖。

## 加载

在 `settings.json` 里列出包，或写进 `extensions.config.json` 的 `loadOrder`；
Pi 会直接加载本包的 TS 入口（`package.json` 的 `pi.extensions`），不需要编译。
