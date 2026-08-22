# Subagent / Workflow 全屏 TUI 交互设计

> 本文定义交互与视觉目标。独立页面、RPC timeline 和 Pi host 改造方案见 [`native-subagent-workflow-tui-tech-design.md`](./native-subagent-workflow-tui-tech-design.md)。原 100% Overlay 实现不再视为满足全屏隔离要求。

## 1. 目标

在不改变主 Agent 现有输入框和 Powerline 样式的前提下，为 Subagent 和 Workflow 提供：

- 自动出现在 Powerline 上方的单行任务导航；
- 方向键选择和 `Enter` 全屏进入；
- 与主 Agent 相近、可继续输入的 Direct Subagent 页面；
- 无输入框的 Workflow 编排页面；
- 无输入框、只读的 Workflow 内部 Agent 页面；
- 后台持续运行且可随时返回的页面导航。

所有进入动作都是整个 TUI 页面切换，不使用 Overlay。页面必须由 Pi host 的 fullscreen route 承载，拥有独立 layout root 与 ScrollView；底层 Main 内容不参与当前页面布局或滚动，`Esc` 后由宿主恢复。

## 2. 不可变约束

1. 主 Agent 只增加 Powerline 上方的一行任务导航。
2. 主 Agent 的现有输入框、Powerline、颜色、边框和内容保持不变。
3. 主 Agent 的任务导航不显示 `Active Work`、`Powerline`、`Agent 输入` 等区域前缀。
4. 主 Agent 的任务导航不增加外层边框。
5. Direct Subagent 页面可以使用标题、前缀和边框，并提供独立输入框。
6. Workflow 页面可以使用标题、边框和双栏，但不提供输入框。
7. Workflow 内部 Agent 页面只读，不提供输入框。
8. `Esc` 只返回上一级页面，不中断后台任务。
9. Main、Subagent 和 Workflow 分别保留滚动位置；可交互页面保留输入草稿。

## 3. 状态表示

| 标记 | 状态        | 含义             |
| ---- | ----------- | ---------------- |
| `○`  | queued      | 等待执行         |
| `●`  | running     | 正在运行         |
| `✓`  | completed   | 已完成，等待查看 |
| `!`  | failed      | 执行失败         |
| `‖`  | interrupted | 已中断           |
| `◆`  | workflow    | Workflow 项目    |

运行项、失败项和待查看的完成项显示在任务导航中。没有这些项目时，任务导航整行自动消失。

完成项不会立即消失，满足以下任一条件后才可清除：

- 用户打开查看；
- 用户手动清除；
- 主 Agent 已消费结果并完成确认。

## 4. 主 Agent 默认界面

下面仅新增倒数第三行任务导航。现有 Powerline 和输入框保持原样。

```text
assistant
我会并行检查线上样本、Router 源码和现有评测结果。

tool
正在读取 src/router.ts……

assistant
两个 Subagent 和一个 Workflow 已经开始运行。


=> Main   ● 样本分析   ● 源码检查   ◆ Router 评估 2/3
gpt-5.6|xhigh >/<branch>   ███░░░│░░░░░ 56.9k→136k/272k > ◷ 1h29m > M/C 32/27%
----------------------------------------------------------------------
❯ 给主 Agent 输入内容……
----------------------------------------------------------------------
```

实际 TUI 使用现有主题的颜色、反色或下划线区分状态和当前选择，不增加标题或边框。

没有任务时，任务导航完全消失：

```text
assistant
当前任务已经完成。

gpt-5.6|xhigh >/<branch>   ███░░░│░░░░░ 56.9k→136k/272k > ◷ 1h29m > M/C 32/27%
----------------------------------------------------------------------
❯ 给主 Agent 输入内容……
----------------------------------------------------------------------
```

## 5. 主 Agent 选择状态

任务导航默认不抢输入框焦点。按 `F6` 后任务导航获得焦点：

```text
assistant
两个 Subagent 正在运行。


=> Main   ● 样本分析   ▸ ● 源码检查   ◆ Router 评估 2/3
gpt-5.6|xhigh >/<branch>   ███░░░│░░░░░ 56.9k→136k/272k > ◷ 1h29m > M/C 32/27%
----------------------------------------------------------------------
❯ 给主 Agent 输入内容……
----------------------------------------------------------------------
```

### 操作

