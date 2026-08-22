# Pi Subagent / Workflow TUI PRD

- 状态：Draft，待 Review
- 版本：v0.6
- 日期：2026-08-14
- Canonical repo：`pi-subagent-workbench`
- 范围：独立 Subagent/Workflow runtime、Pi TUI、会话导航、workflow 工作台及外部 Sidebar 职责边界

## 0. 实现检查点（v0.6）

当前已交付首个可用的全屏 Conversation Workbench：Extension 自主管理 `SubagentService + PiRpcProcessProvider` 生命周期；Runtime API v1 通过不可变 snapshot 和受控 command 暴露 Main/Agent 列表、多 Run transcript、follow-up 与 active Run interrupt；流式 transcript 以 20 次/秒合并发布，并对每个 ChildSession 限制 1 MiB；退出 Workbench 不取消后台 Run；持久交付未完成前明确显示易失确认。

本检查点不是完整 Milestone 1：输入框下方 Switcher、Editor 光标边界进入、target 草稿、首次引导、durable inbox/outbox、reload 恢复、Workflow 工作台、健康/内存水位和真实终端 IME/resize/focus 验证仍未交付，不能据此宣称满足全部 65 项验收。

## 1. 背景

当前 Pi 的 subagent 和 workflow 已具备运行、状态展示、后台通知及部分 artifact 查看能力，但用户交互仍以父会话、工具结果和静态 sidebar 为中心：

- 用户不能像 Claude Code 一样，在输入框下方直接选择 `Main` 或某个 agent 会话。
- 进入 agent 后不能自然地继续输入、查看完整上下文和发送 follow-up。
- workflow 与普通 subagent 的 UI 层级不够清晰。
- workflow 没有独立的 Stage / Agent 工作台，复杂并发任务难以理解当前执行位置。
- in-process、process/mux 和 workflow 的内容来源不同，UI 需要分别读取内存状态、artifact 或 workflow snapshot。

本 PRD 定义一套接近 Claude Code 的会话式 TUI：普通 subagent 与 Main 作为可切换、可输入的会话；workflow 只在复杂编排或多并发任务中出现，并使用独立界面展示 Stage、Agent、进度和内容。

## 2. 产品原则

1. **会话优先**：Main 和每个 agent 都是可进入、可阅读、可继续输入的会话。
2. **目标明确**：输入框必须始终明确显示消息将发送给 Main、某个 agent，还是 workflow 中的某个 agent。
3. **Workflow 是例外而非默认**：单个或少量独立任务直接使用 subagent；只有多阶段、多并发、fan-out/fan-in 等复杂任务才使用 workflow。
4. **离开不等于取消**：从 agent 或 workflow 返回 Main，只改变 UI 焦点，不中断后台运行。
5. **统一运行状态**：native、process 和 mux agent 在 UI 中使用同一套状态与事件模型。
6. **键盘优先**：核心导航全部可通过方向键完成，鼠标不是必要条件。
7. **不打断主流程**：没有 subagent/workflow 时，主界面不增加多余区域。
8. **可视化单一归属**：通用 Sidebar 只展示 Main/Pi 会话信息；所有 subagent/workflow 可视化和交互只属于 Subagent Workbench。
9. **独立 ownership**：`pi-subagent-workbench` 自己拥有 runtime、ResourceGovernor、Session/Run/Workflow 状态与 TUI；不以 `pi-subagentura` 为运行基础，也不读取其私有 registry/global。

## 3. 目标

### 3.1 Main / Agent 会话切换

- 输入框下方出现会话切换器，展示 `Main` 和当前会话关联的 agents。
- 用户可从输入框使用方向键进入会话切换器。
- 用户可使用左右方向键选择 Main 或不同 agent。
- 激活 agent 后，主内容区显示该 agent 的 transcript，输入框消息发送给该 agent。
- agent 正在运行、空闲、完成或失败时，用户都能查看其已有内容。
- 可持续 agent 在完成一次 Run 后仍可输入；新消息在同一 ChildSession 中创建新的 Run。

### 3.2 Workflow 独立工作台

- workflow 使用独立界面，不与普通 agent 列表混为同一个静态 sidebar。
- workflow 界面展示 Stage、每个 Stage 中的 agents、当前状态及选中对象的详细内容。
- 用户可用方向键在 Stage 和 Agent 之间导航。
- 选中 agent 后可查看其实时 transcript，并向该 agent 输入消息。
- 用户可随时退出 workflow 界面返回 Main，workflow 继续运行。

### 3.3 统一内容与状态

- native agent 内容来自 ChildSession 事件。
- process agent 优先来自 Pi RPC 事件，artifact 仅作为恢复和兼容来源。
- mux 只负责可附着 TUI，不以 pane 文本作为权威 transcript。
- workflow 只负责编排和聚合；child 详细内容仍来自对应 ChildSession。

### 3.4 稳定性目标

- 所有 direct subagent 和 workflows 共享一个进程级资源调度器，不能各自无限扩并发。
- 在创建 Session、复制父上下文或启动进程前完成资源准入。
- 队列、事件、transcript 内存、通知和 retained runtime 都有硬上限。
- 超载时排队或明确拒绝新任务，不允许通过持续分配资源把 Pi 推入 OOM。
- TUI 异常只降级对应视图，不中断 Main、subagent 或 workflow。
- 完成、失败、取消和退出路径必须释放 permit、listener、timer、stream 和 provider runtime。

## 4. 非目标

- 不追求像素级复制 Claude Code 的颜色、边框和动画。
- 不在 v1 支持鼠标拖拽排序 Stage 或 Agent。
- 不在 TUI 中编辑 workflow JavaScript。
- 不自动把多个独立 subagent 包装成 workflow。
- 不从 tmux/zellij pane 抓取文本作为权威运行结果。
- 不在 v1 支持 workflow 嵌套 workflow 的可视化。
- 不因退出 agent/workflow 视图自动取消运行任务。
- v1 不提供 `pi-subagentura` registry/global 兼容适配；迁移通过公开 provider/adapter contract 单独设计。

## 5. 核心概念

### 5.1 Main

父 Pi 会话。Main 有自己的 transcript、输入草稿和运行状态。

### 5.2 Agent Conversation

一个稳定的 ChildSession：

- 有固定 `agentId` 和 `sessionId`。
- 有独立 transcript 和输入草稿。
- 可以包含多次 Agent Run。
- 用户从 UI 进入后，可以继续输入。

### 5.3 Agent Run

Agent Conversation 中的一次模型执行：

```text
queued → starting → running → completed
                            ↘ failed
                            ↘ interrupted
                            ↘ cancelled
```

`idle` 不是 Run 状态，而是 ChildSession 当前没有 active Run 且 `availability=ready` 时的 UI 派生状态。`interrupt` 只停止当前 Run；ChildSession 仍可继续使用。

### 5.4 Workflow

显式创建的复杂编排运行。包含一个或多个 Stage，每个 Stage 包含一个或多个 Agent Run。

### 5.5 Stage

Workflow 中具有业务意义的执行阶段，例如：

```text
Discover → Implement → Review → Verify → Synthesize
```

Stage 可以串行，也可以在内部并发运行多个 agents。

## 6. Workflow 使用边界

### 6.1 使用普通 subagent

以下情况默认直接使用 `agent()`：

- 一个边界明确的调查或 review。
- 一个模块或少量文件的实现。
- 一个独立可验证任务。
- 一个需要持续 follow-up 的专家会话。
- 多个彼此无编排依赖、由 Main 直接管理的独立 agents。

### 6.2 使用 workflow

只有出现以下任一情况时才使用 `workflow()`：

- 两个以上需要统一收敛结果的并发任务。
- 明确的 fan-out / fan-in。
- 多阶段 pipeline。
- Stage 之间存在依赖或质量门禁。
- 批量迁移、批量评测、并行审查。
- 需要 `parallel()`、`pipeline()`、`phase()` 或结构化聚合。

后台执行本身不是使用 workflow 的理由。

## 7. 信息架构

统一运行树：

```text
Main
├─ Agent: repo-scan
├─ Agent: security-review
└─ Workflow: migration-review
   ├─ Stage 1: Discover
   │  ├─ Agent: api-scan
   │  └─ Agent: storage-scan
   ├─ Stage 2: Implement
   │  ├─ Agent: api-implement
   │  └─ Agent: storage-implement
   └─ Stage 3: Verify
      ├─ Agent: test
      └─ Agent: review
```

普通 agent 直接挂在 Main 下；只有通过 workflow 创建的 agent 才挂在 Workflow/Stage 下。

建议的基础数据模型：

