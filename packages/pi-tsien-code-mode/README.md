# pi-tsien-code-mode

用一个模型生成的 TypeScript 程序编排已有工具，把中间结果留在程序里而不是上下文里，减少往返次数。

## 工具

- `run_code`

加载时会用 Pi 当前的 Node 可执行文件，在同样的权限限制下运行一个最小 TypeScript 程序。若运行时不支持原生类型擦除（例如 Node 构建未包含 TypeScript 支持）或探测失败，本扩展不会注册 `run_code`，也不会在系统提示中推荐它；其他工具不受影响。启动时会提示当前 Node 路径和版本；更换 Node 后须重启 Pi 进程，`/reload` 不能更换 Node。

报错会区分脚本编译失败（未调用工具）、脚本执行失败和内部工具失败。内部工具失败会标出工具名，保留错误首尾及工具返回的退出码；不会自动重试。执行失败不代表此前的工具调用没有生效。

## 事件钩子

`agent_settled`、`before_agent_start`、`message_end`、`model_select`、`session_shutdown`、`session_start`

## 配置

无

## 依赖

- 内部：无
- peer：`@earendil-works/pi-coding-agent`

## 加载

在 `settings.json` 里列出包，或写进 `extensions.config.json` 的 `loadOrder`；
Pi 会直接加载本包的 TS 入口（`package.json` 的 `pi.extensions`），不需要编译。
