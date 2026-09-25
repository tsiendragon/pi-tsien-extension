# pi-tsien-compact-continue

自动压缩完成后补一条隐藏的 follow-up，提示 agent 基于摘要继续当前任务，避免长任务在压缩点停住。

## 事件钩子

`session_compact`

## 配置

无

## 依赖

- 内部：无
- peer：`@earendil-works/pi-coding-agent`

## 加载

在 `settings.json` 里列出包，或写进 `extensions.config.json` 的 `loadOrder`；
Pi 会直接加载本包的 TS 入口（`package.json` 的 `pi.extensions`），不需要编译。
