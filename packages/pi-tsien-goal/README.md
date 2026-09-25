# pi-tsien-goal

持久化目标、验收标准、进度与阻塞项；支持按间隔自动 continuation，以及需要说明原因的暂停。

## 工具

- `complete_goal`
- `create_goal`
- `get_goal`
- `pause_goal`
- `propose_goal_draft`
- `update_goal_graph`
- `update_goal_progress`

## 命令

- `/goal`

## 事件钩子

`agent_settled`、`before_agent_start`、`context`、`input`、`session_before_compact`、`session_shutdown`、`session_start`、`session_tree`

## 配置

无（目标状态保存在会话的 agent 目录内）

## 依赖

- 内部：无
- peer：`@earendil-works/pi-coding-agent`

## 说明

与 dashboard 的目标图谱页共用同一份状态。

## 加载

在 `settings.json` 里列出包，或写进 `extensions.config.json` 的 `loadOrder`；
Pi 会直接加载本包的 TS 入口（`package.json` 的 `pi.extensions`），不需要编译。
