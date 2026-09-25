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
- `F5`：同时刷新主会话当前 context 和完整活动分支历史快照。
- `Ctrl+Y`：把最后一个 BTW 回答复制到主输入框，但不自动提交。

### `git-graph.ts`

使用 `/git-graph [1-2000]` 打开当前 Git 仓库的提交概览浮层，展示本地与远端引用，并自动折叠普通提交。

### `sidebar.ts`

显示当前 Main/Pi 会话的模型、上下文组成、用量和缓存信息，不读取或展示子代理、工作流或子会话状态。

- `/sidebar [show|hide|toggle|close]`
- `Ctrl+Alt+S`：显示或隐藏当前会话信息侧栏

### `context-powerline.ts`

在 Pi footer 中显示当前模型、推理等级、上下文使用量、自动压缩阈值，以及本机 CPU/内存占用。

状态条上的竖线就是「本会话真正会在哪里压缩」，取自与触发方共用的 `resolveCompactionTrigger`（`auto-compact-target` 目标与 pi 的 `window − reserveTokens` 守卫中的最早者），所以它不会再指向压缩永远不会越过的位置；`getCompactionSettings(model)` 带 model，per-model `reserveTokens` override 才生效。

### `running-commands.ts`

在现有 Powerline 正上方统一显示前台 Agent Bash 与显式后台任务，不改变普通 Bash 的前台执行语义。

- 依赖支持 `pre-powerline v1` 插槽的 `pi-zero`；缺少时只禁用命令界面，不影响命令执行。
- 输入框严格为空时按 `↑` 聚焦命令列表；空格、换行、IME 输入或其他内容均保持原编辑行为。
- 输入为空且有运行命令时，`Ctrl+↑/Ctrl+↓` 仍用于浏览输入历史。
- 命令列表使用 `↑/↓` 选择、`Enter` 查看实时输出、`Esc` 返回输入框。
- 输出视图使用 `↑/↓` 或 `PageUp/PageDown` 滚动、`←/→` 跨前后台任务切换、`End` 恢复跟随、`Esc` 返回列表。
- 前台命令默认保持同步；运行中按 `Ctrl+B` 可将原进程转入后台，不会重启命令。只有一个前台命令时直接转换；并行前台命令会先进入命令列表，再对选中项按 `Ctrl+B`。
- 同一能力在 `pi-dashboard` 上以面板按钮提供：运行中的前台命令会出现在 dashboard 的 Background commands 面板中，点 `Move to background` 即转入后台，语义与 `Ctrl+B` 完全一致（不重启进程，被阻塞的 `bash` 立即以 exit 0 返回）。
- live session 页面（dashboard `/live-sessions`）在输入框上方的命令条里，对每条前台命令直接提供「转后台」按钮。这类进程没有 dashboard bridge（`PI_DASH_BRIDGE_SOCKET` 被清空），命令改走已有的 live feature 通道（`live-observer.ts`）：进程发布命令状态快照，并接收同一个适配器的 `background { toolCallId }` 命令。
- 后台能力提供 `background_command_start`、`background_command_status`、`background_command_output` 和 `background_command_cancel` 四个 Tool；启动时可传可选 `title`，用于列表、输出视图和完成通知，未传时回退到清理后的 Bash 内容。
- 每个 Session 最多同时运行 4 个后台任务；每条任务内存尾部最多 50KB，完整合并输出写入 Session 隔离日志，单文件上限 1GiB。
- 后台任务与主 Agent 共享工作目录；首次启动时会提示并发修改风险。
- `/reload` 会在同一 Pi 进程内重新绑定任务；`/new`、`/resume`、正常退出及扩展失联会终止任务并清理日志。
- 后台任务结束时只向 Agent 发送任务 ID、标题和结果摘要；Agent 忙碌时排入后续 Turn，空闲时自动唤醒，并读取输出继续工作。
- 设置 `backgroundCommands.enabled: false` 可仅关闭并清理后台 Tool，保留阶段一界面和普通 Bash；项目级覆盖只在项目已受信任时生效。
- 当前仍不提供 `/tasks` 管理界面；后台任务通过命令列表和四个后台 Tool 管理。

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

### `trajectory-recorder.ts`

记录 Pi 的可复现 Agent 轨迹，供后续质量分析和任务型模型训练使用。

