# PRD：自主目标续跑、结构化 Blocker 与状态面板

- 状态：Confirmed
- 范围：本地 fork 的 `pi-agent-goal`；不改变上游包的默认行为，除非后续获得上游维护者批准。
- 关联：现有 `/goal`、`--goal-continuation`、`agent_settled` 生命周期。

## 1. 背景与问题

现有 `pi-agent-goal` 已支持由 `--goal-continuation` 显式开启的续跑：当 Pi 在 `agent_settled` 后空闲、goal 仍为 active 且守卫通过时，运行时排入一条 follow-up。该机制解决了“一轮 agent 结束后继续推进”的基础问题，但仍有局限：

1. 续跑默认关闭，用户需要每次显式启用。
2. `progress.blocked` 只是全局字符串列表，无法表达 blocker 影响哪些工作、哪些工作仍可并行推进。
3. 没有可审计的 blocker 尝试记录、可恢复的续跑预算账本或持久化报告。
4. “全部无法推进”的状态不能明确解释原因、需要谁解决、以及用户给出方案后如何恢复。
5. 状态概览没有出现在现有 Powerline 的扩展状态区域，也没有可交互查看的 blocker 窗口。

本 PRD 定义一个本地 fork 的增强目标系统：默认续跑，但由工作项图和结构化 blocker 决定何时继续或暂停；保留用户授权、预算和规则边界。

## 2. 产品目标

1. active goal 连续 30 分钟没有可观察活动后默认继续推进，直到完成、暂停、所有路径受阻、或安全预算触发。
2. 一个工作项受阻时，agent 可继续推进其他不受该 blocker 影响的工作项。
3. blocker 必须区分：agent 可在受限范围内尝试、必须等待用户决策、以及等待外部依赖。
4. 当没有任何安全可推进方向时，自动停止续跑并生成持久化 Markdown blocker 报告。
5. 用户可通过 Powerline 概览和 Pi overlay 弹窗查看当前进度与 blocker 报告；用户的新方案可解除 blocker 并恢复续跑。
6. `/tree`、`/fork`、`/resume`、`/reload` 必须保持当前分支对应的 goal 语义，不能因为全局数据库泄露其他分支状态。
7. 当后台子代理完成只投递通知、没有启动新的 parent turn 时，active goal 不能永久失去调度机会；运行时需要静默看门狗作为兜底。

## 3. 非目标

- 复刻 Codex 的 SQLite schema、app-server RPC、底部目标菜单或精确 token/时间会计。
- 自动获取凭证、绕过权限、执行不可逆操作，或替用户做产品/法律/安全决策。
- 默认写入业务仓库中的 Markdown 文件。
- 承诺 agent 一定完成所有目标；模型能力、外部系统、预算和用户授权仍可能导致暂停。
- 将本地 fork 的“默认续跑”直接贡献回坚持 opt-in 的上游仓库。

## 4. 角色与用户故事

### 开发者

- 我创建并启动一个 goal 后，希望无需重复发送“继续”，agent 在安全范围内完成独立工作。
- 一个 blocker 出现时，我希望其他独立工作继续推进，而不是整个 goal 停止。
- 我希望随时知道完成度、尚存 blocker、以及可推进工作数量。
- 当系统无法继续时，我希望得到可执行的报告，而非笼统的“被阻塞”。
- 我提供解决方案或授权后，希望系统只恢复受影响工作，不重做已完成工作。

### Agent

- 我需要能描述工作项、依赖和 blocker 的影响范围。
- 我需要在有限预算内尝试安全的替代方案，并记录尝试结果。
- 我必须在遇到用户决策、凭证、不可逆操作或明确规则限制时停下相关工作，而不能自行跨越。

## 5. 核心模型

### 5.1 工作项

每个 goal 拥有一组工作项。初始工作项由接受标准和已批准计划生成；现有 goal 迁移时可从 acceptance criteria 推导初始项，再由 agent 细化。

```ts
type WorkItemState = "todo" | "in_progress" | "done" | "blocked" | "deferred";

type WorkItem = {
	id: string;
	goalId: string;
	title: string;
	description?: string;
	state: WorkItemState;
	dependsOn: string[];
	acceptanceCriteriaIds: string[];
	updatedAt: number;
};
```

一个工作项是 **ready**，当且仅当：

- 状态为 `todo` 或可恢复的 `in_progress`；
- 所有依赖工作项均为 `done`；
- 没有生效的 hard blocker 作用于该项；
- 没有违反策略、预算或用户暂停条件。

### 5.2 Blocker

blocker 必须是结构化记录，而非全局文本：

