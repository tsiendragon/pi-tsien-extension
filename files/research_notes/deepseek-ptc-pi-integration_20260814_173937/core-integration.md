# compact_result_v1

**状态：completed（设计完成，只读，未改仓库）**

## 结论

最小可信方案不是伪造 DeepSeek 原生 PTC 协议，而是在 **Pi Agent Core 内把 PTC 实现为一种受控的复合工具调用**：DeepSeek 仍使用其现有 OpenAI-compatible function calling；模型调用一个合成工具 `pi_program` 并提交 JavaScript，Pi 在操作系统级隔离容器中执行代码，代码通过受限代理调用现有 Pi 工具。外层对现有 provider、agent loop、RPC 和 session 仍表现为普通 `toolCall → toolResult`，因而改动小、可回退，并保留 DeepSeek thinking/tool-call 所要求的 `reasoning_content` 回放。

## 明确假设

1. **高置信事实**：DeepSeek 官方资料目前描述的是标准函数调用及 thinking 模式下的多轮工具调用；没有发现 DeepSeek 自有的 `container/caller/allowed_callers` PTC wire protocol。
2. **设计假设**：这里的 “DeepSeek PTC” 指“让 DeepSeek 生成程序、由程序批量调用工具”，而非要求兼容 Anthropic 私有字段。Anthropic PTC 仅作为权威语义参照：代码容器、可调用工具白名单、暂停/结果回送及容器生命周期。
3. **MVP 边界**：仅 JavaScript、仅文本工具结果、单次程序运行、默认只开放只读工具；不跨 turn 保存活容器，不允许无隔离的 host-process 降级。

## 设计

### 1. 协议适配与代码信封

- 增加 feature gate：`programmaticToolCalling: "off" | "auto" | "required"`；默认 `off`。
- `auto` 且隔离 runtime 可用时，Agent Core 在工具集合中加入普通 function tool：

```json
{
  "name": "pi_program",
  "parameters": {
    "type": "object",
    "properties": { "code": { "type": "string" } },
    "required": ["code"],
    "additionalProperties": false
  }
}
```

- 系统提示附加一个短 manifest：可编程调用的工具名、JSON Schema、调用 API 和限制。代码信封固定为 top-level `await` JavaScript：

```js
const a = await tools.call("read", { path: "/workspace/a.json" });
const b = await Promise.all(ids.map(id => tools.call("lookup", { id })));
return { answer: aggregate(a, b) };
```

- `pi_program` 与普通工具一起暴露；模型仍可直接调用普通工具，因此无需 DeepSeek 私有协议。Pi 本地再次校验 `code` 参数，不能依赖 DeepSeek beta strict mode。
- DeepSeek thinking 模式沿用现有 `thinkingFormat: "deepseek"`：流中的 `reasoning_content` 进入 Pi thinking block，后续含工具请求必须原样回放。PTC 外层是普通 tool call，所以无需新增 provider 消息角色。

### 2. 工具代理 API

新增 Agent Core 接口（命名可调整）：

```ts
interface ProgrammaticRuntime {
  run(req: ProgramRequest, proxy: ToolProxy, signal: AbortSignal,
      onOutput: (chunk: string) => void): Promise<ProgramResult>;
}

interface ToolProxy {
  call(name: string, args: unknown, parentCallId: string,
       signal: AbortSignal): Promise<{ ok: boolean; text: string }>;
}
```

- `AgentTool` 增加 `allowedCallers?: ("direct" | "program")[]`；为兼容旧工具，缺省等价于 `["direct"]`，不是全部开放。
- 首版仅显式开放 `read/grep/find/ls`；`bash/edit/write` 仍只能 direct。代理对 allowlist 做**硬校验**（不像 Anthropic `allowed_callers` 仅是模型引导）。
- 从现有 `agent-loop.ts` 抽取可复用的单工具执行原语，使代理调用继续经过：参数 schema 校验、`beforeToolCall`、工具 `execute(signal,onUpdate)`、`afterToolCall`、错误归一化。不能从 `pi_program.execute()` 直接调用底层工具，否则会绕过扩展安全钩子和事件。
- 每次代理调用使用 `${outerToolCallId}:${seq}` 作为稳定 ID；限制最大调用数、并发数、单结果字节数和总输出字节数。
- 单个代理结果只返回沙箱，不进入 LLM context；仅程序最终 `return`（或受限 stdout）成为 `pi_program` 的文本 tool result。这是减少模型 round trip 和工具结果 token 的关键。

