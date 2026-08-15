喵，compact_result_v1

- **state**: `completed`（只读分析；未修改项目文件）
- **可行性结论**: **可以纯 EXTENSION 落地可用的 PTC 语义实现，但属于“扩展层蹦床模拟”，不是 Pi 原生 full PTC。** 自定义 provider 能把 DeepSeek 生成的程序交给隔离运行时，并把运行时每次工具请求编码成 Pi 原生 `toolCall`；后续 Pi 回合由 provider 在本地恢复程序、不再请求模型，因此仍满足循环、条件、并行组合工具且“工具间无模型推理往返”。若 full PTC 被严格定义为“同一运行时内直接嵌套调用任意 Pi 工具、无合成 assistant/tool 回合、完整继承会话/分支语义”，则 **extension-only 不可达**。

## 能力边界

| 形态 | 判定 | 原因 |
|---|---|---|
| Full PTC（Pi 原生一级能力） | ❌ | 扩展没有统一 `invokeTool`/dispatcher；provider 只拿到工具 schema，拿不到 `execute`；也没有内建不可信代码沙箱与可序列化 continuation。 |
| PTC 语义模拟（推荐 extension-only） | ✅ | 完整自定义 `Provider.streamSimple` 可发出 Pi 原生 `toolcall_*`；Pi 核心照常校验、执行、触发 hooks，再由 provider 本地恢复挂起程序。 |
| 静态编译模拟 | ✅，但不完整 | 仅把无数据依赖的直线/批量程序编译为一批普通 tool calls；无法保持依赖工具结果的分支和循环。 |
| UI-only wrapping | ✅，但不是 PTC | renderer/Markdown transformer 只能展示代码或调用卡片，不改变会话、模型上下文或执行语义。 |

## 最强 extension-only 架构与事件序列

1. 扩展注册独立 `deepseek-ptc` provider；从 `Context.tools` 生成 PTC 工具代理签名，调用 DeepSeek 并解析程序输出。
2. 在独立进程/容器/QuickJS-WASM 等隔离运行时执行程序；禁用文件、网络、进程、时钟/随机数，仅开放异步工具代理。
3. 程序运行到工具代理时挂起；provider 输出 `toolcall_start/delta/end`，最终 `done(reason="toolUse")`。多个同时待决请求可合成同一 assistant message，复用 Pi 并行执行。
4. Pi agent loop 调用真实已激活工具；现有参数校验、`tool_call`/`tool_result`、取消、结果记录和 UI 全部保留。
5. 下一次 `streamSimple(context)` 根据 `toolCallId` 读取新增 `toolResult`，**不访问 DeepSeek**，将结果送回挂起 worker；继续到下一批工具请求或程序完成。
6. 程序完成时 provider 输出正常 assistant text + `stop`。会话中会存在合成的 assistant/tool 回合；向 DeepSeek 序列化历史时应折叠为 PTC 程序及其运行结果。
7. 崩溃/重载恢复不要序列化任意语言栈：持久化程序源码、确定性 seed、调用序列及结果，重启后从头 replay，已完成调用命中缓存；分支按当前 session branch 重建。

## 硬阻塞与风险

- **无工具调度 API**：`getAllTools()` 只有名称、描述、schema、guidelines、来源，没有 `execute`；单个 `ptc_execute` 自定义工具无法直接调用任意 built-in/其他扩展工具并继承 hooks。蹦床通过“结束 provider 响应 → 让核心执行原生 toolCall”绕过此限制。
- **普通 provider hooks 不够**：`before_provider_request` 可改请求，`after_provider_response` 只有状态/头；要控制响应协议及本地恢复，必须注册/包装完整 provider，而不能只做事件监听。
- **沙箱不是 Pi 能力**：Node `vm` 不能作为安全边界；没有可用隔离运行时就只能支持受限 DSL/静态 AST，不能安全执行任意 DeepSeek 程序。
- **会话语义需自行补齐**：worker continuation 不可天然持久化；reload、fork、tree、compact、abort、超时与重复投递必须用确定性 replay 和调用幂等键处理。
- **协议事实待接入时锁定**：本结论验证的是 Pi capability boundary；实现前仍需用目标 DeepSeek endpoint 的真实 PTC 输出格式、停止原因和错误语义做契约样例。

## 最小回退设计

先实现 **PTC-lite compiler**：限定可审计 DSL/AST，只允许纯计算、顺序调用和显式 `parallel`；无数据依赖的调用编译成 Pi 原生 tool calls，遇到动态循环/分支则退回普通“每个结果后再问模型”的 agent loop。它无需长驻 worker，安全与恢复成本最低，但必须明确标为 emulation。

## 最小可选 core seam

新增一个公开、受控的：

```ts
ctx.invokeTool({ name, arguments, toolCallId }, { signal, onUpdate })
```

该接口必须走当前 active `AgentTool` 的 `prepareArguments`、schema validation、`beforeToolCall`/`afterToolCall`、执行模式、取消、usage 和全部 tool lifecycle events，并返回规范化 `ToolResult`。有此一处 seam，扩展即可把整段程序放在一个 `ptc_execute` 内运行并调用任意 Pi 工具，消除合成回合；沙箱和 DeepSeek 协议仍留在扩展，不必把 PTC 特性写进核心。

## 证据（最多 5 条）

1. `/mnt/workspace/lilong/envs/tsien/conda/envs/nodejs/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md:1705-1715,1815-1827` — 扩展可注册完整 Provider，并自定义 `stream`/`streamSimple`。
2. `/mnt/workspace/lilong/envs/tsien/conda/envs/nodejs/lib/node_modules/@earendil-works/pi-coding-agent/docs/custom-provider.md:481-550` — 自定义流可直接产生 `toolcall_start/delta/end` 和最终消息。
3. `/mnt/workspace/lilong/envs/tsien/conda/envs/nodejs/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js:105-129` — provider 消息中的 `toolCall` 会进入核心工具执行，再把结果加入下一回合上下文。
4. `/mnt/workspace/lilong/envs/tsien/conda/envs/nodejs/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:943-950,1141-1145` — 扩展只有 shell `exec` 与工具元数据查询，没有通用工具执行入口；`ToolInfo` 明确不含 `execute`。
5. `/mnt/workspace/lilong/envs/tsien/conda/envs/nodejs/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md:1562-1585` — message renderer/Markdown transformer 是展示层；transformer 明确为 display-only，不改变 session/model context。
