# Changelog

## Unreleased

- **新增独立（standalone）扩展配置**：`config/extensions.standalone.json` 给不接入内部 marketplace 的机器用——只声明本仓库与 `vendor/pi-web-tools`，加载同样 25 个 extension，不含 `task-pilot` / `security-guard` / `remote-notifications` / `pi-knowledge`。配套修掉同步器对 `${EAGLEEYE_AI_DEV_ROOT}` 的硬依赖：该变量改为按需解析，配置未引用时机器上无需存在 `eagleeye-ai-dev`；引用了仍会在缺失时明确报错。验证：`node --test test/pi-extension-sync.test.mjs` **4 pass / 0 fail**（新增 standalone 可直接同步、引用 marketplace 仍报错两条用例）；`node scripts/pi-extension-sync.mjs --config config/extensions.standalone.json --agent-dir /tmp/...` 在无 `EAGLEEYE_AI_DEV_ROOT` 下解析出全部 25 个扩展。入口脚本见 `pi-dashboard/scripts/install-standalone.sh`。

- **修复前台 bash 直接报 `manager.canHandoffForeground is not a function`**：全局 manager 单例在 `/reload` 后会被保留，但它的原型仍属于当初创建它的那个类版本。升级判断靠 `supportsForegroundHandoff` 标记，而该标记在更早的版本里就已经是 `true`，于是新加的 `canHandoffForeground` / `listForeground` 永远拿不到 → 前台 bash 与 dashboard 面板快照一起失去方法（bash 整个不可用）。改为不再信任标记：`getBackgroundCommandManager()` 每次都把实例与它的 registry 重新指向当前类，再跑一次幂等的 `upgradeForForegroundHandoff()`；顺带删掉已无人使用的 `supportsTitles` / `supportsForegroundHandoff` 两个死标记。验证：`tsc --noEmit` 干净；node:test **204 pass / 0 fail**（新增「旧类版本留下的单例会被升级」回归用例，断言实例被复用且新方法齐全）。

- **修复 live session「转后台」会把连接弄断**：live 协议校验在扩展侧还有一份镜像（`extensions/live-session/protocol.ts`），它的 `feature_command` 白名单里只有 `btw`，所以 dashboard 发来的 `background-commands` 命令会被客户端判为非法协议并**主动断开连接**（表现为 dashboard 报 `live_session_disconnected`，而命令根本没到处理函数）。已把镜像与 broker 侧的校验对齐（`{ type: 'background', toolCallId }`，含 256 字符上限与未知 feature 拒绝）。真机验证（新开的 live session 进程）：HANDOFF 返回 `{taskId:'bash-acae', mode:'background'}`、命令转发后快照 `revision 1` 出现 `('bash-acae','background')`、agent 收到 `Command moved to background as task bash-acae`、TUI 状态行从 `⠋ Bash · sleep 240` 变成 `◷ Background · bash-acae`（同 pid，进程未重启）。另外确认 **`/reload` 不会重载扩展代码**：已存在的 live session 进程仍跑旧协议，必须在 dashboard 上重开（新进程）才会生效。

- **live session 页面也能把前台命令转入后台**：dashboard 的 `/live-sessions` 进程没有 bridge socket（`launcher.ts` / `tmux-sessions.ts` 例子清空 `PI_DASH_BRIDGE_SOCKET`），面板那条 `background { toolCallId }` 命令根本到不了它，所以输入框上方的命令条只能在面板里看、不能操作。改为复用已有的 live feature 通道：`background-commands` 成为 `live-observer.ts` 中的一个 live feature，进程启动时把命令状态（前台 + 后台任务，输出尾部截到 2KB——快照会写进会话文件”发布给 dashboard，并用 `registerLiveFeatureCommandHandler` 接收同一个适配器的命令（与 `btw` 同一套写法）。dashboard 侧 `LiveCommandBar` 对每条前台命令显示「转后台」按钮，点击先 `claim` 再经 `feature_command`（feature 白名单新增 `background-commands`）下发；交接语义与 TUI `Ctrl+B`、面板按钮完全一致（进程不重启、被阻塞的 `bash` 以 exit 0 返回、输出与并发上限复用同一实现）。验证：两端 `tsc --noEmit` 干净；扩展 node:test 全量 **203 pass / 0 fail**（新增「live session 发布状态并接受转后台命令」，包含越权命令 `start` 被拒）；dashboard 后端新增 `backend/__tests__/live-session-commands.test.ts` **4 pass / 0 fail**（含空/超长 `toolCallId` 与未知 feature 拒收）；前端 eslint 无问题、`vite build` 通过、既有失败用例数不变（5 条）。

