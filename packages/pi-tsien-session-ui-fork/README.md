# pi-tsien-session-ui-fork

会话 UI 套件：Powerline 宿主（其它扩展可插槽）、主题、工作状态消息、Claude Code 风格的思考与工具渲染、`/transcript` 会话回看。

## 工具

- `write`

## 命令

- `/ccstyle`
- `/context`
- `/powerline`
- `/transcript`
- `/vibe`

## 事件钩子

`agent_end`、`agent_settled`、`agent_start`、`before_agent_start`、`message_end`、`message_update`、`session_compact`、`session_shutdown`、`session_start`、`thinking_level_select`、`tool_call`、`tool_execution_end`、`tool_execution_start`、`tool_execution_update`、`tool_result`、`turn_end`、`turn_start`

## 配置

`~/.pi/agent/theme.json`（可选，主题）；`~/.pi/agent/claude-code-style.json`（Claude Code 风格开关）；`~/.pi/agent/compact-thinking.json`（思考摘要样式）

## 依赖

- 内部：无
- peer：`@earendil-works/pi-coding-agent`

## 说明

含第三方代码：工具 diff 渲染来自 `MasuRii/pi-tool-display`（MIT），见 `src/ccstyle/tool-diff/ATTRIBUTION.md`。

## 加载

在 `settings.json` 里列出包，或写进 `extensions.config.json` 的 `loadOrder`；
Pi 会直接加载本包的 TS 入口（`package.json` 的 `pi.extensions`），不需要编译。