### 3. Sandbox/runtime

Pi 官方明确没有内建沙箱，因此 MVP 必须提供真实 OS 边界：

- 新增 `DockerProgrammaticRuntime`（后续可接 Gondolin/OpenShell），运行固定 Node 22 镜像。
- 启动约束：`--network none`、只读根文件系统、空环境变量、无宿主 cwd/凭证挂载、`tmpfs /tmp`、drop capabilities、no-new-privileges、PID/CPU/内存/墙钟限制。
- wrapper 与父进程以严格 JSONL stdio 通信：`tool_call {id,name,args}` / `tool_result {id,ok,text}`；用户 stdout 使用独立 frame，避免与协议混淆。
- 沙箱不能直接访问网络或文件；外部能力只能经过父进程代理。Docker 不可用时：`auto` 隐藏 `pi_program` 并继续 direct tools；`required` 启动即报明确错误。绝不悄悄用 `vm`、`eval` 或普通 child process 充当安全边界。

### 4. 事件流

保持现有事件为主，新增的都是可选字段：

- 外层：现有 `tool_execution_start/update/end`，工具名为 `pi_program`；程序 stdout 作为有上限的 outer update。
- 内层：代理真实工具仍发标准 tool execution 事件，增加 `parentToolCallId` 与 `caller: "program"`，便于 TUI/RPC 构建层级；旧客户端忽略可选字段即可。
- 事件顺序：outer start → 若干 nested start/update/end → outer end → turn_end。并行调用的 end 按完成顺序发送，但 trace 按 seq 固定排序。
- RPC JSONL 只需透传这些 AgentSession events，不增加第二套协议。

### 5. 取消

- 复用现有 `AbortSignal` 链：`AgentSession.abort()` → agent loop → `pi_program.execute()` → runtime 与每个代理工具。
- 收到 abort 后立即停止接受新代理请求、向所有在途工具传播 signal、TERM/KILL 容器，并丢弃迟到结果；outer result 标记 aborted，最终只产生一次 settled/end。
- runtime timeout 与用户取消区分错误码；有副作用工具未来即使开放，也不得在不确定完成状态下自动重试。

### 6. Session 持久化

- 已完成执行无需新消息角色：assistant 中已保存 `pi_program` 的代码参数，随后保存普通 `ToolResultMessage`。
- `ToolResultMessage.details.ptc` 保存非上下文 trace：版本、runtime、代码 hash、代理调用 `{id,name,argsHash,ok,durationMs}`、exit/timeout/truncated；不保存凭证或未脱敏完整结果。
- Pi 在 assistant `message_end` 时已先持久化工具调用；若进程在执行中崩溃，恢复时把“有 call、无 result”视为 interrupted，合成错误结果并让模型决定 direct 重试，**不恢复活容器，也不自动重放可能有副作用的调用**。
- session v3 仍可被旧版本读取，因为消息角色未变，额外 trace 位于可选 `details`。

### 7. 兼容回退

- 非 DeepSeek、旧 provider、无 Docker、模型连续两次生成非法代码、或 runtime 启动失败：在 `auto` 下禁用本 turn 的 `pi_program`，保留现有 direct tool loop。
- 不修改 DeepSeek HTTP API；provider 层只需保证现有 reasoning/tool replay 回归通过。
- Anthropic 原生 PTC 若以后接入，应另做 provider capability adapter；不要把其 `container/caller/allowed_callers` 字段塞进 DeepSeek 请求。

## 预计改动面（canonical 源路径 / 符号）

