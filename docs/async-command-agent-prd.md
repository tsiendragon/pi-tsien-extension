# Pi 异步命令与 Agent 交互 PRD

- 状态：阶段一、阶段二已实现；阶段三待 Review
- 版本：v0.5
- 日期：2026-08-18
- 范围：Pi TUI、pi-zero Powerline 集成、Bash Tool、用户 Shell、后台任务生命周期、主 Agent 消息路由

## 1. 摘要

当前 Pi 执行 Bash Tool 时，操作系统子进程和 TUI 都是异步的，但主 Agent 的控制流仍需等待 Tool Result。用户可以继续编辑和提交消息，不过消息只会进入 `steer` 或 `followUp` 队列，直到当前工具批次结束后才交给模型。

本 PRD 不把所有命令改成无条件并发，而是采用与 Claude Code 相近的双模式：

- **前台命令**：默认行为，主 Agent 等待结果，适合短命令和必须立即消费结果的命令。
- **后台任务**：命令独立运行，立即返回任务 ID，主 Agent 可以继续响应用户。

产品分三个阶段交付：

1. **阶段一——运行状态可见且可查看输出**：在现有 powerline 上方持续显示正在执行的命令、开始时间和耗时；输入框为空时可用方向键聚焦命令并查看实时输出，不改变命令执行语义。
2. **阶段二——显式后台任务**：增加后台命令启动、查询、读取输出和取消能力；主 Agent 可在后台命令运行时继续工作。
3. **阶段三——前台命令动态后台化**：支持类似 Claude Code 的 `Ctrl+B`，把已经运行的 Bash 命令转入后台，并提供统一 `/tasks` 管理界面。

三个阶段必须可以独立发布和回退。阶段二不依赖阶段三；即使最终不修改 Pi 核心，用户也能通过显式后台 Tool 获得主要异步能力。

## 2. 背景与现状

### 2.1 当前执行模型

当前 Pi 的 Bash Tool 使用异步子进程执行并持续发送输出更新，但 Agent Loop 会等待 Tool Promise 完成：

```text
LLM 生成 Tool Call
        ↓
启动 Bash 子进程
        ↓
等待 Tool Result  ← 主 Agent 控制流停在这里
        ↓
下一次 LLM 请求
```

同一条 Assistant Message 中的多个 Tool 默认可以并行执行，但 Agent 必须等待该批次全部完成后才能进入下一轮模型请求。

### 2.2 当前用户交互

Agent 运行期间：

- TUI 仍可编辑输入。
- 按 `Enter` 提交的普通消息进入 `steer` 队列。
- `Alt+Enter` 提交的消息进入 `followUp` 队列。
- `Esc` 中止当前 Agent 运行，并通过 AbortSignal 终止前台 Bash 进程。
- Extension Command 可以立即执行。
- `/btw` 可以通过独立会话回答侧问，但不能代替主 Agent 继续当前任务。

因此，当前体验属于“界面可交互、主 Agent 不可并行响应”。

### 2.3 当前展示问题

Pi 会在 transcript 中展示 Tool Call 和实时输出，但缺少靠近输入区的持续状态：

- 长 transcript 下，用户不容易看到当前究竟在运行什么。
- 多个 Tool 并行时，用户需要展开 Tool 区域才能确认具体命令。
- Powerline 只展示模型、上下文和机器状态，没有当前命令。
- 用户不知道 `Enter` 是排队、`Esc` 是中止，也没有“转入后台”的入口。

### 2.4 当前 TUI 与 Powerline 实现基线

当前环境不是直接显示 Pi 原生 Footer，而是由 `pi-zero` 接管 Powerline：

```text
Pi pending messages
Pi statusContainer
widgetAbove
├─ pi-zero: powerline-status
└─ pi-zero: powerline-top
Editor
widgetBelow
└─ pi-zero: powerline-secondary（当前为空）
原生 Footer（被 pi-zero 替换为空组件）
```

实际链路：

```text
extensions/context-powerline.ts
  → ctx.ui.setStatus(model-info / context-threshold / machine-status)
  → Pi FooterDataProvider
  → pi-zero 读取 extension statuses
  → pi-zero powerline-top Widget
```

当前 `~/.pi/agent/settings.json` 的有效配置为：

- 加载本地 `pi-zero` 和 `pi-tsien-extension` package。
- `powerline.preset` 为 `full`。
- `powerline.placement` 未显式填写；`pi-zero` 默认解析为 `above`。
- 主行左侧为模型、Shell 模式、Git 和消息队列。
- 主行右侧为 Extension 状态、会话耗时和机器状态。
- 没有 secondary 布局内容，因此输入框下方没有第二条 Powerline。

所以当前可见顺序已经是“状态/命令区域 → Powerline → 输入框”，阶段一不得再移动 Footer 或 Powerline。需要解决的是同一 `widgetAbove` 容器内的稳定排序：`pi-zero` 先注册 Powerline，后注册的独立命令 Widget 默认会落在 Powerline 与输入框之间，不能只依赖 `setWidget()` 的插入顺序。

## 3. 问题定义

需要解决以下四类问题：

1. **状态不可见**：长命令运行时，当前命令和耗时没有固定展示位置。
2. **交互语义不明确**：用户可以输入，但不知道消息何时会被主 Agent 消费。
3. **前台命令阻塞主 Agent**：测试、构建、开发服务器等命令可能运行数分钟甚至不退出。
4. **缺少任务生命周期**：没有后台任务 ID、输出文件、查询、取消和退出清理机制。

## 4. 产品原则

1. **前台默认**：不能自动把所有 Bash 命令转入后台。
2. **显式异步**：后台执行必须由用户、模型参数或 `Ctrl+B` 明确触发。
3. **协议完整**：每个 Tool Call 必须及时产生且只产生一个 Tool Result。
4. **状态靠近输入区**：运行状态固定显示在现有 powerline 上方，不依赖 transcript 滚动位置。
5. **Powerline 完全隔离**：命令 UI 不修改现有 powerline 的内容、字段顺序、样式、位置或刷新逻辑；通过 `pi-zero` 的前置插槽保持“命令 → powerline → 输入框”。
6. **输入优先**：只有输入框完全为空时，方向键才可把焦点切换到命令列表；输入非空时保持原编辑行为。
7. **不隐藏风险**：后台命令与主 Agent 共享工作目录，可能修改文件，界面必须明确提示。
8. **可取消、可回收**：所有任务都有取消路径，Session 关闭后不能遗留孤儿进程。
9. **输出有界**：前台预览和后台输出都只在内存保留有限尾部内容，后台完整输出写入文件。
10. **颜色不是唯一信号**：运行、成功、失败、取消必须同时使用文字或符号表达。
11. **阶段独立**：每一阶段都能单独发布、验证和回退。

## 5. 目标

### 5.1 用户目标

- 无需滚动 transcript 即可确认当前命令、开始时间、运行模式和耗时。
- 输入为空时使用方向键选择运行命令，并查看其实时输出。
- 在长命令运行期间继续输入消息。
- 把适合长期运行的命令交给后台任务，并继续与主 Agent 对话。
- 随时查看后台任务状态、最近输出和完整日志。
- 能取消单个任务或全部任务。

### 5.2 系统目标

- 保持现有前台 Tool 协议和默认行为兼容。
- 后台任务启动后立即向模型返回任务 ID。
- 统一管理 Agent Bash Tool 与用户 `!command` 的进程生命周期。
- 支持并行命令、超时、非零退出、取消和 Session 关闭。
- 不增加明显的 TUI CPU 占用或输出内存增长。

## 6. 非目标

