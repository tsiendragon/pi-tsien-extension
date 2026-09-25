# pi-tsien-code-mode

用一个模型生成的 TypeScript 程序编排已有工具，把中间结果留在程序里而不是上下文里，减少往返次数。

## 工具

- `run_code`

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