1. `packages/agent/src/types.ts`：`AgentTool.allowedCallers`、`ProgrammaticRuntime`、nested event 可选字段。
2. `packages/agent/src/agent-loop.ts`：`runLoop`、`executeToolCalls*`、`prepareToolCall`、`executePreparedToolCall`；抽取共享执行原语并接入 `pi_program`。
3. 新增 `packages/agent/src/programmatic/{tool,protocol}.ts`：合成工具、manifest、额度与 JSONL frame 类型。
4. 新增 `packages/coding-agent/src/core/programmatic/docker-runtime.ts`：OS 隔离、进程生命周期、流与取消；由 `createAgentSessionServices` 注入。
5. `packages/coding-agent/src/core/agent-session.ts`：事件可选层级字段透传、abort、trace details 持久化；`session-manager.ts` 原则上不需 schema 升级。
6. `packages/ai/src/api/openai-completions.ts`：原则上无新协议；只补 DeepSeek PTC 回归测试，重点覆盖 `convertMessages`、`buildParams`、`stream`。
7. `packages/coding-agent/src/core/settings-manager.ts` / docs：feature gate、runtime 路径和资源上限。

## 主要风险

- **最高风险：沙箱误标**。Pi 当前无内建沙箱；没有 Docker/Gondolin/OpenShell 就不能安全执行模型代码。
- **权限放大**：程序可快速重复调用工具。必须默认 direct-only、显式 program allowlist、硬额度，首版只读。
- **可观测性缺口**：若绕过共享执行原语，扩展审批/审计会失效；这是架构否决条件。
- **DeepSeek thinking 回放**：含工具的历史若丢 `reasoning_content` 会收到 400；必须做真实 SSE/请求快照测试。
- **幂等性**：崩溃、超时或取消时不能判断写操作是否已生效；因此 MVP 排除写工具。
- **收益不稳定**：少量小工具调用时，程序生成和容器冷启动可能更慢；只在多调用/大结果过滤场景启用 `auto`。

## 验收测试

1. **协议/回放**：mock DeepSeek SSE 依次输出 `reasoning_content` 和 `pi_program` tool call；断言下一请求包含完整 assistant `reasoning_content`、tool call 与 outer tool result，无 400。
2. **PTC 收益路径**：程序并发调用 20 次 mock lookup 并聚合；只发生 2 次 LLM 请求（生成程序、读取最终结果），LLM context 不含 20 份原始结果。
3. **安全与钩子**：允许的 read 调用参数校验及 before/after hook 各恰好一次；调用 `write/bash` 在工具 execute 前被拒绝并留审计事件。
4. **隔离**：程序读取宿主 cwd/env、访问公网、fork bomb、超内存分别失败；无宿主文件或凭证泄漏，资源限制能终止容器。
5. **事件**：断言 outer/nested 层级、ID、并行完成顺序、stdout 截断和 RPC JSONL 均可重建；旧 RPC client 仍可解析。
6. **取消**：长程序和两个在途代理调用期间 abort；容器被杀、signals 传递、无迟到 update、最终仅一次 settled。
7. **持久化**：完成后 resume 不重跑工具；在 outer assistant 保存后强杀，resume 得到 interrupted 结果而非重放；旧 session parser 可读取。
8. **回退**：Docker 缺失、非法代码、feature off 时 direct tool calling 结果与当前 baseline 一致；`required` 明确失败而非降级。

## 证据（最多 5 条）

1. Anthropic PTC 权威语义（代码容器、`allowed_callers`、caller、暂停后 tool result、生命周期与限制）：https://platform.claude.com/docs/en/agents-and-tools/tool-use/programmatic-tool-calling
2. DeepSeek 官方 thinking + tools 要求：含 tools 的后续请求必须完整回传 `reasoning_content`：https://api-docs.deepseek.com/guides/thinking_mode/
3. Pi 已安装 OpenAI/DeepSeek adapter 已支持 tools、`thinkingFormat: "deepseek"` 和 reasoning replay：`/mnt/workspace/lilong/envs/tsien/conda/envs/nodejs/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js:516-622,807-1015,1074-1104`
4. Pi Agent Core 当前在统一 loop 中解析、校验、执行工具并传递 AbortSignal，正是应抽取代理执行原语的位置：`/mnt/workspace/lilong/envs/tsien/conda/envs/nodejs/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js:78-154,178-214,287-470`
5. Pi 官方明确声明没有内建沙箱，真实隔离必须来自 OS/虚拟化/容器边界：`/mnt/workspace/lilong/envs/tsien/conda/envs/nodejs/lib/node_modules/@earendil-works/pi-coding-agent/docs/security.md:31-50`