- 记录用户输入、最终 system prompt、system prompt 来源、每次 context、provider payload、assistant 消息、Tool 参数/结果、模型、thinking level、provider effort、usage、错误、压缩和分支事件。
- 默认目录：`/mnt/workspace/lilong/agent/pi-traces/`；可用 `PI_TRACE_DIR` 覆盖。
- 每个 session 按 `sessionId` 和进程分别追加写入 `sessions/<session-id>/events-<pid>.jsonl`，不覆盖历史；工具结果默认不截断。
- 不做凭证或字符串脱敏；provider request/response 的 header 值也完整记录。只做 JSON 序列化处理；`message_update` 和工具流式增量默认不记录，避免数据量失控。
- process-isolated subagent 会通过 `traceContext` 关联父 session、父 Tool call、父 workflow/work/task、当前 workflow、workId、taskId、taskKey、stageIndex 和 foreach iteration；retry 还记录 source work/workflow 与 attempt，子进程轨迹仍写入同一个 trace 根目录的独立文件。`stageIndex`/`iterationIndex` 使用 0-based。
- 记录器写入失败只提示警告，不阻断 Pi 主流程。
- 同时写一份紧凑计时账本（每个模型调用、Tool 调用、Agent run 一行，约 200B），用于 dashboard 的时间分析，避免解析数十 GB 的完整 trace：
  - 默认目录 `/mnt/workspace/lilong/agent/pi/timing/<sessionId>.jsonl`；可用 `PI_TIMING_DIR` 覆盖，或用 `timingEnabled: false` 关闭。
  - `model`：`provider`、`model`、`attempt`、`totalMs`、`ttftMs`（首个流式增量，≈首个 token）、`responseMs`（HTTP 首字节）、`thinkingMs`、`outputTokens`、`reasoningTokens`、`stopReason`、`isError`。
  - `tool`：`toolName`、`durationMs`、`isError`。
  - `run`：`durationMs`（agent_start → agent_settled）、`modelMs`、`toolMs`、`modelCount`、`toolCount`、`turnCount`。
  - 每条记录用 `scope`（`root`/`child`）标记是否为子代理进程，便于 dashboard 避免父子墙钟重复计数。
  - 不记录提示词、Tool 参数或 Tool 输出。
- 扩展修改后执行 `/reload`；当前由用户级 `/home/tsien/.pi/agent/extensions.config.json` 的最后一项加载，以观察其他扩展修改后的最终请求。

### `observation-pack.ts`

把大型工具结果在投影层替换为简短占位符，原始字节归档到本地，需要时用 `obs_recall` 精确分页取回；不改写已存会话历史。

- 默认关闭；在 `~/.pi/agent/observation-pack.json` 设置 `observationPack.enabled: true` 后执行 `/reload` 生效。
- 归档根目录由 `archiveDir` 配置（默认 `/mnt/workspace/lilong/agent/archiv`），可用 `PI_OBSERVATION_DIR` 覆盖；按 session 隔离存放。
- 仅当纯文本非错误结果超过 `thresholdBytes`（默认 10 KiB）时参与；前 `fullSends`（默认 2）次请求发送全量，之后替换为占位符。
- `obs_recall` 仅在启用时注册，避免默认关闭时占用请求里的 tool schema；按 `offset` 分页，起点向后对齐到 UTF-8 字符边界，配合返回的 `next_offset` 连续读取。
- 会话恢复后可继续读取；原生压缩会省略旧工具结果，压缩后不保证仍能发现 observation id。
- `/obs-prune [--days N] [--yes]`：列出或清理过期归档，默认 dry-run，`--yes` 才移入 `.trash`。
- 与 RTK 并存：`bash`/`read`/`grep` 归档的是 RTK 过滤后的文本，`run_code` 等自定义工具归档真原文。

### `tool-result-pipeline.ts`

`tool_result` 这一层的**唯一入口**。RTK 过滤（stage 1）与 bash-digest（stage 2）不再是两个争抢同一钩子的独立扩展，而是同一流水线里显式有序的 stage：

```ts
export const STAGE_ORDER = ["rtk", "bash-digest"] as const;
```