- **dashboard 支持把前台命令转入后台**：dashboard 槽位此前不注册前台接管工具（`running-commands.ts` 里 `isDashboard` 直接跳过注册），因此 dashboard 中运行的 `bash` 由 Pi 内核执行、不进 manager，无法像 TUI 的 `Ctrl+B` 那样转入后台；桥接协议也只允许 refresh/output/cancel。现在 dashboard 槽位同样把前台 bash 交给 manager（`foreground-handoff`），`background-commands` 适配器新增 `background { toolCallId }` 命令，快照同时列出运行中的前台任务（`mode: "foreground"` + `toolCallId`），`pi-dashboard` 面板对前台任务显示 `Move to background`、后台任务保持 Cancel。交接语义与 TUI 完全一致：进程不重启、被阻塞的 `bash` 以 exit 0 返回并提示 Agent 用 `background_command_status`/`background_command_output` 继续，输出文件、并发上限与完成通知全部复用同一实现；manager 未绑定当前 Session 时接管工具自动回退到内置 bash，避免禁用后台命令时 bash 整体不可用。验证：`tsc --noEmit` 干净，`test/background-commands.test.ts` **25 pass / 0 fail**（新增 dashboard 注册、前台任务可见并可转后台、未绑定回退三条用例）。

- **合并 RTK**：`vendor/pi-rtk` → `extensions/tool-result-pipeline/rtk/`，与 `bash-digest` 统一为单一扩展 `extensions/tool-result-pipeline.ts`。该层原来有 3 个扩展同时抢 `tool_result`（RTK、bash-digest、trajectory-recorder），先后只存在于 `extensions.config.json` 的 `loadOrder` 里，bash-digest 的注释自认「排在 RTK 之后」但无任何断言保护。现在：唯一入口 + 显式有序 stage（前一段输出喂给后一段）+ 每段 fail-open（出错只退化为「本段不改写」）+ 单配置。RTK 的 8 个 `rtk-*` 命令、`rtk_configure` 工具、系统提示注入、两处命令匹配补丁全部原样保留（`registerRtkSurface(pi)` + `applyRtkFilters(event, ctx)`）。移入后 `tsconfig` 才第一次真正校验这份代码（`vendor/` 不在 `include` 里），导入说明符改为本仓库的 `@earendil-works/*` / `typebox`。来源与上游同步方式见 `extensions/tool-result-pipeline/rtk/PROVENANCE.md`（不再自动同步，改为手工移植）。证据：`tsc --noEmit` 干净；测试 147 → **161 pass / 0 fail**；真实 `pi -p` 进程里各 stage 均验证生效。见 `docs/session-context-token-plan.md` §9。
- 新增 **`large-read-pack`（pipeline stage 3）**：把过大的 `read` 结果换成「头 + 尾 + observation id」的包，全文先归档、`obs_recall` 可完整取回；`thresholdBytes` 8192、`headBytes` 6144、`tailBytes` 1500（切口对齐行边界）、`minSavedRatio` 0.5 守卫、**默认关闭**（`~/.pi/agent/large-read-pack.json`）。机会量（全量 replay，91,742 请求）：`read` 占 25.6% of replay，把 >2000 tok 的 `read` 封顶可去 5.1%。**结论：实测否决、保持 `enabled: false`**——质量不退化（A/B 6/6 全对），但 treat 中位成本 **+47%**（$0.0113 vs $0.0077）：省下的是缓存价 token（$0.03/M），取回是全价字节（$0.30/M）外加每请求 ≈$0.004 固定成本，且实测 39.5% 的 >8KB `read` 之后会再读同一路径（`scripts/large-read-followup.ts`）。见 `docs/session-context-token-plan.md` §10。
- **修复 `obs_recall` 在大归档上必失败**：召回工具层的硬限制守卫用 `text.split("\n").length` 计量响应行数（含 2 行头部 + 结尾空元素，共 3 行开销），但只预留了 2 行。结果首块行数填满的归档（bash 短行列表、大 `read`）会直接抛 `Recall output exceeded its hard limit`——召回路径在它最该起作用的场景里是坏的（A/B 实测命中，模型只能改用窄范围 `read` 兜底）。修正：预留量抽成 `recallChunkLimits()`（行预留 2+1，字节预留 512）并加回归测试；实测同一归档旧公式响应 401 行（超限抛错）、新公式 399 行（通过）。同时修复 observation-pack 与 bash-digest 的召回。
- `scripts/extension-ab.ts`：arm 补丁支持 `{"files": {"<config>.json": {...}}}` 覆盖任意 per-arm 配置文件（原来只能改 `observation-pack.json`），用于验证 `large-read-pack`。
- `scripts/context-age-analysis.ts` 重写为 replay 口径（`token × 存活请求数`）并修正两处会让结论相反的度量错误：（1）把已被 compaction 丢弃的历史当成仍存活——现在按 `compaction` 的 `summary` / `firstKeptEntryId` 重建活动上下文，总量从虚高的 118B 降到 9.7B；（2）`entry.isDirectory` 漏调用导致扫描 0 个文件。脚本自带两重自校验（`Σ entries×survives` 对 `Σ 每次请求活动消息 token` 必须为 1.00），结论与量级见 `docs/session-context-token-plan.md` §6。
- 结论修正：`bash-digest` 按新口径只值 1.5% of replay（≈0.9% prompt 成本），而**驱逐**方向上限为 34–53% of replay（≈21–33% 成本）；现 `observation-pack`（阈值 10KB、占位符实测 352 tok）只覆盖约 7% 成本，把阈值降到 1600B、摘录降到 250B（占位符 136 tok）可增量 **+20%**。
- 新增 `scripts/auto-compact-cost-analysis.ts` 并复验 auto-compact 触发点（`docs/session-context-token-plan.md` §8）：全量 92,378 请求显示**每 100K token 的边际成本随上下文变长而下降**（$0.0069→$0.0032，命中率 85%→98.9%），每请求成本 ≈ $0.004 固定（全价新内容）+ 上下文 × $0.03/M（缓存价）。因此"上下文老 token 是便宜货"，驱逐类机制亏钱、插入时精简划算；触发点收益从 24.9%（token 口径）下修为 **~10–14%（成本口径）**，方向仍为正。
- 新增 `scripts/extension-ab.ts`：扩展机制 A/B 台架。用 `PI_CODING_AGENT_DIR` + `PI_OBSERVATION_DIR` 把每个 arm 的配置与归档完全隔离（只软链真实配置），headless `pi -p` 跑多 trial，按真实单价（`cacheRead:input` 价差）算成本并把答案落盘供对照 ground truth。踩坑已内置处理：必须用 `--tools` 否则模型走 `run_code` 让机制不触发；`pi -p` 的 stdin 必须 `ignore`。
- **实测否决**"降 observation-pack 阈值"方案（`docs/session-context-token-plan.md` §7）：在隔离 agent 目录 + `pi -p` headless 的 A/B 中，把阈值 10240→1600、摘录 1024→250、`fullSends` 2→1 后，短会话 token −19% 但**成本 +41%**（`dashscope` 的 `cacheRead 0.03 / input 0.30`，投影时改写 `pi.on("context")` 会击穿已缓存前缀，1 个 token 的击穿≈10 个 token 的节省），长会话则**质量失败**（答不出被替换掉的中部细节，control 答对）。正确形态是**插入时精简**（`pi.on("tool_result")`，同 `bash-digest`），不产生击穿。
- 修正 §6 的推断：token 节省不等于成本节省；`cacheRead:input = 1:10` 时该等价关系会被击穿打破。
- 新增 `scripts/observation-pack-placeholder-size.ts`：直接调 `placeholderFor()` 量占位符的真实 token 开销（固定样板 100 tok，摘录按比例），用于给驱逐阈值定档。
- `run_code` 移除时间与次数上限：`maxRunComputeTimeMs` / `maxRunWallTimeMs` / `maxOuterRunCodeCalls` 支持 `null` 表示无限制（哨兵值 2^31-1，避开 Node 定时器/vm 溢出）；`docs/ptc-full-tool-config.json` 已全部设为 `null`，未配置模型也走无限制兜底。嵌套写入/子调用与 assistant token 预算保留。
- 新增 `observation-pack`：把超过阈值的大型工具结果在投影层替换为占位符并归档到本地，`obs_recall` 按需分页取回；默认关闭，且仅在启用时注册 `obs_recall`。
- `trajectory-recorder` 新增紧凑计时账本：每个模型调用、Tool 调用和 Agent run 追加一行约 200B 的记录（`ttftMs`、`thinkingMs`、`totalMs`、`durationMs`、`scope` 等），写入 `/mnt/workspace/lilong/agent/pi/timing/`，供 dashboard 时间分析使用；不记录提示词与 Tool 输出。
- 自动压缩触发点统一为 `min(270000, 0.75 × contextWindow)`，替换只对 1M 窗口生效的 `auto-compact-1m`（`auto-compact-target`）；不改 `compaction.reserveTokens`，因为它同时决定摘要输出预算。
- 新增 `bash-digest`：把超过阈值（默认 1200B ≈ 300 token）的 `bash` 输出改写为短摘要，原文归档并带 obs id 供 `obs_recall` 取回；默认关闭，observation-pack 未启用时完全惰性，任何失败都回退原文。默认排除“列出条目”类命令（`ls`/`git log`/`grep`/`cat`/`sed`…）——实测这些输出被摘要会丢行并导致错误回答；安全口径下 bash token 省 6%，激进口径可到 ~60% 但有质量风险，见 `docs/session-context-token-plan.md`。
- PTC 简化为始终可用的 `run_code` Code Mode：动态组合当前 active tools，移除 `/ptc` 模式切换和独立权限分层，嵌套调用统一复用 Pi 原生工具流水线。
- BTW 历史快照刷新键由 `Ctrl+R` 改为 `F5`，避免与自定义提交键冲突。
- 新增前台 Bash 命令区域，显示本地开始时间、耗时和最多 50KB 的实时输出尾部。
- 输入严格为空时可用方向键聚焦命令、切换输出和控制自动跟随。
- 通过 `pi-zero` 的 `pre-powerline v1` 插槽保持“命令 → Powerline → 输入框”，不覆盖现有 Powerline。
- 新增 4 个显式后台命令 Tool，支持立即返回任务 ID、查询状态、读取有限输出和整组取消；启动时可传人类可读标题。
- 后台日志按 Session 隔离，默认限制 1GiB；内存输出尾部限制 50KB，并在 Session 结束时清理。
- 前后台任务共享方向键列表和输出视图；完成摘要只进入下一次用户 Turn，不主动触发模型。
- 新增 `backgroundCommands.enabled` 回退开关，并支持同进程 `/reload` 任务重绑定。

## 0.3.0

- BTW 打开时继承主 Agent compact 后的当前有效 context。
- 新增只读 `session_history` 工具，按需搜索或分页读取 compact 前的完整活动分支历史。
- `Ctrl+R` 现在同时刷新当前 context 与完整 Session 历史快照。
- 历史查询结果仅在内存中截断，不写入临时文件或主 Session。

## 0.2.0

- 新增 `/btw` 临时侧聊浮窗。
- BTW 读取主 Agent 活动分支的历史快照，但使用独立内存会话。
- BTW 强制只启用 `read`、`grep`、`find`、`ls` 四个只读工具。
- 支持流式回答、取消、历史快照刷新和复制回答到主输入框。

## 0.1.0

- 集中管理 `git-graph` extension。
- 将会话信息侧栏重命名为 `sidebar`，并移除子代理与工作流展示。
- 集中管理 `context-powerline` extension。