- 不让同一个 Tool Call 在没有 Tool Result 的情况下继续下一次模型请求。
- 不自动判断任意 Shell 命令是否“安全后台化”。
- 不保证后台任务与主 Agent 后续文件修改之间不存在业务冲突。
- 不在首版跨 Pi 进程或跨机器恢复后台任务。
- 不把后台 Bash 等同于 subagent、workflow 或 Taskspace。
- 不提供完整终端模拟器，不支持向后台进程发送任意交互式按键。
- 不追求像素级复制 Claude Code。

## 7. 核心概念

### 7.1 前台命令

由 Agent 或用户启动，当前 Agent 回合等待其最终结果。适合：

- `git status`
- `rg ...`
- 一次性 lint
- 结果会直接决定下一步动作的短命令

### 7.2 后台任务

独立运行并立即返回任务 ID 的命令。主 Agent 不等待进程退出。适合：

- 长时间测试
- 构建和打包
- 开发服务器
- 文件监听器
- 长时间数据处理

### 7.3 转入后台

把已经启动的前台 Bash 命令切换为后台任务：

- 子进程继续运行，不重启命令。
- 原 Tool Call 立即结束，并返回任务 ID。
- 后续完成信息作为任务事件出现，不再产生第二个 Tool Result。

### 7.4 任务所有者

```ts
type CommandOwner =
  | "agent-bash"
  | "user-shell"
```

所有者决定任务在 transcript 中的展示方式，但不改变底层进程管理规则。

## 8. 统一数据模型

```ts
type CommandMode = "foreground" | "background"

type CommandTaskState =
  | "starting"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timed_out"

type CommandExitReason =
  | "exit"
  | "signal"
  | "timeout"
  | "session_shutdown"
  | "output_limit"

interface CommandTask {
  id: string
  owner: CommandOwner
  toolCallId?: string
  sessionId: string
  command: string
  cwd: string
  mode: CommandMode
  state: CommandTaskState
  startedAt: number
  backgroundedAt?: number
  endedAt?: number
  pid?: number
  exitCode?: number | null
  exitReason?: CommandExitReason
  outputFile?: string
  outputBytes: number
  tail: string
  timeoutMs?: number
}
```

要求：

- `id` 在当前 Pi 进程内唯一，默认使用短前缀，例如 `bash-a81f`。
- `command` 和 `cwd` 只在本地展示，不进入遥测。
- `tail` 有严格字节上限；前台完整输出继续由 Tool transcript 保存，后台完整输出保存在 `outputFile`。
- 完成状态不可逆。
- 同一 OS 进程只能归属一个 `CommandTask`。

## 9. 目标交互总览

### 9.1 一个前台命令

输入框为空、焦点仍在编辑器时：

```text
⠋ Bash · Aug 05:12:02pm: npm test (12m)              ↑ 输出 · Enter 排队 · Ctrl+B 后台 · Esc 中断
gpt-5.6-sol|max > ⎇ main ███░░░│░░░░░ 65.7k→136k/272k > ◷ 4h29m > M/C 36/11%
────────────────────────────────────────────────────────────
> _
────────────────────────────────────────────────────────────
```

每个命令显示本地开始时间，格式固定为 `MMM hh:mm:ssa`，例如 `Aug 05:12:02pm`。运行时长放在命令后，例如 `(12m)`。快捷键提示固定在行末；空间不足时优先截断命令，不截断关键快捷键。

### 9.2 多个命令

编辑器焦点下的默认状态：

```text
⠋ 2 个前台命令运行中                                ↑ 选择 · Ctrl+B 后台 · Esc 中断
    · Aug 05:12:02pm: npm test (2m53s)
    · Aug 05:13:03pm: npm run build (34s)
gpt-5.6-sol|max > ⎇ main ███░░░│░░░░░ 65.7k→136k/272k > ◷ 4h29m > M/C 36/11%
────────────────────────────────────────────────────────────
> _
────────────────────────────────────────────────────────────
```

快捷键提示放在摘要行末，每个命令行只显示开始时间、命令和运行时长。

### 9.3 方向键聚焦命令

输入框完全为空时按 `↑`，焦点进入命令列表，并先选中离输入框最近的最后一条命令：

```text
⠋ 2 个前台命令运行中                           ↑↓ 选择 · Enter 输出 · Esc 输入框
    · Aug 05:12:02pm: npm test (2m53s)
  › · Aug 05:13:03pm: npm run build (34s)
gpt-5.6-sol|max > ⎇ main ███░░░│░░░░░ 65.7k→136k/272k > ◷ 4h29m > M/C 36/11%
────────────────────────────────────────────────────────────
> _
────────────────────────────────────────────────────────────
```

- `↑/↓` 在命令之间移动选中项。
- 在最后一条命令继续按 `↓`，或按 `Esc`，焦点返回输入框。
- `Enter` 打开选中命令的实时输出。
- 输入框只要包含任意字符，包括空格，方向键就完全保持现有编辑行为。
- 有运行命令且输入为空时，`Ctrl+↑/Ctrl+↓` 用于浏览输入历史，作为普通 `↑/↓` 被命令列表占用后的后备操作。
- 选中命令结束后，焦点移动到最近的仍运行命令；没有剩余命令时自动返回输入框。

### 9.4 查看命令输出

按 `Enter` 后，在 powerline 上方展开所选命令的实时输出：

```text
⠋ Output 2/2 · Aug 05:13:03pm: npm run build · running (34s)       ←→ 切换 · Esc 返回
┌─ Recent output ───────────────────────────────────────────────────────────────────────┐
│ vite v6.1.0 building for production...                                               │
│ transforming (128) src/session.ts                                                    │
│ ✓ 127 modules transformed                                                            │
└─ Live · ↑↓ 滚动 · PageUp/PageDown 翻页 · End 跟随最新 · +8 new lines ────────────────┘
gpt-5.6-sol|max > ⎇ main ███░░░│░░░░░ 65.7k→136k/272k > ◷ 4h29m > M/C 36/11%
────────────────────────────────────────────────────────────
> _
────────────────────────────────────────────────────────────
```

- 默认自动跟随最新输出。
- 用户按 `↑`、`PageUp` 等向上滚动后暂停自动跟随，并显示新增行数。
- `End` 恢复跟随最新输出。
- `←/→` 在其他运行命令之间切换，保留各自滚动位置。
- `Esc` 返回命令列表，并保留原选中项；再次按 `Esc` 返回输入框。
- 阶段一只保留最多 50KB 的输出尾部；更早内容显示“已截断”，完整 Tool 输出仍可在 transcript 中查看。

### 9.5 后台任务

后台任务沿用同一套时间戳、方向键选择和输出查看规则：

```text
◷ 2 个后台任务运行中                                 ↑ 选择 · /tasks 管理
    · Aug 05:12:02pm: bash-a81f · npm test (2m53s)
    · Aug 05:13:03pm: bash-c204 · vite --host (1m18s)
gpt-5.6-sol|max > ⎇ main ███░░░│░░░░░ 65.7k→136k/272k > ◷ 4h29m > M/C 36/11%
────────────────────────────────────────────────────────────
> _
────────────────────────────────────────────────────────────
```

### 9.6 UI 区域定义

命令区域使用独立组件，通过 `pi-zero` 管理的 `pre-powerline` 插槽固定放在现有 powerline 正上方；powerline 与输入框保持当前布局：

```text
┌─ Transcript ───────────────────────────────────────────────┐
│ assistant: 我正在运行测试……                               │
│ tool: bash                                                 │
│ output: ...                                                │
├─ Running commands Widget ──────────────────────────────────┤
│ ⠋ Bash · Aug 05:12:02pm: npm test (2m53s)        ↑ 输出   │
└────────────────────────────────────────────────────────────┘
gpt-5.6-sol|max > ⎇ main ███░░░│░░░░░ 65.7k→136k/272k > ◷ 4h29m > M/C 36/11%
────────────────────────────────────────────────────────────
> _
────────────────────────────────────────────────────────────
```