```ts
interface ConversationTarget {
  id: string;
  type: "main" | "agent" | "workflow";
  parentId?: string;
  sessionId?: string;
  label: string;
  availability: "ready" | "readonly" | "disposed" | "unavailable";
  activeRunId?: string;
  latestRunStatus?: RunStatus;
  unreadCount: number;
}

type RunStatus =
  | "queued"
  | "starting"
  | "running"
  | "completed"
  | "failed"
  | "interrupted"
  | "cancelled";

interface WorkflowStageView {
  id: string;
  workflowId: string;
  title: string;
  description?: string;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  agentIds: string[];
}
```

## 8. Main 界面

### 8.1 没有 agent 时

会话切换器不显示，保持现有 Pi 界面：

```text
┌──────────────────────────────────────────────────────────────────┐
│ Main transcript                                                  │
│                                                                  │
│ assistant: ...                                                   │
├──────────────────────────────────────────────────────────────────┤
│ > 输入消息                                                       │
└──────────────────────────────────────────────────────────────────┘
  model · context · usage
```

### 8.2 有 agent 时

会话切换器位于输入框下方、footer 上方：

```text
┌──────────────────────────────────────────────────────────────────┐
│ Main transcript                                                  │
│                                                                  │
│ assistant: 已启动两个并行调查任务                                │
├──────────────────────────────────────────────────────────────────┤
│ Message to Main                                                  │
│ > 输入消息                                                       │
├──────────────────────────────────────────────────────────────────┤
│  ‹  Main  │ ● repo-scan  │ ✓ security-review  │ ◇ ● workflow  › │
└──────────────────────────────────────────────────────────────────┘
  ↓ 进入会话选择 · ←→ 选择 · ↑/Enter 激活
```

状态符号：

```text
● running
○ idle / waiting
✓ completed
! failed
‖ interrupted
× cancelled
◇ workflow（类型标记，不代替运行状态）
```

Workflow 同时显示类型和状态，例如 `◇ ● migration-review`。颜色不能是唯一状态信号，必须同时提供符号。

### 8.3 进入 agent

激活 agent 后，主内容区切换到该 ChildSession，输入目标同步变化：

```text
┌─ Agent: repo-scan ─────────────── ● running ─────────────────────┐
│ user: 调查 Session fork 的实现                                  │
│                                                                  │
│ assistant: 我先定位 SessionRepo...                              │
│                                                                  │
│ tool: knowledge_search                                          │
│ result: ...                                                      │
├──────────────────────────────────────────────────────────────────┤
│ Message to repo-scan                                             │
│ > 再检查一下 SQLite backend                                     │
├──────────────────────────────────────────────────────────────────┤
│  ‹  Main  │ ● repo-scan  │ ✓ security-review  │ ◇ ● workflow  › │
└──────────────────────────────────────────────────────────────────┘
  Enter 发送 · Alt+Enter 排队为 follow-up · ↓ 进入会话选择
```

要求：

- 输入内容只发送到 `repo-scan`，不经过 Main 模型转述。
- agent 正在运行时，`Enter` 使用 steering 语义；`Alt+Enter` 使用 follow-up 语义。
- agent idle/completed 时，`Enter` 在同一 ChildSession 中启动新 Run。
- 切换到其他会话时，为每个 target 独立保存未提交草稿。
- agent 完成时不自动把用户切回 Main。

## 9. Main / Agent 焦点与方向键

### 9.1 焦点状态

```text
Transcript → Editor → Conversation Switcher
```

v1 必须支持 Editor 与 Conversation Switcher；Transcript 独立滚动沿用 Pi fullscreen 行为。

### 9.2 推荐按键

| 当前焦点     | 按键                  | 行为                                                                        |
| ------------ | --------------------- | --------------------------------------------------------------------------- |
| Editor       | `↓`                   | 当光标已位于最后一个可视行且没有补全/历史弹窗时，进入 Conversation Switcher |
| Switcher     | `←` / `→`             | 选择 Main、agent 或 workflow                                                |
| Switcher     | `↑`                   | 激活当前选择并回到该 target 的 Editor                                       |
| Switcher     | `Enter`               | 激活当前选择；workflow 打开独立工作台                                       |
| Switcher     | `Esc`                 | 取消选择并回到当前 target 的 Editor                                         |
| Switcher     | `?`                   | 打开当前上下文的完整按键帮助，`Esc` 关闭                                    |
| Agent Editor | `Enter`               | 向当前 agent 发送 steering/新 Run                                           |
| Agent Editor | `Alt+Enter`           | 向当前 agent 排队 follow-up                                                 |
| 任意普通会话 | `/subagent-workbench` | 显式打开 Workbench 或聚焦 Conversation Switcher                             |

### 9.3 方向键冲突规则

Pi Editor 当前使用 `↑/↓` 进行光标移动和历史浏览。为避免破坏现有行为：

1. 只有当光标已经处于最后一个可视行时，额外一次 `↓` 才进入 Switcher。
2. 补全菜单、历史选择或其他 modal UI 激活时，方向键仍由当前组件处理。
3. 如果 Pi Editor 无法可靠暴露光标边界，v1 技术降级为 `Shift+↓` 进入 Switcher；产品最终目标仍是边界触发的无修饰方向键。
4. Switcher 聚焦时，`Esc` 只退出 Switcher，不触发 `app.interrupt`。

### 9.4 Switcher 溢出规则

- 当前选中 target 必须始终可见，选择移动时窗口自动水平滚动。
- `‹` / `›` 只在对应方向仍有隐藏 target 时显示。
- target label 按终端显示宽度截断，详情视图显示完整名称。
- `Main` 固定为逻辑首项，但滚动到远端 target 时不要求始终占用可见宽度。
- target 保持稳定创建顺序，不因完成、失败或未读状态动态重排；通过 badge、Needs attention 过滤和跳转操作突出异常项。
- v1 不要求数字快捷跳转；agent 数量较多时通过 `/subagent-workbench` 打开完整列表。

### 9.5 中断按键

| 当前焦点                  | `Ctrl+C` 行为                                           |
| ------------------------- | ------------------------------------------------------- |
| Main Editor               | 沿用 Pi 当前行为，中断 Main Run                         |
| Agent Editor              | 中断当前 Agent Run，不 dispose ChildSession             |
| Conversation Switcher     | 只退出 Switcher，不中断 Main 或 Agent                   |
| Workflow Workbench 导航区 | 不隐式取消 workflow；显示显式 cancel/interrupt 操作提示 |
| Workflow Agent Input      | 中断当前选中 Agent Run，不自动取消 workflow             |

取消整个 workflow 必须使用显式命令或带确认的操作。

### 9.6 首次引导与帮助

- parent session 中第一次出现 Agent 时，Switcher 显示一次性提示：`↓ 进入会话选择 · ? 查看全部按键`。
- 用户成功进入过 Switcher 后，该提示在当前 parent session 内不再重复出现。
- Switcher 和 Workflow Workbench 都支持 `?` 打开当前焦点可用按键、目标说明和取消语义；帮助关闭后恢复原焦点、选择和草稿。
- 帮助必须说明 `Esc` 只返回、`Ctrl+C` 中断当前 Run、取消 workflow 需要显式确认，避免用户误操作。

## 10. Workflow 启动和退出

### 10.1 Foreground Workflow

Foreground workflow 启动后自动打开独立工作台。

### 10.2 Background Workflow

Background workflow 不抢占当前输入焦点，只在 Conversation Switcher 中新增：

```text
◇ ● workflow-name
```

用户选择并按 `Enter` 后打开工作台。

### 10.3 退出 Workflow

- `Esc` 返回进入 workflow 前的 Main/Agent 会话。
- 退出只改变 UI，不取消 workflow。
- workflow 继续运行并通过 Switcher 状态、未读计数和完成通知更新。
- 取消 workflow 必须使用明确命令或安全确认，不能复用普通 `Esc`。
- 安全确认默认选择“不取消”，`Esc` 始终安全退出；必须显示将受影响的 active/queued Run 数量，确认期间后台任务继续运行，重复确认不得执行两次。
- 行内确认或轻量 overlay 的具体形式由 TUI 技术验证决定，不在 PRD 中固定超时和字符键。

### 10.4 退出 Pi

Pi 收到正常退出请求或 `session_shutdown` 时，必须先显示任务 readback：

```text
退出 Pi？
2 个 native Run 将终止
1 个 mux Run 将按 surviveParent 策略处理
3 个排队任务将取消
```

- queued 项必须写入 cancelled 终态并清理，不能静默遗失。
- native in-process Run 无法跨 Main 进程存活，退出前必须明确告知。
- process/mux Run 是否继续由显式 `surviveParent` 策略决定；不得因 provider 类型静默假设全部继续或全部终止。
- 继续运行的 child 必须保留可发现的 session/artifact/attach 信息；终止的 child 必须回收进程、permit、listener 和 timer。
- 信号触发的紧急退出允许缩短交互流程，但仍应执行幂等清理和持久化可写终态；无法完成时在下次启动执行 orphan reconciliation。