| 按键      | 操作                                   |
| --------- | -------------------------------------- |
| `←` / `→` | 主输入框为空时直接聚焦导航并切换选中项 |
| `↑` / `↓` | 保留主输入框的历史消息和多行光标行为   |
| `Enter`   | 全屏进入选中项                         |
| `Esc`     | 退出任务导航，焦点返回主输入框         |
| `F6`      | 可选：聚焦或退出任务导航               |
| `i`       | 中断选中的运行项                       |
| `x`       | 清除选中的已完成项                     |
| `?`       | 打开快捷键帮助                         |

## 6. Direct Subagent 全屏界面

主 Agent 直接创建的 Subagent 是可交互页面。进入后整个 TUI 切换，并继续使用同一个 ChildSession。

```text
╭─ Subagent · 源码检查 ───────────────────────────── ● running ─╮
│ Main › Subagent › 源码检查                                   │
├───────────────────────────────────────────────────────────────┤
│                                                               │
│ user                                                          │
│ 检查 Router 的完整调用链，不要修改代码。                       │
│                                                               │
│ assistant                                                     │
│ 我先定位 Router 的入口以及 orientation 的输出结构。            │
│                                                               │
│ tool · read                                                   │
│ src/router.ts                                                 │
│                                                               │
│ tool · bash                                                   │
│ rg "routeCard|orientation" src tests                          │
│                                                               │
│ assistant                                                     │
│ 最早的异常边界出现在 orientation 输出到 router 输入的映射……    │
│                                                               │
├─ Session ──────────────────────────────────────────────────────┤
│ session_12d5 · run_03 · tools 4 · context 31% · elapsed 01:42 │
├─ Follow-up ────────────────────────────────────────────────────┤
│ ❯ 继续检查这个映射是否影响其他国家……                           │
╰───────────────────────────────────────────────────────────────╯
```

用户提交 Follow-up 后继续使用同一会话，不创建新 Subagent：

```text
╭─ Subagent · 源码检查 ───────────────────────────── ● running ─╮
│                                                               │
│ user                                                          │
│ 继续检查这个映射是否影响其他国家。                             │
│                                                               │
│ assistant                                                     │
│ 我会复用刚才读取的上下文，继续检查……                           │
│                                                               │
├─ Follow-up ────────────────────────────────────────────────────┤
│ ❯                                                             │
╰───────────────────────────────────────────────────────────────╯
```

### 操作

| 按键                 | 操作                           |
| -------------------- | ------------------------------ |
| 正常输入并按 `Enter` | 向当前 Subagent 发送 Follow-up |
| `Esc`                | 返回主 Agent，不中断运行       |
| `Ctrl+C`             | 中断当前 Run                   |
| `PgUp` / `PgDn`      | 滚动对话                       |
| `End`                | 跳到最新输出                   |
| `F6`                 | 打开全局任务导航               |
| `Alt+←` / `Alt+→`    | 切换其他 Subagent 或 Workflow  |

## 7. Workflow 全屏界面

Workflow 页面用于查看 Stage、内部 Agent 和实时输出，不提供输入框。Stage 树与实时输出区域按终端高度动态扩展，状态栏和快捷键固定在页面底部，不保留无用途的下半屏空白。

```text
╭─ Workflow · Router 评估 ─────────────────────── Stage 2/3 ────╮
│ Main › Workflow › Router 评估                                 │
├──────────────────────────────┬────────────────────────────────┤
│ Stages                       │ Live Output                    │
│                              │                                │
│ ✓ Stage 1 · 收集证据         │ 线上样本分析                   │
│   ✓ 日志检查                 │                                │
│   ✓ 样本统计                 │ 正在查询最近 7 天 Router        │
│                              │ 失败样本……                     │
│ ● Stage 2 · 并行分析         │                                │
│ ▸ ● 线上样本分析             │ tool · query                   │
│   ○ 源码分析                 │ processed 1234 / 5000          │
│                              │                                │
│ ○ Stage 3 · 汇总结论         │ 当前主要错误码：               │
│   ○ 结果汇总                 │ ROUTER_NOT_FOUND               │
│                              │ CARD_TYPE_UNKNOWN              │
├──────────────────────────────┴────────────────────────────────┤
│ running 1 · queued 1 · completed 2 · elapsed 02:31            │
├───────────────────────────────────────────────────────────────┤
│ ↑↓ 选择  ←→ 展开/折叠  Enter 查看  i 中断  Esc 返回           │
╰───────────────────────────────────────────────────────────────╯
```

