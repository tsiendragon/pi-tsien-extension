# Native Subagent / Workflow TUI Tech Design

- **状态**：Core implementation completed; RPC extension-dialog projection remains follow-up
- **范围**：`pi-subagent-workbench` Direct Subagent、Workflow、Workflow Agent 页面
- **目标版本**：下一次 TUI 架构升级
- **依赖**：Pi host 增加受支持的 fullscreen route API

## 0. 实现结果

已落地：

- Pi host `ctx.ui.custom(..., { fullscreen: true })`，负责 alternate screen、完整 layout root、焦点和 Main 恢复；
- Workbench 独立 `VStack + primary ScrollView + fixed dock`；
- RPC thinking、assistant block、tool start/update/end、model/provider/usage timeline；
- 复用 Pi `UserMessageComponent`、`AssistantMessageComponent`、`ToolExecutionComponent`、`CustomEditor` 和 Footer view-model renderer；
- Direct、Workflow、Workflow Agent 的独立滚动与分层返回；
- 真实 tmux 验证：Direct、Workflow、Workflow Agent 连续 PageUp 均未出现 Main sentinel，`Esc` 后 Main 原页面恢复。

待后续单独交付：RPC extension `select/confirm/input/editor` modal 投影，以及跨重启 durable transcript。

## 1. 背景与问题

当前 Workbench 使用：

```ts
ctx.ui.custom(factory, {
  overlay: true,
  overlayOptions: { width: "100%", maxHeight: "100%" },
});
```

它只是把自绘组件覆盖在主 Agent 页面上，不是独立页面，因此存在三个结构性问题：

1. **滚动没有隔离**：主 Agent transcript 仍在宿主 TUI 文档中。终端滚轮或向上滚动可以露出主 Agent 内容。
2. **执行过程不完整**：RPC Provider 当前主要投影 user/assistant 文本，没有保留 thinking、tool call、tool progress、tool result、retry、compaction 等事件。
3. **Direct Subagent 不是原生 Pi 体验**：输入框、状态栏和消息渲染是 Workbench 自绘版本，不是与主 Agent 共用的组件和交互语义。

这不是继续增加 Overlay 高度可以解决的问题。必须同时改变页面承载方式、事件模型和 UI 组件复用方式。

## 2. 目标

### 2.1 Direct Subagent

Direct Subagent 打开后应表现为独立的 Pi 页面：

- 显示 user、assistant text、thinking、tool call、tool 实时输出和 tool result；
- 使用与主 Agent 相同的消息渲染、主题、输入框和 Powerline 风格；
- Follow-up 继续发送到同一个 RPC ChildSession；
- 运行中提交的信息按 Follow-up 语义排队；
- 滚轮、PgUp/PgDn、Home/End、搜索只作用于该 Subagent 的 transcript；
- `Esc` 返回 Main，但不取消后台任务；
- Main 的 transcript、输入草稿、焦点和滚动位置在返回后原样恢复。

### 2.2 Workflow

Workflow 打开后应是自己的独立页面：

- 页面只包含 Workflow 标题、Stage/Task 导航、选中 Agent 的完整实时过程和 Workflow 状态栏；
- Workflow 页面不提供 Follow-up 输入框；
- Stage 串行、Stage 内 Agent 并行的运行语义保持不变；
- 滚动只作用于 Workflow 自己的 Stage/Agent 内容，不能显示 Main 内容；
- 进入 Workflow Agent 后，使用相同的完整消息渲染，但保持只读；
- `Esc` 按 `Workflow Agent → Workflow → Main` 返回，不中断任务。

### 2.3 屏幕隔离

“独立页面”在行为上必须满足：

- 当前页面拥有独立的 application document 和 ScrollView；
- Main document 不参与当前页面布局和滚动；
- fullscreen 模式使用 alternate screen，不把内容写入普通终端 scrollback；
- 页面切换由 Pi host 保存和恢复 layout root、焦点、滚动位置和编辑器草稿；
- 不直接向 `stdout` 写 ANSI，不在同一个终端上启动第二个互相竞争的 TUI renderer。