共同布局规则：

- 不修改 `context-powerline.ts`，不调用 `setStatus()` 或 `setFooter()` 覆盖现有状态。
- Powerline 的内容、字段顺序、样式、位置和 2 秒机器状态刷新逻辑保持不变。
- 目标顺序固定为 `command component → pi-zero powerline-top → editor`，由 `pre-powerline` 插槽保证，不依赖 Widget 注册先后。
- 没有前台命令、后台任务或短暂任务通知时，不渲染 Widget，不占空白行。
- 折叠态 Widget 最多占 5 行：1 行摘要和最多 4 行命令；选中项移动到窗口外时列表随之滚动。
- 输出展开态最多占终端高度的 40%，最低保留输入框和完整 powerline。
- 前台命令排在后台任务之前；同组内按开始时间排序，最早开始的任务在前。
- 折叠态不显示 stdout/stderr；只有进入输出视图后才显示所选命令的有限尾部。
- 命令中的换行、制表符和连续空白统一压缩为单个空格。
- 快捷键提示右对齐；宽度不足时先截断命令，再缩短非关键文案，不能挤占 powerline。
- 命令按终端显示宽度截断，末尾使用 `…`；完整命令仍可在 Tool 详情或 `/tasks` 中查看。
- 开始时间使用本地时区和 `MMM hh:mm:ssa` 格式。
- 运行耗时小于 1 分钟显示秒，超过 1 分钟显示 `XmYYs`，超过 1 小时显示 `XhYYm`。
- 状态必须同时包含符号和文字，不仅依赖颜色。
- 非交互模式不渲染 Widget，但任务事件和 Tool Result 保持一致。
- 后续章节为节省篇幅而省略 powerline 时，均表示“现有 powerline 原样保留”，不是隐藏或替换它。

统一状态示例：

| 状态 | 符号 | 示例 |
|---|---:|---|
| 前台运行 | `⠋` | `⠋ Foreground · npm test · 42s` |
| 后台运行 | `◷` | `◷ Background · bash-a81f · 3m12s` |
| 成功 | `✓` | `✓ Succeeded · bash-a81f · exit 0` |
| 失败 | `!` | `! Failed · bash-a81f · exit 1` |
| 已取消 | `×` | `× Cancelled · bash-a81f` |
| 已超时 | `◷` | `◷ Timed out · bash-a81f · 30m` |

以上 ASCII 图是布局和信息层级的验收基准；具体边框字符与颜色跟随当前 Pi 主题。

## 10. 阶段一：运行状态可见

### 10.1 阶段目标

在不改变 Agent 执行模型的前提下，让用户始终知道：

- 当前是否有 Bash Tool 在运行。
- 当前运行的命令、开始时间和耗时是什么。
- 输入为空时如何用方向键聚焦命令。
- 如何查看所选命令的实时输出。
- 普通输入会排队，编辑器焦点下的 `Esc` 会中止。

### 10.2 范围

阶段一包含：

1. 新增独立 `running-commands` Extension。
2. 监听 `tool_execution_start`、`tool_execution_update`、`tool_execution_end`。
3. 只跟踪 `toolName === "bash"` 的 Agent Bash Tool。
4. 向 `pi-zero` 的 `pre-powerline` 插槽注册命令组件，在现有 powerline 上方显示命令状态。
5. 为每个命令显示本地开始时间和动态运行时长。
6. 支持同一批次多个并行 Bash Tool 和可滚动的选中窗口。
7. 使用 `CustomEditor` 的兼容包装器：输入为空时拦截首次 `↑` 进入命令列表；进入命令焦点后再路由选择和输出查看按键。
8. 从 `tool_execution_update.partialResult` 维护每个命令最多 50KB 的实时输出尾部。
9. 支持命令列表焦点和输出查看焦点，保留每个命令的滚动位置。
10. 命令结束后立即更新列表、焦点和输出状态。
11. Session 切换、Reload 和 Shutdown 时注销插槽组件，并清理输出缓存与 Timer。

阶段一不包含：

- 后台执行。
- `Ctrl+B` 动态后台化；该提示到阶段三才启用。
- `/tasks`。
- 用户直接输入的 `!command` 状态聚合。
- 超过 50KB 尾部的前台输出存档；完整内容仍由现有 Tool transcript 负责。

### 10.3 展示规则

- 一个命令时使用单行：状态、类型、开始时间、命令、耗时、右对齐快捷键提示。
- 多个命令时第一行显示运行数量和右对齐提示，后续每行显示开始时间、命令和耗时。
- 开始时间使用本地时区，格式固定为 `MMM hh:mm:ssa`。
- 折叠态最多展示四条命令；更多命令通过滚动窗口展示，不使用不可选中的静态 `+N` 代替选中项。
- 选中行使用 `›`，不能只依赖背景色。
- 命令参数中的换行、制表符和连续空白统一压缩为空格。
- 空间不足时按“命令正文、次要说明、关键快捷键”的顺序截断，关键快捷键优先保留。
- 不展示环境变量和 PID；PID 只在后续任务详情页展示。
- 命令区紧贴 powerline 上方，不能改变 powerline 的任一状态字段。

建议状态：

```text
⠋ running
✓ succeeded
! failed
× cancelled
◷ timed out
```

阶段一折叠态只显示运行中的命令；最终状态继续使用现有 Tool transcript 展示，避免重复信息。

### 10.4 焦点与按键规则

交互有三个焦点状态：

```text
editor → command-list → command-output
   ↑          ↓                ↓
 输入框      命令选择          输出查看
```

| 当前焦点 | 条件与按键 | 行为 |
|---|---|---|
| Editor | 输入非空时 `↑/↓` | 完全保持 Pi 当前光标和历史行为 |
| Editor | 输入为空、有运行命令时 `↑` | 进入命令列表，选中离输入框最近的最后一条 |
| Editor | 输入为空、有运行命令时 `Ctrl+↑/Ctrl+↓` | 浏览输入历史，不进入命令列表 |
| Command list | `↑/↓` | 在命令之间移动；越过最后一条时返回 Editor |
| Command list | `Enter` | 打开所选命令的输出视图 |
| Command list | `Esc` | 返回 Editor，不中止 Agent |
| Command output | `↑/↓`、`PageUp/PageDown` | 滚动输出并暂停自动跟随 |
| Command output | `←/→` | 切换上一条或下一条运行命令 |
| Command output | `End` | 回到末尾并恢复自动跟随 |
| Command output | `Esc` | 返回命令列表并保留选中项 |

Editor 焦点下保持现有语义：

- `Enter` 发送 `steer`。
- `Alt+Enter` 发送 `followUp`。
- `Esc` 中止当前 Agent 运行。

“输入为空”严格指编辑器内容长度为 0；只包含空格或换行也视为非空，不能抢占方向键。

### 10.5 UI 具体示例

#### 示例 A：输入为空，进入命令列表

进入前：

```text
⠋ 2 个前台命令运行中                                      ↑ 选择 · Esc 中断
    · Aug 05:12:02pm: npm test (2m53s)
    · Aug 05:13:03pm: npm run build (34s)
gpt-5.6-sol|max > ⎇ main ███░░░│░░░░░ 65.7k→136k/272k > ◷ 4h29m > M/C 36/11%
────────────────────────────────────────────────────────────
> _
```

按 `↑` 后：

```text
⠋ 2 个前台命令运行中                           ↑↓ 选择 · Enter 输出 · Esc 输入框
    · Aug 05:12:02pm: npm test (2m53s)
  › · Aug 05:13:03pm: npm run build (34s)
gpt-5.6-sol|max > ⎇ main ███░░░│░░░░░ 65.7k→136k/272k > ◷ 4h29m > M/C 36/11%
────────────────────────────────────────────────────────────
> _
```

