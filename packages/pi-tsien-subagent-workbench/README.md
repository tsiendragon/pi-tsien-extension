# pi-tsien-subagent-workbench

进程隔离的子代理与可恢复的 Workflow（编排、重试、结果收集），可由 dashboard 的 Workbench 面板查看。

## 工具

- `subagent_cancel`
- `subagent_results`
- `subagent_start`
- `subagent_workflow`
- `subagent_workflow_control`

## 命令

- `/subagent-workbench`

## 事件钩子

`session_shutdown`、`session_start`

## 配置

无

## 依赖

- 内部：无
- peer：`@earendil-works/pi-coding-agent`

## 说明

依赖 `pi-tsien-shared`；被 `pi-tsien-memory` 依赖。

## 加载

在 `settings.json` 里列出包，或写进 `extensions.config.json` 的 `loadOrder`；
Pi 会直接加载本包的 TS 入口（`package.json` 的 `pi.extensions`），不需要编译。
