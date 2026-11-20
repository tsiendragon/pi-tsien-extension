# pi-tsien-live-session

把当前的 Pi 会话作为可远程接管的 live session 暴露给 dashboard：接管 / 释放、会话树导航、分叉、触发 reload；会话标题由 agent 设置；可按需导出「这个会话实际发给模型的内容」供 dashboard 做上下文分析。

## 工具

- `set_session_title`

## 命令

- `/dashboard-release`
- `/live-session-reload`
- `/ls-fork`
- `/ls-navigate`

## 事件钩子

`agent_end`、`agent_settled`、`agent_start`、`before_provider_request`、`extension_ui`、`extension_ui_notify`、`input`、`message_end`、`message_start`、`message_update`、`model_select`、`session_before_compact`、`session_compact`、`session_compact_failed`、`session_info_changed`、`session_shutdown`、`session_start`、`session_tree`、`thinking_level_select`、`tool_execution_end`、`tool_execution_start`、`tool_execution_update`、`turn_end`、`turn_start`

压缩期间（`session_before_compact` 到结束事件之间）dashboard / TUI 的输入会排在队列里，压缩结束后自动发送；状态随 `summary_update` 的 `compacting` 字段下发。

`before_provider_request` 只做观察：记下最后一次发给 provider 的载荷，供 dashboard 的只读 `get_context` 命令取用（照原样返回 `undefined`，不改写请求）。

## Proof jobs（只读）

Live Session 在发送会话快照后，经 Pi 事件总线发送 `pimatrix:proof-jobs:request`（`{ sessionId }`），并监听 pi-matrix 的 `pimatrix:proof-jobs:snapshot`（`{ sessionId, tasks }`）。仅接收当前会话的数据。

dashboard 收到 `live_feature_snapshot`，其 `data` 为 `{ feature: "proof-jobs", snapshot: { tasks } }`。每项仅包含 `id`、`label`、`state` 和可选的毫秒时间戳 `createdAt`、`startedAt`、`finishedAt`。快照替换整个列表；`tasks: []` 清空列表。切换会话不沿用旧列表，重连或 resync 会重新发布并请求最新快照。不提供 job 控制命令，协议仍为 v2。

## 配置

无（协议见 `src/protocol.ts`）

## 依赖

- 内部：`pi-tsien-shared`
- peer：`@earendil-works/pi-coding-agent`

## 说明

dashboard 侧入口 `/live-sessions`；依赖 `pi-tsien-shared`。

## 加载

在 `settings.json` 里列出包，或写进 `extensions.config.json` 的 `loadOrder`；
Pi 会直接加载本包的 TS 入口（`package.json` 的 `pi.extensions`），不需要编译。