#### 示例 B：输入非空，不抢方向键

```text
⠋ Bash · Aug 05:12:02pm: npm test (2m53s)                     Enter 排队 · Esc 中断
gpt-5.6-sol|max > ⎇ main ███░░░│░░░░░ 65.7k→136k/272k > ◷ 4h29m > M/C 36/11%
────────────────────────────────────────────────────────────
> 测试结束后再检查 README_
```

此时 `↑/↓` 只移动编辑器光标或浏览历史，不进入命令列表。

#### 示例 C：查看实时输出

```text
⠋ Output 2/2 · npm run build · running (34s)                         ←→ 切换 · Esc 返回
┌─ Recent output ───────────────────────────────────────────────────────────────────────┐
│ vite v6.1.0 building for production...                                               │
│ transforming (128) src/session.ts                                                    │
└─ Live · ↑↓ 滚动 · PageUp/PageDown 翻页 · End 跟随最新 ───────────────────────────────┘
gpt-5.6-sol|max > ⎇ main ███░░░│░░░░░ 65.7k→136k/272k > ◷ 4h29m > M/C 36/11%
────────────────────────────────────────────────────────────
> _
```

#### 示例 D：窄终端

```text
⠋ 2 commands                         ↑ select
  · Aug 05:12:02pm npm test (2m53s)
  · Aug 05:13:03pm npm run bui… (34s)
<现有 powerline 按自身窄屏规则原样渲染>
────────────────────────────────────
> _
```

不得水平溢出或把一条命令折成多行；窄屏只缩短命令 UI，不修改 powerline 的截断规则。

#### 示例 E：全部命令结束

最后一个命令结束后，命令 Widget 和输出视图消失，焦点自动回到输入框；powerline 不重建、不闪烁，最终状态仍由现有 Tool transcript 表达。

### 10.6 技术边界

建议新增：

```text
extensions/running-commands.ts
extensions/lib/command-ui/command-aware-editor.ts
extensions/lib/command-ui/output-view.ts
```

实现要求：

- `pi-zero` 新增版本化的 `pre-powerline` 组件插槽，由 Powerline 宿主管理组件注册、注销、渲染和销毁。
- 插槽内容渲染在 `powerline-status` 通知之后、`powerline-top` 之前；没有命令时返回空行数组，不占高度。
- `running-commands.ts` 向该插槽注册稳定 key，不得再独立调用 `setWidget(..., { placement: "aboveEditor" })` 依赖 Map 插入顺序。
- 插槽必须把终端宽度和 Theme 传给命令组件，支持右对齐提示、宽度截断和输出视图。
- `pi-zero` Reload、关闭 Powerline 或切换 Session 时必须释放已注册组件；重新启用时可安全重新绑定。
- 当前有效 `powerline.placement` 必须为 `above`；缺省值按 `pi-zero` 现有规则解析为 `above`。若配置为 `below`，命令组件跟随 Powerline，但不宣称满足本 PRD 的目标布局。
- `CommandAwareEditor` 必须继承 Pi `CustomEditor`；非命令焦点状态下，所有输入交给 `super.handleInput()`。
- 命令列表和输出视图共享一个焦点控制器，但不能写入编辑器文本。
- 输出缓存来自 `tool_execution_update.partialResult`，更新需要节流。
- 当前仓库没有其他 `setEditorComponent()` 使用者；若未来出现第二个自定义编辑器，必须显式组合，不能静默覆盖。
- 不修改 `extensions/context-powerline.ts`，命令扩展不得调用 `setStatus()` 或 `setFooter()`。
- Powerline 与命令组件更新失败彼此隔离；命令 UI 异常时只注销命令组件，不影响现有 Powerline。
- 若 `pre-powerline` 插槽不可用，启动时只提示一次兼容性错误并禁用命令 UI；不得改变 Bash Tool 执行语义。

### 10.7 阶段一验收标准

1. Bash Tool 开始后 200ms 内在 `pre-powerline` 插槽出现命令组件。
2. 每条命令显示本地开始时间、动态耗时和经过单行清理的命令。
3. 命令运行前、运行中、查看输出和运行结束后，powerline 的内容、字段顺序、样式、位置和刷新逻辑均不变化。
4. 输入非空时，`↑/↓/Enter/Esc` 保持 Pi 编辑器现有行为。
5. 输入为空且有运行命令时，`↑` 选中离输入框最近的命令。
6. 命令列表中 `↑/↓` 可遍历全部命令，`Enter` 打开输出，`Esc` 返回输入框。
7. 输出视图可实时更新、滚动、暂停跟随、恢复跟随并用 `←/→` 切换命令。
8. 单命令输出尾部内存不超过 50KB，截断状态可见。
9. 两个以上 Bash Tool 并行时数量、时间、排序和选中窗口准确。
10. 选中命令结束时焦点迁移正确，最后一个命令结束时自动返回输入框。
11. 耗时每秒更新，空闲时不存在常驻刷新 Timer。
12. `/new`、`/resume`、`/reload` 和退出后没有残留插槽组件、输出缓存或 Timer。
13. 不改变 Tool Result、消息队列、Agent 执行语义和 Editor 焦点下的 `Esc` 行为。
14. `npm run check` 通过。
15. 单命令、多命令、列表聚焦、输出查看、窄终端和空闲状态与 9.1—9.4、10.5 的 UI 示例一致。

### 10.8 阶段一发布门槛

- TUI 普通模式和 fullscreen 模式均通过手工验证。
- 80、120、200 列终端宽度下不溢出。
- 验证空输入、非空输入、多行输入、输入历史和 IME 中文输入不被错误抢焦点。
- 高频 Tool Update 不导致 Widget 高频重建；耗时更新最多每秒一次，输出刷新需要节流。
- 验证普通编辑器、命令列表和输出视图三种焦点之间不存在按键泄漏。
- 对比启用扩展前后的 Powerline 文本和位置快照必须完全一致；只允许在其上方新增命令区域。

## 11. 阶段二：显式后台任务

### 11.1 阶段目标

允许 Agent 明确启动后台命令，Tool 立即返回任务 ID，使主 Agent 能在命令运行期间继续响应用户。

### 11.2 用户入口

阶段二提供四个 Tool：

```text
background_command_start
background_command_status
background_command_output
background_command_cancel
```

建议输入与输出：

```ts
background_command_start({
  command: "npm test",
  title?: "运行测试",       // 可选；用于 UI 和完成通知
  timeout?: 1800,
})

// Tool Result
{
  taskId: "bash-a81f",
  title: "运行测试",
  status: "running",
  outputFile: "/tmp/pi-background/bash-a81f.log"
}
```

`title` 是可选的人类可读短标题，最多 120 个字符；会清理 ANSI/控制字符并折叠空白。未传或标题为空时回退到清理后的 Bash 命令。状态和输出 Tool 同时返回完整 `command` 字段；完成摘要优先显示标题。

`background_command_output` 默认返回有限尾部：

```ts
background_command_output({
  taskId: "bash-a81f",
  tailLines?: 200,
})
```

完整输出由现有 Read Tool 按需读取 `outputFile`。

### 11.3 启动语义

- 仅当用户明确要求后台运行，或模型明确选择后台 Tool 时启动。
- 不根据预计耗时自动切换。
- 启动成功并获得 PID 后，Tool 立即返回。
- 启动失败时 Tool 以错误结束，不创建任务 ID。
- 后台任务使用独立 AbortController，不继承原 Tool Call 结束后的临时生命周期。
- 权限检查、工作目录和环境处理必须与普通 Bash Tool 一致。

