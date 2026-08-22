# pi-tsien-extension

一组面向 [Pi](https://github.com/earendil-works/pi-mono) 的实用 TypeScript extensions。

## Extensions

### `effort.ts`

使用 `/effort [level]` 直接调整当前模型的 thinking level。

- 例如：`/effort high`
- 支持：`off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`
- 不带参数时打开级别选择；实际级别会按当前模型能力自动限制。

### `btw.ts`

使用 `/btw` 打开一个与主任务隔离的临时侧聊浮窗。

- 打开时继承主 Agent compact 后的当前有效 context 快照。
- 额外保存主 Session 完整活动分支的只读快照；BTW 仅在问题需要时通过 `session_history` 搜索 compact 前的旧消息。
- 使用独立内存会话，BTW 的消息和工具结果不会写回主会话或出现在 `/tree` 中。
- 仅启用 `read`、`grep`、`find`、`ls` 和只读的 `session_history`，不能执行 shell、编辑或写入文件。
- 支持流式回答和只读工具状态显示。
- `Esc`：生成时取消，空闲时关闭。
- `PageUp` / `PageDown`：滚动侧聊记录。
- `Ctrl+R`：同时刷新主会话当前 context 和完整活动分支历史快照。
- `Ctrl+Y`：把最后一个 BTW 回答复制到主输入框，但不自动提交。

### `git-graph.ts`

使用 `/git-graph [1-2000]` 打开当前 Git 仓库的提交概览浮层，展示本地与远端引用，并自动折叠普通提交。

### `sidebar.ts`

显示当前 Main/Pi 会话的模型、上下文组成、用量和缓存信息，不读取或展示子代理、工作流或子会话状态。

- `/sidebar [show|hide|toggle|close]`
- `Ctrl+Alt+S`：显示或隐藏当前会话信息侧栏

### `context-powerline.ts`

在 Pi footer 中显示当前模型、推理等级、上下文使用量、自动压缩阈值，以及本机 CPU/内存占用。

### `running-commands.ts`

在现有 Powerline 正上方统一显示前台 Agent Bash 与显式后台任务，不改变普通 Bash 的前台执行语义。

- 依赖支持 `pre-powerline v1` 插槽的 `pi-zero`；缺少时只禁用命令界面，不影响命令执行。
- 输入框严格为空时按 `↑` 聚焦命令列表；空格、换行、IME 输入或其他内容均保持原编辑行为。
- 输入为空且有运行命令时，`Ctrl+↑/Ctrl+↓` 仍用于浏览输入历史。
- 命令列表使用 `↑/↓` 选择、`Enter` 查看实时输出、`Esc` 返回输入框。
- 输出视图使用 `↑/↓` 或 `PageUp/PageDown` 滚动、`←/→` 跨前后台任务切换、`End` 恢复跟随、`Esc` 返回列表。
- 前台命令默认保持同步；只有 Agent 明确调用 `background_command_start` 才会后台运行。
- 后台能力提供 `background_command_start`、`background_command_status`、`background_command_output` 和 `background_command_cancel` 四个 Tool；启动时可传可选 `title`，用于列表、输出视图和完成通知，未传时回退到清理后的 Bash 内容。
- 每个 Session 最多同时运行 4 个后台任务；每条任务内存尾部最多 50KB，完整合并输出写入 Session 隔离日志，单文件上限 1GiB。
- 后台任务与主 Agent 共享工作目录；首次启动时会提示并发修改风险。
- `/reload` 会在同一 Pi 进程内重新绑定任务；`/new`、`/resume`、正常退出及扩展失联会终止任务并清理日志。
- 后台任务结束时只向 Agent 发送任务 ID、标题和结果摘要；Agent 忙碌时排入后续 Turn，空闲时自动唤醒，并读取输出继续工作。
- 设置 `backgroundCommands.enabled: false` 可仅关闭并清理后台 Tool，保留阶段一界面和普通 Bash；项目级覆盖只在项目已受信任时生效。
- 当前阶段仍不提供 `Ctrl+B` 动态后台化或 `/tasks` 管理界面。

```json
{
  "backgroundCommands": {
    "enabled": false
  }
}
```

如果另一个 Extension 已接管自定义 Editor，命令状态仍会显示，但按键聚焦会停用并给出警告，避免静默覆盖。

### `usage-analytics.ts`

在本地统计 Tool 与 Skill 的使用频率，不上传提示词、参数或输出，也不会自动卸载任何能力。

- `/usage`：查看摘要
- `/usage tools`：查看 Tool 调用、成功失败和累计耗时
- `/usage skills`：查看 Skill 的显式调用、自动加载推断和曝光次数
- `/usage unused [天数]`：列出保守的卸载候选，默认 30 天
- `/usage export [路径]`：导出 JSON
- `/usage reset`：确认后清空统计

数据默认保存在 `~/.pi/agent/usage-analytics.json`；如果设置了 `PI_CODING_AGENT_DIR`，则保存在该目录。详细口径和限制见 [`docs/usage-analytics-prd.md`](docs/usage-analytics-prd.md)。

### `00-zero.ts`

已将 `pi-zero` 的全部模块迁入本 package：Powerline、工作状态消息、`/context`、Claude Code 风格 Tool 渲染、compact thinking 和 `/transcript`。

- `/powerline [on|off|refresh|preset|placement]`
- `/vibe [theme|off|mode|model|generate]`
- `/context`
- `/ccstyle [on|off|compact|status|panel]`
- `/transcript [status|expand|collapse|turns <n>]`
- `running-commands.ts` 使用 Zero 的 `pre-powerline v1` 插槽；现在插槽宿主也由本 package 内的 Zero 提供。

### `subagent-workbench.ts`

已将 `pi-subagent-workbench` 的 Runtime、ResourceGovernor、RPC 子 Agent、Workflow 和 TUI Workbench 迁入本 package。

- Tools：`subagent_start`、`subagent_workflow`、`subagent_results`、`subagent_cancel`
- `/subagent-workbench open|start|status|close`
- 支持 Direct Subagent、分阶段 Workflow、后台运行、跟进消息和独立视图；每个任务可设置 `thinking`，跟进消息固定复用初始 `cwd`、模型与 thinking。
- 原生全屏路由需要 Pi 宿主支持 `ctx.ui.custom(..., { fullscreen: true })` 与 `aboveStatus` Widget；缺少增强 UI API 时仍使用兼容的编辑器/Footer fallback，但不能保证原生全屏布局。

### `goal.ts`

已将 `pi-agent-goal` 迁入本 package，提供持久化目标、分支感知状态、验收标准、进度/阻塞项和显式 continuation。

- `/goal`、`/goal status`、`/goal start`、`/goal import`、`/goal pause|resume|complete|clear`
- Tools：`get_goal`、`create_goal`、`propose_goal_draft`、`complete_goal`、`update_goal_progress`、`update_goal_graph`

### `memory.ts`

已将 `pi-tsien-memory` 迁入本 package，提供本地 SQLite/FTS5 长期记忆、自动召回、候选审核和遗忘/撤销流程。

- `/memory recent|recalled|review|doctor|forget|undo|on|off|admin on|admin off|admin status`
- 日常 Tools：`memory_search`、`memory_remember`、`memory_update`、`memory_forget`
- 高级 Tools 默认隐藏；`/memory admin on` 临时显示候选审核、撤销、验证、晋升和诊断工具，`admin off` 再隐藏。
- 默认数据目录：`~/.pi/tsien-memory/`
- `pi-dashboard` 与 `pi-knowledge` 保持独立；Memory 的 knowledge bridge 仍是可选协作接口。

迁移后的详细设计和验收材料位于 `/mnt/workspace/lilong/repos/pi-tsien-extension/docs/integrated/`。

## 本地安装

```bash
pi install /mnt/workspace/lilong/repos/pi-tsien-extension
```

也可以临时加载整个 package：

```bash
pi -e /mnt/workspace/lilong/repos/pi-tsien-extension
```

安装或修改后执行 `/reload`。

## 避免重复加载

如果仍存在旧的独立 extension 副本，应先停用它们：

```text
~/.pi/agent/extensions/git-graph.ts
~/.pi/agent/extensions/subagent-sidebar.ts
~/.pi/agent/extensions/context-powerline.ts
```

否则 Pi 可能同时加载两份 extension，重名命令可能显示为 `/git-graph:1`、`/git-graph:2`。当前会话信息侧栏由本 package 的 `extensions/sidebar.ts` 提供。

本仓库不会自动修改或删除其他全局 extension。

## 开发

```bash
npm install
npm run check
```

Pi 会直接加载 `extensions/*.ts`，无需预编译。