## 3. 非目标

本次不做：

- 在 Workflow 页面向内部 Agent发送 Follow-up；
- 把主 Agent 和子 Agent 合并为同一个模型会话；
- 用 tmux/zellij 作为运行时硬依赖；
- 在 Workbench 内复制全部 Pi 内置设置页面；
- 修改 Agent 调度、资源限制和 Stage 串并行语义。

RPC 模式不支持的 Pi 内置 TUI 命令（例如只存在于 interactive mode 的 `/settings`）不会在第一版伪装为可用；skill、prompt template 和 extension command 仍通过 RPC `prompt` 正常展开。

## 4. 方案决策

### 4.1 推荐方案

采用两层结构：

1. **Pi host 管理 fullscreen route**：宿主管理 alternate screen、layout root、焦点、滚动状态和恢复 Main。
2. **Workbench 基于完整 RPC 事件渲染 native-style 页面**：RPC 子进程继续负责工具、skills、extensions、prompt templates、context files 和 Agent 执行；Workbench 使用 Pi 公共 TUI 组件渲染完整过程。

```text
Main InteractiveMode
        │
        │ Enter target
        ▼
Host Fullscreen Route Manager
        │ owns alt-screen/layout/focus/restore
        ▼
Workbench Route Root
  ├─ DirectAgentPage
  ├─ WorkflowPage
  └─ WorkflowAgentPage
        │
        ▼
Workbench Runtime v2 timeline
        │
        ▼
Pi RPC child events
```

### 4.2 为什么不直接附着交互式 Child Pi

一个已经以 `--mode rpc` 启动的进程不能在运行中转换为 interactive TUI。改成 PTY 中的 interactive child 虽然外观最接近原生 Pi，但会引入：

- 后台运行时必须持续解析并保存 ANSI terminal state；
- attach 时需要重建完整屏幕；
- 父 TUI 和子 TUI 会争用输入、resize、mouse mode、Kitty keyboard protocol 和 alternate screen；
- 需要额外 terminal emulator 或 tmux/zellij；
- RPC 调度、Workflow 聚合和状态观测会变差。

因此不采用“嵌套 interactive Pi/PTY”作为默认架构。

### 4.3 为什么不继续使用 100% Overlay

Overlay 始终属于 Main 的 layout/viewport。即使视觉上覆盖 100%，Main document 仍然存在，无法保证滚动隔离，因此明确淘汰。

## 5. 必需的 Pi Host API

当前扩展 API 只有两种 `custom()` 行为：

- `overlay: true`：覆盖现有内容；
- 非 Overlay：只替换主编辑器区域。

两者都不能安全替换完整 fullscreen layout root。`TuiAltScreen.setLayoutRoot()` 虽然存在，但扩展无法读取和恢复宿主原 layout root；扩展直接调用会破坏 Main 生命周期。

因此需要先在 Pi 上游增加受支持的 host-owned fullscreen route API。建议向 `ExtensionUICustomOptions` 增加：

```ts
interface ExtensionUICustomOptions {
  overlay?: boolean;
  fullscreen?: boolean;
  // existing options omitted
}
```

调用方式：

```ts
await ctx.ui.custom(
  (tui, theme, keybindings, done) =>
    createWorkbenchRouteRoot({ tui, theme, keybindings, done }),
  { fullscreen: true },
);
```

`overlay` 和 `fullscreen` 互斥。

### 5.1 Host 行为合同

`fullscreen: true` 由 `InteractiveMode` 执行以下步骤：