- stage 契约：`(event, ctx) => Promise<{ content } | undefined>`；返回 `undefined` 表示不改写，**每个 stage 必须 fail-open**（内部出错即返回 `undefined`），坏掉的 stage 只会退化成“输出不变”，不会丢工具输出。
- 前一个 stage 的输出喂给下一个，所以 bash-digest 摘要的就是 RTK 过滤后的文本。这个顺序由代码声明、由 `test/tool-result-pipeline.test.ts` 断言，不再依赖 `~/.pi/agent/extensions.config.json` 里 `loadOrder` 的先后（以前只是注释里的一句“排在 RTK 之后”）。
- RTK 的其余界面（8 个 `rtk-*` 命令、`rtk_configure` 工具、系统提示注入、配置、统计）原样保留，由 `registerRtkSurface(pi)` 注册。源码来源与两处命令匹配补丁见 `extensions/tool-result-pipeline/rtk/PROVENANCE.md`。
- 新增机制 = 新增一个 stage，而不是再多一个扩展。

### `bash-digest`（pipeline stage 2）
把超过阈值的 `bash` 输出在进入上下文前改写为一段短摘要，原文按 observation-pack 布局归档，摘要头带 obs id，细节仍可用 `obs_recall` 取回。

- 默认关闭；在 `~/.pi/agent/bash-digest.json` 设置 `enabled: true` 后执行 `/reload` 生效。
- 摘要被当作**索引**而不是替代品：**observation-pack 未启用时本扩展完全惰性**，因为失去召回路径的有损改写不可接受。
- 判定：纯文本、非错误、命令未命中 `excludePatterns`、预清洗后 > `thresholdBytes`（默认 1200 ≈ 300 token）、且代码特征行占比 ≤ `codeDumpRatio`（默认 0.3）。
- 摘要模型由 `digestModel` 指定（默认 `dashscope/qwen3.8-flash`，non-thinking、`temperature=0`），预算按原文比例给（`clamp(0.6 × 原文, 128, 256)`），`timeoutMs` 默认 6000、`maxConcurrent` 默认 2。
- 配置模板在 `config/examples/bash-digest.example.json`；「模型与凭证怎么配、怎么确认真的生效」见 `config/examples/README.md`。凭证走宿主 pi 自己的 provider 配置（通常是环境变量，如 `DASHSCOPE_API_KEY`），dashboard 用法下建议写进 dashboard 的环境文件。
- 采纳还需摘要 < 原文 `maxDigestRatio`（默认 0.6），否则回落原文；任何失败（超时、报错、守卫不过、信号量饱和）一律返回原文，绝不抛错。
- `excludePatterns` 默认排除“列出条目”类命令（`ls`/`find`/`git log`/`grep`/`cat`/`sed`/`head`/`wc` …），按子命令边界匹配，只测真正产出 stdout 的那一段。理由：这些命令的输出就是调用方要的条目集合，**摘要只能靠丢行压缩，而丢掉的行就是丢事实**。实测过一次丢行导致的错误回答。
- 改写形如 `[digest 703 tok -> 60 tok | raw: obs_xxx]` + 摘要正文；同一 `toolCallId` 命中缓存不重复调用。

### `large-read-pack`（pipeline stage 3，**实测否决，默认关闭**）

把过大的 `read` 结果在进入上下文前换成“头部 + 尾部 + observation id”的包，**全文先归档**，所以 `obs_recall` 能把省掉的每一个字节取回来——改写是指针，不是删除。

> **为什么不启用**：离线机会确实有（`read` 占 25.6% of replay，封顶 2000 tok 可去 5.1%），但隔离 A/B 里**反而贵 47%**（质量没退化，6/6 全对）。原因是不对称单价 + 重取率：省下的是**缓存价** token（$0.03/M），被 `obs_recall`/二次 `read` 取回的是**全价**字节（$0.30/M），还多出每请求 ≈$0.004 的固定成本；实测 39.5% 的 >8KB `read` 之后会再读同一路径。细节见 `docs/session-context-token-plan.md` §10。代码与单测保留，改一行配置即可复现该实验。

