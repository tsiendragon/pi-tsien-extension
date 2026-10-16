# Dashboard 主 Agent 专用 Extension

此入口仅由 Dashboard 主会话显式加载。没有加入根 package.json 的 pi.extensions，不修改已安装副本，也不影响普通 Session。

## 归属与加载契约

- Extension 源码：`~/repos/pi-tsien-extension/extensions/supervisor/index.ts`。
- 角色和 Skill：pi-dashboard 的 `agent/supervisor/`，由 Dashboard 配置管理。
- Dashboard 关闭普通扩展/Skill/上下文自动发现，显式加载本入口和必需的 LiveSession 桥。
- `--supervisor-credentials` 是通过 registerFlag 注册的专用参数，值为后端创建的私有凭证文件路径。不是新增环境变量。
- 安装、配置及生效方式的权威说明在 pi-dashboard 仓库的 `guide/config.md` 和 `guide/dashboard.md`；本文件不提供另一套部署步骤。

凭证文件含 socketPath、token、revision、allowedTools，权限 0600。session_start 惰性读取后先关闭工具，核查白名单，再请求认证的 GET /health 和 POST /loaded（含实际 sessionId、revision、工具名）。成功后才就绪。每轮 before_agent_start 和每个 tool_call 再落实工具白名单；桥接命令不被误禁用。凭证和内部路径不会发送给模型或日志。

## 清空主会话

专用命令 `/supervisor-clear` 仅在监督通道就绪且主助手空闲时调用 `ctx.newSession()`；不传入历史消息，因此新会话没有旧聊天上下文。Pi 新会话生命周期自动重载扩展及其他资源，`session_start` 重新向 Dashboard 注册新 sessionId。Dashboard 的清空接口负责限制会话控制权、接收新绑定并等待新会话连接；任务、事件、附件和旧会话文件不删除。不提供模型可调用的清空工具。部署与旧会话首次更新见 Dashboard `guide/dashboard.md`。

## 工具与后端协议

HTTP over Unix socket，不支持 TCP 回退、代理或重定向。POST /execute：

```text
{request: {operation, args}, grantRef?, confirmed?}
```

工具参数为严格 Type.Object，不接受额外权限字段。Extension 自动以 sessionId、operation、toolCallId 生成稳定 requestId，重试不会重复写同一事件或任务。

| 工具 | operation | 主要参数 |
|---|---|---|
| supervisor_context / event_objects | context | 范围/查询提示 |
| event_list / event_get | events | objectRef、includeChildren 或 id；event_get 的 includeImages=true 将授权事件的历史截图作为模型图像内容返回 |
| event_query | query | objectRef、includeChildren、limit（1–200）、order（asc/desc，默认 desc）、types、since/until、view（summary/full）；固定返回 {events,total,truncated,excludedWithoutTime} |
| event_append | record | objectRef、title、type、description、时间、参与者、sourceKind、原话、附件、interval |
| event_correct | correct | id、expectedVersion、patch、reason |
| supervisor_task_create | task_create | title、description、kind、parentUid、tags |
| supervisor_task_update | task_update | uid、status（todo/doing/paused/done）、title、description、evidence |
| supervisor_working_state | working_state | objectRef、description、stage、nextStep、waitingFor、expectedEventId、expectedVersion；只更新本地观察，不改来源事实 |
| supervisor_action | action | id、expectedVersion、objectRef、title、reason、state、sourceRefs |
| supervisor_analyze | analyze | objectRef、includeChildren |
| supervisor_report | report | kind、objectRef、content、sourceRefs、coverage、missing |
| supervisor_inspect | inspect | 批准的绝对 path |
| supervisor_coordinate | coordinate | sessionId、text、kind（clarification/continue/correction）、sourceRefs |

sourceKind=user 表示用户本人提供，relay 表示用户转述合作方、尚未独立核实。实际读写范围、稳定 UID、任务来源写权限、幂等、更正版本和协调频率由后端裁定，不由 Skill 或工具参数裁定。

## 授权和确认

写入授权按“回合来源”判定：**自动巡查轮**由 Dashboard 在提示前加机器标签 `[supervisor-auto-patrol]`，扩展据此把该轮标为 `userTurn: false`，后端拒绝其中的一切写入；**任何没有该标签的提示都算真实用户轮**（在面板、会话页或弹窗里直接说话都行），扩展随请求带 `userTurn: true`，无需任何用户可见标记即可记录。该轮原话（截断 4000 字符）随请求以 `userPrompt` 发送，服务据此解析本轮授权哪些操作，否定与提问仍然不授权。弹窗发出的消息另外带单个 `[supervisor-user-grant:<uuid>]` 标记，用于把用户原话作为审计引用（缺失或多个标记则不带引用）。自动巡查不会继承写授权，也不能弹出正式完成/破坏性更正确认。否定、提问或不明确的语言不会因关键词获得权限；当前真实用户轮内可通过展示具体目标与内容的 UI 确认授权该项操作。模型不能自己传 grantRef、confirmed 或用户身份。

- 明确的普通任务状态更新不重复确认；完成状态还需 evidence，并由 ctx.ui.confirm 获得真实确认。
- 普通时间、参与者、下一步和阶段更正不重复确认；覆盖标题/原话/事实等其他字段以及待办完成使用真实 UI 确认，取消不发送写请求。
- 普通澄清/继续/纠偏协调由后端 mode 和目标会话授权控制，不冒充用户决策；敏感扩展确认不能自动回答。
- 确认等待期间切换轮次或关闭会话，旧操作失效。没有 UI 则拒绝受确认保护的操作。

请求绝对超时 15 秒，普通响应最多 2 MiB；仅 event_get(includeImages=true) 允许最多 9 MiB 传输，后端限定 4 张、图像原始字节共 6 MiB，文本结果不嵌入 base64。可通过 AbortSignal 取消。HTTP 错误、后端拒绝、无效 JSON、空执行结果、超限、断流或超时明确抛错，不伪造成功。凭证值在返回结果、错误和确认提示中遮盖。后端部分成功结果原样呈现，主 Agent 必须说明。

## 验证边界

测试文件：`~/repos/pi-tsien-extension/test/supervisor.test.ts`，覆盖本地 Unix 网关、15 个工具、错误/超时/取消、初始化和白名单、按轮授权清除及真实确认（最终结果见 Dashboard 实施记录）；工作区 TypeScript 检查通过。

`supervisor_context` 内嵌的事件列表已改为摘要并按默认 50 条截断（返回 `eventsTotal`/`eventsTruncated`）；需要过滤、分页或正文时用 `event_query` / `event_get`。

Dashboard 的 `backend/__tests__/supervisor-integration.test.ts` 另外把实际 Extension、后端网关、事件 Store 与本地 Task Provider 贯通，检查创建 Epic/子 Task、状态更新、回复记录、更正、完成确认及自动巡查拒写。

上述不替代真实模型/浏览器与运行中服务的部署验收，当前没有代用户启动或重启服务。
