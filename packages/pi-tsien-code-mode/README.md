# pi-tsien-code-mode

用一个模型生成的 TypeScript 程序编排已有工具，把中间结果留在程序里而不是上下文里，减少往返次数。

## 工具

- `run_code`

加载时会用 Pi 当前的 Node 可执行文件，在同样的权限限制下运行一个最小程序。类型擦除在**宿主进程**完成（优先用与 Node 内置擦除同源的 `amaro`/SWC，strip-only 模式；缺失时回退到 `node:module.stripTypeScriptTypes`），沙箱子进程只收到纯 JavaScript，因此不再要求 Node 构建自带 TypeScript 支持——Debian/Ubuntu 那类共享 `libnode` 的构建（`node_use_amaro=0`）下同样可用。若宿主机完全没有可用的擦除器，或探测失败，本扩展不会注册 `run_code`，也不会在系统提示中推荐它；其他工具不受影响。探测失败时会同时给出具体原因。启动时会提示当前 Node 路径和版本；更换 Node 后须重启 Pi 进程，`/reload` 不能更换 Node。

报错会区分脚本编译失败（未调用工具）、脚本执行失败和内部工具失败。内部工具失败会标出工具名，保留错误首尾及工具返回的退出码；不会自动重试。失败时会附上已成功、已派发但失败或结果不确定、以及被拦截而未派发的调用编号（若有）。执行失败不代表此前的工具调用没有生效：先检查实际状态，再用新的 `run_code` 调用处理未完成部分。

每次 `run_code` 独立检查嵌套调用额度和配置的运行时限；超过限制只影响该次调用。整轮累计写入、模型输出 token 和调用次数只用于统计和软提醒，不会锁住后续调用。嵌套工具的权限和参数校验不变。

## 事件钩子

`agent_settled`、`before_agent_start`、`message_end`、`model_select`、`session_shutdown`、`session_start`

## 配置

可选模型配置位于 `<PI_CODING_AGENT_DIR | ~/.pi/agent>/code-mode/full-tool.json`。`maxNestedWrites`、`maxNestedRuns` 和运行超时按单次程序计算；旧字段 `maxOuterRunCodeCalls`、`maxTotalTokens` 仅作为整轮用量提醒阈值。

## 依赖

- 内部：无
- peer：`@earendil-works/pi-coding-agent`

## 加载

在 `settings.json` 里列出包，或写进 `extensions.config.json` 的 `loadOrder`；
Pi 会直接加载本包的 TS 入口（`package.json` 的 `pi.extensions`），不需要编译。