- **默认关闭**：`~/.pi/agent/large-read-pack.json` 里 `enabled: true` 才生效（`observation-pack` 未启用时仍保持惰性，理由同 bash-digest）。
- 阈值：`thresholdBytes` 8192（只处理大于 8 KiB 的结果）、`headBytes` 6144、`tailBytes` 1500，切口对齐行边界，不会把一行截成两半。
- 守卫 `minSavedRatio` 0.5：包（含头尾样板开销）必须小于原文的一半才改写，否则原文返回；只裁掉一行的情况不会触发。
- 头部带可执行召回指引：`[read-pack 6600 tok -> 1900 tok | kept lines 1-278 and 1033-1100 | omitted lines 279-1032 (18756 bytes, ~4689 tok) | raw: obs_x | retrieve: call obs_recall with {"id":"obs_x","offset":0}]`，中间还有一行显式省略标记。
- 为什么只做 `read`：全量 replay 里 `read` 占 25.6% 的 replay 权重，把 >2000 tok 的 `read` 封顶就能去掉 5.1% of replay（`scripts/context-age-analysis.ts`）。
- 为什么必须在插入时改写：它挂在流水线上（`pi.on("tool_result")`），写进的是会话本身；若改成投影时改写会从改写点起击穿前缀缓存，在 `cacheRead:input = 1:10` 下反而更贵（见 `docs/session-context-token-plan.md` §7/§10）。
- 与 RTK 并存：摘要输入是 RTK 过滤后的文本（已确认 pi 的 `tool_result` handler 是链式生效）；改写后的结果不再触发 observation-pack 的占位符替换。
- 实测（3 天真实数据）：安全口径覆盖 7.0% 的 bash token、摘要路径压缩 88%、bash 总省 6.0%；激进口径（清空 `excludePatterns`）可达 bash 省 ~60% 但有丢行风险。取舍与 A/B 见 `docs/session-context-token-plan.md`。

### `auto-compact-target.ts`

把所有模型的压缩触发点统一到 `min(270000, 0.75 × contextWindow)`，而不是只对 ≥1M 窗口的模型按 50% 触发。

- 覆盖模型窗口差异：1M/1.05M → 270,000；272K → 204,000；262,144 → 196,608；128K → 96,000。
- 触发由扩展调用 `ctx.compact()` 完成；**不改** `settings.json` 的 `compaction.reserveTokens`，因为 pi 用它推导摘要输出预算（`maxTokens = min(0.8 × reserveTokens, model.maxTokens)`），放大它会产生超大输出预算的请求。
- 带 `ctx.isIdle()` 守卫，只在 run 边界（`agent_settled` / `session_start` / `model_select`）真正触发；长自治 run 可能越过目标，pi 内置阈值仍是最后防线。
- 触发点由 `core.ts` 的 `resolveCompactionTrigger` 统一给出（本扩展目标与 pi 守卫取最早者），触发方与所有显示（TUI 状态条、dashboard 状态行）读同一个值；`live-session` 把该值随 `summary_update` 遥测推给 dashboard。
- 可选配置 `~/.pi/agent/auto-compact-target.json`：`targetTokens`、`windowRatio`、`modelOverrides`。

### `live-session.ts`

把本会话桥接到 pi-dashboard 的 `/live-sessions`：订阅 pi 事件、投影快照、按事件流下发增量，并提供 `/ls-*` 命令（导航/分叉、模型与思考等级、abort/compact 等）。

- **完整 summary 只走快照**（connect / resync / `/tree` / fork 才重建），因此**每轮都变的值走事件流**：`summary_update` 只带变化字段（`contextUsage`、`compact`、`status`），registry 就地修补自己的 summary，浏览器同步修补侧栏与页面，不会渲染成转写气泡。
- **状态按真源推导**：`status` 在发布时问 pi 的 `ctx.isIdle()`（覆盖 agent run 与压缩两种忙碌），而不是累积一个由 `agent_start`/`agent_settled` 改写的标志——pi 只在 run 循环结束时发 `agent_settled`，独立压缩（`auto-compact-target` 调 `ctx.compact()`）永远不会有它。
- **命令**：`/ls-navigate`、`/ls-fork`、`/live-session-reload`、`/dashboard-release` 都是**注册的扩展命令**——带 `/` 的文本只有注册过的命令会被 pi 执行（`_tryExecuteExtensionCommand`），pi 自己的内置命令（`/new`、`/compact`）由交互式 editor 分发、走不到 input 文本流，所以 web 侧的按钮必须对应到**注册名**。注意：`/clear`（开新会话）由 `session-aliases.ts` 注册，不是本扩展，但同样是注册命令，dashboard 的「清空」就是发它。
- **状态心跳**：默认每 20s 重算一次，只有与上次发布不同才发补丁（空闲零流量、不动 `lastActivityAt`），任何「本地已停、面板还显示工作中」的漂移 ≤1 个心跳自愈；周期可用 `statusHeartbeatMs` 覆盖。

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