1. 保存当前 TUI mode、Main layout root、focused component、editor draft 和 viewport state；
2. 若当前不是 fullscreen，切换到 `TuiAltScreen`；
3. 将扩展返回的组件设置为唯一 fullscreen layout root；
4. 当前 route 必须提供唯一的 primary `ScrollView`；
5. mouse wheel、keyboard viewport commands、selection 和 search 只路由到当前 root；
6. `done()` 后 dispose route，恢复 Main root、mode、focus、draft 和 viewport；
7. 异常或 extension unload 时也必须执行同一恢复流程；
8. 禁止嵌套启动第二个 terminal renderer。

`InteractiveMode` 已持有 `fullscreenLayoutRoot`，因此恢复应由 host 完成，而不是把私有 root 暴露给扩展。

### 5.2 上游复用组件

为了满足“与主 Agent 一致”而不是长期维护近似副本，需要从 Pi interactive renderer 抽出稳定公共组件或工厂：

```ts
createAgentTimelineView(model: AgentTimelineModel, options): Component;
createAgentEditor(options): EditorComponent;
createAgentPowerline(model: AgentPowerlineModel, options): Component;
```

要求：

- Main 和 Workbench 使用同一套 message/tool/thinking renderer；
- 主题、Markdown、tool pending/success/error、thinking 展开策略一致；
- Powerline 接收 view model，不直接依赖主 `AgentSession`；
- Workbench 不从 `dist/modes/interactive/*` 私有路径导入实现。

如果上游暂时只能先交付 fullscreen route API，第一阶段可复用公开的 `Markdown`、`Editor`、`ScrollView`、`VStack` 和 Theme 做兼容渲染；native renderer 抽取完成后替换，不改变 Runtime 数据合同。

## 6. RPC 事件与 Provider 改造

### 6.1 当前缺口

`PiRpcProcessProvider` 当前主要消费 assistant text delta 和最终 assistant message。RPC 实际已提供：

- `message_start/update/end`；
- `thinking_start/delta/end`；
- `toolcall_start/delta/end`；
- `tool_execution_start/update/end`；
- `turn_start/end`；
- `queue_update`；
- `compaction_start/end`；
- `auto_retry_start/end`；
- `extension_ui_request`；
- usage、model 和 session state。

### 6.2 Provider UI Event

在 Provider 层增加结构化事件，不把 RPC 原始 JSON 泄漏给 UI：

```ts
type ProviderUiEvent =
  | { type: "assistant-start"; runId: string; messageId: string }
  | {
      type: "text-delta";
      messageId: string;
      contentIndex: number;
      delta: string;
    }
  | {
      type: "thinking-delta";
      messageId: string;
      contentIndex: number;
      delta: string;
    }
  | { type: "tool-call"; toolCallId: string; name: string; args: unknown }
  | { type: "tool-start"; toolCallId: string; name: string; args: unknown }
  | { type: "tool-update"; toolCallId: string; output: ToolOutput }
  | {
      type: "tool-end";
      toolCallId: string;
      output: ToolOutput;
      isError: boolean;
    }
  | { type: "queue"; steering: string[]; followUp: string[] }
  | { type: "compaction"; phase: "start" | "end"; summary?: string }
  | { type: "retry"; phase: "start" | "end"; attempt: number; error?: string }
  | { type: "usage"; usage: AgentUsage }
  | { type: "extension-ui"; request: ExtensionUiRequest };
```

规则：

- `tool_execution_update.partialResult` 是累计输出，Runtime 用 replace，不重复 append；
- `message_end.message` 是最终权威值，用于纠正 delta 聚合；
- 所有事件绑定 `sessionId`、`runId`；旧 Run 的晚到事件不能覆盖新 Run；
- 未知事件记录诊断计数，但不使 Run 失败；
- UI 渲染异常不能影响 Provider 控制通道。

## 7. Runtime 数据模型

保留现有 `messages` 兼容字段，新增结构化 timeline：

