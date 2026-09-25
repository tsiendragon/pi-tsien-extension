# pi-tsien-sidebar

当前会话信息侧栏：模型、上下文组成、用量、缓存（不展示子代理 / 子会话）。

## 命令

- `/sidebar`

## 事件钩子

`before_agent_start`、`context`、`message_end`、`session_shutdown`、`session_start`

## 配置

无

## 依赖

- 内部：无
- peer：`@earendil-works/pi-coding-agent`

## 说明

依赖 `pi-tsien-session-ui-fork`。

## 加载

在 `settings.json` 里列出包，或写进 `extensions.config.json` 的 `loadOrder`；
Pi 会直接加载本包的 TS 入口（`package.json` 的 `pi.extensions`），不需要编译。