```ts
type BlockerKind =
	| "technical"
	| "dependency"
	| "external_wait"
	| "permission_or_credential"
	| "user_decision"
	| "policy_or_safety"
	| "scope_unclear";

type BlockerDisposition = "agent_can_try" | "needs_user" | "external_wait";
type BlockerState = "open" | "resolved" | "superseded";

type GoalBlocker = {
	id: string;
	goalId: string;
	title: string;
	reason: string;
	kind: BlockerKind;
	disposition: BlockerDisposition;
	state: BlockerState;
	workItemIds: string[];
	evidence?: string;
	proposedResolution?: string;
	owner: "agent" | "user" | "external";
	createdAt: number;
	updatedAt: number;
};
```

每次 agent 尝试处理 blocker 都生成包含假设、动作、结果和证据的不可变 attempt 记录。

### 5.3 Agent 自主判断与强制边界

agent 可以把技术不确定性标为 `agent_can_try`，并在一次受限的续跑中尝试替代实现、只读调查、局部修复或验证。调度器必须强制以下边界：

- 凭证、权限、付费/外部副作用、生产发布、不可逆操作、产品取舍、法律/合规/安全规则：只能为 `needs_user` 或 `external_wait`。
- agent 的“可自行解决”只是建议，不能绕过工具权限、既有安全规则或用户确认。
- agent 不能仅凭“暂无思路”创建永久 blocker；必须记录已尝试路径和下一步建议。

## 6. 持久化设计

### 6.1 真相源与数据库职责

Pi session custom entries 继续是与对话分支绑定的 **canonical state**。它们保证 `/tree`、`/fork`、`/resume` 后能依据 `ctx.sessionManager.getBranch()` 得到正确 goal 状态。

SQLite 是跨重启的调度账本、报告库和审计索引，不得独立决定当前分支的 goal 状态。数据库位置：

```text
~/.pi/agent/pi-goal.sqlite
```

实现优先使用 Node `node:sqlite`，避免 native addon。数据库文件与目录应使用仅当前用户可读写的权限；报告不得主动采集或写入凭证。

### 6.2 建议表

```text
goal_runs
work_items
work_item_dependencies
blockers
blocker_work_items
blocker_attempts
continuation_state
blocker_reports
```

每条记录至少包含 `session_id`、`goal_id`、`source_entry_id`、创建/更新时间。数据库启动时应从当前 branch 的 custom entries 进行重建或一致性校验；查询报告时只显示当前 branch 可达的记录。

`continuation_state` 保存：续跑计数、无进展计数、预算消耗、最后会话活动时间、最后看门狗触发时间、最后排队/执行时间、停止原因。它必须能在 `/reload` 和进程重启后恢复，不能因重启绕过安全上限，也不能因重启重复发送看门狗消息。

`blocker_reports` 保存结构化快照和由快照生成的 Markdown，包含 revision、触发原因、摘要与 checksum。

## 7. 调度与续跑

### 7.1 默认行为

本地 fork 默认启用 continuation。用户必须仍能通过配置或启动参数显式关闭它；上游发行包保持 opt-in。

`agent_settled` 只负责在 Pi 完成重试、自动 compact 重试和已排队消息后结算 continuation 状态，并重新安排静默观察。它不得直接排入下一轮，因此用户按 Esc 中断后不会立即被自动续跑。

静默看门狗是唯一自动调度点。`/goal start` 和 `--start` 仍是独立的一次性显式 handoff，不受 30 分钟阈值限制。

### 7.2 调度算法

每次看门狗确认静默达到阈值：

1. 读取当前 branch 的 canonical goal snapshot；没有 active goal 则退出。
2. 检查用户消息、Pi idle、重复排队、stale goal、暂停状态、预算、以及已有正在运行的 continuation。
3. 计算 ready 工作项，并识别所有未完成工作项的 blocker 依赖闭包。
4. 若存在 ready 项，选择优先级最高且未在最近一次无进展回合重复尝试的项，排入简短 follow-up；详细目标和工作项上下文由隐藏 `goal-context` 提供。
5. 若没有 ready 项，但存在 `agent_can_try` blocker，允许在严格预算内安排一次针对该 blocker 的探索；探索必须更新 attempt 记录和工作项/Blocker 状态。
6. 若所有未完成项都被 hard blocker 或其依赖闭包覆盖，停止自动续跑，写入 `all_paths_blocked` 记录和 blocker 报告。
7. 若目标完成，调用既有 completion 流程；若用户暂停、预算耗尽或策略禁止，记录对应停止原因并不再自动排队。

同一静默窗口最多排入一条 follow-up。调度器必须在执行前后重读 `goalId` 和 branch state，防止旧消息作用于已替换或切换的 goal。

### 7.3 静默看门狗

