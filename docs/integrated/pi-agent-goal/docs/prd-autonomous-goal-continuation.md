# PRD：定期目标 Follow-up、结构化 Blocker 与状态面板

- 状态：Confirmed
- 范围：本地 fork 的 `pi-agent-goal`；不改变上游包默认行为。
- 关联：现有 `/goal`、`--goal-continuation`、`agent_settled` 生命周期。

## 背景

用户创建 active goal 后，希望系统定期继续推进，而不必反复输入“继续”。本地 fork 采用最小模型：active goal 每隔固定时间排入一条简短 follow-up。它不是静默看门狗，也不按 idle 或 pending-message 状态决定是否调度。

## 产品目标

1. 本地 fork 默认启用定期 follow-up；默认间隔 20 分钟，可配置为任意正分钟数。
2. 每个 active goal 同时最多有一条待消费的 follow-up；消费后下一周期可以继续。
3. pause、complete、clear、replacement、显式关闭和 session shutdown 后不再自动排队。
4. `/goal start` 与 `--start` 保持一次性显式 handoff，独立于定期 follow-up。
5. `/tree`、`/fork`、`/resume`、`/reload` 保持当前分支对应的 goal 状态，不跨分支泄露。
6. 工作项、结构化 blocker、尝试记录和 Powerline 状态继续服务用户可见的进度管理；它们不作为定时器门禁。

## 非目标

- 静默窗口、idle/pending-message 观察、回合数、无进展、wall-clock 或 token 预算门禁。
- 自动判断一个 blocked goal 是否应停止；用户可用 `/goal pause` 或 `--goal-continuation=false` 停止定期 follow-up。
- 复刻 Codex 的 SQLite schema、app-server RPC、底部菜单或精确 token/时间会计。
- 自动获取凭证、绕过权限、执行不可逆操作或替用户做产品/安全决策。

## 用户体验

- `/goal <objective>` 仍先进入 Start/Edit/Cancel 审核；Start 后目标成为 active。
- `/goal start` 立即排入一条显式 follow-up。
- active goal 的 session 启动后，运行时每 20 分钟尝试排入 `继续目标`；通过 `--goal-continuation-interval-minutes <n>` 配置间隔。
- `--goal-continuation=false` 关闭自动 follow-up。
- `/goal pause`、`/goal complete`、`/goal clear` 停止后续定时推进；`/goal resume` 恢复 active 状态。
- 定时 follow-up 详细上下文来自隐藏 `goal-context`，消息本身保持为四个字符。

## 调度设计

1. `session_start` 创建一个可取消的递归 `setTimeout`。
2. 每个 tick 读取当前 branch 的 canonical goal snapshot。
3. continuation 被禁用、goal 非 active、goal 已替换、或同一 goal 已有 queued follow-up 时，当前 tick 不发送消息。
4. 其他情况下，写入 `goal-continuation` queued entry，并以 `deliverAs: "followUp"` 发送 `继续目标`。
5. 输入 hook 收到该 follow-up 后清除 queued 状态并记录 started entry；下一周期可再次排队。
6. `session_shutdown` 清理 timer；pause、complete、clear 或 replacement 在后续 tick 的 active-state 检查中自然停止发送。

`agent_settled` 只同步审计账本，不直接排入下一轮，因此 Esc 中断不会立即触发 follow-up。

## 状态与边界

Pi session custom entries 是与分支绑定的 canonical state。SQLite 位于 `~/.pi/agent/pi-goal.sqlite`，仅作为可重建的审计/报告物化视图，不独立决定 branch state。

工作项和 blocker 保留以下边界：凭证、权限、外部副作用、生产发布、不可逆操作、产品取舍与安全规则必须等待用户或外部系统；定期 follow-up 不绕过现有工具权限或确认门禁。

## 验收标准

### 自动 follow-up

- [ ] 未传 `--goal-continuation` 时，active goal 默认按 20 分钟间隔排入 `继续目标`。
- [ ] `--goal-continuation=false` 时不排入自动 follow-up。
- [ ] `--goal-continuation-interval-minutes <n>` 接受正数分钟值；非法值回退默认 20 分钟。
- [ ] 同一 goal 在前一条 follow-up 未消费时不会重复排队；消费后下一周期可再次排队。
- [ ] paused、complete、clear、replacement、stale goal 与 session shutdown 后不再排入自动 follow-up。
- [ ] `/goal start` 与 `--start` 仍为独立的一次性显式 handoff。
- [ ] 自动 prompt 固定为 `继续目标`，不超过 10 个字符。

### 进度与边界

- [ ] `/tree`、`/fork`、`/resume`、`/reload` 显示当前分支的正确 goal 状态。
- [ ] Powerline 在 active goal 时显示进度；无 active goal 时清除。
- [ ] 结构化 blocker 和 attempt 保留审计信息，不自动绕过用户/权限/安全边界。
- [ ] 自动 follow-up 不默认写入业务仓库。

### 验证

- [ ] 自动化测试覆盖默认与自定义间隔、关闭开关、前一条未消费时的去重、消费后的下一周期、pause/complete 和 session shutdown。
- [ ] 自动化测试覆盖 goal 状态重建、工具权限边界、隐藏上下文与 compaction。
- [ ] 手工 Pi TUI smoke 覆盖 `/goal`、`/goal pause`、`/goal resume`、`/goal complete`、`/compact`、`/reload`、`/resume`、`/tree` 与 `/fork`。