## 11. Workflow 独立工作台

### 11.1 宽终端布局（建议宽度 ≥ 120）

```text
┌─ Workflow: migration-review ─ ● running ─ 6 agents ─────────────┐
│ Phase: Implement · elapsed 03:42 · ↑128k ↓12k · Esc 返回 Main  │
├───────────────┬─────────────────────┬────────────────────────────┤
│ STAGES        │ AGENTS              │ CONTENT                    │
│               │                     │                            │
│ ✓ Discover    │ ✓ api-scan          │ Agent: api-implement       │
│ ▶ Implement   │ ● api-implement     │ Status: running            │
│ ○ Review      │ ● storage-implement │                            │
│ ○ Verify      │                     │ assistant: 正在修改...     │
│               │                     │                            │
│               │                     │ tool: edit                 │
│               │                     │ path: src/api.ts           │
│               │                     │                            │
├───────────────┴─────────────────────┴────────────────────────────┤
│ Message to api-implement                                        │
│ > 完成后补充对应的单元测试                                      │
├──────────────────────────────────────────────────────────────────┤
│ ←→ 切换区域 · ↑↓ 选择 · Enter 进入 · Tab 输入 · Esc 返回        │
└──────────────────────────────────────────────────────────────────┘
```

### 11.2 中等终端布局（80–119）

Stage 和 Agent 合并为左侧树，右侧展示内容：

```text
┌─ Workflow: migration-review ─ ● running ────────────────────────┐
├────────────────────────┬─────────────────────────────────────────┤
│ ▾ ✓ Discover           │ Agent: api-implement                    │
│   ✓ api-scan           │                                         │
│ ▾ ▶ Implement          │ assistant: ...                          │
│   ● api-implement      │ tool: edit ...                          │
│   ● storage-implement  │                                         │
│ ▸ ○ Review             │                                         │
├────────────────────────┴─────────────────────────────────────────┤
│ Message to api-implement >                                      │
└──────────────────────────────────────────────────────────────────┘
```

### 11.3 窄终端布局（< 80）

使用单列逐层进入：

```text
Workflow Summary
→ Stage List
→ Agent List
→ Agent Transcript
```

标题栏始终显示当前位置：

```text
migration-review / Implement / api-implement
```

`←` 返回上一层，`→` 或 `Enter` 进入下一层。

## 12. Workflow 导航

| 焦点                 | 按键                  | 行为                            |
| -------------------- | --------------------- | ------------------------------- |
| Stage 列             | `↑` / `↓`             | 选择 Stage                      |
| Stage 列             | `→` / `Enter`         | 进入该 Stage 的 Agent 列        |
| Agent 列             | `↑` / `↓`             | 选择 Agent，并实时更新 Content  |
| Agent 列             | `←`                   | 返回 Stage 列                   |
| Agent 列             | `→` / `Enter`         | 聚焦 Content                    |
| Content              | `PageUp` / `PageDown` | 滚动 transcript                 |
| Content              | `←`                   | 返回 Agent 列                   |
| 任意列               | `Tab`                 | 聚焦选中 agent 的输入框         |
| Input                | `Enter`               | 向选中 agent 发送消息           |
| Input                | `Alt+Enter`           | 排队 follow-up                  |
| Workflow             | `Esc`                 | 返回调用方会话，不取消 workflow |
| Switcher / Workbench | `?`                   | 打开当前焦点的按键帮助          |

### 12.1 Transcript 滚动跟随

- 当前 transcript 已位于底部时，新内容自动跟随。
- 用户向上滚动后，新内容不得把视图强制拉回底部；显示 `N 条新内容 · End 跳到最新`。
- 用户回到底部后清除新内容提示并按 §16 清零未读。
- 每个 target 在当前 parent session 运行期间独立保留滚动位置；reload 后按 §15.1 恢复安全默认值。
- Agent 完成、失败或被中断时，若用户不在底部，只更新状态和新内容提示，不改变滚动位置。

选择 Stage 根节点时，Content 显示：

- Stage 描述。
- 依赖 Stage。
- Agent 总数及完成情况。
- Stage 日志和失败原因。
- 聚合 usage。

选择 Workflow 根节点时，Content 显示：

- 当前 phase。
- Stage 总进度。
- 最近 workflow logs。
- agents started/running/completed/failed。
- 聚合 usage、耗时和结果摘要。

Workflow 根节点和 Stage 根节点在 v1 为只读；只有具体 agent 支持直接输入。Workflow coordinator inbox 作为后续能力单独设计。

## 13. Stage 展示规则

Stage 状态：

```text
○ pending
▶ running
✓ completed
! failed
× cancelled
```

要求：

- `phase("Name")` 首次出现时创建或激活对应 Stage。
- 在某个 phase 下启动的 agent 自动归属当前 Stage。
- 未显式调用 `phase()` 的 workflow 使用 `Default` Stage。
- 并发 agents 同时显示各自状态和 activity。
- Stage 完成后仍保留，可回看 agents 和 transcript。
- 后续动态新增 Stage/Agent 时，当前选择按稳定 ID 保持，不因列表插入跳动。
- 一个 agent 只能有一个直接 Stage 父节点；跨 Stage 依赖通过引用展示，不复制 agent。

## 14. 输入与消息路由

### 14.1 Main

```text
Target = Main → parent AgentSession.prompt/followup
```

### 14.2 Agent

```text
Target = Agent → ChildSession inbox
```

消息不得先注入 Main，再由 Main 决定是否转发。

### 14.3 Agent 正在运行

- `Enter`：steering，在当前模型回合允许的下一个安全边界投递。
- `Alt+Enter`：follow-up，在当前 Run 完成后投递。
- UI 只有在 runtime 返回持久化 message ID 后才显示 `queued`；仅写入内存时必须显示一次性易失提示，不能伪装成已可靠接受。
- queued 状态显示可解释原因，例如 `active 4/4`、`等待 process slot` 或 `内存保护中`；优先级和 round-robin 生效时不承诺不稳定的精确队列位置。
- Milestone 2 提供持久 acknowledgment；Milestone 5 再提供完整重放、去重和跨重启 delivery。

### 14.4 Agent idle/completed

- 在同一个 ChildSession 启动新 Run。
- 保留已有 transcript。
- 不创建同名但无历史的新 agent。

### 14.5 Agent failed/cancelled

- transcript 保留并可查看。
- 若 ChildSession 可恢复，允许用户发送新消息启动新 Run。
- 若 provider 不支持恢复，输入框显示只读原因，并提供“以新会话继续”操作；新会话使用新的 `sessionId`，保留来源引用并作为独立 target 出现在 Switcher，不得静默替换旧会话。

### 14.6 Workflow Agent 的人工继续

Workflow 对 Agent Run 结果的提交点是该次 `agent()` 调用的结果写入 workflow journal。提交点之前接受的 steering/follow-up 属于原 workflow-owned Run；提交点之后的用户输入在同一 ChildSession 中创建 `manual-continuation` Run：

- `manual-continuation` 仍显示在原 Agent Conversation 下，保留上下文连续性。
- 不重新打开已完成 Stage，不修改原 workflow 结果、状态或聚合 usage。
- Workbench 必须明确显示“人工继续，不计入原 workflow”。
- 若需要重新执行 Stage 或更新 workflow 结果，必须使用显式 retry/reopen；不属于 v1。
- 取消原 workflow 不自动取消已经独立启动的 `manual-continuation`。

## 15. 草稿管理

每个可输入 target 独立保存草稿：

```text
Main draft
Agent A draft
Agent B draft
Workflow / Agent C draft
```

切换 target 时：

1. 保存当前输入框文字和光标位置。
2. 恢复目标 target 的草稿和光标位置。
3. 更新输入框标题及边框颜色。
4. 不自动发送或清空任何草稿。

图片、附件及多模态草稿的跨 target 保留不属于 v1，后续另行设计。

### 15.1 Reload 持久化边界

- Main 草稿继续由 Pi 的现有 Editor/session 机制管理。
- Agent 草稿和光标位置保存为 parent session 的 Extension entry；同一 parent session reload 后恢复。
- 当前 target 在 reload 后仅当对应 ChildSession 仍存在且可打开时恢复，否则回到 Main。
- transcript 滚动位置、Workflow 树展开状态和临时 hover/selection 在 v1 为易失状态，reload 后恢复安全默认值。
- 草稿持久化失败时保留当前内存草稿并显示错误，不得清空或发送草稿。

## 16. 未读与完成通知

- 非当前 target 产生新 assistant 内容时，增加未读计数。
- 用户进入并滚动到最新内容后清零。
- Switcher 示例：

```text
Main │ ● repo-scan (3) │ ✓ security-review │ ◇ ● workflow (5)
```

