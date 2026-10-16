# pi-tsien-subagent-workbench

进程隔离的子代理与可恢复的 Workflow（编排、重试、结果收集），可由 dashboard 的 Workbench 面板查看。

## 工具

- `subagent_cancel`
- `subagent_results`
- `subagent_start`
- `subagent_workflow`
- `subagent_workflow_control`

## 命令

- `/subagent-workbench`

## 事件钩子

`session_shutdown`、`session_start`

## 配置

- `PI_SUBAGENT_EXECUTION_MODEL`：精确的 `provider/model` 默认模型；未设置时使用 `azure-gateway/gpt-5.6-luna`。
- 默认思考强度为 `medium`；任务模型覆盖工作流模型，只有显式 `inheritModel: true` 才继承父模型。

## 局限

- 模型名只接受精确 `provider/model`；本包没有模型注册表时不能验证远端是否可用，也不会自动 fallback。
- 输入预算包含 task、context 和工作流输入，默认硬限 9 MiB；结果默认硬限 8 MiB，超限会明确失败，不截断关键输入或原始结果。
- `read_only`、`research`、`code` 角色在工具事件入口拦截不允许的工具；底层 Pi 的扩展和项目规则仍会加载，不使用 `--no-extensions`。如果底层运行时已经执行了不可逆外部副作用，工作台不能撤销它。
- `resultPreview` 只是有限预览，原始结果仍保存在工作台，可再次 collect；重复完成不会重复通知。对于背景命令或交接状态不明的外部清理，本包目前不提供自动判断，调用方必须自行确认后清理，不能把它当作已完成。
- 一次性任务默认关闭子会话；只有显式 `retainSession` 才保留。当前实现不承诺跨进程恢复未持久化的实时流。

## 依赖

- 内部：无
- peer：`@earendil-works/pi-coding-agent`

## 说明

依赖 `pi-tsien-shared`；被 `pi-tsien-memory` 依赖。

## 加载

在 `settings.json` 里列出包，或写进 `extensions.config.json` 的 `loadOrder`；
Pi 会直接加载本包的 TS 入口（`package.json` 的 `pi.extensions`），不需要编译。
