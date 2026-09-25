# pi-tsien-context-powerline

在 footer 显示当前模型、推理等级、上下文用量、自动压缩阈值，以及本机 CPU / 内存占用。

## 事件钩子

`agent_settled`、`context`、`message_end`、`model_select`、`session_compact`、`session_shutdown`、`session_start`、`thinking_level_select`

## 配置

无

## 依赖

- 内部：`pi-tsien-shared`
- peer：`@earendil-works/pi-coding-agent`

## 说明

压缩阈值画的是 `pi-tsien-auto-compact` 实际使用的同一条线。

## 加载

在 `settings.json` 里列出包，或写进 `extensions.config.json` 的 `loadOrder`；
Pi 会直接加载本包的 TS 入口（`package.json` 的 `pi.extensions`），不需要编译。