- agent/workflow 完成时不自动切换当前会话。
- 完成通知只出现一次。
- 短时间内多个同类完成事件可以聚合为一条摘要，例如 `3 个 agent 已完成，1 个失败`；失败和 needs-attention 不能被聚合摘要隐藏。
- Switcher 保持稳定顺序；Workbench 提供 `All / Running / Needs attention / Completed` 过滤和“跳到下一个需注意 target”操作。

UI 通知语义由 `pi-subagent-workbench` 公开 delivery contract 定义；参数名称保持清晰且可独立演进：

| UI 语义  | `notifyOnComplete` | `triggerTurnOnComplete` | 行为                                       |
| -------- | ------------------ | ----------------------: | ------------------------------------------ |
| `notify` | `notify`           |                 `false` | 只显示通知和 artifact 指针，不注入完整输出 |
| `quiet`  | `inject`           |                 `false` | 注入 Main 上下文，但不触发 Main 新 Run     |
| `wakeup` | `inject`           |                  `true` | 注入 Main 上下文并触发 Main 新 Run         |

UI 不创建第二套独立 delivery 协议；后续若修改公开参数，必须提供版本迁移。

## 17. 内容来源

### 17.1 Native Agent

权威来源：

```text
ChildSession messages/events
```

不创建 `output.md` 作为实时内容来源。

### 17.2 Process Agent

优先来源：

```text
pi --mode rpc JSONL events
```

artifact 用于：

- 进程异常后的结果恢复。
- 历史兼容。
- 父进程退出后的持久化。

### 17.3 Mux Agent

- transcript 来源仍为 RPC/session/artifact。
- tmux/zellij 只提供 `Attach` 能力。
- 不解析 pane 屏幕文本作为消息历史。
- Attach 前显示 backend、目标 session/pane 和对应 detach/返回按键；不得假设所有 backend 使用同一快捷键。
- detach 返回 Pi 后恢复原 Workbench target、焦点、选择和草稿，并立即刷新 child 状态。
- attach 失败只显示对应 child 的错误和可复制命令，不关闭 Workbench 或改变 Run 状态。

### 17.4 Workflow

- Stage/phase/log 来自 workflow journal。
- Agent 内容来自 ChildSession。
- workflow 只保存 agent result 引用，不复制完整 transcript。

## 18. UI 状态模型

建议统一事件：

```text
subagent/session-created
subagent/run-started
subagent/message-accepted
subagent/message-appended
subagent/tool-started
subagent/tool-ended
subagent/run-idle
subagent/run-completed
subagent/run-failed
subagent/run-interrupted
subagent/run-cancelled
subagent/session-disposed

workflow/run-created
workflow/stage-started
workflow/stage-completed
workflow/agent-added
workflow/agent-result-committed
workflow/log
workflow/run-completed
workflow/run-failed
workflow/run-cancelled
```

UI 使用稳定 `sessionId/runId/workflowId/stageId` 投影状态，不以数组下标作为选择身份。

## 19. Pi TUI 实现建议

### 19.1 Main / Agent Switcher

当前 Pi `setWidget(..., { placement: "belowEditor" })` 可显示内容，但 widget 本身不适合承接焦点和输入路由。

推荐两阶段：

1. **Extension 技术验证**：先验证 `CustomEditor` 能否在 editor 下方稳定渲染 Conversation Switcher，并在 `handleInput()` 中实现边界方向键、焦点切换、IME 和 target 草稿；`setWidget(..., { placement: "belowEditor" })` 只负责显示，不作为交互控件。
2. **Extension 原型**：技术验证通过后，用 `CustomEditor` 完成 Main/Agent 切换和目标提交；Workflow 独立工作台继续使用 `ctx.ui.custom()`。
3. **通用能力**：如果 Extension 无法可靠获取 editor 光标边界、接管焦点或替换提交目标，在 Pi core 增加通用的 focusable editor accessory/input-target hook，而不是内置 subagent 功能。

### 19.2 Workflow 工作台

使用非 overlay 的 `ctx.ui.custom()` 创建独立 `Focusable` 组件：

- 宽终端：Stage、Agent、Content 三列。
- 中等终端：运行树、Content 两列。
- 窄终端：单列 drill-down。
- 组件关闭后恢复之前的 Main/Agent editor 和草稿。

### 19.3 通用 Sidebar 与 Subagent Workbench

采用两个独立 package/Extension，禁止重复拥有 subagent/workflow 可视化：

```text
pi-tsien-extension/extensions/sidebar.ts
    └─ Main/Pi 会话概览

pi-subagent-workbench/src/index.ts
    └─ 全部 subagent/workflow runtime、可视化和交互
```

#### 通用 Sidebar

`sidebar.ts` 只展示 Main/Pi 会话自身信息：

- 当前模型和 thinking level。
- Main context 使用量及组成。
- system prompt、skills、tools、history 和 tool results 占用。
- 用户输入、模型输出、缓存、token、费用和 pending message。
- 与 subagent 无关的 Pi 进程基础状态。

通用 Sidebar 禁止：

- 读取 `__piSubagentura*` 或其他 subagent runtime 私有全局变量。
- 展示 agent 数量、activity、transcript 或 usage。
- 展示 workflow、Stage、phase 或 workflow usage。
- 读取 child artifact/session。
- 提供 agent 的 cancel、interrupt、resume、attach 或选择操作。

建议入口：

```text
/sidebar
Ctrl+Alt+S
```

#### Subagent Workbench

`pi-subagent-workbench/src/index.ts` 是以下信息的唯一可视化入口：

- 输入框下方 Main/Agent/Workflow Conversation Switcher。
- Agent transcript、输入、steering、follow-up 和 resume。
- Workflow 独立工作台及 Stage/Agent 树。
- agent/workflow 状态、usage、activity 和未读消息。
- ResourceGovernor 的 active、queued、limit 和保护状态。
- agent/workflow cancel、interrupt、resume 和 attach。
- subagent/workflow 错误、失败和资源保护提示。

建议显式入口为 `/subagent-workbench`；日常 Main/Agent 切换仍优先使用输入框下方的方向键交互。

#### 迁移顺序

当前外部 `pi-tsien-extension/extensions/subagent-sidebar.ts` 同时混合 Main metrics 与 subagent/workflow 状态，不能只改文件名。跨仓迁移必须按以下顺序进行：

1. 在独立 `pi-subagent-workbench` repo 实现 agent/workflow runtime 与可视化能力。
2. Workbench 通过功能、稳定性和 TUI 回归后，将所有 child/workflow 状态读取迁入 Workbench。
3. 从原 Sidebar 删除 `__piSubagentura*`、workflow、child metrics 和控制入口。
4. 在 `pi-tsien-extension` 用剩余 Main/Pi 会话能力重新实现 `extensions/sidebar.ts`。
5. 注册 `/sidebar` 和 `Ctrl+Alt+S`，更新 README 与安装说明。
6. 移除仓库内旧 `subagent-sidebar.ts`，并停用 `~/.pi/agent/extensions/subagent-sidebar.ts` 等独立安装副本，避免重复加载。
7. 分别验证 Sidebar 和 Workbench 的关闭、异常、reload 和卸载行为。

迁移期间不得让 Sidebar 和 Workbench 同时渲染同一份 agent/workflow 列表。Workbench 未达到功能等价前，不删除旧 Sidebar 的观测能力。

## 20. 需要的底层能力

### 20.1 可先在 Extension 实现

- Switcher 渲染和焦点。
- 每 target 草稿。
- 当前 in-process job 内容预览。
- artifact transcript 兼容读取。
- workflow Stage/Agent 树。
- workflow 独立工作台。
- 通用 `sidebar.ts` 的 Main/Pi 会话概览。
- 旧 `subagent-sidebar.ts` 到 Workbench/Sidebar 的职责迁移。

### 20.2 `pi-subagent-workbench` 独立 runtime

- 稳定 ChildSession 与多 Run。
- `send/steer/followup/interrupt/resume`。
- 统一事件总线。
- native/process/mux provider 的统一消息模型。
- 复用 Pi 已有 `--mode rpc`，实现 process provider 的 RPC 生命周期、事件、取消和恢复适配。
- workflow Stage、agent 归属和 agent result commit 事件。
- durable inbox/outbox。
- 向 Workbench UI 暴露版本化、只读 snapshot 和受控 command API；禁止 UI 直接读取 runtime 可变集合、provider handle 或任何其他 package 的私有全局变量。

建议最小接口：

```ts
interface SubagentWorkbenchRuntime {
  readonly apiVersion: 1;
  getSnapshot(): WorkbenchSnapshot;
  subscribe(listener: (snapshot: WorkbenchSnapshot) => void): () => void;
  dispatch(command: WorkbenchCommand): Promise<WorkbenchCommandResult>;
}
```

