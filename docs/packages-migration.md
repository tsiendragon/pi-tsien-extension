# packages 迁移（P0 拆包）进度

目标：把 `extensions/**` 里的 24 个扩展 + 共享代码拆成 `packages/pi-tsien-*`（一功能一包），
为公开发布 npm 做准备。**不发布**，本阶段只做仓库内拆分与验证。

## 门禁（每批都要过）

1. `npm run parity:check` —— 25 个条目与迁移前指纹逐条一致（工具 / 命令 / 事件 / 调用签名）
2. `npm run typecheck` —— 干净
3. `npm run test:node` —— 全绿
4. 有确定性逻辑的包，额外做「同输入同输出」字节级对比（例：`capability_ls`）

任何一项不过 → 不进入下一批、不删旧文件。

## 布局约定

- 每包一个入口 `src/index.ts`（`package.json` 的 `pi.extensions` 指向它）
- 包内相对路径**保持原样**（整棵子树一起搬，`extensions/x.ts` + `extensions/x/**` 的相对关系不变）
- 跨包引用一律用**包名**（`pi-tsien-shared/lib/live-observer.ts`、`pi-tsien-shared/auto-compact-target/core.ts`）
- 内部依赖写普通 semver（`^0.1.0`），不用 `workspace:*`（npm pack 会原样保留，发布时会坏）
- 根 `package.json` 用 npm workspaces（`packages/*`）把内部包链接进 `node_modules`

## 共享库 `pi-tsien-shared`

`extensions/lib/**`（14 个文件）+ `extensions/auto-compact-target/core.ts`。
消费方：btw、live-session、running-commands、schedule、subagent-workbench、auto-compact-target、context-powerline + 若干测试。

## 批次与进度

| 批次 | 内容 | 状态 |
|---|---|---|
| 0 | 试点：`session-aliases`、`capability`（含真实执行对比） | ✅ 完成（`1713cb0`） |
| 1+2 | 共享库 `pi-tsien-shared`（lib）+ 15 个单文件/自目录包 | ✅ 完成 |
| 3a | subagent-workbench、btw、running-commands、schedule（有跨包耦合但文件干净） | ✅ 完成 |
| 3b | auto-compact-target、context-powerline、live-session（**被并行会话的未提交改动阻塞**） | ⏸ 等待 WIP 落定 |
| 4 | 本机 live 配置切换（备份 + 外科手术式改 + dry-run 复核 + 保留回滚） | 待办 |
| 5 | 删除 `extensions/lib/live-observer.ts` 兼容 shim、重新抓基线、更新文档与 CHANGELOG | 待办 |

### 批次 3b 的阻塞

`extensions/auto-compact-target/core.ts`（+103 行）、`auto-compact-target.ts`、`context-powerline.ts`、`live-session.ts`、
`live-session/protocol.ts`、`test/auto-compact-target.test.ts`、`test/live-session.test.ts` 有**并行会话的未提交改动**
（证据：改动时间 20:33–21:58，早于本会话的提交；`live-session.ts` 的改动量在两次检查间由 196 行变为 217 行，说明仍在编辑）。
迁移与这些文件无关的部分已完成；涉及它们的部分等 WIP 提交后再做。

### 迁移中修正的 3 个真问题（都是门禁抓出来的）

1. **依赖分析漏边**：初版把 `extensions/` 顶层入口的一切都当"自目录"，漏掉 memory→subagent-workbench、
   tool-result-pipeline→observation-pack、session-ui-fork→default-system-prompt 等跨包依赖（`typecheck` 报 TS2307）。
2. **改写顺序**：先移动文件再改写引用 → 旧路径已不存在、解析失败（0 处改写）。改为先改写后移动。
3. **入口选错**：memory 的附属目录里 `src/index.ts` 是**库 barrel**（不是扩展工厂），真实入口是 `src/extension/index.ts`
   —— 由 `parity:check` 抓出（该条目注册为 0 个工具/命令）。

## 命名映射（批次 1）

| 旧 | 新包 |
|---|---|
| `extensions/lib/**` + `extensions/auto-compact-target/core.ts` | `pi-tsien-shared` |
| `extensions/compact-continue.ts` | `pi-tsien-compact-continue` |
| `extensions/default-system-prompt.ts` | `pi-tsien-default-system-prompt` |
| `extensions/effort.ts` | `pi-tsien-thinking-level` |
| `extensions/git-graph.ts` | `pi-tsien-git-graph` |
| `extensions/metrics-sidebar.ts` | `pi-tsien-metrics-sidebar` |
| `extensions/sidebar.ts` | `pi-tsien-sidebar` |
| `extensions/usage-analytics.ts` | `pi-tsien-usage-analytics` |
| `extensions/prompt-inspector.ts` | `pi-tsien-prompt-inspector` |
| `extensions/trajectory-recorder.ts` | `pi-tsien-trajectory-recorder` |