# compact_result_v1

- **status**: `done`
- **scope**: Pi 0.84.1，只读检查；PTC 按仓库定义指 DeepSeek Programmatic Tool Calling。
- **documentation_coverage**: 完整读取指定 `README.md`、`docs/extensions.md`、`docs/custom-provider.md`、`docs/sdk.md`，以及直接相关的 `docs/session-format.md`、`docs/compaction.md`、`docs/rpc.md`、`docs/models.md`；并检查已安装 `pi-coding-agent`、`pi-agent-core`、`pi-ai` 实现。

## 架构摘要

```text
Host/TUI/RPC/SDK
  -> AgentSession.prompt（输入扩展、模板/技能、before_agent_start）
  -> pi-agent-core Agent / runAgentLoop
  -> transformContext -> convertToLlm
  -> ModelRuntime.streamSimple
  -> pi-ai Provider（组装请求、解析 SSE/JSON、产出 AssistantMessageEventStream）
  -> assistant 的 toolCall 内容块
  -> schema 校验 -> tool_call gate -> Tool.execute -> tool_result patch
  -> ToolResultMessage 回注上下文 -> 下一次 Provider 请求
  -> AgentSession 事件桥接 -> SessionManager 追加 JSONL 树
```

### 分层与关键符号

1. **编排/宿主层（pi-coding-agent）**：`createAgentSession` 创建 `Agent`、`ModelRuntime`、`AgentSession`、`SessionManager` 和扩展运行器；`AgentSession.prompt` 负责输入扩展、命令/技能/模板、鉴权、压缩前检和 `before_agent_start`。
2. **循环层（pi-agent-core）**：`runAgentLoop` / `runLoop` 每轮调用 `streamAssistantResponse`；最终 assistant message 中出现 `toolCall` 才进入 `executeToolCalls`。默认是“逐个预检、允许的调用并发执行、最终 ToolResultMessage 按 assistant 原始顺序回注”；任一工具声明 `executionMode: "sequential"` 会让整批串行。
3. **Provider 层（pi-ai）**：`ModelRuntime.streamSimple` 解析鉴权后转发给选中 Provider。内置 API 解析器把厂商流转换为统一的 `start/text_*/thinking_*/toolcall_*/done|error`；工具参数在流中增量解析，loop 只消费最终标准 `toolCall` 内容块。
4. **事件层**：底层 Agent 事件先进入 `AgentSession`；扩展可观察 message/turn/tool 生命周期。`tool_call` 位于参数校验后、执行前，可改参数或阻断；`tool_result` 位于执行后、`tool_execution_end` 和最终 ToolResultMessage 前，可改结果。Provider 侧只有 headers、已序列化 payload、响应 status/headers 钩子，没有原始响应 body/流事件替换钩子。
5. **持久化层**：`SessionManager` 是 append-only JSONL 树（`id`/`parentId`）；`message_end` 后持久化 user/assistant/toolResult，自定义 entry 不进模型上下文，自定义 message 才进入。`buildSessionContext` 按当前 leaf、分支和 compaction 重建下一次模型上下文。

## PTC 扩展边界结论

### 可用现有扩展完成的受限路线

- 注册一个完整自定义 Provider/`streamSimple`，把 DeepSeek PTC 输出规范化为普通 `toolCall { name: "ptc_runtime", arguments: { code } }`；或在 PTC 代码以普通 assistant 文本出现时，用 `message_end` 替换为该合成 toolCall。
- 注册 `ptc_runtime` 自定义工具，在沙箱中执行程序，并把最终结果作为一个普通 ToolResultMessage 返回。
- 这条路线无需改 loop，外层 PTC 调用自动获得现有阻断、取消、事件和 JSONL 持久化语义，适合作为协议/收益验证。

### 当前扩展无法透明完成的部分

- 公开 `ExtensionAPI` 没有 `invokeTool/executeTool`：`getAllTools()` 仅给元数据，不能取得任意内置或第三方活动工具的执行函数。因此扩展式 PTC runtime 只能调用它自己拥有/重新包装的工具，无法无损复用整个 Pi 活动工具集合。
- `after_provider_response` 看不到响应 body；若 DeepSeek 使用非标准流事件，必须写完整自定义 Provider，单靠 payload/message 钩子不够。
- 内层 PTC 工具调用不会自然产生标准 `tool_execution_*`、ToolResultMessage 和逐调用 JSONL 记录；只能塞进外层工具 `details`/custom entry，导致 UI、审计、重放、usage 和错误语义降级。

### 原生支持的最小改动面

1. 在 pi-ai Provider 适配层把 PTC 程序解析为统一内容块（新增 `programmaticToolCall`，或约定内部 `ptc_runtime` toolCall）。
2. 从 `agent-loop.js` 抽出可重入的 Tool Dispatcher（复用 `prepareToolCall` → execute → `finalizeExecutedToolCall`），向 PTC runtime 暴露受 allowlist 约束的调用能力。
3. 定义嵌套调用事件、取消/超时/并发/最大步数/输出预算；明确内层调用是否逐条回注模型。
4. 扩展 session schema 或明确 materialization 规则，持久化程序、内层调用顺序、结果、错误和 usage，保证恢复/分支/压缩可重建。

**路线建议**：先做“自定义 Provider + 单一 `ptc_runtime` 工具”的扩展级可行性验证；只有 DeepSeek 合同确认收益且要求访问所有 Pi 工具、完整嵌套可观测性或可恢复重放时，再进入核心原生方案。不要仅用 `before_provider_request` 改 payload 后假设现有 Provider 解析器能理解 PTC。

## 未决问题

1. DeepSeek PTC 的确切 wire contract：代码位于普通文本、标准 tool call，还是专有流事件？
2. 程序运行时/语言、工具绑定协议，以及每个内层结果是否需要即时返回模型。
3. 产品要求是“外层一个 PTC 调用即可”还是必须逐个展示、审计和重放内层调用。
4. PTC 是否必须访问全部动态活动工具/第三方扩展工具，还是固定 allowlist 足够。
5. 沙箱、网络/文件权限、最大步数、并发、取消和 usage 计费由 Pi 还是 DeepSeek runtime 负责。

## 证据（5 条）

1. **会话构造与 Provider 钩子接线**：`/mnt/workspace/lilong/envs/tsien/conda/envs/nodejs/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/sdk.js:150-225`（`Agent`、`ModelRuntime.streamSimple`、headers/payload/response/context hooks）。
2. **Provider 注册与工具流解析**：`/mnt/workspace/lilong/envs/tsien/conda/envs/nodejs/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/compat.js:45-85,118-189`；`/mnt/workspace/lilong/envs/tsien/conda/envs/nodejs/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js:94-130,259-282,383-405,469-481`。
3. **Agent loop 与工具执行语义**：`/mnt/workspace/lilong/envs/tsien/conda/envs/nodejs/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js:78-145,178-245,287-540`（循环、标准流消费、校验/预检、并行执行、结果回注）。
4. **扩展边界与事件桥接**：`/mnt/workspace/lilong/envs/tsien/conda/envs/nodejs/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:210-390`；`/mnt/workspace/lilong/envs/tsien/conda/envs/nodejs/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:504-523,648-809,864-1026`（Provider/tool/message hooks 与完整公开 ExtensionAPI）。
5. **JSONL 持久化和上下文重建**：`/mnt/workspace/lilong/envs/tsien/conda/envs/nodejs/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js:200-245,740-877,940-1070`（compaction-aware context、append-only entry、branch/context API）。

**completed**：已完成架构、扩展边界、PTC 两条路线和未决问题映射；未修改任何仓库文件。