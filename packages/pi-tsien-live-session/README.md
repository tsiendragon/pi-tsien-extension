# pi-tsien-live-session

把当前的 Pi 会话作为可远程接管的 live session 暴露给 dashboard：接管 / 释放、会话树导航、分叉、触发 reload；会话标题由 agent 设置。

## 工具

- `set_session_title`

## 命令

- `/dashboard-release`
- `/live-session-reload`
- `/ls-fork`
- `/ls-navigate`

## 事件钩子

`agent_end`、`agent_settled`、`agent_start`、`extension_ui`、`extension_ui_notify`、`input`、`message_end`、`message_start`、`message_update`、`model_select`、`session_compact`、`session_info_changed`、`session_shutdown`、`session_start`、`session_tree`、`thinking_level_select`、`tool_execution_end`、`tool_execution_start`、`tool_execution_update`、`turn_end`、`turn_start`

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
