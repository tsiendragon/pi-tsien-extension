# pi-tsien-side-chat

与主任务隔离的**只读**侧聊浮窗：临时问一句而不污染主会话上下文；不能写文件、不能执行命令。

## 命令

- `/btw`

## 事件钩子

`session_shutdown`、`session_start`

## 配置

无

## 依赖

- 内部：无
- peer：`@earendil-works/pi-coding-agent`

## 说明

依赖 `pi-tsien-shared`（dashboard 桥接与 live feature）。

## 加载

在 `settings.json` 里列出包，或写进 `extensions.config.json` 的 `loadOrder`；
Pi 会直接加载本包的 TS 入口（`package.json` 的 `pi.extensions`），不需要编译。
