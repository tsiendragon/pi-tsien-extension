# pi-tsien-trajectory-recorder

记录可复现的 agent 轨迹，并额外写一份紧凑计时账本供 dashboard 做时间分析。

## 事件钩子

`after_provider_response`、`agent_end`、`agent_settled`、`agent_start`、`before_agent_start`、`before_provider_headers`、`before_provider_request`、`context`、`input`、`message_end`、`message_start`、`message_update`、`model_select`、`session_before_compact`、`session_compact`、`session_info_changed`、`session_shutdown`、`session_start`、`session_tree`、`thinking_level_select`、`tool_call`、`tool_execution_end`、`tool_execution_start`、`tool_execution_update`、`tool_result`、`turn_end`、`turn_start`、`user_bash`

## 配置

`PI_TRACE_DIR` / `PI_TIMING_DIR` 可覆盖输出路径

## 依赖

- 内部：无
- peer：`@earendil-works/pi-coding-agent`

## 加载

在 `settings.json` 里列出包，或写进 `extensions.config.json` 的 `loadOrder`；
Pi 会直接加载本包的 TS 入口（`package.json` 的 `pi.extensions`），不需要编译。
