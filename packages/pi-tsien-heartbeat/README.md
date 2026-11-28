# pi-tsien-heartbeat

会话空闲时发一次**极低成本**请求，让主会话的 prompt 缓存不过期。

长会话等待（等子代理、等长实验、等人）时前缀缓存会过期。过期之后下一次真实请求要按
全价重建整份缓存；心跳的做法是空闲时把"主会话最近一次请求的前缀"原样重放一遍，只在
其后追加一条 `Reply with exactly: ok` 的临时 user 消息，让 provider 重新计时并把缓存
写回。实测单次约 **$0.003**（几乎全是缓存重读费）。

> **先看结论（三模型实测）**：心跳**只对"固定 TTL"的 provider 在长等待时有用**。
> deepseek 有效（TTL≈45min，0.8×TTL 续期后 2h 仍 99.4% 命中）；kimi 缓存保留 >2h，
> 基本无需心跳；sol 是**概率性缓存**，实测心跳完全无效，**默认不发送**。
> 细节见[三模型实测对照](#三模型实测对照缓存机制--ttl--心跳是否有效)。

## 三个必须同时成立的正确性条件

| 条件 | 为什么 | 实现方式 |
| --- | --- | --- |
| `sessionId` = 主会话 sessionId | pi-ai 里 `prompt_cache_key = clampOpenAIPromptCacheKey(options.sessionId)`（`openai-completions` / `openai-responses` / `azure-openai-responses` / `openai-codex-responses` 同款），传错就等于另开一份缓存 | 每次都从 `ctx.sessionManager.getSessionId()` 现取 |
| 上下文前缀与主会话一致 | 只有前缀逐字节相同才命中缓存 | 抄真实请求：`systemPrompt` 取 `before_agent_start` 的 `event.systemPrompt`；`messages` 取 `context` 事件的 messages 再 `convertToLlm`；`tools` 取 `before_provider_request` 里已序列化的 `payload.tools`，心跳时用 `onPayload` 原样放回 |
| 不写会话历史 | 心跳消息一旦进历史就会污染下一轮上下文（而且改变前缀，反而让缓存失效） | 走 pi-ai 的 `completeSimple` 直发独立请求，不经过 agent loop/turn；不调用 `sendMessage` / `sendUserMessage` / `appendEntry` |

其它安全约束：

- **只在空闲时发**：`ctx.isIdle() !== true`、或 `ctx.hasPendingMessages()`、或上一次心跳还没回来时跳过。
- **距上次真实活动 ≥ `0.8 × TTL` 才发**（自适应闸门，见下节）；心跳本身也算活动，不会连发。
- **子代理会话不发**：判据与 `pi-tsien-context-slim` 的 `isSubagentProcess` 一致
  （`PI_SUBAGENT_WORKBENCH_CHILD=1` / `PI_TRACE_CONTEXT` 里带 parent 字段 /
  sessionFile 含 `subagent-sessions`）。
- **会话切换丢弃快照**：`sessionId` 变了就清空 messages/tools 快照，避免拿 A 会话的前缀去打 B 会话的 cache key。
- **失败不影响主会话**：全部异常在扩展内部捕获并写日志；失败后按 `cadence × streak` 退避（最多 4 倍），且 `maxRetries: 0`（不重试、不重复付费）。

## 三模型实测对照（缓存机制 / TTL / 心跳是否有效）

三个模型跑的是同一套实验协议：建立上下文后**静置**固定时长，再发一条真实请求，看
`usage.cacheRead` 是否仍覆盖整份前缀（命中率 = 命中次数 / 试验次数）。"心跳组"在
0.8×TTL 处插一次心跳，其余与纯等待组完全相同。

| 模型 | 缓存机制 | TTL | 心跳是否有用 | 依据数据 |
| --- | --- | --- | --- | --- |
| `dashscope/deepseek-v4.1-flash` | **固定 TTL** | **≈45min** | **有用** | 纯等待：30min **99.7%** / 60min **96%** / 120min **30.7%**（明显过期）；心跳组（0.8×TTL≈36min 续期）：120min 仍 **99.4%** |
| `dashscope/kimi-k3.1-pro` | 长保留（固定但很长） | **> 120min** | 基本无需 | 纯等待 120min 后命中率仍 **91.8%**，曲线没掉 |
| `openai-codex/gpt-6.2-sol` | **概率性 / 不稳定**（疑 LRU、容量或路由驱动） | 无固定值 | **无效，不要开** | 纯等待：5min **0%** / 10min **0%** / 15min **53.6%**（**非单调**：5min 比 15min 还差）；15min 时**心跳组与纯等待组命中率完全相同（53.6%）**；心跳请求自身 4 次只有 **1 次**命中 |

三条可操作的结论：

1. **心跳只对固定 TTL 有意义**：cache 命中率随时间单调下降、且在 TTL 内续期能拉回来，
   才有"发一次请求把计时器重置"这回事。deepseek 满足，所以 0.8×TTL 有效。
2. **TTL 很长时心跳没必要**：kimi 保留 >2h，正常会话里的等待（几十分钟）根本等不到过期，
   心跳只会白花一次前缀重读费。默认不关掉（万一真等 3h 还有救），但间隔自动变成 96min。
3. **命中与"写入多久"无关时，心跳必然无效**：sol 的 5min 命中率（0%）低于 15min（53.6%），
   说明淘汰由 provider 侧的 LRU/容量/路由决定，跟"上次写入的时间"没有单调关系。
   对照组已直接验证：心跳组的命中率与纯等待组一模一样，而心跳请求自己还大多 miss。
   **给它发心跳是纯亏损**：付了钱，cacheRead 还可能为 0。

## 缓存类型（cacheKind）：先判类型，再谈间隔

TTL 数值只对"固定 TTL"这一类缓存有意义，所以扩展先判**缓存类型**，再决定要不要发：

| cacheKind | 含义 | 行为 | 归入的模型 |
| --- | --- | --- | --- |
| `fixed-ttl` | 从写入/命中起按固定寿命过期，续期有效 | **正常心跳**，间隔 = 0.8 × TTL | `dashscope/deepseek-*`、**未知模型（保守默认）** |
| `long-retention` | 寿命很长（实测 ≥2h），会话里的等待通常等不到过期 | 不静音，但 0.8×TTL = 96min 才发一次，实际几乎不触发 | `dashscope/kimi-*` |
| `probabilistic` | 命中由 provider 侧 LRU / 容量 / 路由决定，与"上次写入多久"弱相关（甚至非单调） | **默认一律不发**，写一条 `skip` 日志说明原因 | `openai-codex/*`（含 sol）、`openai/*` |

`probabilistic` 的**强制开启**：只有用户显式设了 `PI_HEARTBEAT_TTL=<秒>` 或
`PI_HEARTBEAT_INTERVAL=<秒>` 才放行——这两个变量等于"我知道这类缓存不听话，但我要做实验"。
日志里会记录 `timing.cacheKind`（仍是 `probabilistic`，不会被 env 覆盖改写成 `fixed-ttl`）
和 `timing.forcedBy`（是谁把它打开的）。

未知模型（查表查不到）按 `fixed-ttl` 处理，即**保守地当作"心跳可用"**：
判错成"该发而没发"只会多花一点小钱，判错成"不该发"则会让用户以为开了却在裸奔。
同理 `long-retention` 也不静音——它只是间隔自然很长。

## 间隔自适应：0.8 × TTL

心跳**不是固定周期**，间隔按模型的 prompt 缓存 TTL 推出来：

```
发送闸门 refreshAfter = 0.8 × TTL      # 距上次活动满这么久才发一次
期望心跳间隔         = 0.8 × TTL      # 稳态下就是这个节奏
```

为什么是 0.8：早于 TTL 发，缓存本来就没过期，纯粹白花钱；晚于 TTL 发，缓存已经过期，
续命失败。0.8 留出 20% 余量吸收时钟/网络抖动。

### 为什么改成"TTL 临近才发"而不是固定周期

固定周期会在一个 TTL 窗口里重复发很多次：实测 deepseek TTL≈45min，若用 4min 固定间隔，
每条消息会发 10+ 次心跳，成本同倍放大 10 倍。改成"距上次活动 ≥ 0.8×TTL 才发一次"后：

- 每个 TTL 窗口**最多 1 次**心跳，成本与"空闲时长 / TTL"成正比（而不是与 tick 数成正比）；
- 心跳成功本身就刷新缓存，并把 `lastActivityAt` 推到当下，所以稳态下下一次自然是 0.8×TTL 之后；
- 定时器只是低频"看一眼"（cadence = `clamp(0.1 × TTL, 60s, 300s)`，不花钱），
  发送时刻偏离闸门最多一个 cadence，远小于 20% 的 TTL 余量。

deepseek 例：TTL 2700s → 闸门 2160s（36min）→ cadence 270s（4.5min，纯本地检查）。

### 模型 TTL 表（最终校准值）

| provider / model | cacheKind | TTL (s) | 间隔 0.8×TTL | 心跳 | 依据 |
| --- | --- | --- | --- | --- | --- |
| `dashscope/deepseek-v4.1-flash` | `fixed-ttl` | **2700**（45min） | **2160s = 36min** | **正常发** | 实测：30min 99.7% / 60min 96% / 120min 30.7%；心跳组 120min 仍 99.4% |
| `dashscope/deepseek-*`（其它型号） | `fixed-ttl` | 2700 | 2160s | 正常发 | 同系列外推 |
| `dashscope/kimi-k3.1-pro` | `long-retention` | **7200**（2h，下界） | 5760s = **96min** | 几乎不触发 | 实测 120min 等待后仍 91.8%，TTL **>2h**（真实值只会更长，表里取下界） |
| `dashscope/kimi-*` | `long-retention` | 7200 | 5760s | 几乎不触发 | 同上 |
| `openai-codex/gpt-6.2-sol` | `probabilistic` | 1800（仅标称） | — | **默认不发** | 实测概率性缓存：5/10min 0%、15min 53.6%（非单调）；心跳组 = 等待组 = 53.6%；心跳自身 4 次仅 1 次命中 |
| `openai-codex/*`（其它） | `probabilistic` | 1800 | — | **默认不发** | 同后端，按 sol 结论保守处理 |
| `openai/*`（官方直连） | `probabilistic` | 1800 | — | **默认不发** | provider 侧管理、未实测出固定 TTL；与 sol 同按保守策略，需实测后用 `PI_HEARTBEAT_TTL` 强制 |
| 其它 / 未知模型 | `fixed-ttl` | 1800（30min） | 1440s = 24min | 正常发 | 保守默认，见下 |

sol / openai 系列那一行的 TTL 1800s **不是**"认为它 30min 过期"，而是"若用户强制开启，
按 24min 的间隔发"——因为它们的命中率没有单调结构可拟合，任何 TTL 数字都是标称值。

查表顺序：`PI_HEARTBEAT_TTL` → 精确 `provider/model` → provider 子串
（`deepseek` / `kimi` / `openai-codex` / `openai`，**`openai-codex` 必须排在 `openai` 前**）
→ model id 前缀（`deepseek*` / `kimi*` / `gpt-6.2-sol*` / `gpt-6.2*`）→ 默认 1800s。
`cacheKind` 始终取**查表结果**，不受 `PI_HEARTBEAT_TTL` 影响（否则日志会把 sol 谎报成
`fixed-ttl`，事后无法回溯）。

### 未知模型：保守默认 1800s

没有 TTL 数据时用 **1800s（30min）**，理由：多数 provider 的 prompt cache 在 5–60min 量级，
30min 既不会早到离谱（早发只是多花几次小钱），也不至于晚到必然过期（那就白开了）。
这个默认值**可以也建议**用 `PI_HEARTBEAT_TTL` 按实测结果覆盖。缓存的默认类型也是
`fixed-ttl`：查不到就先当作"心跳可能有用"，宁可多发几次小钱，也不要把用户静音。

### 覆盖优先级

```
0. cacheKind 判据           probabilistic 且没设下面两个 env → 一律不发（最高优先级）
1. PI_HEARTBEAT_INTERVAL  显式固定间隔（便于实验/手动调优；模式变成 fixed-interval）
2. PI_HEARTBEAT_TTL       显式指定 TTL，闸门 = 0.8 × 该值
3. 内置 TTL 表            provider/model 查表（含 cacheKind）
4. 默认 1800s / fixed-ttl 未知模型
```

注意第 0 条压过第 1、2 条**的静音部分，但反过来 1、2 是解除静音的开关**：对
`probabilistic` 模型，只有这两个变量能让心跳真的发出去。

注意 `PI_HEARTBEAT_MIN_IDLE` 仍在：最终闸门是 `max(0.8×TTL, MIN_IDLE)`，
默认 120s 远小于 0.8×TTL，实际不起作用，但可以防止 `PI_HEARTBEAT_TTL` 被误设成极小时乱发。

## 什么时候该开 / 该关心跳

按顺序判，第一条不过就不用往下看了：

0. **该模型的 cacheKind 必须是 `fixed-ttl`**（见上一节）。`probabilistic`（sol / openai 系列）
   不管等多久都不要开——实测心跳组的命中率与纯等待组完全相同，唯一区别是多付了钱。
   `long-retention`（kimi）不必开：TTL >2h，你等的那点时间缓存根本没过期。
1. **等待时间 > TTL**：等待短于 TTL 时缓存本来就没过期，开了只会多花钱。
2. **等待之后还有后续对话**：这是最后一段、不会再回来，那缓存过期也无所谓。
3. **context 足够大（≳ 5–10K token）**：心跳每次要重读整份前缀，
   上下文很小时心跳费可能比重建费还贵。
4. **等待 < 10 × TTL**：更长的等待里 provider 侧本来就有其它淘汰机制，且人也不会守着。

反例：sol 上等 1 小时 → **不开**（心跳无效，纯亏损）；kimi 上等 1 小时 → 不开（没过期，
且 0.8×2h=96min 也还没到）；deepseek 上等 90 秒的子代理（< TTL）→ 不开；
deepseek 上等 3 小时（> 10×TTL）→ 不如直接接受一次全价重建。


## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PI_HEARTBEAT` | 关闭 | 设为 `1` 启用（**`probabilistic` 模型除外，见下两行**） |
| `PI_HEARTBEAT_INTERVAL` | 未设置 | **显式固定间隔（秒），覆盖自适应**。不设时才算 `0.8 × TTL`；对 `probabilistic` 模型它也是**强制开启**开关 |
| `PI_HEARTBEAT_TTL` | 未设置 | 显式指定 TTL（秒），覆盖内置 TTL 表；闸门仍是 `0.8 × 该值`；对 `probabilistic` 模型是**强制开启**开关（只做实验用，日志记 `timing.forcedBy`） |
| `PI_HEARTBEAT_MIN_IDLE` | `120` | 安全下限：距上次真实活动至少多少秒才允许发（自适应下几乎总被闸门覆盖） |
| `PI_HEARTBEAT_MAX_TOKENS` | `16` | 心跳回复上限 |
| `PI_HEARTBEAT_TIMEOUT_MS` | `120000` | 单次请求超时 |
| `PI_HEARTBEAT_DRY_RUN` | 关闭 | `1` = 只写日志不发请求（零成本联调） |
| `PI_HEARTBEAT_VERBOSE` | 关闭 | `1` = 连跳过原因也写日志 |
| `PI_HEARTBEAT_LOG` | `~/.pi/agent/heartbeat.log` | 日志路径 |

## 日志格式

`~/.pi/agent/heartbeat.log`，JSONL，一行一条：

```json
{"ts":"2026-11-27T04:12:00.000Z","event":"heartbeat","seq":3,"mode":"sent",
 "sessionId":"01J...","model":"dashscope/deepseek-v4.1-flash",
 "systemPromptChars":18234,"messageCount":57,"toolsInjected":true,
 "reasoning":"minimal","maxTokens":16,
 "timing":{"mode":"adaptive","ttlSec":2700,"ttlSource":"table",
           "ttlMatched":"dashscope/deepseek-v4.1-flash","cacheKind":"fixed-ttl",
           "refreshAfterSec":2160,"idleSec":2172},
 "usage":{"input":12,"cacheRead":40123,"cacheWrite":0,"output":2},
 "cost":{"input":0.000001,"cacheRead":0.000401,"cacheWrite":0,"output":0.000001,"total":0.000403},
 "hit":true,"stopReason":"stop","durationMs":840}
```

- `hit` 就是 `usage.cacheRead > 0`：**这一列是判断心跳有没有真的续上缓存的唯一依据**。
- `timing.ttlSource` 取值 `env` / `table` / `provider` / `prefix` / `default`，
  `timing.cacheKind` 取值 `fixed-ttl` / `long-retention` / `probabilistic`，
  `timing.forcedBy` 只在"用户强制开启 probabilistic 模型"时出现。
  `idleSec` 是发心跳时的实际空闲秒数——用来校核"是不是真的到了 0.8×TTL 才发"。
- `PI_HEARTBEAT_VERBOSE=1` 时，probabilistic 模型会留下原因日志（不会静默）：

  ```json
  {"event":"skip","reason":"probabilistic-cache","model":"openai-codex/gpt-6.2-sol",
   "cacheKind":"probabilistic","note":"概率性缓存（sol 等）：实测心跳无效且自己要付整份前缀钱，默认不发；确需实验请显式设 PI_HEARTBEAT_TTL=<秒>"}
  ```
- 持续 `hit:false` 说明前缀或 cache key 对不上（见下节排查）；但**在 probabilistic 模型上
  `hit:false` 是常态，不代表配置坏了**。

## 注册

加到 `~/.pi/agent/settings.json` 的 `extensions` 数组：

```json
"/home/user/pi-stack/pi-tsien-extension/packages/pi-tsien-heartbeat/src/index.ts"
```

**建议放在数组最后一项。** `context` 事件的 handler 按注册顺序执行，排最后才能看到前面
扩展（尤其 `pi-tsien-context-slim`）transform 完之后、真正要发给模型的 messages。

同时建议把它加入 `~/pi-stack/pi-tsien-extension/package.json` 的 `pi.extensions` 与
`config/extensions.standalone.json`（本包已加；`settings.json` 属于用户配置，未自动改）。

## 单元测试

```bash
cd ~/pi-stack/pi-tsien-extension
node --import tsx --test --test-reporter=tap packages/pi-tsien-heartbeat/test/heartbeat.test.ts
```

36 个用例（内容类用例用 `PI_HEARTBEAT_INTERVAL` 固定闸门避免等 36min，并钉在查表 miss
的未知模型上，以免被 probabilistic 策略静音；TTL / 缓存类型用例用自适应闸门）：

1. **前缀一致**：心跳 `context.messages` 去掉末尾那条后，与 `convertToLlm(主会话 messages)` 深度相等；
   systemPrompt 用的是 `before_agent_start` 里那份（即使与 `ctx.getSystemPrompt()` 不同）。
2. **cache key 一致**：`options.sessionId === 主会话 sessionId`，且 `clampOpenAIPromptCacheKey` 两边相同。
3. **最低档 thinking**：effort 型模型用 `minimal`；budget 型模型（旧 Anthropic）关掉 thinking（否则 pi 会把
   `max_tokens` 抬到 1024+ 只为拿一个 effort，反而更贵）；非 reasoning 模型不带该参数。
4. **不写历史**：心跳前后快照 JSON 逐字节不变、长度不增；连续两次心跳的消息条数始终是"前缀 + 1"；
   `sendMessage` / `appendEntry` / `registerTool` 一次都没被调用；`context` 与 `before_provider_request`
   的 handler 都返回 `undefined`（只观测不改写）。
5. **开关与空闲**：默认关闭；busy / 有排队消息 / 无快照 / 子代理会话 全部跳过；
   心跳不自触发连发；失败后进入退避且能在退避到期后恢复；`stopReason==="error"` 记为 error 而不是成功；
   dry-run 不发请求只写日志；会话切换丢弃旧快照。
6. **TTL 自适应**：
   - TTL 查表：`deepseek-v4.1-flash` → 2700s；`deepseek-v4*` 前缀命中；kimi → 7200s；未知模型查不到。
   - `未知模型 → DEFAULT_TTL_SEC (1800s)`，来源标为 `default`，cacheKind 为 `fixed-ttl`。
   - `0.8 × TTL` 闸门：deepseek 2160s（36min）、kimi 5760s（96min）、默认 1440s（24min）；
     且 `闸门 + cadence ≤ TTL`（留余量）。
   - 覆盖优先级：`PI_HEARTBEAT_INTERVAL` > `PI_HEARTBEAT_TTL` > 表 > 默认；非法值（`0` / `-5` / `abc`）忽略；
     `INTERVAL` 模式下 `timing.mode === "fixed-interval"`。
   - 真打到 deepseek 上：30min 时不发、36min+1s 发一次、再 10min 内不重复发；日志 `timing.idleSec ≥ 2160`。
   - 换模型立即生效（deepseek 36min → 未知模型 24min）；定时器 cadence 由 TTL 推出，不是旧的固定 240s。
7. **缓存类型 / probabilistic 策略**：
   - 三模型 cacheKind：deepseek `fixed-ttl`、kimi `long-retention`、sol `probabilistic`；
     `openai-codex/*` 与 `openai/*` 都是 `probabilistic`。
   - sol + `PI_HEARTBEAT=1`：空闲 6h、再 6h 都不发；`timing().suppressed === true`。
   - 静音原因**不看 verbose**，也会留下**一次** `event:"skip"`、`reason:"probabilistic-cache"`
     的日志（含 `cacheKind` 与说明），且不刷屏：连续三次 tick 只有一条。
   - `PI_HEARTBEAT_TTL=600` → `suppressed:false`、`forcedBy:"PI_HEARTBEAT_TTL"`、
     `cacheKind` 仍是 `probabilistic`，闸门 480s，到时**真的发出去**且日志带 `timing.forcedBy`。
   - `PI_HEARTBEAT_INTERVAL` 同样能强制开启 probabilistic 模型。
   - `fixed-ttl`（deepseek）照常 0.8×TTL 发；`long-retention`（kimi）不发而且不会被误标成
     probabilistic（skip 原因是 `recent-activity`），超过 96min 闸门后照常发一次。
   - 未知模型：`cacheKind:fixed-ttl`、`suppressed:false`（宁可多发，不要静默）。
   - sol → deepseek 换模型后心跳立刻恢复。

## 真实集成验证步骤（需在主会话执行）

心跳涉及真实 provider 计费与缓存行为，单元测试只能保证"发出去的请求形状正确"，
`hit:true` 必须用真实请求确认。

### 0. 前置

```bash
# 确认当前 pi 版本与 extensions 列表
node -e "const s=require(process.env.HOME+'/.pi/agent/settings.json');console.log(s.extensions.slice(-3))"
```

### 1. 先跑零成本 dry-run

在 `~/.pi/agent/settings.json` 的 `extensions` 末尾加入心跳包路径，然后带 dry-run 启动：

```bash
PI_HEARTBEAT=1 PI_HEARTBEAT_DRY_RUN=1 PI_HEARTBEAT_TTL=60 PI_HEARTBEAT_MIN_IDLE=5 \
  PI_HEARTBEAT_VERBOSE=1 pi
```

在这个会话里随便问一句（让扩展抓到真实前缀），然后静置 60–90 秒（`PI_HEARTBEAT_TTL=60` → 闸门 48s）。期望：

```bash
tail -5 ~/.pi/agent/heartbeat.log
# {"event":"heartbeat","mode":"dry-run","toolsInjected":true,"messageCount":N,
#  "timing":{"mode":"adaptive","ttlSec":60,"ttlSource":"env","refreshAfterSec":48,...}}
```

要检查的点：
- `toolsInjected:true` —— 说明抓到了 `payload.tools`；
- `messageCount` 与你当前上下文的条数相符；
- `sessionId` 与 `~/.pi/agent/sessions/**/<id>.jsonl` 文件名里的 id 一致；
- **会话历史没有变长**：`ls -l` 那个 jsonl 文件，dry-run 期间行数不变
  （dry-run 根本不发请求，这一条主要是确认扩展没有偷偷写 session）。

### 2. 真实发一次

```bash
PI_HEARTBEAT=1 PI_HEARTBEAT_TTL=60 PI_HEARTBEAT_MIN_IDLE=5 PI_HEARTBEAT_VERBOSE=1 pi
```

同样先问一句建立上下文，然后静置。期望日志里出现 `"mode":"sent"` 且 **`"hit":true`**：

```bash
tail -3 ~/.pi/agent/heartbeat.log | python3 -m json.tool --json-lines
```

判据三条：
1. `hit === true` 且 `usage.cacheRead` 与当前上下文体量相当（几万量级）；
2. `cost.total` 在 $0.001–$0.01 量级；
3. **会话文件没多出任何消息**：记录静置前后的行数

   ```bash
   f=$(ls -t ~/.pi/agent/sessions/*/*.jsonl | head -1); wc -l < "$f"   # 静置前
   # ...等心跳发出后再看一次...
   wc -l < "$f"                                                        # 应完全相同
   ```

   > 注意：只要你不输入任何东西，pi 不会写 session；心跳若写历史，行数一定变化。

### 3. `hit:false` 的排查顺序

如果真实请求里 `hit:false`，按下面顺序查（都是"前缀不一致"的具体形态）：

1. **扩展顺序**：确认心跳在 `extensions` 数组最后。若它排在 `context-slim` 前面，
   `context` 事件里拿到的是 transform 之前的历史 → 前缀偏大，必然 miss。
2. **tools 段**：看日志 `toolsInjected`。为 `false` 说明这个 provider/protocol 没在
   `before_provider_request` 里给 `payload.tools`（例如某些 provider 把 tools 放在别的字段），
   此时心跳缺少 tools 段 → miss。
3. **思考内容剥离**：`context-slim` 会剥历史 thinking。心跳拿到的是 transform 之后的
   messages（正确），但若某 provider 在序列化时按模型能力做二次加工，仍可能差几个字节。
4. **模型切换**：换了模型之后第一次心跳若 miss 属正常（tools/prompt 都变了），第二次起应命中。
5. **provider 侧最短缓存寿命**：缓存可能本来就没写成功（例如上下文太短，低于 provider
   的最小可缓存长度）。这种情况 `cacheRead` 恒为 0，不是扩展的问题。

### 4. 长等待对照（30min / 1h / 2h）

这是本项目的核心实验，由主会话执行。**已验证过的结论见
[三模型实测对照](#三模型实测对照缓存机制--ttl--心跳是否有效)**；下面是复现/复测协议。
建议三组（用自适应默认，不用固定间隔）：

```bash
# A 自适应（推荐）：deepseek 闸门 = 36min
PI_HEARTBEAT=1 pi
# B 固定 4min（旧做法，反问对照：确认它真的更贵）
PI_HEARTBEAT=1 PI_HEARTBEAT_INTERVAL=240 pi
# C 对照组：不开心跳，同样时长静置
```

每组的记录项：静置时长、心跳次数（`grep -c '"mode":"sent"'`）、心跳总花费
（`jq -s 'map(.cost.total // 0) | add'`）、**静置后第一条真实请求的 `cacheRead` 与 `cost`**。

预期：C 组静置后的首条请求 `cacheRead≈0`（全价重建）；A/B 组 `cacheRead≈上下文规模`。
并且 A 组的花费应明显低于 B（B 在一个 TTL 窗口里发 9 次，A 只发 1 次）。
若 A 组的 `timing.idleSec` 不是 2160 左右，说明 `PI_HEARTBEAT_INTERVAL` 或 `PI_HEARTBEAT_TTL`
在环境里还有残留，先清掉再测。

在 sol 上复测时**一定先 `PI_HEARTBEAT=0` 做纯等待组**：因为默认策略就把 sol 静音了，
不加 `PI_HEARTBEAT_TTL` 是发不出去的。要复现"心跳对 sol 无用"这个结论，需要对同一等待
时长各跑一组（有/无强制心跳），比较**静置后第一条真实请求**的命中率——已实测 15min 时
两组都是 53.6%，且四次心跳里只有一次命中。

## 已知边界

- **budget 型 thinking 模型**（旧 Anthropic、Bedrock Anthropic）：心跳不带 `reasoning`。
  原因是 pi 的 `streamSimple` 会把 `max_tokens` 抬到 `思考预算 + 答案`，`minimal` 也要
  1024 起，会让单次心跳比省下的钱更贵。心跳只需要触发缓存重读，不需要模型思考。
- **`tools` 复用是按模型缓存的**：换模型后第一次心跳不带 tools（避免把别的模型的序列化
  格式塞进去），下一轮真实请求后自动恢复。
- **只对支持 `payload.tools` 的 provider 生效**；其它协议仍然正确（只是少了 tools 段）。
- **进程退出**：定时器 `unref()`，不会拖住 pi 退出；`session_shutdown` 时清理。
- **sol / openai 系列默认不发心跳**：这是刻意的，不是 bug。日志里 `event:"skip"`、
  `reason:"probabilistic-cache"` 就是预期行为。想验证就显式设 `PI_HEARTBEAT_TTL`。
- **未知模型按 `fixed-ttl` 处理**：查表查不到时不会静音。若某个 provider 其实也是概率性
  缓存，需要把它的 provider/model 加进 `MODEL_TTL_SEC` / `PROVIDER_TTL_SEC` 表，
  而不是靠"默认更保守"来兜（因为保守方向是"发"）。
- **长保留模型不会被静音**：kimi 的闸门是 96min；如果你真的空闲超过 96min 并打算继续对话，
  它会发一次——这是想要的（2h 之后确实可能过期）。