`WorkbenchSnapshot` 是不可变投影；`WorkbenchCommand` 只允许显式的 send、steer、followup、interrupt、cancel、resume 和 attach。API 不向 Extension 暴露 provider handle、AbortController、队列或 Session 实例。

### 20.3 可能需要 Pi core 的通用接口

- SessionRepo `create/fork` 对 Extension 可用。
- `parentSessionId` 和 child session discovery。
- `watchSession()` 完整事件流。
- Extension 可打开/切换指定 Session transcript。
- 可聚焦的 editor accessory 或 input-target hook。
- typed message source。

Pi core 只提供通用 Session、Editor 和事件原语，不内置具体 subagent/workflow 产品逻辑。

## 21. 稳定性契约

本节是实现和发布的强制门禁，不是可选优化。无法绝对排除操作系统 OOM、第三方 provider 崩溃或硬件故障，但产品必须保证自身创建的并发、队列和内存对象有界，并在达到边界时可预测地排队、拒绝或降级，而不是让 Pi 失控。

现有 Pi TUI 的 render 合并、workflow 局部 semaphore、通知有界队列和 AbortController 可以复用，但它们不能替代下述进程级保护：多个 workflows 的局部上限会相乘，direct async subagent 也必须经过同一个调度器。

### 21.1 进程级 ResourceGovernor

所有执行入口共享一个 `ResourceGovernor`：

```text
Direct subagent ─┐
Workflow A ──────┼──▶ ResourceGovernor ──▶ native/process/mux provider
Workflow B ──────┘           │
                             ├─ admission
                             ├─ weighted permits
                             ├─ bounded queue
                             ├─ memory pressure
                             └─ cancellation/timeout
```

禁止 workflow、direct subagent 或 provider 自建可绕过全局限制的执行池。workflow 可以有更低的局部上限，但最终必须同时取得全局 permit。

### 21.2 默认硬上限

| 资源                               |    默认上限 | 行为                                                                          |
| ---------------------------------- | ----------: | ----------------------------------------------------------------------------- |
| Pi 进程同时运行的 Agent Run        |           4 | 其余进入有界队列                                                              |
| 单个 workflow 同时运行的 Agent Run |           4 | 不能占满超过全局上限                                                          |
| process/mux 同时运行数             |           2 | 防止子进程 RSS 放大                                                           |
| `with_context` 同时运行数          |           2 | 原生共享前缀实现前限制父上下文复制                                            |
| 同时 active workflow               |           2 | 其余 workflow 排队或明确拒绝                                                  |
| 每个 parent 的等待队列             |          32 | 队列满返回 `resource_exhausted`                                               |
| 单个 workflow 生命周期 Agent Run   |          64 | 超出立即失败，不继续创建                                                      |
| 内存 retained job metadata         |         100 | 超出后按 LRU 清理 terminal metadata                                           |
| 单个 child 的内存事件窗口          |       1 MiB | 更早内容落盘，终态事件不能丢失                                                |
| 单次 task/prompt                   | 1 MiB UTF-8 | 准入和 Session 创建前返回 `task_too_large`                                    |
| 单次 explicit context              | 8 MiB UTF-8 | 准入和 Session 创建前返回 `context_too_large`                                 |
| 单次 provider output               | 8 MiB UTF-8 | Run failed、释放 permit 并返回 `output_too_large`；后续 artifact 支持另行升级 |
| 单个 workflow 内存聚合结果         |       8 MiB | 更大结果写 artifact，只保留引用                                               |

限制可以通过受支持的配置降低。提高限制必须显式配置并在启动时显示有效值；不得按 CPU 核数自动提高到超过上述安全默认值。

### 21.3 准入顺序

创建任务必须遵循：

```text
校验参数
→ 估算 provider/context 权重
→ ResourceGovernor.acquire(signal, timeout)
→ 创建/fork ChildSession
→ 序列化必要上下文
→ 启动 Run/provider
```

不得先创建完整 `AgentSession`、复制父 transcript 或启动进程，再等待 permit。

`acquire()` 必须：

- 支持 `AbortSignal` 和等待超时。
- 使用分层优先级和 parent/workflow round-robin；禁止单个 workflow 通过提前填满队列长期占用全部 permit。
- 同一优先级、同一调度主体内部保持 FIFO；调度主体之间轮转。
- 队列满时返回结构化 `resource_exhausted`，包含 active、queued、limit 和建议动作。
- workflow/parent 取消时立即移除其排队项。
- permit 只能由唯一 lease 释放，所有执行路径在 `finally` 中释放。
- 拒绝任务时不静默切换 provider、降低隔离级别或新建无历史 Session。

嵌套调度必须满足无永久等待不变量：持有 permit 的 Run 不得同步等待一个在当前资源状态下永远无法取得 permit 的后代任务。runtime 可采用异步立即返回、层级 lease、嵌套保留容量或结构化拒绝，但必须保证：

- 全局 permit 已满时，同步嵌套要么可推进，要么在有界等待后返回 `nested_resource_exhausted`，不能永久 pending。
- 异步嵌套返回稳定 job ID 后，父 Run 不得阻塞等待 child permit。
- 调度诊断必须记录 parent/child wait graph 和最长等待时间，检测到环或无可运行节点时显示 `deadlock_suspected`。
- 不得通过绕过 ResourceGovernor、静默提高并发或提前释放仍在消耗资源的 active Run permit 来解除等待。

具体采用哪种调度算法在实现设计中决定，PRD 不固定死锁检测秒数或 credit 传递方案。

### 21.4 优先级与内存水位保护

调度和 shed-load 使用以下默认优先级，从高到低：

```text
P0 当前用户显式交互的 Agent Run（包括 Workbench 中当前选中的 Agent）
P1 direct background Agent Run
P2 workflow-owned background Agent Run
```

Main Run 不通过 Subagent ResourceGovernor 调度，也不得作为 shed-load 牺牲对象。选择某个 Agent 只提升其后续交互消息和新 Run，不抢占已运行任务；提高优先级不能绕过并发、内存或 process/mux 上限。同优先级需要 shed-load 时，优先中断最新启动且可取消的后台 Run。

内存比例取以下可观测值中的较高者：

```text
heapUsed / V8 heap limit
RSS / cgroup memory limit
RSS / system memory limit（无 cgroup 时）
```

采样要求：

- 每次 admission 前读取最新内存状态；存在 active Run 时进行周期采样。
- 采样周期必须明显短于预期的内存保护反应窗口，并允许根据内存增长速度自适应缩短；具体秒数由压测决定。
- cgroup limit 不可用时回退 system memory limit；两者都不可用时使用保守 fallback，并在 Workbench Status 中显示 `memory limit: fallback`。
- 采样失败不能被解释为“内存充足”；连续失败时停止扩并发并显示诊断。
- 每个 snapshot 记录采样时间和来源，避免 UI 将旧值显示为实时值。

| 内存比例  | 调度行为                                                                                  |
| --------- | ----------------------------------------------------------------------------------------- |
| `< 70%`   | 正常调度                                                                                  |
| `70%–80%` | 不扩并发，主动释放 terminal/idle runtime                                                  |
| `80%–90%` | 拒绝新任务，只允许已运行任务结束                                                          |
| `> 90%`   | 紧急 shed load：清空可取消队列、释放 idle runtime；仍持续上升时中断最新的低优先级后台 Run |

触发保护时必须显示原因和指标，例如：

```text
Agent 未启动：Pi 内存保护已触发
active=4 queued=18 rss=7.2GiB limit=8GiB
```

内存保护不能只记录日志后继续分配。

### 21.5 Session 与 runtime 生命周期

ChildSession 身份和 transcript 持久化；模型流、tool runtime 和监听器只在 Run/Activation 期间驻留。

Run 进入 terminal 状态后立即释放：

- model stream 和 provider handle。
- tool listeners 和 event subscriptions。
- AbortController、timer、poller 和 heartbeat。
- 临时 processor、RPC connection 和 mux supervisor handle。
- ResourceGovernor permit。

继续保留：

- `sessionId/runId/parentSessionId`。
- 轻量状态、usage 和 result/artifact 引用。
- 磁盘 transcript/journal。

可继续输入的 idle runtime 默认 TTL 为 5 分钟；TTL 到期后 `dispose` runtime，但保留 ChildSession，下一次输入 cold resume。registry 不得默认永久持有完整 `AgentSession`。terminal metadata 最多保留 100 条，超出按 LRU 清理；用户正在查看的节点不被自动移除。

### 21.6 父上下文复制

Native fork 的目标实现是：

```text
共享不可变父 Session 前缀 + child 增量记录
```

