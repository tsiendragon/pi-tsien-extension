# pi-tsien-extension

一组面向 [Pi](https://github.com/earendil-works/pi-mono) 的实用 TypeScript extensions。

## Extensions

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

在 Pi footer 中显示当前上下文使用量、自动压缩阈值和模型上下文窗口。

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

这三个 extension 当前仍保留在：

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