### 11.4 Agent 继续执行

后台 Tool 返回任务 ID 后，Agent Loop 获得正常 Tool Result，可以立即进入下一次模型请求：

```text
LLM 调用 background_command_start
        ↓
启动进程并登记任务
        ↓
立即返回 taskId
        ↓
主 Agent 继续响应
        │
        └──────── 后台进程继续运行
```

完成时：

1. 更新任务状态。
2. 更新 Widget。
3. 在 TUI 发出一次本地通知。
4. 将简短完成摘要以 `followUp` 方式加入 Agent 上下文。
5. Agent 忙碌时等待当前工作结束，空闲时自动触发新的模型请求，让 Agent 读取输出并继续任务。

完成摘要不得包含完整输出或输出路径，只包含任务 ID、标题、结果、耗时和下一步动作：

```text
Background task bash-a81f [运行测试] finished: exit=0 after 3m12s. Read its output with background_command_output and continue the task.
```

### 11.5 Widget 扩展

阶段二在阶段一命令列表中加入后台任务，时间戳和快捷键仍使用同一格式：

```text
⠋ 1 个前台 · 1 个后台任务                              ↑ 选择 · Enter 输出
    · Aug 05:12:02pm: Foreground · npm run lint (12s)
    · Aug 05:09:21pm: Background · bash-a81f · 运行测试 (2m53s)
```

规则：

- 前台命令优先显示，后台任务随后显示。
- 输入为空时，`↑/↓` 可以连续选择前台命令和后台任务。
- `Enter` 对两种任务都打开相同输出视图；后台任务从日志尾部读取，前台命令从内存尾部读取。
- 输出视图中 `←/→` 可以跨前台和后台任务切换。
- 已完成任务短暂显示一次通知后从常驻 Widget 移除。
- 失败任务使用 `!`，但不能只依赖颜色。
- Powerline 继续原样位于命令列表与输入框之间。
- 后台任务优先显示 `title`；未提供标题时显示清理后的 Bash 命令。状态、输出 Tool 和完成摘要同时返回或保留原始 `command`。

### 11.6 UI 具体示例

#### 示例 A：后台任务启动成功

Tool 立即返回任务 ID，Widget 随后显示后台任务：

```text
◷ Background · Aug 05:12:02pm: bash-a81f · 运行测试 (3s)        ↑ 输出 · Esc 输入框
gpt-5.6-sol|max > ⎇ main ███░░░│░░░░░ 65.7k→136k/272k > ◷ 4h29m > M/C 36/11%
────────────────────────────────────────────────────────────
> 接着帮我检查配置文件_
────────────────────────────────────────────────────────────
```

Tool transcript 仍显示 `running · bash-a81f · /tmp/pi-background/…`。阶段二尚未提供 `/tasks`，用户可以用方向键直接查看输出，也可以通过自然语言让 Agent 调用状态、输出或取消 Tool。

#### 示例 B：前台与后台任务同时存在

```text
⠋ 1 个前台 · 2 个后台任务                         ↑ 选择 · Enter 输出 · Esc 中断前台
    · Aug 05:14:22pm: Foreground · npm run lint (12s)
    · Aug 05:12:02pm: Background · bash-a81f · npm test (2m53s)
    · Aug 05:13:03pm: Background · bash-c204 · 开发服务器 (1m18s)
gpt-5.6-sol|max > ⎇ main ███░░░│░░░░░ 65.7k→136k/272k > ◷ 4h29m > M/C 36/11%
────────────────────────────────────────────────────────────
> _
────────────────────────────────────────────────────────────
```

要求：前台命令始终排在后台任务之前；命令列表焦点下的 `Esc` 只返回输入框，Editor 焦点下的 `Esc` 中断前台 Agent，但不得取消已经登记的后台任务。

#### 示例 C：后台任务完成通知

成功任务从常驻 Widget 移除，并显示一次本地通知：

```text
┌─ Notification ─────────────────────────────────────────────┐
│ ✓ Background task finished                                │
│   运行测试 · bash-a81f · exit 0 · 3m12s                   │
│   Output: /tmp/pi-background/bash-a81f.log                 │
└────────────────────────────────────────────────────────────┘
```

通知默认显示 5 秒，可由用户关闭；通知消失后不再占输入区。下一次 Agent Turn 仍只注入一次文本摘要。

#### 示例 D：后台任务失败

```text
┌─ Notification ─────────────────────────────────────────────┐
│ ! Background task failed                                  │
│   Linux 构建 · bash-f331 · exit 1 · 48s                   │
│   让 Agent 读取 bash-f331 的输出以查看错误                 │
└────────────────────────────────────────────────────────────┘
```

超时、取消和输出超限使用同一结构，第二行分别显示 `timed out`、`cancelled` 或 `output limit reached`。

#### 示例 E：达到并发上限

此场景不新增 Widget 条目，而是在 Tool Result 和本地通知中明确失败：

```text
┌─ Notification ─────────────────────────────────────────────┐
│ ! Cannot start background command                         │
│   当前 Session 已有 4 个后台任务；请先等待或取消一个任务。 │
└────────────────────────────────────────────────────────────┘
```

#### 示例 F：共享工作目录提示

当前 Session 首次启动后台任务时显示一次，不对每个任务重复弹出：

```text
┌─ Notice ───────────────────────────────────────────────────┐
│ ◷ 后台任务与主 Agent 共享当前工作目录                     │
│   两者同时修改同一文件可能产生冲突。                       │
└────────────────────────────────────────────────────────────┘
```

### 11.7 输出管理

- stdout 与 stderr 按到达顺序写入同一日志文件，与现有 Bash Tool 保持一致。
- 内存尾部默认最多 50KB。
- 输出文件必须设置总上限；建议默认 1GB，可配置。
- 达到上限后终止任务，状态为 `failed`，`exitReason="output_limit"`。
- 日志文件名不得包含原始命令。
- 日志目录按 Session 隔离，并在 Session Shutdown 时清理。

### 11.8 生命周期管理

默认策略：后台任务属于当前 Session。

| 操作 | 行为 |
|---|---|
| `/new` | 取消旧 Session 全部后台任务 |
| `/resume` | 取消当前 Session 任务后切换 |
| `/reload` | 任务管理器在同一 Pi 进程内保留，Reload 后重新绑定 UI |
| 正常退出 | 终止全部后台任务并等待进程组退出 |
| `SIGTERM`/`SIGHUP` | 尽力终止全部后台任务 |
| 进程崩溃 | 不保证恢复；启动时清理可确认属于旧进程的临时文件 |

阶段二不支持任务跨 Pi 进程存活。

### 11.9 并发与资源限制

建议默认值：

- 每个 Session 最多 4 个后台 Bash 任务。
- 全部后台任务共享同一并发上限。
- 超出上限时明确拒绝，不静默排队。
- 单任务默认无超时，但 Tool 描述必须鼓励为测试和构建设置合理超时。
- 取消操作必须作用于整个进程组，而不只是 Shell 父进程。

### 11.10 安全要求

- 后台 Tool 必须经过与 Bash Tool 相同的 `tool_call` Gate。
- 命令、cwd 和环境在实际 Spawn 前完成最终权限检查。
- 任务 ID 只能访问当前 Session 的任务。
- 不允许通过任意路径参数读取其他任务日志。
- UI 必须提示后台任务与主 Agent 共享工作目录，可能同时修改文件。
- 遥测不得记录命令正文、输出正文、环境变量或日志路径。

### 11.11 阶段二验收标准