这是 Milestone 2 的高风险技术项，开始实现前必须通过 SessionRepo 技术验证确认存储、恢复和 compaction 路径。不能为每个 child 长期保留一份扁平化父 transcript。若共享前缀不能在当前里程碑可靠交付，允许使用受上下文大小、并发和 TTL 限制的复制方案过渡，但不得改变稳定 ChildSession 和多 Run 的产品语义。

原生共享前缀完成前：

- `with_context` 全局并发最多为 2。
- 准入前估算序列化字节数。
- 超过上下文或内存预算时要求使用 `fresh`、`summary` 或 `explicit`，不得继续复制。
- workflow fan-out 默认使用 `fresh` 或 `explicit`，除非任务明确需要父上下文。

### 21.7 有界事件与结果背压

Runtime event 必须先进入有界 store，再投影为 UI snapshot：

```text
Provider events
→ bounded EventStore
→ immutable ViewSnapshot
→ TUI render
```

规则：

- `run-started/run-completed/run-failed/run-cancelled` 等终态和身份事件不可丢弃。
- token delta、重复 progress 和 activity 可以合并为最新值。
- 单 child 内存事件窗口默认 1 MiB；超出后先持久化，再释放旧 delta。
- 持久化失败时不得继续无限积累内存；停止接收或合并可丢弃 delta，标记 transcript `degraded`，保留身份和终态事件，并向用户显示可恢复错误。
- 通知继续使用有界记录数、总字节数、单结果字节数和单次 flush 上限。
- workflow 的 `parallel()`/`pipeline()` 使用窗口化迭代，不能一次创建数千个 Promise 和闭包。
- workflow 的逻辑输入硬校验可以高于运行窗口，但等待队列始终受 ResourceGovernor 的 32 项上限控制。
- soft token budget 不能替代内存和结果字节硬上限。

### 21.8 TUI 渲染稳定性

- 方向键处理、选择切换和 `render()` 中禁止同步读取 artifact 或大文件。
- UI 只读取某个 revision 的不可变 snapshot，不遍历 runtime 正在修改的集合。
- streaming 内容最多触发 20 FPS，普通状态最多 5 FPS，elapsed time 最多 1 FPS；键盘输入仍可立即请求 render。
- 非当前 agent 只渲染一行摘要；当前 transcript 只渲染终端可见窗口。
- 大 transcript 分页读取，不因 target 切换重建 AgentSession 或全部 Markdown。
- terminal resize 后保留 target、Stage、Agent、滚动位置和草稿。
- 每个自定义 TUI 顶层组件必须有错误边界；`render()` 或输入处理异常时显示降级页并允许 `Esc` 返回 Main。
- UI 错误只关闭/降级视图，不取消正在运行的 agent/workflow。
- `dispose()` 必须幂等，并清理 timer、listener、overlay handle 和缓存。

降级页示例：

```text
Workflow UI 暂时不可用
任务仍在后台运行，错误已记录
Esc 返回 Main
```

### 21.9 执行故障隔离

- 每个 Run 都有独立 `AbortController`、显式 max duration 配置、terminal state guard 和 health 状态。
- provider heartbeat 与内容进度分开：长时间没有 token/progress 不等于 child 已死亡，不能仅凭静默时间强制终止正常长工具调用。
- heartbeat 或 RPC 健康异常时先标记 `stalled` 并显示 last heartbeat、provider 和建议动作；`stalled` 是诊断状态，不替代 Run terminal status。
- process/mux 在 heartbeat 与 RPC 都失效并超过实现定义的 grace period 后，supervisor 才能强制终止 child、标记 Run failed 并回收 permit。
- native Run 优先通过 AbortController interrupt；无法确认 runtime 已停止前不得提前释放 permit 或删除 Session 状态。
- 默认阈值和 grace period 由 provider 能力与压测确定，不在 PRD 写死统一分钟数；用户可为长任务显式配置 max duration。
- 所有后台 Promise 都必须落入对应 Run 的成功/失败状态，禁止出现 `unhandledRejection`。
- process/mux child 崩溃只标记对应 Run failed，supervisor 回收进程和 permit。
- native provider 与 Main 共享 Node 进程，无法隔离真正的 OOM 或 native fatal error；ResourceGovernor 和内存水位是其强制前置保护。
- 高风险、不可信或高内存任务使用 process provider，不允许为了吞吐静默回退 native。
- provider 不支持 fork、resume、structured output 或 continuable 时必须 fail loud。
- notification、artifact 或 UI 写入失败不得覆盖已经确定的 Run terminal result。

### 21.10 可观测性

状态页和诊断日志至少提供：

```text
active / queued / limits
active workflows
provider/isolation 分布
heapUsed / heapLimit / RSS / memoryLimit
retained sessions / listeners / timers
coalesced or dropped transient events
最近一次 resource_exhausted 或内存保护原因
Run health / last heartbeat / longest queue wait
scheduler wait graph / deadlock_suspected
memory sample source / sampledAt / fallback reason
平均/最大 render duration
```

Workbench 提供固定 `Status` 视图展示上述指标；资源保护错误和 stalled 提示可以直接跳转到该视图。状态视图只读，不允许绕过限制或直接操作 runtime handle。这些指标默认本地保存，不上传遥测数据。

## 22. 异常与边界场景

1. agent 在被选中时完成：保持当前会话，状态变为 completed，输入仍可 resume。
2. workflow 动态增加 Stage/Agent：按稳定 ID 保持当前选择。
3. process child 突然退出：显示失败原因，保留最后 transcript。
4. artifact 缺失：显示“历史内容不可用”，不能无限 loading。
5. Main 被中断：按运行策略决定 child 是否继续，UI 不自行推断。
6. 多个 workflows：都出现在 Switcher，分别打开独立工作台。
7. workflow 完成后：工作台可继续回看；输入只对可恢复 agent 开放。
8. parent session reload：从 session/journal 重建 Switcher 和 workflow tree。
9. agent 名称过长：中间或尾部截断，但详情页显示完整名称。
10. 中文、宽字符和 ANSI 样式：每行不得超过终端可见宽度。
11. IME 输入：CustomEditor/Workflow Input 必须正确实现 Focusable 光标传播。
12. 全局 permit 耗尽：任务保持 queued 或返回 `resource_exhausted`，不能绕过 governor。
13. 排队任务被取消：从队列移除，不创建 Session，不遗留 Promise、timer 或 permit。
14. 内存达到软/硬水位：停止扩并发或拒绝新任务，已有任务和 Main 保持可操作。
15. TUI render 抛错：显示降级页，后台任务继续运行。
16. 大量 workflow 同时启动：全局 active 数保持在硬上限，局部 semaphore 不相乘。
17. agent terminal 后：runtime 被释放，用户仍可从持久 Session 回看和 cold resume。
18. workflow-owned Agent 已提交结果后收到用户输入：创建 `manual-continuation`，不修改原 workflow 结果或 Stage 状态。
19. 用户中断单个 workflow Agent：只终止对应 Run，workflow DSL 按结构化失败结果继续或收敛，不隐式取消兄弟 Agent。
20. 用户取消整个 workflow：取消尚未启动的队列项并中断仍由该 workflow 持有的 active Run；已提交结果和 transcript 保留，独立的 `manual-continuation` 不受影响。
21. Workbench runtime API 版本不兼容：Workbench 显示只读降级页，不读取私有全局变量或猜测事件结构。
22. 全局 permit 已满且 Agent 同步启动后代任务：系统继续推进或有界返回 `nested_resource_exhausted`，不永久 pending。
23. provider 长时间无内容但 heartbeat 正常：显示运行中或无进度提示，不误杀有效长工具调用。
24. heartbeat 与 RPC 同时失效：显示 stalled；process/mux 超过 grace period 后只回收对应 child，其他 Run 和 Main 保持可操作。
25. 用户退出 Pi 时存在 active/queued Run：显示 readback，按 isolation 与 `surviveParent` 策略处理，并为每个任务写入可解释终态或存活引用。
26. 退出中断后遗留 child：下次启动执行 orphan reconciliation，能重新关联、明确保留或安全回收，不能无限累积无人管理会话。
27. 用户向上滚动查看 transcript 时收到新内容：滚动位置保持，新内容提示增加，回到底部后再清零。
28. Attach 进入 mux child 后 detach：返回原 Workbench target、焦点和草稿，child 状态刷新且不会重复订阅。

## 23. 可访问性

- 状态同时使用符号和颜色。
- 所有功能可以只通过键盘完成。
- 选中行必须有高亮、前缀和文本提示，不只依赖背景色。
- terminal 不支持 Unicode 图标时允许切换 ASCII 符号。
- 帮助行展示当前焦点下实际可用的按键。

## 24. 验收标准

### 24.1 Main / Agent