### 操作

| 按键            | 操作                                |
| --------------- | ----------------------------------- |
| `↑` / `↓`       | 选择 Stage 或 Workflow 内部 Agent   |
| `←` / `→`       | 折叠或展开 Stage                    |
| `Enter`         | 全屏查看选中的 Workflow Agent       |
| `i`             | 中断选中的 Workflow Agent           |
| `Shift+i`       | 中断整个 Workflow                   |
| `PgUp` / `PgDn` | 滚动实时输出                        |
| `Esc`           | 返回主 Agent，Workflow 继续后台运行 |
| `?`             | 打开快捷键帮助                      |

## 8. Workflow 内部 Agent 全屏界面

Workflow 内部 Agent 由 Workflow 调度，页面只读，不提供输入框。

```text
╭─ Workflow Agent · 线上样本分析 ─────────────── ● running ─────╮
│ Router 评估 › Stage 2 › 线上样本分析                          │
├───────────────────────────────────────────────────────────────┤
│                                                               │
│ Task                                                          │
│ 查询最近 7 天 Router 失败样本，按国家、卡类型和错误码统计。     │
│                                                               │
│ assistant                                                     │
│ 我先确认数据分区、版本范围和过滤条件。                          │
│                                                               │
│ tool · query                                                  │
│ SELECT country, card_type, error_code, count(*) ...            │
│                                                               │
│ assistant                                                     │
│ 当前主要失败集中在三个国家……                                  │
│                                                               │
├─ Status ───────────────────────────────────────────────────────┤
│ tools 2 · tokens 18k · elapsed 01:42 · read-only              │
├───────────────────────────────────────────────────────────────┤
│ PgUp/PgDn 滚动 · i 中断 · Esc 返回 Workflow                   │
╰───────────────────────────────────────────────────────────────╯
```

### 操作

| 按键            | 操作                    |
| --------------- | ----------------------- |
| `PgUp` / `PgDn` | 滚动输出                |
| `End`           | 跳到最新输出            |
| `i`             | 中断当前 Workflow Agent |
| `Esc`           | 返回 Workflow 页面      |

## 9. 页面导航关系

```text
主 Agent
现有输入框和 Powerline 不变
        │
        │ F6 → 方向键 → Enter
        ├──────────────────────────────┐
        ▼                              ▼
Direct Subagent                    Workflow
全屏、有输入框                     全屏、无输入框
        │                              │
        │ Esc                          │ Enter
        ▼                              ▼
返回主 Agent                    Workflow 内部 Agent
                               全屏、只读、无输入框
                                        │
                                        │ Esc
                                        ▼
                                  返回 Workflow
```

## 10. 页面状态与生命周期

- 从 Main 进入 Subagent 或 Workflow 时，主 Agent 保持后台状态。
- 从子页面返回 Main 时，不取消对应任务。
- Direct Subagent 的 Follow-up 复用原 ChildSession 和上下文。
- Workflow 内部 Agent 不接受用户 Follow-up。
- Main、Direct Subagent、Workflow、Workflow 内部 Agent 分别保存滚动位置。
- Main 和 Direct Subagent 分别保存未提交的输入草稿。
- 运行状态变化实时刷新任务导航和当前页面。
- 已完成或失败的任务保留到用户查看或显式清除。

## 11. 验收标准

1. 启动 Direct Subagent 或 Workflow 后，Powerline 上方自动出现单行任务导航。
2. 任务导航出现和刷新时不抢主输入框焦点。
3. 主 Agent 原有输入框和 Powerline 的样式、位置及内容不发生变化。
4. 用户可聚焦导航，使用方向键选择并按 `Enter` 全屏进入。
5. Direct Subagent 页面支持在同一会话中继续输入 Follow-up。
6. Workflow 页面无输入框，可查看 Stage、任务状态和实时输出。
7. Workflow 内部 Agent 页面只读且无输入框。
8. `Esc` 按页面层级返回，不中断后台任务。
9. 中断 Agent 或 Workflow 后，页面和任务导航立即反映真实状态。
10. 没有运行、失败或待查看任务时，任务导航自动消失。
