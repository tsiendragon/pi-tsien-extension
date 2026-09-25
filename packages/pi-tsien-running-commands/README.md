# pi-tsien-running-commands

前台命令与后台任务统一列表；`Ctrl+B` 把正在跑的进程转到后台（不重启）；dashboard 的后台命令面板复用同一套语义。

## 工具

- `background_command_cancel`
- `background_command_output`
- `background_command_start`
- `background_command_status`

## 事件钩子

`session_shutdown`、`session_start`、`tool_execution_end`、`tool_execution_start`、`tool_execution_update`

## 配置

无

## 依赖

- 内部：无
- peer：`@earendil-works/pi-coding-agent`

## 说明

依赖 `pi-tsien-shared`（background-commands 与 command-ui）。

## 加载

在 `settings.json` 里列出包，或写进 `extensions.config.json` 的 `loadOrder`；
Pi 会直接加载本包的 TS 入口（`package.json` 的 `pi.extensions`），不需要编译。