默认静默阈值为 30 分钟，并允许通过配置覆盖或关闭。运行时使用可取消的低频定时器检查，而不是按固定周期无条件发送消息。

“新事件”是当前 session branch 上可观察到的新 entry，包括用户/assistant/tool 消息、goal state、continuation record、subagent completion 通知和 compaction 记录。纯 UI 刷新、定时器 tick 和看门狗内部检查不算活动，避免看门狗自行刷新静默时间。

只有同时满足以下条件才可发送一条 continuation follow-up：

- 当前 branch 仍有同一个 active goal；
- 距最后一次可观察活动已达到静默阈值；
- parent agent 明确 idle，且没有 pending message；
- 没有 queued 或 running continuation；
- goal 未被用户暂停、替换或清除；
- 未命中 `all_paths_blocked`、无进展、最大回合数、wall-clock 或其他安全停止条件；
- 当前静默窗口尚未触发过看门狗。

看门狗消息固定为 `继续目标`（4 个字符，不超过 10 个字符），使用 `deliverAs: "followUp"`，并记录触发来源为 `watchdog`。详细状态由下一轮隐藏 `goal-context` 注入。发送前后必须重读 branch 与 `goalId`；同一静默窗口最多发送一次。任何新的真实活动都会开启新的静默窗口。

如果检查时 agent busy 或存在 pending message，看门狗不得发送，也不得把本次检查记为已触发；它应在下一次低频 tick 重新评估。若运行时无法可靠确认 idle，则失败关闭，不发送消息。

session shutdown、tree 切换、goal pause/complete/clear 时必须取消定时器。session start/reload 时从 branch entries 恢复最后活动和最后触发记录，再计算剩余等待时间；不得因为重启立即重复唤醒。

### 7.4 预算与循环保护

默认开启不代表无限循环。至少实现：

- 每个 goal 的最大自动续跑回合数，可配置；
- 最大连续无实质进展回合数；
- 总 token 或等价运行预算，以及 wall-clock 安全上限；
- 用户输入立即取消已排队的 continuation；
- 对同一工作项/同一 blocker 的指数退避或“必须产生新证据才可重试”规则。

预算耗尽应生成报告并保持 goal 未完成，等待用户选择继续、调整预算、暂停或修改计划。

### 7.5 用户解除 blocker

用户在普通对话中提供方案、授权或新约束后，agent 必须更新对应 blocker 和工作项。用户输入优先于自动续跑并重置静默窗口；下一次看门狗触发时重新计算 ready 项，而不是盲目恢复旧 follow-up。用户也可显式执行 `/goal start` 立即 handoff。

## 8. UI 与报告

### 8.1 Powerline

复用现有 Powerline 的 `extension_statuses` 区域。活跃 goal 显示紧凑状态：

```text
🎯 5/8 · ⚠2 · ▶1
```

- `5/8`：done 工作项 / 总工作项；
- `⚠2`：open blocker 数；
- `▶1`：ready 工作项数；
- 没有 ready 项时显示 `🎯 5/8 · ⛔2`；
- 无 active goal 时清除该状态。

实现使用 `ctx.ui.setStatus("goal-progress", text)`；不得修改 Powerline 本体。

### 8.2 Blocker overlay

新增 `/goal blockers` 命令，使用 `ctx.ui.custom(..., { overlay: true })`：

- 左栏：blocker 列表，按 `needs_user`、`agent_can_try`、`external_wait` 过滤；
- 右栏：当前或历史持久化 Markdown 报告；
- 展示影响工作项、证据、已尝试方案、推荐解决方案和解除后的下一步；
- 支持只读查看、复制 Markdown、选择报告 revision；
- 用户解决 blocker 应走明确的输入/确认操作，不能因为打开窗口自动改变状态。

没有 TUI 时，`/goal blockers --markdown` 输出报告；`/goal blockers export <path>` 需要用户明确指定路径后才写文件。

### 8.3 自动 Markdown 报告

在 `all_paths_blocked`、预算耗尽或策略停止时，生成并持久化报告。最低内容：

1. goal 摘要和完成度；
2. 不可推进的工作项及依赖链；
3. 每个 blocker 的类型、影响、owner、证据、已尝试措施；
4. agent 是否可继续尝试及其受限方案；
5. 用户需要提供的决策、信息或授权；
6. blocker 解除后的建议执行顺序。

报告存入 SQLite 并以 custom entry 记录其 revision/摘要，使当前 branch 可恢复；默认不写入业务仓库。

## 9. 兼容性与迁移