1. 后台进程启动后 500ms 内返回任务 ID，不等待命令结束。
2. 主 Agent 能在任务仍为 `running` 时完成新的模型响应。
3. 状态、输出和取消 Tool 对合法任务 ID 返回一致结果。
4. 非零退出、超时、取消和输出超限均产生正确终态。
5. 完整输出写入文件，内存尾部不超过上限。
6. 取消后整个进程组退出，不遗留子进程。
7. Session Shutdown 后后台任务数为零。
8. 后台完成不会默认自动触发模型请求。
9. 下一次 Agent Turn 能看到一次且仅一次的完成摘要。
10. 阶段一前台命令行为保持不变。
11. 输入为空时可在前台和后台任务之间连续选择，并查看任一任务的实时输出。
12. 后台任务行显示开始时间、任务 ID、命令和运行时长，且不改变 powerline。
13. 启动、混合运行、完成、失败、并发超限和共享目录提示与 11.6 的 UI 示例一致。

### 11.12 阶段二发布门槛

- 在 Linux 和 macOS 验证进程组终止。
- Windows 若无法保证同等进程树终止能力，必须明确标记实验状态。
- 完成 30 分钟长任务、持续无输出任务和高输出任务测试。
- 进程退出、Reload、Session 切换均无孤儿任务。

## 12. 阶段三：前台命令动态后台化

### 12.1 阶段目标

支持类似 Claude Code 的交互：当前前台 Bash 命令运行时间过长时，用户按 `Ctrl+B` 即可让它继续在后台执行，同时解除主 Agent 等待。

### 12.2 用户体验

一个前台 Bash 运行时：

```text
⠋ Bash · Aug 05:12:02pm: npm test (2m53s)          ↑ 输出 · Ctrl+B 后台 · Esc 中断
gpt-5.6-sol|max > ⎇ main ███░░░│░░░░░ 65.7k→136k/272k > ◷ 4h29m > M/C 36/11%
────────────────────────────────────────────────────────────
> _
────────────────────────────────────────────────────────────
```

用户按 `Ctrl+B` 后，子进程不重启，命令行原地切换为后台状态；powerline 不刷新、不重建：

```text
✓ 已转入后台 · bash-a81f
◷ Background · Aug 05:12:02pm: bash-a81f · npm test (2m54s)       ↑ 输出 · /tasks 管理
gpt-5.6-sol|max > ⎇ main ███░░░│░░░░░ 65.7k→136k/272k > ◷ 4h29m > M/C 36/11%
────────────────────────────────────────────────────────────
> _
────────────────────────────────────────────────────────────
```

原 Tool Result 对模型表示：

```text
Command moved to background as task bash-a81f.
Use background_command_status or background_command_output to inspect it.
```

主 Agent 随即继续执行，并消费已经提交的 `steer` 消息。转入后台确认通知默认显示 3 秒，不影响命令列表和 powerline。

### 12.3 多命令行为

`Ctrl+B` 根据当前焦点决定目标：

- Command list 焦点：转入后台当前选中的前台命令。
- Command output 焦点：转入后台当前正在查看的前台命令。
- Editor 焦点且只有一个前台命令：直接后台化。
- Editor 焦点且有多个前台命令：打开轻量选择器。
- 当前选中项已经是后台任务：不重复处理，显示“任务已在后台”。

Editor 焦点下的多命令选择器：

```text
┌─ Move command to background ───────────────────────────────┐
│ > ⠋ Aug 05:12:02pm: npm test                    2m53s     │
│   ⠋ Aug 05:13:03pm: npm run build                  34s     │
│   ⠋ Aug 05:13:25pm: npm run lint                   12s     │
│   ◉ All 3 foreground Bash commands                          │
├────────────────────────────────────────────────────────────┤
│ ↑↓ 选择 · Enter 确认 · Esc 返回                            │
└────────────────────────────────────────────────────────────┘
```

规则：

- 选择器覆盖输入区，但保留原输入草稿，关闭后恢复光标位置。
- 选择单个命令只释放该 Tool Call。
- Agent 仍会等待其他未完成前台 Tool。
- 选择全部会把当前批次所有运行中的 Bash 转为后台。
- 已完成或正在结束的命令立即从选择器移除。
- 选择器打开期间若只剩一个命令，界面直接收敛为该命令的确认操作，不自动后台化。
- `Esc` 只关闭选择器，不中断命令。
- 只要存在前台 Bash，`Ctrl+B` 的后台化语义优先于 Pi 默认的“光标左移”；没有前台 Bash 时恢复原按键行为。

### 12.4 核心实现要求

阶段三需要 Pi 核心提供可控制的执行句柄：

```ts
interface ForegroundCommandHandle {
  toolCallId: string
  taskId: string
  state: "running" | "backgrounded" | "finished"
  background(): Promise<CommandTask>
  cancel(): Promise<void>
}
```

`background()` 必须满足：

1. 不重启子进程。
2. 将进程所有权从 Tool Execution 转交给 Background Task Manager。
3. 立即完成原 Tool Promise。
4. 停止向已经完成的 Tool Row 发送 partial update。
5. 后续输出只进入后台日志和 Widget。
6. 后台完成时不产生第二个 Tool Result。

### 12.5 Tool 协议

动态后台化不是“缺少 Tool Result 的异步 Tool”，而是提前完成原 Tool：

```text
Tool Call: bash(npm test)
Tool Result: moved to background as bash-a81f
```

后台完成通过任务事件表达：

```text
Task Event: bash-a81f succeeded, exit=0
```

任何 Provider 都只能看到一对合法的 Tool Call / Tool Result，避免破坏 Anthropic、OpenAI 或其他 Provider 的消息协议。

### 12.6 用户 Shell 支持

阶段三把用户直接输入的 `!command` 纳入同一任务管理器：

- 前台 `!command` 显示在同一 Widget。
- 运行期间可以按 `Ctrl+B` 转入后台。
- 后台后不自动触发主 Agent 响应。
- 命令结束后输出仍可按现有设置加入 Session Context。
- 同一 Session 可以同时存在 Agent Bash 与用户 Shell 后台任务。

用户 Shell 使用 `[user]` 标记，避免与模型调用的 Bash 混淆：

```text
⠋ 1 个前台 · 1 个后台任务                       ↑ 选择 · Enter 输出 · Ctrl+B 后台
    · Aug 05:14:22pm: Foreground [user] · !pnpm dev (18s)
    · Aug 05:12:02pm: Background [agent] · bash-a81f · npm test (3m12s)
gpt-5.6-sol|max > ⎇ main ███░░░│░░░░░ 65.7k→136k/272k > ◷ 4h29m > M/C 36/11%
────────────────────────────────────────────────────────────
> _
────────────────────────────────────────────────────────────
```

### 12.7 `/tasks` 管理界面

#### 任务列表

新增 `/tasks`，默认选中第一条运行中的任务：

```text
┌─ Background tasks (3) ─────────────────────────────────────┐
│ > ● Aug 05:12:02pm · bash-a81f [agent] npm test (3m12s)   │
│   ● Aug 05:13:03pm · bash-c204 [user] vite --host (1m45s)  │
│   ! Aug 05:10:41pm · bash-f331 [agent] npm run build (48s) │
├────────────────────────────────────────────────────────────┤
│ Enter 详情 · c 取消 · k 取消全部 · r 刷新 · Esc 关闭       │
└────────────────────────────────────────────────────────────┘
```

列表规则：

- 排序为运行中、失败、成功、取消；同状态按开始时间倒序。
- 每一行都显示本地开始时间；运行任务实时更新耗时，但不在列表中滚动输出。
- 已结束任务保留到当前 Session 结束，便于查看日志和退出原因。
- `[agent]` 表示模型调用的 Bash，`[user]` 表示用户直接执行的 `!command`。
- 命令过长时单行截断，选中后进入详情查看完整命令。

#### 任务详情

