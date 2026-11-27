# pi-tsien-goal

持久化目标、验收标准、进度与阻塞项；支持按间隔自动 continuation——遇到卡点先走「绕过/自助解决/先推进其他工作」阶梯，仍无法解决的外部等待记录为结构化阻塞并保持目标活动、由每轮 continuation 先复核；暂停仅用于用户要求停止或继续不安全的场景。

## 目标是结果合同，不是流程清单

`objective` 必须是一个可验收的终态：证明/反驳某个命题、把算法优化到明确指标、或探索到写清质量/影响力门槛的结果。`acceptanceCriteria` 只放能证明终态的结果检查；记录、汇报、独立评审、更新 STATUS、不投稿等行为规则放 `constraints`。

`propose_goal_draft` 会在无人值守保存前跑确定性质量门禁：过程型 objective、只有流程的义务、无界“优化/探索”、逃生条款（“做不出来就记录并结案”）会被拒绝。质量门禁只判断目标写法，不判断数学结论。

算法优化目标可以带一个最小优化合同：`optimization: { metric, baseline, target, guardrails }`。工具会把它渲染成“单一指标 + 基线 + 数字目标 + guardrails”的 objective/验收标准，并自动加入“允许任意算法/实现路线”的约束；`target` 必须含数字或明确倍数（如 `降低 ≥20%`、`翻倍`）。

无人值守草案还必须带一个三层计划：2–4 个有序里程碑（`horizon: "mid"`，每个有 `doneWhen`），第一个里程碑直接带 1–3 个当前可执行动作（`horizon: "short"`，`parentId` 指向该里程碑）。运行时只挑当前里程碑下的 ready 动作；里程碑必须在其短期动作完成/暂缓、且带有 `evidence` 时才能标记 done，之后才解锁下一个；`complete_goal` 在所有里程碑/动作完成或显式 deferred 之前会拒绝。旧目标没有计划时仍按平铺 work item 运行。

## 工具

- `complete_goal`
- `create_goal`
- `get_goal`
- `pause_goal`
- `propose_goal_draft`
- `update_goal`（原地改 objective / 验收标准 / 约束 / 来源文档，必带理由；不得改变用户的范围）
- `update_goal_graph`（每个 work item 只要求 `id` 和 `state`，省略字段继承当前值；不再需要猜验收标准 ID）
- `update_goal_progress`

## 命令

- `/goal <objective>`：新建或替换目标
- `/goal replan <objective>`：原地重规划，保留 goal ID、已完成/已 deferred 的里程碑与证据，替换未完成 frontier；新计划追加在历史之后
- `/goal status`、`/goal pause|resume`、`/goal clear`、`/goal complete`

## 事件钩子

`agent_settled`、`before_agent_start`、`context`、`input`、`session_before_compact`、`session_shutdown`、`session_start`、`session_tree`

## 配置

目标状态保存在会话的 agent 目录内。`/goal` 的执行轮结束后，由独立模型给出 `continue` / `wait` / `stop` 调度建议；运行中的 pi-matrix 任务只阻塞依赖它的工作。小模型可在等待期间建议另一条可执行路线；已跟踪的审查完成或失败时，在自动接续预算及授权范围内合并终止事件、启动一轮收取结果，不让过时的轮末交接吞掉通知。不使用轮询。

同一会话中由目标执行链启动的后台 subagent/workflow 通过 `pi:workbench-job` 事件（`{sessionId,id,label,state}`，state 为 `pending`/`finished`/`failed`/`cancelled`）接入：完成或失败只唤醒一次，并要求用 `subagent_results` 收取实际输出；其他会话的事件、目标启动前的任务、本轮已用 `subagent_results` 收取（非 `status`）的结果都不会唤醒；`cancelled` 既不唤醒也不终止目标链。已排队接续期间完成的任务并入下一轮提示，不再二次唤醒。由定时扩展发出的回收消息保留已有目标链和后台任务跟踪，但不会开启新的自动接续。`/goal <目标>` 起草轮中排队的开始提示会在空闲后重新发送，确保走 `before_agent_start` 进入目标执行链。