```ts
interface ConversationRecord {
  // existing fields
  readonly timeline?: readonly TimelineEntry[];
  readonly metrics?: ConversationMetrics;
  readonly uiRequests?: readonly PendingUiRequest[];
}

type TimelineEntry = UserEntry | AssistantEntry | ToolEntry | SystemEntry;

interface AssistantEntry {
  readonly id: string;
  readonly runId: string;
  readonly type: "assistant";
  readonly blocks: readonly (
    | { type: "text"; text: string; streaming?: boolean }
    | { type: "thinking"; text: string; streaming?: boolean }
    | { type: "toolCall"; toolCallId: string; name: string; args: unknown }
  )[];
}

interface ToolEntry {
  readonly id: string;
  readonly runId: string;
  readonly type: "tool";
  readonly toolCallId: string;
  readonly name: string;
  readonly args: unknown;
  readonly output?: ToolOutput;
  readonly status: "running" | "completed" | "failed";
}
```

### 7.1 内存边界

- 继续实施每个 Conversation 的 byte cap；
- tool update 只保留最新累计结果；
- 淘汰时以完整 entry 为单位，不截断 JSON/UTF-8；
- user/assistant/toolCall/toolResult 关联组优先一起保留；
- 被淘汰时插入一个 `transcript-truncated` SystemEntry；
- 完整大输出仍由工具原有 `fullOutputPath` 管理，不复制到 Runtime。

### 7.2 指标

Powerline view model 至少包含：

```ts
interface ConversationMetrics {
  model?: string;
  thinkingLevel?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  contextTokens?: number;
  contextWindow?: number;
  contextPercent?: number;
  cost?: number;
  toolCalls: number;
  elapsedMs: number;
  queuedFollowUps: number;
}
```

数据来源：RPC event usage、`get_state` heartbeat 和受节流的 `get_session_stats`。运行时最多每 1 秒刷新一次 footer，不为每个 token delta 触发完整 stats RPC。

## 8. 页面组件架构

### 8.1 顶层 Route Root

```text
WorkbenchFullscreenRoot (VStack, terminal height)
  ├─ RouteHeader                    fixed
  ├─ RouteBody                      flex
  │    └─ primary ScrollView
  ├─ Working/Notification row       fixed, optional
  ├─ Powerline                     fixed
  └─ Editor or ReadOnlyHelp         fixed
```

Body 是当前 route 唯一文档。Main transcript 不在这个组件树中。

### 8.2 DirectAgentPage

```text
DirectAgentPage
  ├─ Native AgentTimelineView       primary ScrollView
  ├─ Native WorkingIndicator
  ├─ Native-style Powerline
  └─ Native AgentEditor
```

行为：

- 初次打开默认 follow end；
- 用户向上滚后停止自动追随，出现“有新输出”提示；
- `End` 恢复 follow end；
- `Enter` 发送；运行中发送按 `follow_up` 排队；
- `Ctrl+C` 中断当前 Run；
- `Esc` 仅关闭 route；
- 草稿按 `sessionId` 保存；
- skills、prompt templates、extension commands 的 autocomplete 来自 RPC `get_commands`。

### 8.3 WorkflowPage

宽屏：

```text
WorkflowPage
  ├─ Header
  ├─ HStack
  │   ├─ StageTreeView
  │   └─ selected AgentTimelineView (primary ScrollView)
  ├─ WorkflowPowerline
  └─ ReadOnlyHelp
```

窄屏使用上下布局，但仍只创建 Workflow 自己的 document。

- `↑/↓` 选择 Stage/Task；
- `←/→` 折叠 Stage；
- `Tab` 在 Stage 树和输出滚动焦点间切换；
- 滚轮在指针所在 pane 内滚动；
- `Enter` 打开 WorkflowAgentPage；
- `i` 中断选中 Agent，`I` 中断 Workflow；
- 无 Follow-up Editor。

### 8.4 WorkflowAgentPage

复用 DirectAgentPage 的 Timeline 和 Powerline，只移除 Editor：

