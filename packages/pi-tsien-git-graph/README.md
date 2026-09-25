# pi-tsien-git-graph

当前仓库的提交概览浮层，含本地与远端引用。

## 命令

- `/git-graph`

## 配置

无

## 依赖

- 内部：无
- peer：`@earendil-works/pi-coding-agent`

## 说明

依赖 `pi-tsien-session-ui-fork` 提供的 Powerline 插槽。

## 加载

在 `settings.json` 里列出包，或写进 `extensions.config.json` 的 `loadOrder`；
Pi 会直接加载本包的 TS 入口（`package.json` 的 `pi.extensions`），不需要编译。
