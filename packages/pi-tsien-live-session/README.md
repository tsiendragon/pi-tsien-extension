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
