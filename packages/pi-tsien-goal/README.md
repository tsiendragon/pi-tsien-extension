# pi-tsien-goal

持久化目标、验收标准、进度与阻塞项；支持按间隔自动 continuation——遇到卡点先走「绕过/自助解决/先推进其他工作」阶梯，仍无法解决的外部等待记录为结构化阻塞并保持目标活动、由每轮 continuation 先复核；暂停仅用于用户要求停止或继续不安全的场景。

## 工具

- `complete_goal`
- `create_goal`
- `get_goal`
- `pause_goal`
- `propose_goal_draft`
- `update_goal`（原地改 objective / 验收标准 / 约束 / 来源文档，必带理由；不得改变用户的范围）
- `update_goal_graph`
- `update_goal_progress`

## 命令

- `/goal`

## 事件钩子

`agent_settled`、`before_agent_start`、`context`、`input`、`session_before_compact`、`session_shutdown`、`session_start`、`session_tree`

## 配置

目标状态保存在会话的 agent 目录内。`/goal` 的执行轮结束后，由独立模型给出 `continue` / `wait` / `stop` 调度建议；运行中的 pi-matrix 任务只阻塞依赖它的工作。小模型可在等待期间建议另一条可执行路线；已跟踪的审查完成或失败时，在自动接续预算及授权范围内合并终止事件、启动一轮收取结果，不让过时的轮末交接吞掉通知。不使用轮询。

- `--goal-evaluator-models` 或 `PI_GOAL_EVALUATOR_MODELS`：逗号分隔的有序 `provider/model` 列表（命令行优先）。默认 `anthropic/claude-haiku-4-5,openai-codex/gpt-6-luna,opencode-go/deepseek-v4.1-flash`。每个候选最多等 12 秒；缺认证、额度/请求错误、超时或无效 JSON 会尝试下一项。会话日志只记录各候选的失败类别，不记录原始错误或认证信息。全失败不等于停止决定，已跟踪的证明结果仍可唤醒。若交接明确标出一个任务图中当前可执行的检查点动作，且仍在预算内（有正在运行或排队的证明任务时，还须明确声明该动作不依赖任何任务结果、也不修改任务正在处理的路线），每次显式开始／继续最多兜底接续一次；否则不自动开启探索轮，目标不结案。
- `--goal-evaluator-models off`（或环境变量设为 `off`）关闭自动接续，无定时兜底；手动「继续目标」仍可使用。
- 每次显式开始/继续最多自动接续 6 轮，连续三轮无新的已完成事项或有证据的路线尝试会停止自主探索（未收取的任务结果除外，仍受总轮数限制）。同一进展阶段完全相同的模型建议不重复派发。`continue` 必须有具体行动，`wait` 必须有具体唤醒条件。普通进度查询不发起新执行链。模型只看有界的目标摘要、可执行项、后台任务元数据和轮末交接（本轮证据、立即可做事项、阻塞/唤醒条件与结束原因）；这些内容会发给所选提供商。模型不能结案、改证明状态或代替用户批准。

## 依赖

- 内部：无
- peer：`@earendil-works/pi-coding-agent`

## 说明

与 dashboard 的目标图谱页共用同一份状态。

## 加载

在 `settings.json` 里列出包，或写进 `extensions.config.json` 的 `loadOrder`；
Pi 会直接加载本包的 TS 入口（`package.json` 的 `pi.extensions`），不需要编译。
