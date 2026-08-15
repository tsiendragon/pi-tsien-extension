compact_result_v1

## summary

**结论：公开资料中没有一个由 DeepSeek 正式命名为“Programmatic Tool Calling（PTC）”的独立模型协议。** DeepSeek 官方实现中与 PTC 同构的能力叫 **DeepSeek Harness Code Mode**：模型仍通过一次普通工具调用提交 `run_code({code, description})`，由 Harness 在本地代码运行时执行 TypeScript/Python 程序；程序通过生成的类型化 `tools` SDK 调用真实工具。DeepSeek API 服务器不执行这些程序或业务工具。

“PTC”这一术语的当前明确学术定义来自 PwC 作者的论文《The Bitter Lesson of Tool Calling》，不是 DeepSeek 论文；该论文只评估 OpenAI 与 Anthropic 模型，不能作为 DeepSeek 模型能力声明。因而，严谨表述应是：**“DeepSeek Harness 的 Code Mode 属于 PTC/Code Mode 范式”**，而不是“DeepSeek 定义了 PTC 协议”。

## findings

### 1. 权威定义与边界

- **已验证（DeepSeek 官方）**：Code Mode 是 `ToolRuntime` 的工具呈现模式，配置为 `native | code | both`。
  - `native`：把每个工具作为普通 JSON Schema function 暴露给模型。
  - `code`：线上只暴露保留工具 `run_code`，并在系统提示中加入按当前可见工具生成的 SDK；其他工具只能在程序内部调用。
  - `both`：同时暴露普通工具和 `run_code`。
- **已验证（通用 PTC 论文，非 DeepSeek）**：PTC 指把工具暴露成类型化 Python stub，由模型写脚本组合调用，agent loop 在一个 agent turn 内执行脚本并处理结果。
- **推断**：DeepSeek Code Mode 与论文 PTC 属同一范式，但两者不是同一个固定 wire protocol；语言、沙箱、返回格式和错误模型由各自 Harness 决定。

### 2. 模型输出语法

DeepSeek Harness 的模型侧合同是一次普通工具调用：

```text
run_code({
  "description": "简述程序用途",
  "code": "const x = await tools.foo({ ... }); return x;"
})
```

TypeScript 运行时下，`code` 是可在 `AsyncFunction` 中执行的函数体，允许顶层 `await` / `return`；调用形式为 `await tools.name(args)`，特殊名称用 `tools["my-tool"](args)`。仅支持可擦除 TypeScript 语法，`enum`、namespace 等会失败。Python 运行时使用等价的 async Python SDK、`await tools.name(args)`、`print(...)` 和顶层返回。

只有 `console.log`/`print` 与最终 `return` 会回到模型上下文；中间工具结果仅在执行期间可见。类型声明用于帮助模型，TypeScript 类型会在运行前删除，不构成运行时类型安全。

### 3. 谁执行代码与工具

- **模型/DeepSeek API**：只生成 `run_code` 的工具调用及 JSON 参数。
- **DeepSeek Harness**：接收该调用，运行完整的审批/守卫/执行/后处理流水线，并调用 `ctx.codeRuntime.run(...)`。
- **代码运行时**：官方随附的 TypeScript 后端为本地 Node `worker_threads.Worker`，每次调用新建一个 worker；不是 DeepSeek 云端代码解释器。
- **真实工具**：程序中的每个 `tools.*` 调用通过 message-port bridge 回到 Harness 工具注册表，由对应插件、MCP 客户端或本地执行器执行。工具调用的副作用不会因外层程序后续失败而回滚。

这与 DeepSeek 原生 Tool Calls API 的责任边界一致：官方文档明确说模型本身不执行函数，调用方必须实现并执行函数，再把 `role: tool` 的结果送回模型。

### 4. 工具如何暴露

- 工具插件先向 Harness 注册 name、description、参数 schema、输出 schema 与 executor。
- `code` 模式把当前 agent **可见范围**内的工具编译为确定性的 TypeScript `.d.ts` 或 Python 类型定义，注入系统提示；`run_code` 自身不出现在该 SDK 中。
- 子调用参数和成功返回值必须是无损 JSON；成功返回工具声明的 canonical JSON value。
- 工具仍经过与原生调用相同的 pre-execute、审批/守卫、execute、post-execute、结果规范化与观察链路。
- 并发只在工具自身声明为 concurrency-safe 时允许；只读独立调用可通过 `Promise.all` / `asyncio.gather` 重叠，带副作用或未声明安全的调用按独占屏障执行。

### 5. 状态、取消与错误语义

- **状态**：每次 `run_code` 都是全新 worker，无跨调用 REPL 状态；本次程序内局部变量存在到 worker 结束。持久状态只能来自工具副作用、外部服务或 Harness/session 自身。
- **成功**：外层 canonical 结果为 `{logs: string[], result?: JsonValue}`；`undefined` 表示没有 result。
- **工具失败**：程序内 promise 以真实 `ToolCallError` 拒绝，仅保证 `toolName` 与人类可读 `message`；模型代码可 `try/catch` 后继续。
- **运行时失败**：外层转为 `CodeRunFailedError/CODE_RUN_FAILED`。底层区分 `exception | timeout | abort | worker-exit | invalid-output | output-limit`。
- **取消**：外层结束或取消时会中止未完成子调用，并等待队列排空后再结算；已发生副作用不回滚。
- **历史**：子调用事件进入日志/可观察层，但中间 canonical value 不进入模型历史；只有外层打印与返回值进入下一轮上下文。

### 6. 支持的模型与 provider

