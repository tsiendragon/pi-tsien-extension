# pi-tsien-session-aliases

补上 `/clear`（开新会话）与 `/exit`（退出）两个命令别名。

## 命令

- `/clear`
- `/exit`

## 配置

无

## 依赖

- 内部：无
- peer：`@earendil-works/pi-coding-agent`

## 加载

在 `settings.json` 里列出包，或写进 `extensions.config.json` 的 `loadOrder`；
Pi 会直接加载本包的 TS 入口（`package.json` 的 `pi.extensions`），不需要编译。
