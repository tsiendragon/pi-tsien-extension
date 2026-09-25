# pi-tsien-auto-compact

把自动压缩的触发点统一到一条策略上（`min(上限, 比例 × 上下文窗口)`），而不是按各模型 50% 窗口；触发判断与所有状态行（Powerline、dashboard）用**同一个** resolver，显示与行为不会分叉。

## 事件钩子

`agent_settled`、`context`、`model_select`、`session_start`

## 配置

`~/.pi/agent/auto-compact-target.json`（可选）

## 依赖

- 内部：`pi-tsien-shared`
- peer：`@earendil-works/pi-coding-agent`

## 说明

resolver 实现在 `pi-tsien-shared/src/auto-compact-target/core.ts`，被 context-powerline / live-session 复用。

## 加载

在 `settings.json` 里列出包，或写进 `extensions.config.json` 的 `loadOrder`；
Pi 会直接加载本包的 TS 入口（`package.json` 的 `pi.extensions`），不需要编译。