- 旧 `goal-state` 可继续读取；没有工作项的 active goal 从 acceptance criteria 创建初始工作项快照。
- 保留 `/goal start` 的“一次显式 handoff”语义；自动续跑是独立机制。
- 保留 `--goal-continuation` 作为兼容开关，并新增显式关闭配置；本地 fork 的默认值改为 enabled。
- `/goal pause`、`/goal complete`、`/goal clear` 必须停止续跑并同步/失效对应 scheduler state。
- 包版本、README、实现文档、设置文档和 release claims 必须与新行为同步。

## 10. 验收标准

### 自动续跑

- [ ] 本地 fork 在未传 `--goal-continuation` 时启用静默看门狗，但 `agent_settled` 和 Esc 中断不会立即排入 continuation。
- [ ] 用户可显式关闭自动续跑。
- [ ] 同一静默窗口最多排入一条 continuation；用户新消息取消已排队续跑并重置窗口。
- [ ] `paused`、`complete`、clear、stale goal、预算耗尽及重复排队均不会续跑。
- [ ] 重启或 reload 后，续跑回合/无进展/预算不会被重置绕过。
- [ ] active goal 连续 30 分钟无新 session event 时，看门狗在 idle、无 pending message且全部既有门禁通过后只排入一条 continuation。
- [ ] 自动 follow-up prompt 为 `继续目标`，不超过 10 个字符。
- [ ] subagent completion 仅投递 artifact pointer、没有启动 parent turn 时，看门狗能恢复 parent 调度。
- [ ] 同一静默窗口不会重复唤醒；新事件会重置静默窗口。
- [ ] busy、pending message、paused/complete/clear、stale goal、all-paths-blocked 和预算停止状态不会被看门狗绕过。
- [ ] `/reload`、session resume 和 tree 切换不会导致重复唤醒或跨 branch 使用旧活动时间。

### 工作项与 blocker

- [ ] 一个 blocker 只阻止其关联工作项；独立 ready 项继续执行。
- [ ] 所有未完成项被 hard blocker 或依赖闭包覆盖时停止，并生成报告。
- [ ] `agent_can_try` 仅能在配置预算和策略边界内尝试，并写入 attempt 记录。
- [ ] `needs_user`、凭证/权限、不可逆操作和策略限制不会被 agent 自动跨越。
- [ ] 用户提供有效方案后，相关 blocker 可被解除且调度器重新发现 ready 项。

### 持久化与 UI

- [ ] `/tree`、`/fork`、`/resume`、`/reload` 显示当前 branch 的正确工作项、blocker 与报告。
- [ ] SQLite 与 session custom entries 不一致时有可检测、可恢复的策略，且不会跨 branch 误显示。
- [ ] Powerline 正确显示紧凑概览，并在无 active goal 时清除。
- [ ] `/goal blockers` overlay 可查看持久化 Markdown；非 TUI 有文本退化路径。
- [ ] 自动报告不默认写入业务仓库，也不包含凭证。

### 验证

- [ ] 新增单元测试：ready 计算、依赖闭包、blocker 分类、预算、无进展、看门狗静默窗口/去重、跨重启恢复和报告渲染。
- [ ] 新增 lifecycle/integration 测试：`agent_settled`/Esc 不立即续跑、subagent completion 无 parent turn、30 分钟看门狗唤醒、用户中断、stale goal、pause/complete/clear、树分支和 reload。
- [ ] 运行 `npm run typecheck`、`npm run lint`、`npm run format`、`npm test`。
- [ ] 手工 Pi TUI smoke：`/goal`、`/compact`、`/reload`、`/resume`、`/tree`、`/fork`、Powerline 和 blocker overlay。

## 11. 开放决策

1. 自动回合数、token 预算和 wall-clock 默认值是多少？建议先采用保守默认值，并在 Powerline/报告中明确显示预算停止原因。
2. 工作项由 agent 自动拆分、用户编辑，还是两者均可？首版应要求可审计的 agent 提案并保留用户编辑入口。
3. token/时间用量能否从当前 Pi runtime 稳定取得？若不能，首版只实现回合数与 wall-clock 预算，并将精确 token accounting 延后。
4. blocker report 的 SQLite 分支可达性如何实现？首版应以 custom entry 为 canonical anchor，并在 session 启动时重建 SQLite materialized view。
5. overlay 是否提供“提交解决方案”编辑器？建议首版只读；用户通过正常对话提供方案，以保留现有审计和授权语义。

## 12. 实施阶段

1. **状态基础**：定义工作项、结构化 blocker、attempt、branch-aware custom entries 和 SQLite migrations。
2. **调度器**：实现 ready/依赖闭包计算、默认续跑、预算与恢复逻辑。
3. **报告与 CLI**：生成报告，增加 `/goal blockers --markdown` 和 export。
4. **TUI**：Powerline status、overlay、无 UI 退化路径。
5. **验证与文档**：覆盖测试、手工 smoke、同步 README/implementation/setup/release note。
