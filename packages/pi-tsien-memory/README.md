# pi-tsien-memory

本地 SQLite/FTS5 长期记忆：自动召回、候选审核、遗忘与撤销，全部在本地，不上传内容。高级工具（审核 / 撤销 / 应用验证 / 提升预览 / 健康检查）默认关闭，需要时再打开。

## 工具

- `memory_doctor`
- `memory_forget`
- `memory_promote_dismiss`
- `memory_promote_preview`
- `memory_remember`
- `memory_review`
- `memory_search`
- `memory_undo`
- `memory_update`
- `memory_verify_application`

## 命令

- `/memory`

## 事件钩子

`agent_end`、`agent_settled`、`before_agent_start`、`context`、`input`、`session_before_compact`、`session_shutdown`、`session_start`、`tool_result`

## 配置

数据在 `~/.pi/tsien-memory/`；项目级开关 `<cwd>/.pi/tsien-memory.json`

## 依赖

- 内部：无
- peer：`@earendil-works/pi-coding-agent`

## 说明

依赖 `pi-tsien-subagent-workbench`（候选审核走子代理）。

## 加载

在 `settings.json` 里列出包，或写进 `extensions.config.json` 的 `loadOrder`；
Pi 会直接加载本包的 TS 入口（`package.json` 的 `pi.extensions`），不需要编译。