1. 没有 child 时不显示 Conversation Switcher。
2. 出现 child 后，Switcher 位于输入框下方。
3. 用户能从 Editor 使用方向键进入 Switcher。
4. `←/→` 能选择 Main 和不同 agent。
5. 激活 agent 后显示其 transcript，输入框明确标识目标 agent。
6. 向 agent 输入不会先提交给 Main。
7. agent running 时支持 steering/follow-up；idle/completed 时在同一 Session 创建新 Run。
8. Main 和每个 agent 分别保留输入草稿。
9. 切换会话不停止任何 agent。
10. 非当前会话的新内容产生未读计数；进入并滚动到最新内容后清零。

### 24.2 Workflow

11. 只有显式 workflow 才创建 Workflow 节点和独立工作台。
12. Foreground workflow 自动打开工作台；background workflow 不抢焦点。
13. 工作台能展示 Stage 及每个 Stage 的 agents。
14. 用户能用方向键选择 Stage 和 Agent。
15. 选中 Agent 后能查看实时 transcript 并发送消息。
16. `Esc` 返回调用方会话但不取消 workflow。
17. workflow 动态增加 Stage/Agent 时选择不跳动。
18. 完成和失败的 Stage/Agent 可回看。
19. 宽、中、窄三种终端布局均可操作。

### 24.3 一致性与恢复

20. native、process 和 mux agent 使用相同状态符号和导航行为。
21. 完成通知不重复。
22. UI 关闭或异常不影响 agent/workflow 执行。
23. session reload 后可重建 child/workflow 导航状态。
24. TUI 渲染测试覆盖中文宽字符、resize、方向键焦点及动态节点插入。

### 24.4 稳定性与过载保护

25. 启动 100 个逻辑 agent 时，实际同时运行数始终不超过全局上限 4。
26. 同时启动 10 个 workflows 时，全局 active 数仍不超过 4，process/mux 不超过 2。
27. 队列达到 32 后，新任务返回结构化 `resource_exhausted`，且不创建 Session 或复制上下文。
28. 排队中的 workflow/agent 被取消后，队列项、permit、listener 和 timer 均被释放。
29. 连续运行和回收 agent 30 分钟，terminal runtime 清理后 RSS 不出现与完成任务数成线性关系的增长。
30. 单 agent 产生 10 MiB transcript 时，内存窗口保持有界，TUI 不全量重建 transcript。
31. 连续 10,000 次 streaming event 下，瞬态 delta 被合并，键盘和 target 切换仍可响应。
32. 自定义 TUI `render()` 故意抛错时显示降级页，Main 和后台任务继续运行。
33. child process 强制退出时，只对应 Run failed，supervisor 回收进程与 permit。
34. 反复进入/退出 Agent/Workflow 视图 100 次后，listener、timer、overlay 和 focus handle 数量不增长。
35. 所有后台失败都进入对应 Run terminal state，不产生 `unhandledRejection`。
36. 达到 70%/80%/90% 内存水位时分别执行限流、拒绝和 shed-load 策略，并显示可解释原因。
37. agent terminal 后完整 runtime 被释放，随后输入可从同一持久 ChildSession cold resume。
38. workflow 输入规模大于运行窗口时使用窗口化调度，不一次物化全部 Promise/闭包。

补充 payload 门禁：非法运行时参数、空 task、非正 timeout、超过 1 MiB 的 task、超过 8 MiB 的 explicit context 必须在 Session/provider 前拒绝；超过 8 MiB 或结构非法的 provider output 必须令对应 Run failed 并释放 permit。所有大小按 UTF-8 字节计算，边界值可接受，超 1 字节必须拒绝。

稳定性门禁 25–38、50 以及 54–56 未通过时，不得默认开放多 agent/workflow 并发 UI。

### 24.5 Sidebar / Workbench 职责拆分

39. `/sidebar` 和 `Ctrl+Alt+S` 只打开通用 Main/Pi 会话概览。
40. 外部 `sidebar.ts` 不读取 Workbench runtime、child session、workflow 或 artifact，未安装 `pi-subagent-workbench` 时仍可独立工作。
41. Agent/Workflow 列表、transcript、usage、activity、Stage 和控制操作只在 `subagent-workbench` 出现。
42. 同一个 agent/workflow 不会被 Sidebar 和 Workbench 同时渲染或重复通知；外部 `sidebar.ts` 的 import graph 不包含 `pi-subagent-workbench` 模块。
43. `/subagent-workbench` 和输入框下方方向键能够进入 Workbench，不占用 Sidebar 快捷键。
44. 旧 `subagent-sidebar.ts` 只在 Workbench 达到功能等价并通过稳定性门禁后移除；安装说明能识别并处理旧全局副本，避免重复加载。

### 24.6 状态、路由与控制语义

45. Conversation availability 与 Run status 分开存储；`idle` 只由“无 active Run 且 availability=ready”派生，`completed` 和 `interrupted` 保留为 latest Run 结果。
46. Workbench UI 只通过版本化 `SubagentWorkbenchRuntime` 获取不可变 snapshot 和发送受控 command，不读取 runtime 可变对象、provider handle 或其他 package 私有 global。
47. `Ctrl+C` 在 Main、Agent Editor、Switcher 和 Workflow Workbench 中符合 §9.5，不会因为焦点误判而取消错误目标。
48. workflow Agent 结果提交后继续输入会创建 `manual-continuation`，原 workflow 结果、Stage 状态和聚合 usage 不变。
49. 取消单个 workflow Agent 不隐式取消兄弟 Agent；取消整个 workflow 会清理其排队项和 workflow-owned active Run，但保留 transcript 和已提交结果。
50. 只有低优先级任务等待时，新进入的 foreground direct Agent 获得下一个释放的 eligible permit；三个同优先级 workflow 各持续排队时，前 12 次 grant 的数量差不超过 1。
51. parent session reload 后恢复仍有效的 target 和 Agent 草稿；目标已失效时安全回到 Main，易失 UI 状态不影响任务运行。
52. `notify`、`quiet`、`wakeup` 按 §16 映射现有 delivery 参数，不产生重复注入或重复唤醒。
53. Session prefix sharing 技术验证失败时启用受限复制 fallback，稳定 ChildSession、多 Run 和资源上限仍满足验收。

### 24.7 运行健康与交互友好性

54. 全局 permit 被占满时构造同步嵌套任务，系统能继续推进或有界返回 `nested_resource_exhausted`，不永久等待，也不绕过并发上限。
55. provider heartbeat/RPC 失效时 Run 显示 stalled 和 last heartbeat；process/mux 经过 grace period 后回收对应 child 和 permit，其他 Run 不受影响。
56. 模拟长时间无 token 但 heartbeat 正常的工具调用时，不会仅因内容静默被误杀；显式 max duration 仍可中断并形成终态。
57. active/queued 任务存在时退出 Pi，会显示 readback 并按 isolation 与 `surviveParent` 处理；异常退出后的 orphan 能在下次启动被重新关联或安全回收。
58. 第一个 Agent 出现时显示一次性 Switcher 提示；Switcher/Workbench 中按 `?` 能查看当前焦点的进入、返回、发送、中断和取消按键。
59. transcript 位于底部时自动跟随；用户向上滚动后位置不跳动并显示新内容计数，回到底部后才清零。
60. Agent 输入只有收到持久化 message ID 后才显示可靠 `queued`；完整 durable delivery 未交付时，易失路径有明确提示且不伪造成功。
61. 排队 UI 显示 active/limit、等待的资源类型或内存保护原因，不显示会因优先级和 round-robin 变化而失真的精确位置。
62. Attach 前显示 backend 和返回方式；detach 后恢复 Workbench target、焦点和草稿，重复 attach/detach 不增加 listener。
63. Workbench Status 能查看 active/queued、内存采样来源、Run health、last heartbeat、最长等待和最近保护原因，并能从错误提示直接进入。
64. Switcher 保持稳定创建顺序；failed/needs-attention 通过 badge、过滤和跳转暴露，不通过动态重排打断当前选择。
65. 取消 workflow 的确认默认安全、不阻塞后台任务、显示受影响 Run 数量，重复确认只执行一次，`Esc` 不产生取消副作用。

## 25. 交付阶段

### Milestone 0：稳定性基础设施

#### M0a：全局准入

- 进程级 `ResourceGovernor`，覆盖 direct subagent 和所有 workflows。
- 有界、可取消、带超时的等待队列。
- 分层优先级、parent/workflow round-robin 和默认并发硬上限。
- 嵌套调度无永久等待不变量和 `nested_resource_exhausted`。
- structured `resource_exhausted`。

#### M0b：生命周期与内存

- workflow、context、process/mux 和 retained runtime 硬上限。
- 内存水位、采样 fallback、shed-load 和可解释诊断。
- provider heartbeat、stalled health 和 grace-period 回收。
- Run terminal cleanup、幂等 dispose 和 cold resume 基础。