```text
┌─ Task bash-a81f ────────────────────────────────────────────┐
│ Status       ● running                                     │
│ Owner        agent-bash                                    │
│ Started      Aug 05:12:02pm                                │
│ Duration     3m12s                                         │
│ PID          48217                                         │
│ Command      npm test -- --runInBand                       │
│ Working dir  /mnt/workspace/project                        │
│ Output       /tmp/pi-background/bash-a81f.log              │
├─ Recent output ─────────────────────────────────────────────┤
│ PASS src/session.test.ts                                   │
│ PASS src/bash.test.ts                                      │
│ Tests: 126 passed, 4 running                               │
├────────────────────────────────────────────────────────────┤
│ c 取消任务 · o 打开完整输出 · Esc 返回                     │
└────────────────────────────────────────────────────────────┘
```

最近输出区域展示有限尾部，超出区域可滚动；输出仍在写入时不得抢占用户当前滚动位置。

#### 取消单个任务

```text
┌─ Cancel background task? ──────────────────────────────────┐
│ bash-a81f · npm test · running 3m12s                       │
│ 将终止 Shell 及其整个子进程组，无法撤销。                  │
├────────────────────────────────────────────────────────────┤
│ [Keep running]                          [Cancel task]       │
└────────────────────────────────────────────────────────────┘
```

默认焦点必须位于 `Keep running`，避免误触取消。

#### 取消全部任务

```text
┌─ Cancel all background tasks? ─────────────────────────────┐
│ 将终止当前 Session 的 2 个运行中任务：                     │
│ • bash-a81f · npm test                                     │
│ • bash-c204 · vite --host                                  │
│ 已结束任务和日志不会在此操作中删除。                       │
├────────────────────────────────────────────────────────────┤
│ [Keep tasks]                         [Cancel 2 tasks]       │
└────────────────────────────────────────────────────────────┘
```

#### 空状态

```text
┌─ Background tasks ─────────────────────────────────────────┐
│ 当前 Session 没有后台任务。                               │
│ 在前台 Bash 运行时按 Ctrl+B，或让 Agent 显式后台运行命令。 │
├────────────────────────────────────────────────────────────┤
│ Esc 关闭                                                   │
└────────────────────────────────────────────────────────────┘
```

详情页完整展示：

- 任务 ID
- 命令
- cwd
- 所有者
- 状态
- PID
- 开始时间和耗时
- 退出码或退出原因
- 最近输出
- 完整日志路径

取消单个或全部任务都需要确认；已经结束的任务不显示取消入口。

### 12.8 按键语义

| 按键 | Editor 焦点 | Command list 焦点 | Command output 焦点 |
|---|---|---|---|
| `↑/↓` | 输入为空时进入命令列表；非空时保持编辑行为 | 选择命令，越过底部返回 Editor | 滚动输出 |
| `←/→` | 保持编辑器光标行为 | 不改变选中项 | 切换查看的命令 |
| `Enter` | 前台 Agent 运行时进入 `steer`，空闲时正常发送 | 打开所选命令输出 | 保持输出视图，不提交消息 |
| `Ctrl+B` | 一个前台命令则后台化，多个则打开选择器 | 后台化选中的前台命令 | 后台化当前查看的前台命令 |
| `Esc` | 中止当前 Agent/前台命令 | 返回 Editor | 返回 Command list |
| `Alt+Enter` | 进入 `followUp` | 不适用 | 不适用 |
| `End` | 保持编辑器行为 | 不适用 | 恢复跟随最新输出 |

补充规则：

- 只有后台任务时，`Ctrl+B` 显示提示并建议 `/tasks`，不取消任务。
- 没有前台 Bash 时，`Ctrl+B` 恢复 Pi 原有的光标左移行为。
- 后台任务只能通过 `/tasks`、取消 Tool 或 Session Shutdown 终止，避免用户按 `Esc` 时误杀后台服务。

### 12.9 竞态处理

必须覆盖以下竞态：

1. 用户按 `Ctrl+B` 的同时命令自然结束。
2. 用户连续按两次 `Ctrl+B`。
3. `Ctrl+B` 与 `Esc` 同时到达。
4. Session Shutdown 与后台化同时发生。
5. Tool timeout 与后台化同时发生。
6. 多个并行 Bash 中部分已结束、部分仍运行。

统一规则：

- 第一个成功完成的状态转换获胜。
- `finished` 是终态，不能再后台化。
- `backgrounded` 后原 Tool AbortSignal 不再拥有进程。
- Shutdown 的优先级高于后台化，进入 Shutdown 后拒绝新后台任务。

### 12.10 阶段三验收标准

1. 单个前台 Bash 按 `Ctrl+B` 后不重启进程，并返回稳定任务 ID。
2. 原 Tool Call 只产生一个合法 Tool Result。
3. 主 Agent 在命令结束前恢复下一次模型请求。
4. 后台任务继续写日志并可查询、读取和取消。
5. 多命令选择器准确展示所有仍在运行的 Bash。
6. `!command` 与 Agent Bash 使用同一套状态和清理逻辑。
7. `Esc` 不会误杀已经后台化的任务。
8. `/tasks` 能查看、取消单个任务和确认后取消全部任务。
9. 所有竞态测试结果确定，不出现双重完成或孤儿进程。
10. 阶段一、阶段二已有能力无回归。
11. Command list 或 Command output 焦点下，`Ctrl+B` 只后台化当前选中的前台命令。
12. 前后台切换期间命令开始时间保持不变，powerline 内容和刷新状态完全不变化。
13. `Ctrl+B` 状态切换、选择器、用户 Shell 标记、任务列表、详情、取消确认和空状态与 12.2、12.3、12.6、12.7 的 UI 示例一致。

### 12.11 阶段三发布门槛

- 需要 Pi Core 维护者 Review Tool 协议和 Agent Loop 边界。
- 需要 Bash、TUI、Session Shutdown 三个模块的集成测试。
- 至少完成一次真实长测试、构建、开发服务器和多并行 Tool 验证。
- Provider 消息序列在 Anthropic 和 OpenAI 兼容接口上均通过验证。

## 13. 事件模型

建议增加统一命令任务事件：

```ts
type CommandTaskEvent =
  | { type: "command_task_started"; task: CommandTask }
  | { type: "command_task_backgrounded"; task: CommandTask }
  | { type: "command_task_updated"; taskId: string; outputBytes: number }
  | { type: "command_task_finished"; task: CommandTask }
  | { type: "command_task_removed"; taskId: string }
```

要求：

- 输出事件需要节流，不能按每个 stdout chunk 触发 TUI 全量渲染。
- UI 使用 registry snapshot，而不是自行推导进程状态。
- 阶段一可以先使用现有 Tool 生命周期事件。
- 阶段二开始引入 `CommandTaskRegistry`。
- 阶段三让前台和后台命令统一接入 registry。

## 14. 组件边界

建议职责拆分：

```text
CommandTaskRegistry
├─ 保存任务状态
├─ 状态转换与竞态控制
└─ 对外发布 snapshot/event

CommandProcessManager
├─ spawn
├─ process group
├─ timeout
├─ cancel
└─ shutdown cleanup

CommandOutputStore
├─ 日志文件
├─ tail buffer
├─ 输出上限
└─ 清理

PrePowerlineHost（pi-zero）
├─ 稳定组件排序
├─ 注册与注销
├─ 宽度和 Theme 传递
└─ Reload / Session 清理

RunningCommandsWidget
├─ 前台命令展示
├─ 后台任务展示
├─ 开始时间与 elapsed timer
├─ 选中态与可滚动窗口
└─ terminal width truncation

CommandFocusController
├─ editor / command-list / command-output 状态
├─ selected task
├─ 每个任务的输出滚动位置
└─ 命令结束时的焦点迁移

CommandAwareEditor
├─ 空输入时的方向键路由
├─ 命令列表与输出视图按键路由
└─ 其他输入委托给 Pi CustomEditor

CommandOutputView
├─ 50KB 前台输出尾部
├─ 后台日志尾部
├─ 自动跟随与新增行提示
└─ 命令切换

BackgroundCommandTools
├─ start
├─ status
├─ output
└─ cancel

ForegroundBackgroundController
├─ Ctrl+B
├─ ownership handoff
└─ Tool Result completion
```

