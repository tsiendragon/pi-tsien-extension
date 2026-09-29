# pi-tsien-auto-compact

把自动压缩的触发点统一到一条策略上（`min(上限, 比例 × 上下文窗口)`），而不是按各模型 50% 窗口；触发判断与所有状态行（Powerline、dashboard）用**同一个** resolver，显示与行为不会分叉。

## 事件钩子

`agent_settled`、`context`、`model_select`、`session_start`、`session_shutdown`

## 工具

`compact_context`：用户在自然语言里要求「压缩 / 整理上下文」时由 Agent 调用；`instructions` 可选，用来说明摘要重点。

- 工具**只登记请求**，不内联压缩：`ctx.compact()` 会先 abort 当前 agent run，内联调用会杀掉刚调用它的那一轮并丢掉工具结果。
- 代价与语义：压缩在本轮 run 结束、会话空闲后才发生，不会中途打断任务，也不能在任务中途立刻释放上下文；压缩完不会自动继续对话（与 `/compact` 一致，`compact-continue` 只跟 `threshold`）。
- 仅在 `tui` / `rpc` 模式可用：`ctx.compact()` 是 fire-and-forget，而 `-p` / `--mode print|json` 在 run 结束就销毁会话，延迟压缩会被提前取消（实测 json 模式下 `compaction_start` 后不会落盘 compaction entry），所以工具在这两种模式直接返回 `unavailable_in_one_shot_mode`，不当场谎报“已安排”。
- 真正压缩在上面的 run 边界（空闲）执行，与阈值触发共用同一道 `ctx.isIdle()` 守卫；请求按 session id 隔离，`session_shutdown` 清理未消费的请求。
- 不受 `auto-compact-target.json` 的 `enabled` 影响：`enabled=false` 只关闭自动阈值触发，Agent 显式请求仍可用。
- 结果（`tokensBefore → estimatedTokensAfter`）与失败都用 `ctx.ui.notify` 回报；“会话太小、无可压缩内容” 属于失败分支。

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
