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

### `subagent-sidebar.ts`

显示子代理与 workflow 的运行状态、工具活动、上下文和用量信息。

- `/subagent-sidebar [show|hide|toggle|close]`
- `Ctrl+Alt+S`：显示或隐藏侧边栏

### `context-powerline.ts`

在 Pi footer 中显示当前模型、推理等级、上下文使用量、自动压缩阈值，以及本机 CPU/内存占用。

### `usage-analytics.ts`

在本地统计 Tool 与 Skill 的使用频率，不上传提示词、参数或输出，也不会自动卸载任何能力。

- `/usage`：查看摘要
- `/usage tools`：查看 Tool 调用、成功失败和累计耗时
- `/usage skills`：查看 Skill 的显式调用、自动加载推断和曝光次数
- `/usage unused [天数]`：列出保守的卸载候选，默认 30 天
- `/usage export [路径]`：导出 JSON
- `/usage reset`：确认后清空统计

数据默认保存在 `~/.pi/agent/usage-analytics.json`；如果设置了 `PI_CODING_AGENT_DIR`，则保存在该目录。详细口径和限制见 [`docs/usage-analytics-prd.md`](docs/usage-analytics-prd.md)。

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

以下三个 extension 当前仍保留独立副本：

```text
~/.pi/agent/extensions/git-graph.ts
~/.pi/agent/extensions/subagent-sidebar.ts
~/.pi/agent/extensions/context-powerline.ts
```

在正式启用本 package 前，应先停用这些独立副本，否则 Pi 会同时加载两份，重名命令可能显示为 `/git-graph:1`、`/git-graph:2`。

本仓库创建过程不会自动修改或删除现有全局 extension。

## 开发

```bash
npm install
npm run check
```

Pi 会直接加载 `extensions/*.ts`，无需预编译。
