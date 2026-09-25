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
| 3b | auto-compact-target、context-powerline、live-session | ✅ 完成（WIP 先单独落成 `1bdd902`，再迁移） |
| 4 | 本机 live 配置切换 | ✅ 完成（见「live 切换记录」） |
| 5 | 删除兼容 shim、重新抓基线（新路径）、更新文档与 CHANGELOG | ✅ 完成 |

### 批次 3b 的处理（WIP 如何落地）

那批未提交改动是「把压缩触发阈值抽成共享 resolver」（`core.ts` 新增 `resolveCompactionTrigger`，
`auto-compact-target` / `context-powerline` / `live-session` 的状态行都画同一条线，live-session 协议上报各候选人）。
处理方式：先把它**单独提交**为 `1bdd902`（当时门禁已全绿：typecheck + 246 测试 + parity 25/25），
再做迁移，这样迁移 diff 干净、也能单独 review/改写。

### 最终形态

`extensions/` 目录已清空；25 个扩展 + 共享库全部在 `packages/pi-tsien-*`。
包入口：多数是 `src/index.ts`，memory 是 `src/extension/index.ts`（其 `src/index.ts` 是库 barrel）。
跨包依赖（写进各自 `dependencies`）：shared ← live-session / running-commands / schedule / side-chat / subagent-workbench / auto-compact / context-powerline；
memory → subagent-workbench；rtk-fork → observation-pack；session-ui-fork → default-system-prompt；subagent-workbench → trajectory-recorder。

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
## live 切换记录（批次 4）

- 备份：`~/.pi/agent/settings.json.pre-packages-migration-20260926-001541`、同后缀的 `extensions.config.json`
  （第一次尝试的备份 `...-001446` 也保留）。
- 改动：按「旧路径 → 新路径」映射替换 `settings.json` 的 `extensions`（24 条改写，4 条外部条目原样保留）、
  重建 `packages[]`；`extensions.config.json` 的 loadOrder 改写 25 条、保留 knowledge / remote-notifications / security-guard；
  **不改动顺序、不碰 marketplace 插件条目**（避免触发无关的 quarantine）。
- 复核 1（同步器 dry-run）：只剩迁移前就存在的 `auto extension - security-guard.ts -> quarantine`，无其它漂移。
- 复核 2（live 真机 `pi -p`）：25 个扩展全部从 `packages/*` 加载（TOTAL 1835ms），`capability_ls` 返回 `classify-text`、
  `WebSearch` 返回 `Pi Coding Agent / https://pi.dev/`；`memory_doctor` 未出现在工具列表属**预期**（它是「高级工具」，由 `advancedToolsEnabled` 控制）。
- 顺带修掉一个**试点阶段引入的回归**：live 里 `session-aliases.ts` / `capability.ts` 两条仍指向已搬走的旧文件
  （试点只改了仓库配置、没同步 live），本次一并修正。同时把 3 个旧包 id（`web-tools`/`session-aliases`/`capability`）
  统一成目录名，消除「id ≠ 目录」的隐患。
- 回滚：把上述备份复制回 `~/.pi/agent/` 即可。

## 校验入口

```bash
npm run parity:capture   # 抓当前布局的指纹基线
npm run parity:check     # 与基线逐条比对（不一致 exit=1）
```
基线已按新布局重抓（`test/fixtures/extension-parity-baseline.json`，25 条目全在 `packages/*`）。