```text
WorkflowAgentPage
  ├─ Native AgentTimelineView       primary ScrollView
  ├─ Native-style Powerline
  └─ ReadOnlyHelp
```

## 9. 页面与任务生命周期

### 9.1 打开 Direct Subagent

```text
Top navigation Enter
  → host enters fullscreen route
  → route reads retained runtime timeline
  → subscribe runtime updates
  → focus child editor
  → live RPC events update timeline
```

### 9.2 返回 Main

```text
Esc
  → save child draft + scrollTop
  → unsubscribe route listeners
  → dispose route components
  → host restores Main layout/focus/scroll/draft
  → child process keeps running
```

### 9.3 Workflow 路由栈

Workbench 在一个 host fullscreen route 内维护内部路由栈：

```text
WorkflowPage → WorkflowAgentPage
       ↑              │
       └──── Esc ─────┘
```

只有从 WorkflowPage 再按 `Esc` 才退出 host fullscreen route。禁止嵌套调用第二个 `ctx.ui.custom({ fullscreen: true })`。

### 9.4 中断与关闭

- 退出页面不等于中断；
- 中断只通过 Controller 的 `interrupt-agent` / `interrupt-workflow`；
- 主 Pi session shutdown 时先关闭 fullscreen route，再 dispose Controller；
- Provider 异常退出后页面保留已有 timeline，并明确显示 unavailable/failed；
- host 恢复失败属于必须测试的高影响错误，需 finally 强制恢复 terminal mode、mouse mode 和 focus。

## 10. Extension UI 请求

RPC Child 可能通过 extension 发起 `select/confirm/input/editor`。处理策略：

- DirectAgentPage：在当前独立页面内显示 modal，并通过 `extension_ui_response` 回传；
- Workflow Agent：标记 `needsAttention`，用户打开对应 Agent 后可处理 modal；这不等同于发送 Follow-up；
- 未打开页面时，顶部导航显示 attention 状态；
- timeout/cancel 必须与 RPC 协议一致；
- `notify/setStatus/setWidget` 投影到对应子页面，不污染 Main footer/widget。

## 11. 兼容与迁移

### Phase 0：Pi Host 能力（必需）

- 增加 `fullscreen: true` custom route；
- 增加 host 保存/恢复和 route disposal 测试；
- 抽取或公开稳定的 timeline/editor/powerline renderer 接口。

没有 Phase 0 时，不宣称解决了滚动隔离；继续使用 Overlay 只能是旧版兼容路径。

### Phase 1：独立页面

- Workbench 从 100% Overlay 切换到 host fullscreen route；
- Direct/Workflow 各自使用独立 root 和 ScrollView；
- 先保留当前简化 transcript，优先消除 Main 内容泄漏。

### Phase 2：完整中间过程

- Provider 投影 thinking/tool/retry/compaction/queue events；
- Runtime 增加 timeline 和 metrics；
- 页面展示完整执行过程。

### Phase 3：Native UI 一致性

- 替换自绘 transcript、editor 和 Powerline；
- Main 与 Workbench 共用上游 renderer；
- 增加主题、窄屏、resize、IME 和 autocomplete 测试。

### Phase 4：Workflow 与 Extension UI

- Workflow 双 pane、Workflow Agent route；
- extension UI modal 和 needsAttention；
- 完成长时间运行与异常恢复验证。

## 12. 测试计划

### 12.1 单元测试

- text/thinking/toolcall delta 聚合；
- tool partialResult replace 语义；
- message_end 权威纠正；
- 旧 Run 晚到事件隔离；
- byte cap 按完整 entry 淘汰；
- Direct draft、route scrollTop、Workflow pane scrollTop 分别保存；
- Follow-up 复用 sessionId；
- Workflow route 无 editor。

### 12.2 Host 集成测试

