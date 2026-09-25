# pi-tsien-rtk-fork

`tool_result` 钩子的**唯一入口**：按声明的顺序执行 stage —— RTK 过滤（模型暴露的前后文压缩）→ bash-digest（大段输出交模型摘要）→ large-read-pack（默认关闭）。任一 stage 出错只退化为「不改写」，不影响工具结果本身。

后两个 stage 的开关与模型都在 ``~/.pi/agent/bash-digest.json`` 里配。

## 工具

- `rtk_configure`

## 命令

- `/rtk-clear`
- `/rtk-off`
- `/rtk-on`
- `/rtk-stats`
- `/rtk-toggle-ansiStripping`
- `/rtk-toggle-buildOutputFiltering`
- `/rtk-toggle-gitCompaction`
- `/rtk-toggle-linterAggregation`
- `/rtk-toggle-searchResultGrouping`
- `/rtk-toggle-smartTruncation`
- `/rtk-toggle-sourceCodeFiltering`
- `/rtk-toggle-testOutputAggregation`
- `/rtk-toggle-truncation`
- `/rtk-what`

## 事件钩子

`before_agent_start`、`session_start`、`tool_result`

## 配置

`~/.pi/agent/bash-digest.json`（stage 开关与摘要模型）；`<cwd>/.pi/rtk-config.json`（项目级 RTK 配置，由 `rtk_configure` 工具读写）

## 依赖

- 内部：无
- peer：`@earendil-works/pi-coding-agent`

## 说明

含第三方代码：RTK 由 `pi-rtk` 0.1.4 合并而来（MIT，Matt Cowger），出处与改动见 `src/rtk/PROVENANCE.md`。

## 加载

在 `settings.json` 里列出包，或写进 `extensions.config.json` 的 `loadOrder`；
Pi 会直接加载本包的 TS 入口（`package.json` 的 `pi.extensions`），不需要编译。
