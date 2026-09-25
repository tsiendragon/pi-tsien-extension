# pi-tsien-observation-pack

把超大工具结果换成「头 + 尾 + observation id」占位符，全文归档，需要时按 offset 精确取回。**默认关闭**。

## 命令

- `/obs-prune`

## 事件钩子

`context`、`session_start`

## 配置

`~/.pi/agent/observation-pack.json`（`archiveDir` 等）

## 依赖

- 内部：无
- peer：`@earendil-works/pi-coding-agent`

## 说明

被 `pi-tsien-rtk-fork` 的 stage 复用。

## 加载

在 `settings.json` 里列出包，或写进 `extensions.config.json` 的 `loadOrder`；
Pi 会直接加载本包的 TS 入口（`package.json` 的 `pi.extensions`），不需要编译。
