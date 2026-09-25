# pi-tsien-schedule

当前会话内的定时 / 周期任务，用于长任务跟进与轮询。

## 工具

- `schedule`

## 命令

- `/schedule`

## 事件钩子

`session_shutdown`、`session_start`

## 配置

无

## 依赖

- 内部：无
- peer：`@earendil-works/pi-coding-agent`

## 说明

依赖 `pi-tsien-shared`（live feature）。

## 加载

在 `settings.json` 里列出包，或写进 `extensions.config.json` 的 `loadOrder`；
Pi 会直接加载本包的 TS 入口（`package.json` 的 `pi.extensions`），不需要编译。
