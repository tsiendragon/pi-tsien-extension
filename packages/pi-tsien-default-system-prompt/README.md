# pi-tsien-default-system-prompt

用 `~/.pi/agent/DefaultSystemPrompt.md` 覆盖系统提示的开头并调整 Guidelines 段落；文件不存在时静默跳过。

## 事件钩子

`before_agent_start`

## 配置

`~/.pi/agent/DefaultSystemPrompt.md`（可选）

## 依赖

- 内部：无
- peer：`@earendil-works/pi-coding-agent`

## 说明

被 `pi-tsien-session-ui-fork` 复用（同一套段落调整函数）。

## 加载

在 `settings.json` 里列出包，或写进 `extensions.config.json` 的 `loadOrder`；
Pi 会直接加载本包的 TS 入口（`package.json` 的 `pi.extensions`），不需要编译。