- fullscreen route mount 时 Main root 不在 active layout；
- mouse wheel 只改变 child primary ScrollView；
- 关闭后 Main root、focus、draft 和 viewportTop 完全恢复；
- route factory 抛错、dispose 抛错、session shutdown 都能恢复；
- regular/fullscreen 两种主 TUI mode 均可进入和退出；
- resize 后固定 footer/editor 仍在底部。

### 12.3 Fake RPC 测试

Fake RPC 顺序输出：

```text
thinking_delta
text_delta
tool_execution_start
tool_execution_update
tool_execution_end
text_delta
agent_settled
```

断言 UI timeline 顺序、tool 状态、streaming finalization 和 Powerline metrics。

### 12.4 真实终端验收

在 tmux 中只用于自动截图验证，不作为产品依赖：

1. Main transcript 写入唯一哨兵 `MAIN_SENTINEL`；
2. 打开 Direct Subagent，连续向上滚动超过 child 内容长度；
3. pane capture 不得包含 `MAIN_SENTINEL`；
4. 页面必须出现 thinking、tool call、tool output、Powerline 和 Editor；
5. 输入 Follow-up，确认同一 ChildSession；
6. `Esc` 后 Main 哨兵、草稿和滚动位置恢复；
7. 对 Workflow 和 Workflow Agent 重复隔离检查；
8. 检查退出后无残留 mouse mode、alternate screen、child process 或 tmux session。

## 13. 验收标准

1. Direct Subagent 页面显示完整 thinking、tool call、tool progress、tool result 和 assistant 输出。
2. Direct Subagent 使用与主 Agent共用的消息 renderer、主题、Editor 和 Powerline renderer。
3. Direct Follow-up 复用原 ChildSession。
4. Direct 页面向上滚动任意距离都不能出现 Main 内容。
5. Workflow 页面向上滚动任意距离都不能出现 Main 内容。
6. Workflow Agent 页面显示对应 Agent 的完整过程且无 Follow-up Editor。
7. Main、Direct、Workflow、Workflow Agent 各自保存滚动位置；Main/Direct 各自保存输入草稿。
8. `Esc` 返回不取消后台任务，并恢复 Main 的原焦点、草稿和 viewport。
9. terminal resize、异常退出和 session shutdown 后终端状态可恢复。
10. 所有页面继续反映真实中断、失败、stalled 和 unavailable 状态。

## 14. 风险与应对

| 风险                            | 影响             | 应对                                               |
| ------------------------------- | ---------------- | -------------------------------------------------- |
| Pi host 不提供 fullscreen route | 无法保证滚动隔离 | Phase 0 作为硬依赖，不用 Overlay 冒充完成          |
| Native renderer 仍是私有实现    | UI 长期漂移      | 抽取公共 view-model renderer，不导入私有 dist 路径 |
| RPC 高频事件导致重绘过多        | 输入卡顿         | delta 合并、每帧最多一次 render、stats 节流        |
| tool 输出过大                   | 内存和渲染压力   | replace partial、byte cap、fullOutputPath          |
| 页面切换时事件晚到              | 状态错乱         | sessionId/runId 归属校验，Runtime 与 View 解耦     |
| terminal mode 恢复失败          | 主 TUI 不可用    | host finally 恢复、故障注入和真实终端测试          |

## 15. 最终结论

该需求可行，但不能只在 `pi-subagent-workbench` 内继续修补 100% Overlay。达到“与主 Agent 一致、完整中间过程、滚动绝对隔离”需要：

1. Pi host 提供正式的 fullscreen route 生命周期；
2. Main 与 Workbench 共用稳定的 timeline/editor/powerline renderer；
3. Workbench 将 RPC 完整事件投影为结构化 timeline；
4. Direct、Workflow 和 Workflow Agent 使用各自独立的 layout root 与 ScrollView。

推荐按 `Host fullscreen 隔离 → 完整 RPC timeline → Native UI 复用 → Workflow/Extension UI` 的顺序交付，避免再次出现“视觉全屏但底层仍是 Main 页面”的假全屏实现。
