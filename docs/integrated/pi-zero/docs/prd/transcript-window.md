# PRD: 历史窗口渲染

## 背景与目标

- 背景：Pi 长会话会积累大量早期消息、工具输出和思考块。用户通常只阅读最近进展；过长的 TUI 转录区会增加恢复会话、压缩后重建和调整窗口尺寸时的渲染负担，也让当前工作内容难以聚焦。
- 目标：在不删除 session 数据、不改变模型上下文的前提下，让 pi-zero 默认只渲染最近 20 个对话轮次，并能在当前会话按命令临时展开全部历史。

## 功能需求

| 优先级 | 功能点 | 描述 | 验收标准 |
|---|---|---|---|
| P0 | 默认窗口模式 | 未配置时启用历史窗口，保留最近 20 个对话轮次；当前正在执行的轮次永远可见。一个轮次从用户消息开始，到下一条用户消息前结束。 | 新建、恢复和压缩后的会话均只显示最近 20 个完整轮次与当前轮次。 |
| P0 | 可配置策略 | 从 Pi 全局及项目级 `settings.json` 读取 `transcriptWindow`；支持 `enabled`、`recentTurns`、`hideHistoricalTools` 和 `hideHistoricalThinking`。全局设置由项目设置覆盖。 | 缺省配置等效于 `enabled: true`、`recentTurns: 20`、两个隐藏项均为 `true`；无效值安全回退默认值。 |
| P0 | 折叠提示行 | 被窗口排除的对话显示为单个折叠提示，说明隐藏轮次数和展开命令。 | 历史被折叠时仅显示一条提示，不出现被折叠轮次的用户、助手、工具或思考内容。 |
| P0 | 临时展开命令 | 提供 `/transcript status`、`/transcript expand` 和 `/transcript collapse`。展开和折叠仅影响当前 Pi 进程，不写 session 内容或模型上下文。 | 执行 `expand` 后完整历史可见；执行 `collapse` 后恢复配置的窗口；重启后回到配置决定的默认状态。 |
| P0 | 历史噪声抑制 | 处于折叠范围内的工具输出和思考块默认不渲染；最近窗口内仍遵循现有 ccstyle/compact-thinking 显示逻辑。 | 工具输出和思考块不会泄漏到折叠提示行前后；现有 `/ccstyle` 行为不回归。 |
| P1 | 临时窗口大小 | 提供 `/transcript turns <n>`，为当前会话将可见轮次数设为 `n`。 | 合法整数生效并立即重绘；非法值不改变现有状态且提示用法。 |
| P1 | 操作状态反馈 | 命令执行后显示当前状态、可见轮次数和折叠轮次数。 | 用户无需读取配置文件即可确认当前窗口模式。 |

## 配置示例

```json
{
  "transcriptWindow": {
    "enabled": true,
    "recentTurns": 20,
    "hideHistoricalTools": true,
    "hideHistoricalThinking": true
  }
}
```

## 非功能需求

- 性能：在长会话恢复、压缩后重建和窗口尺寸变化时，避免为被折叠的历史构建完整可视消息树；默认窗口模式不得明显降低普通短会话的响应速度。
- 数据安全：仅影响本地 TUI 展示；不得删除、截断或改写 session JSONL、提示词、模型上下文和工具结果。
- 兼容性：适配 pi-zero 当前支持的 Pi TUI 版本，并与现有 `ccstyle`、`compact-thinking`、用户消息样式和 powerline 共存。
- 可恢复性：配置缺失、无法读取或字段非法时回退默认值；渲染补丁失败时回退 Pi 原生转录显示，不中断 agent。

## 边界与约束

- 不在范围内：不改变模型发送给 provider 的上下文，不压缩或删除历史，不修改 Pi 上游会话格式。
- 不在范围内：不在首版提供历史搜索、分页加载、鼠标点击展开或跨会话记忆展开状态。
- 依赖：pi-zero 现有对 Pi TUI 消息和工具组件的渲染补丁；目标 Pi 版本的内部组件结构需要通过自动化测试覆盖。
- 风险：Pi 的公开扩展 API 没有面向转录容器的完整窗口化接口，因此实现需与现有 ccstyle 一样依赖内部组件行为；Pi 升级时可能需要兼容修复。

## 验收标准

- [ ] 不配置 `transcriptWindow` 时，长会话默认只展示最近 20 个轮次和当前轮次。
- [ ] 配置 `enabled: false` 时，完整历史保持可见。
- [ ] 配置 `recentTurns` 后，显示数量按配置生效，非法配置回退默认值。
- [ ] `/transcript expand` 与 `/transcript collapse` 可在不重启、不修改 session 的情况下即时切换。
- [ ] `/transcript turns <n>` 仅影响当前会话且立即刷新。
- [ ] 恢复会话、上下文压缩、`/reload` 及窗口缩放后，折叠状态正确且无重复、空白或错序消息。
- [ ] `ccstyle` 的工具显示、思考块折叠、用户消息样式和 powerline 均保持可用。
- [ ] README、CHANGELOG 和版本号与实现同步更新。

## 里程碑

| 阶段 | 产出 | 预期时间 |
|---|---|---|
| Tech Design | `docs/tech-design/transcript-window.md` | D+1 |
| 开发完成 | 功能代码、单元测试与手工 TUI 验证记录 | D+2 |
| 发布准备 | README、CHANGELOG、版本更新 | D+2 |
