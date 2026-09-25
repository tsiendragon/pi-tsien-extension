# pi-tsien-usage-analytics

本地统计工具与技能的使用频率（不上传提示词 / 参数 / 输出，也不会自动卸载任何东西）。

## 命令

- `/usage`

## 事件钩子

`agent_start`、`before_agent_start`、`input`、`resources_discover`、`session_shutdown`、`session_start`、`tool_execution_end`、`tool_execution_start`

## 配置

`~/.pi/agent/usage-analytics.json`

## 依赖

- 内部：无
- peer：`@earendil-works/pi-coding-agent`

## 加载

在 `settings.json` 里列出包，或写进 `extensions.config.json` 的 `loadOrder`；
Pi 会直接加载本包的 TS 入口（`package.json` 的 `pi.extensions`），不需要编译。