- `--goal-evaluator-models` 或 `PI_GOAL_EVALUATOR_MODELS`：逗号分隔的有序 `provider/model` 列表（命令行优先）。默认 `openai-codex/gpt-6-luna,dashscope/deepseek-v4.1-flash,anthropic/claude-haiku-4-5`。每个候选最多等 12 秒；缺认证、额度/请求错误、超时或无效 JSON 会尝试下一项。会话日志只记录各候选的失败类别，不记录原始错误或认证信息。全失败不等于停止决定，已跟踪的证明结果仍可唤醒。若交接明确标出一个任务图中当前可执行的检查点动作（有正在运行或排队的证明任务时，还须明确声明该动作不依赖任何任务结果、也不修改任务正在处理的路线），每次显式开始／继续最多按交接兜底接续一次。没有这类交接时，若无待收任务且有可执行项，或当前未完成的里程碑没有硬阻塞，则默认派发「继续目标」；同一进展阶段最多一次，仍遵守防空转和审批边界。若评估结果为 `uncertain` 且存在 `needs_user` / `external_wait` 等硬阻塞、因而没有可执行项，仍会派发一轮受限复核：只允许核对阻塞是否仍然成立，必要时带证据解除或替代该阻塞，不得执行被阻塞的工作，也不得重复向用户提同一请求；同一组阻塞只复核一次，阻塞集合变化后才再次复核。`uncertain`、评估失败以及没有目标级依据的 `wait` / `stop` 都不能否决可执行工作。单轮工具额度耗尽不是目标级上限；程序仍检查硬阻塞、待收任务和防空转。
- `--goal-evaluator-models off`（或环境变量设为 `off`）关闭自动接续，无定时兜底；手动「继续目标」仍可使用。
- 自动接续没有固定总轮数。连续三轮无新的已完成事项或有证据的路线尝试会暂停自主探索，但仍可收取已提交任务的结果。用户明确设定的限制、宿主实际限额和审批边界仍然有效。同一进展阶段完全相同的模型建议不重复派发。`continue` 必须有具体行动，`wait` 必须有具体唤醒条件。活跃目标可用「继续」「好的，接着做」「继续目标。先收取后台任务」或英文 `Please resume the goal` 等明确指令恢复自动接续。明确口令可直接识别；其他交互/RPC 输入由相同候选模型在短超时内判断是否续跑或停止，也能识别出现在消息中间的明确要求。模型仅收到最多 4,000 个字符的用户消息；普通问答或分类失败不启动空闲目标，也不清除已有执行链。已暂停的目标仍须先用 `/goal resume`。模型只看有界的目标摘要、可执行项、后台任务元数据和轮末交接（本轮证据、立即可做事项、阻塞/唤醒条件与结束原因）；这些内容会发给所选提供商。模型不能结案、改证明状态或代替用户批准。

`update_goal_progress` 可选 `checkpoint: {kind, evidence, decision}`：用稳定的产物路径、运行 ID 或结果摘要记录真正改变决策的门槛、独立复现或资源缺口。相同证据引用不重复计入；普通汇报不重置防空转计数。检查点不认证证据、不更改验收标准，也不完成目标。可选 `feedback: {method, scope, outcome, gate?, independentCheck?, challenge?}` 记录可复用路线经验。同一方法和范围以后来的检查点为准；`reinforce` 必须记录达到的预设门槛、独立核验和一条挑战该结论的互补路线。`falsified` 仅淘汰明确被反驳的范围；`proof_gap` 指向修证明；`resource_limit` 和 `inconclusive` 不判定方法失败。反馈会提供给执行模型和调度评估器，是优先级建议，不自动分配算力或提高证据档位。

## 依赖

- 内部：无
- peer：`@earendil-works/pi-coding-agent`

## 说明

与 dashboard 的目标图谱页共用同一份状态。

## 加载

在 `settings.json` 里列出包，或写进 `extensions.config.json` 的 `loadOrder`；
Pi 会直接加载本包的 TS 入口（`package.json` 的 `pi.extensions`），不需要编译。