阶段一在 `pi-zero` 增加 `PrePowerlineHost`，并实现轻量前台命令 Registry、`RunningCommandsWidget`、`CommandFocusController`、`CommandAwareEditor` 和 `CommandOutputView`；阶段二把 Registry 与 Output Store 扩展到后台任务，并增加 Process Manager 和 Tools；阶段三增加前后台所有权转移 Controller 并改造内置 Bash。

## 15. 错误处理

| 场景 | 用户可见行为 | Agent 可见行为 |
|---|---|---|
| Spawn 失败 | 错误通知 | Tool Error，无任务 ID |
| 非零退出 | 任务标记失败 | 下一 Turn 完成摘要 |
| Timeout | 标记 timed out | 包含 timeout 时长 |
| 用户取消 | 标记 cancelled | 包含取消原因 |
| 输出超限 | 标记 failed | 包含 output limit |
| 日志写失败 | 立即终止任务 | Tool/任务错误 |
| Session Shutdown | 清理中提示 | 不触发新 Agent Turn |
| Widget 渲染失败 | 隐藏 Widget，命令继续 | 不影响 Tool |

UI 故障不得终止命令；日志和进程管理故障必须停止对应后台任务，避免失去控制。

## 16. 可观测性与隐私

允许记录的本地指标：

- 前台命令数量。
- 后台任务数量。
- 前台转后台次数。
- 各终态数量。
- 启动、取消和清理耗时。
- 孤儿进程检测数量。
- Widget 渲染错误数量。

禁止记录：

- 命令正文。
- stdout/stderr 正文。
- 环境变量。
- cwd 完整路径。
- 日志文件正文。

建议成功指标：

1. 后台任务孤儿进程率为 0。
2. 后台化操作成功率不低于 99.9%。
3. Widget 更新不导致空闲 CPU 持续明显升高。
4. 后台任务启动后主 Agent 可在任务结束前继续产生响应。
5. Stage 3 发布后，长前台命令被用户中止重跑的比例下降。

## 17. 测试矩阵

### 17.1 命令类型

- 立即成功且无输出。
- 立即失败。
- 长时间无输出。
- 持续高频输出。
- stdout/stderr 交替输出。
- 派生多个子进程。
- 开发服务器不主动退出。
- 超时边界附近自然退出。

### 17.2 用户操作

- 输入为空时按 `↑` 进入命令列表。
- 输入非空、多行输入和 IME 输入时使用全部方向键。
- 在命令列表中选择首条、中间、末条和滚动窗口外命令。
- 打开输出、滚动、暂停跟随、恢复跟随和切换命令。
- 选中命令结束、其他命令结束和全部命令结束时观察焦点迁移。
- 运行期间提交 `steer`。
- 运行期间提交 `followUp`。
- Editor、Command list、Command output 三种焦点下分别按 `Esc`。
- `Ctrl+B` 后立即查询。
- `Ctrl+B` 后立即取消。
- 多个命令中选择一个或全部后台化。
- Resize、切换 fullscreen、展开 Tool 输出。
- `/reload`、`/new`、`/resume` 和退出。
- 启用命令 UI 前后对比 Powerline 内容、位置与刷新行为。

### 17.3 失败注入

- Spawn 抛错。
- 日志目录不可写。
- 日志写入中途失败。
- kill 失败或子进程暂时不退出。
- Extension Reload 时任务仍运行。
- Tool End 与 `Ctrl+B` 同时发生。
- Shutdown 与任务完成同时发生。

## 18. 分阶段依赖与交付物

| 阶段 | 主要改动位置 | 是否修改 Pi Core | 独立价值 |
|---|---|---:|---|
| 阶段一 | `pi-tsien-extension` + `pi-zero` pre-powerline 插槽 | 否 | 展示开始时间和耗时，方向键选择命令并查看实时输出 |
| 阶段二 | Extension 原型，可逐步上移 Core | 非必须 | 主 Agent 与显式后台命令并行 |
| 阶段三 | Pi Core、TUI、Bash Tool | 是 | `Ctrl+B` 动态后台化和统一 `/tasks` |

### 18.1 阶段一交付物

- `running-commands` Extension。
- `pi-zero` 版本化 `pre-powerline` 组件插槽；不改 Powerline 内容、位置与刷新。
- Command-aware Editor 兼容包装器。
- 命令焦点控制器和实时输出视图。
- Widget、按键路由和输出尾部测试。
- Powerline 文本、位置与刷新零变更对比记录。
- TUI 宽度与并行命令验证记录。
- README 使用说明。

### 18.2 阶段二交付物

- Background Task Manager。
- 四个后台命令 Tool。
- 输出存储与清理机制。
- Session 生命周期集成测试。
- Agent 并行交互演示。

### 18.3 阶段三交付物

- Bash 执行句柄和所有权转移接口。
- `Ctrl+B` 快捷键与多命令选择器。
- 用户 `!command` 集成。
- `/tasks` 管理界面。
- Provider 协议、竞态和进程清理测试。

## 19. 回退策略

### 19.1 阶段一

关闭 `running-commands` Extension 时必须注销 `pre-powerline` 组件，清除输出缓存和焦点状态，并通过 `setEditorComponent(undefined)` 恢复 Pi 默认编辑器；现有 Tool UI 与 Powerline 不受影响。

### 19.2 阶段二

禁用后台 Tool，已运行任务在禁用前先统一取消；普通 Bash Tool 保持原状。

### 19.3 阶段三

通过 Feature Flag 关闭动态后台化和 `Ctrl+B`，保留阶段二显式后台 Tool。不能通过回退遗留正在运行的任务。

建议 Feature Flag：

```text
backgroundCommands.enabled
backgroundCommands.dynamicForegroundHandoff
```

## 20. 建议决策

1. **采用前台默认、显式后台的双模式**，不做全局无条件异步。
2. **阶段一使用 Extension + `pi-zero` pre-powerline 插槽**，新增命令组件、方向键焦点和输出视图，不修改 Pi Core 或现有 Powerline。
3. **阶段二先提供独立后台 Tool**，验证任务模型和生命周期。
4. **阶段三再修改 Pi Core**，支持已经运行的命令通过 `Ctrl+B` 转入后台。
5. **后台完成发送简短 `followUp` 摘要**；Agent 忙碌时排队，空闲时自动触发并继续处理。
6. **Session 退出默认终止全部后台任务**，首版不支持跨进程保活。
7. **前台与后台统一使用一个 CommandTaskRegistry**，避免 TUI、Tool 和 Shell 分别维护状态。

## 21. 已确认与待 Review 决策

阶段二已按推荐默认值落地：

1. 保留 4 个独立后台 Tool，不修改普通 Bash Tool 参数。
2. 后台输出文件默认总上限为 1GiB，内存尾部为 50KB。
3. `/reload` 由进程级管理器保留任务并重新绑定；扩展未在 10 秒内重新绑定时统一取消和清理。
4. Linux/macOS 使用独立进程组终止；Windows 先标记实验支持。
5. 后台完成摘要以 `followUp` 投递；Agent 忙碌时等待，空闲时立即触发 Agent Turn。

阶段三仍需确认：存在前台 Bash 时，`Ctrl+B` 是否覆盖 Pi 默认“光标左移”，或改用单独的可配置快捷键。
