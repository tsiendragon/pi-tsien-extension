# pi-tsien-metrics-sidebar

逐轮指标浮层：tokens、prompt cache 读写、耗时。

## 命令

- `/metrics-sidebar`

## 事件钩子

`message_end`、`session_shutdown`、`session_start`、`session_tree`

## 配置

无

## 依赖

- 内部：无
- peer：`@earendil-works/pi-coding-agent`

## 加载

在 `settings.json` 里列出包，或写进 `extensions.config.json` 的 `loadOrder`；
Pi 会直接加载本包的 TS 入口（`package.json` 的 `pi.extensions`），不需要编译。