- **DeepSeek Code Mode 没有公开的模型 allowlist**；它是 Harness 层能力，前提是所选模型/provider 能可靠地产生 `run_code` 普通工具调用。
- 官方 Harness 模型配置支持 DeepSeek，并可添加 Anthropic、OpenAI 等 catalog provider，以及 Bedrock、Vertex、Azure、Codex 和自定义 OpenAI-compatible endpoint。该事实只证明 Harness 可路由这些 provider，**不等于每个模型都经 PTC 验证**。
- PTC 论文评估 14 个模型：Claude Haiku 4.5、Sonnet 4.5/4.6/5、Opus 4.8，以及 GPT-4o、4.1、5-nano、5、5.4-mini、5.4、5.6-Luna/Sol/Terra；**没有 DeepSeek 模型**。

### 7. 声称收益

**DeepSeek 官方设计层声明（非独立 benchmark）：**
- 多步工具工作可在一次程序中循环、分支、连接、过滤和 fan-out，减少每个子调用一次模型往返。
- 中间结果不反复塞回上下文，只返回模型最终需要的内容。
- 对大量工具而言，生成 SDK 与前缀缓存提供更稳定的接口。

**PTC 论文实证（不能外推为 DeepSeek 指标）：**
- BFCL v4 子集上，14 个模型中 11 个 PTC 持平或超过 JSON tool calling。
- 并行 fan-out 中 13/14 持平或更好；论文称 Claude Sonnet 5 在 JSON 方式约 70–72 个调用开始漏调用，而 PTC 在 100 个调用仍保持完整枚举。
- 链式任务中多数模型约用一半 wall-clock 时间，但 GPT-5 是反例；高 fan-out 时 token 成本才出现优势。

### 8. 已知限制

- DeepSeek Harness 仍是 developer preview，官方警告会有破坏兼容性的变更。
- Node worker 只是 containment，不是硬安全边界；模型代码可访问 Node API，权限等级按官方说法与 bash 相当，且 worker 终止不能杀死它已派生的 OS 进程。多租户需容器级边界。
- SDK prompt 可能与普通工具 schemas 一样大；`both` 会同时承担两套表示，官方没有承诺普遍节省 token。
- 中间 binding value 没有字节上限，可能耗尽内存；默认 64 MiB 只限制外层 logs/result/error payload。
- 每次运行无持久内核，普通副作用无事务回滚。
- PTC 论文只使用“回显参数”的 stub，没有真实 API；小型 ablation 样本置信区间较宽。链式条件下 PTC 输入 token 约为 JSON 方式的 1.5 倍；旧模型还会因多行代码转义错误显著退化。

## unresolved

1. DeepSeek 未公开把 “PTC” 作为正式产品名或标准，因此无法确认其是否计划将 Code Mode 对外品牌化为 PTC。
2. 未发现 DeepSeek 模型在 Code Mode/PTC 下的官方准确率、延迟或 token benchmark；不能从 PwC 的 OpenAI/Anthropic 实验推断 DeepSeek-V4 表现。
3. 官方公开文档没有给出“provider × model × Code Mode 语言后端”的完整兼容矩阵；配置可路由不代表质量认证。
4. Python SDK renderer 已内置，但第一方 Python code-runtime 被描述为单独交付；其当前发布/安装矩阵需按具体 Harness 版本确认。

## evidence

1. **DeepSeek Harness — Code Mode foundation**<br>
   URL: https://github.com/deepseek-ai/deepseek-harness/blob/master/.agents/notes/implemented/feature/2026-06-15-code-mode.md<br>
   Exact claim: “Code Mode is a first-class presentation mode of `ToolRuntime`”; `code` 模式只提供 `run_code` 与生成的 SDK；运行时收到 program + async bindings，官方 worker-thread 后端每次运行新 worker，并明确写着 “containment, not a security boundary”。<br>
   Confidence: 高（DeepSeek 官方仓库，实现状态为 implemented）

2. **DeepSeek Harness — dsh-tools Code Mode contract**<br>
   URL: https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/tools/README.md<br>
   Exact claim: “ONLY what you print or return comes back to you”; `run_code` 必须包含 `code` 和 `description`，工具通过 `await tools.name(args)` 调用，失败为 `ToolCallError`，运行失败为 `CodeRunFailedError`；每次 run state 是 fresh。<br>
   Confidence: 高（DeepSeek 官方包文档）

3. **DeepSeek API — Tool Calls**<br>
   URL: https://api-docs.deepseek.com/guides/tool_calls/<br>
   Exact claim: “The functionality of the `get_weather` function needs to be provided by the user. The model itself does not execute specific functions.”<br>
   Confidence: 高（DeepSeek 官方 API 文档）

4. **DeepSeek Harness — Configure models**<br>
   URL: https://deepseek-harness.github.io/deepseek-harness/en/guide/providers<br>
   Exact claim: Harness 可配置 DeepSeek；catalog provider 示例包括 Anthropic/OpenAI，原生认证 provider 包括 Bedrock/Vertex/Azure/Codex，并允许自定义 provider、base URL、API protocol 和 model list。<br>
   Confidence: 高（DeepSeek Harness 官方站点；只证明路由能力，不证明 PTC 质量）

5. **The Bitter Lesson of Tool Calling**<br>
   URL: https://arxiv.org/html/2608.06370v1<br>
   Exact claim: PTC 中“tools are exposed as typed Python stubs ... with execution and results handled in a single agent turn”；论文报告 14 个模型中 11 个持平或优于 JSON baseline、并行 fan-out 中 13/14 持平或更好，同时明确限制为 echo-return stubs、小样本 ablation 与固定输入 token 开销。<br>
   Confidence: 中高（公开论文 v1；非 DeepSeek 作者/官方声明，尚不能外推到 DeepSeek 模型）

状态：completed — 已建立术语归属、DeepSeek 官方运行合同、责任边界、错误/状态语义、provider/model 范围、收益与限制，并区分了官方事实、外部论文结果和推断。