#### M0c：事件与 TUI 隔离

- 有界 EventStore、瞬态事件合并和不可变 TUI snapshot。
- Workbench runtime API v1。
- render/input 错误边界。

完成稳定性验收 25–38、50 以及 54–56 后，Milestone 0 才算通过。后续 UI 可以与 M0b/M0c 并行开发，但 Milestone 0 是默认开放多 agent/workflow 并发 UI 的发布前置门禁。

### Milestone 1：Agent Conversation Switcher

- 完成 `CustomEditor`、焦点、IME 和 target submit 技术验证。
- Main/Agent target 模型。
- 输入框下方 Switcher、溢出滚动、方向键导航、首次提示和 `?` 帮助。
- 每 target 草稿、滚动跟随及 reload 恢复。
- Workbench Status、Needs attention 过滤和可解释排队状态。
- 通过 Workbench runtime API 适配当前 in-process/process 内容。
- 仅在现有 provider 已支持时开放 active agent 输入；不在此阶段承诺稳定 ChildSession 的多 Run。
- 所有 spawn 必须经过 ResourceGovernor。
- 完成验收 58、59、61、63 和 64。

### Milestone 2：Native ChildSession

- Pi SessionRepo create/fork 技术验证。
- 优先实现 shared immutable parent prefix + child delta；无法可靠交付时使用受限复制 fallback。
- stable ChildSession + transient Run。
- watch/open child session。
- 复用现有 Pi RPC mode 完成 process provider 适配。
- `send/steer/followup/interrupt/resume` 和同一 Session 多 Run。
- 持久 message acknowledgment；完整 durable delivery 留在 Milestone 5。
- Pi 退出 readback、`surviveParent` 处理和 orphan reconciliation。
- mux Attach/detach 返回 Workbench 的完整路径。
- terminal runtime 自动释放和 cold resume。
- artifact 降级为兼容和恢复层。
- 完成验收 7、45、47、51、53、57、60 和 62。

### Milestone 3：Workflow Workbench

- Stage 数据模型和事件。
- 三种响应式布局。
- Stage/Agent 导航。
- Agent transcript、输入和 `manual-continuation` 标记。
- Agent result commit 边界和 workflow cancel 传播。
- background workflow 入口。
- workflow 局部配额与全局 ResourceGovernor 联动。
- windowed `parallel()`/`pipeline()`。
- 达到现有 Sidebar 的 agent/workflow 观测功能等价。
- 完成验收 46、48、49、50、52 和 65。

### Milestone 4：Sidebar 职责拆分

- 将全部 agent/workflow 可视化和控制迁入 Subagent Workbench。
- 从旧 Sidebar 删除所有 subagent/workflow 状态依赖。
- 在 `pi-tsien-extension` 重新实现通用 `extensions/sidebar.ts`。
- 注册 `/sidebar` 和 `Ctrl+Alt+S`。
- 移除旧 `subagent-sidebar.ts` 及重复安装说明。
- 验证 Sidebar 未安装 `pi-subagent-workbench` 时仍可独立工作。
- 验证 Workbench 是 agent/workflow 唯一事实视图。

### Milestone 5：恢复与体验完善

- 基于 Milestone 2 持久 acknowledgment 完成 inbox/outbox 重放、去重和跨重启 delivery。
- workflow journal/resume。
- 未读和通知去重。
- transcript 分页和虚拟化。
- 快捷键自定义和帮助页。
- 长时间 soak、内存和故障注入回归。
- 记录空载、单 Agent、四 Agent 并发峰值、回收后稳态 RSS 及循环增长斜率；以回收后趋于平台值作为泄漏判定。

## 26. Review 决策

### 26.1 已确认

1. **可视化归属**：所有 subagent/workflow 可视化和交互统一放在 `subagent-workbench`，不在 Sidebar 重复展示。
2. **Sidebar 定位**：保留并重新实现通用 `sidebar`，只展示 Main/Pi 会话概览，不依赖 `pi-subagent-workbench`。
3. **迁移顺序**：先让 Workbench 达到功能等价，再拆除旧 Sidebar 的 subagent 能力并重命名为 `sidebar.ts`。
4. **入口归属**：`/sidebar` 和 `Ctrl+Alt+S` 属于通用 Sidebar；`/subagent-workbench` 和输入框下方方向键属于 Workbench。
5. **状态分层**：Conversation availability 与 Run status 分开建模；`idle` 是无 active Run 时的派生 UI 状态，`completed` 和 `interrupted` 是 latest Run 结果。
6. **完成 Agent 输入**：可恢复 Agent 默认在同一 ChildSession 中创建新 Run；provider 不支持时必须显式创建关联的新会话。
7. **未读清零**：进入 target 后只有滚动到最新内容才清零。
8. **Runtime 接口**：Workbench UI 只通过本 repo 的版本化 snapshot/command API 访问独立 runtime，不读取私有全局变量。
9. **Workflow 人工继续**：Agent result commit 后的新 Run 标记为 `manual-continuation`，不修改原 workflow 结果和 Stage 状态。
10. **取消传播**：中断单个 workflow Agent 不隐式取消兄弟 Agent；取消 workflow 只传播到其队列项和 workflow-owned active Run。
11. **调度公平性**：采用分层优先级和 parent/workflow round-robin；Main 不作为 shed-load 牺牲对象。
12. **通知兼容**：`notify/quiet/wakeup` 映射现有 `notifyOnComplete` 与 `triggerTurnOnComplete`，不创建第二套 delivery 协议。
13. **嵌套调度**：持有 permit 的 Run 不得同步永久等待无法取得 permit 的后代任务；必须推进或结构化拒绝。
14. **Run 活性**：heartbeat 与内容进度分开；内容静默不等于死亡，只有健康检查和 grace policy 满足时才回收 child。
15. **退出 readback**：Pi 退出前显示 active/queued 影响范围；process/mux 是否存活由显式 `surviveParent` 策略决定。
16. **首次引导**：第一个 Agent 出现时显示一次性 Switcher 提示，Switcher/Workbench 都提供 `?` 上下文帮助。
17. **滚动跟随**：只在用户位于底部时自动跟随；向上滚动后保持位置并显示新内容计数。
18. **消息确认**：可靠 `queued` 必须基于持久 message ID；Milestone 2 交付 acknowledgment，Milestone 5 交付完整 durable delivery。
19. **注意力管理**：Switcher 保持稳定顺序，通过 badge、Needs attention 过滤和跳转突出异常项，不动态重排。
20. **Attach 往返**：Attach 前说明 backend 返回方式，detach 后恢复 Workbench target、焦点和草稿。

### 26.2 待确认

1. **进入 Switcher 的主按键**：是否接受“Editor 最后一行再按一次 `↓`”；技术降级是否使用 `Shift+↓`。
2. **激活选择**：Switcher 中 `↑` 和 `Enter` 是否都激活当前 target。
3. **Foreground workflow**：是否始终自动打开独立工作台。
4. **Workflow 根节点输入**：v1 是否保持只读，仅允许对具体 agent 输入。
5. **完成节点保留时间**：保留到 parent session 结束，还是允许用户手动隐藏。
6. **窄终端阈值**：`80/120` 是否合适。
7. **Agent steering 语义**：`Enter=steering`、`Alt+Enter=follow-up` 是否与 Main 保持一致。
8. **默认资源上限**：全局 4、单 workflow 4、process/mux 2、`with_context` 2 是否合适。
9. **队列和 workflow 上限**：每 parent 队列 32、单 workflow 生命周期 64 个 Agent Run 是否合适。
10. **内存水位**：70%/80%/90% 的限流、拒绝和 shed-load 阈值是否接受。
11. **紧急 shed-load**：内存持续超过 90% 时，是否允许中断最新的低优先级后台 Run 以保护 Main。
12. **runtime TTL**：idle runtime 5 分钟后 dispose、下次输入 cold resume 是否合适。
13. **完成节点保留**：内存 metadata 上限 100，完整 transcript 只保留在 Session store 是否满足回看需求。
14. **稳定性发布门禁**：是否同意验收 25–38、50 以及 54–56 未通过前不开放默认多 agent/workflow 并发。
15. **`surviveParent` 默认值**：process 和 mux 是否使用相同默认值，还是按 isolation 分别配置。
16. **Run health 默认值**：各 provider 的 heartbeat、stalled warning、grace period 和 max duration 默认值如何确定。
17. **取消确认形式**：行内确认还是轻量 overlay；保持默认安全和幂等语义不变。
18. **极窄终端 Switcher**：继续水平滚动，还是在低于待定宽度时折叠为摘要并引导进入 Workbench。
19. **注意力入口**：Needs attention 的默认过滤入口、跳转快捷键和通知聚合时间窗口。