- Tools：`subagent_start`、`subagent_workflow`、`subagent_workflow_control`、`subagent_results`、`subagent_cancel`
- `/subagent-workbench open|start|status|close`
- 支持 Direct Subagent、可恢复的单 task/分阶段 Workflow、后台运行、跟进消息和独立视图；Workflow 默认通过摘要与绝对产物路径交接上下文，支持 `retry_task` 精确重试失败 task，并可显式使用受限 JavaScript 编译动态计划为可持久化结构化定义。每个任务可设置 `thinking`，跟进消息固定复用初始 `cwd`、模型与 thinking。
- 原生全屏路由需要 Pi 宿主支持 `ctx.ui.custom(..., { fullscreen: true })` 与 `aboveStatus` Widget；缺少增强 UI API 时仍使用兼容的编辑器/Footer fallback，但不能保证原生全屏布局。

### `goal.ts`

已将 `pi-agent-goal` 迁入本 package，提供持久化目标、分支感知状态、验收标准、进度/阻塞项、每 20 分钟自动 continuation 和 Agent 可说明原因的暂停。

- `/goal`、`/goal status`、`/goal start`、`/goal import`、`/goal pause|resume|complete|clear`
- Tools：`get_goal`、`create_goal`、`propose_goal_draft`、`complete_goal`、`pause_goal`、`update_goal_progress`、`update_goal_graph`

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

### 独立（standalone）配置

给不接入内部 marketplace（eagleeye-ai-dev）的机器用的最小配置：

```bash
node scripts/pi-extension-sync.mjs --config config/extensions.standalone.json
node scripts/pi-extension-sync.mjs --config config/extensions.standalone.json --apply
```

`config/extensions.standalone.json` 只包含本 package 与 `packages/pi-tsien-web-tools`，不含
`task-pilot`、`security-guard`、`remote-notifications`、`pi-knowledge` 等外部来源。
每个扩展的职责清单见 `pi-dashboard/docs/standalone-install.md` §6「扩展清单」。
`pi-dashboard` 的一键安装脚本会自动应用这份配置，见
`pi-dashboard/scripts/install-standalone.sh`。

扩展自己的配置模板（复制到 `~/.pi/agent/` 后改值）在 `config/examples/`，
例如 bash-digest 摘要模型与凭证的写法见 `config/examples/README.md`。

## 避免重复加载

如果仍存在旧的独立 extension 副本，应先停用它们：

```text
~/.pi/agent/extensions/git-graph.ts
~/.pi/agent/extensions/subagent-sidebar.ts
~/.pi/agent/extensions/context-powerline.ts
```

否则 Pi 可能同时加载两份 extension，重名命令可能显示为 `/git-graph:1`、`/git-graph:2`。当前会话信息侧栏由本 package 的 `extensions/sidebar.ts` 提供。

本仓库不会自动修改或删除其他全局 extension。

## Vendored packages

个别第三方 package 上游存在影响正常使用的缺陷，本仓库保留一份打补丁的副本
放在 `vendor/`，并通过 `extensions.config.json` 的本地路径 source 加载：

- `pi-rtk` — 已**合并进本仓库**（原 `vendor/pi-rtk/` → `extensions/tool-result-pipeline/rtk/`），不再随上游同步；
  源码来源、合并时的改动与两处命令匹配补丁见 `extensions/tool-result-pipeline/rtk/PROVENANCE.md`。
- WebSearch/WebFetch 已改为**自研实现** `packages/pi-tsien-web-tools`（不再加载第三方副本）：
  我们的 DuckDuckGo lite 解析方式、markdown 清理与懒加载；行为与旧副本 A/B 等价（见该包 README）。
  第三方副本 `vendor/pi-web-tools/` 保留作回滚路径，`vendor/pi-web-tools/VENDORED.md` 仍记录其来历；
  `test/pi-web-tools-vendor.test.ts` 继续守护这份回滚副本。
- WebFetch 依赖的 `jsdom` / `turndown` / `@mozilla/readability` / `turndown-plugin-gfm`
  由仓库根 `package.json` 声明，根目录 `npm install` 即可。

守卫测试：`test/pi-rtk-vendor.test.ts`（合并后的命令匹配补丁）、
`test/pi-web-tools-vendor.test.ts`、`test/tool-result-pipeline.test.ts`（stage 顺序与“单入口”契约）。

## 开发

```bash
npm install
npm run check
```

Pi 会直接加载 `extensions/*.ts`，无需预编译。
