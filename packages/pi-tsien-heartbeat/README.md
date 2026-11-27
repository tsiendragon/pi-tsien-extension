# pi-tsien-heartbeat

会话空闲时发一次**极低成本**请求，让主会话的 prompt 缓存不过期。

长会话等待（等子代理、等长实验、等人）时前缀缓存会过期。过期之后下一次真实请求要按
全价重建整份缓存；心跳的做法是空闲时把"主会话最近一次请求的前缀"原样重放一遍，只在
其后追加一条 `Reply with exactly: ok` 的临时 user 消息，让 provider 重新计时并把缓存
写回。实测单次约 **$0.003**（几乎全是缓存重读费）。

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

### 模型 TTL 表

| provider / model | TTL (s) | 推荐间隔 0.8×TTL | 状态 |
| --- | --- | --- | --- |
| `dashscope/deepseek-v4.1-flash` | 2700（45min） | **2160s = 36min** | **实测**：空闲 30min 命中 99.7% / 60min 96% / 120min 30.7% |
| `dashscope/deepseek-*`（其它型号） | 2700 | 2160s | 按同系列实测结论外推 |
| `openai-codex/gpt-6.2-sol` | 1800（30min） | 1440s = 24min | **占位值，待实测确认** |
| `dashscope/kimi-k3.1-pro` | 3600（60min） | 2880s = 48min | **占位值，待实测确认** |
| 其它 / 未知模型 | 1800（30min） | 1440s = 24min | 保守默认，见下 |

查表顺序：`PI_HEARTBEAT_TTL` → 精确 `provider/model` → provider 子串
（如 provider 名含 `deepseek`）→ model id 前缀（如 `deepseek*`）→ 默认 1800s。

### 未知模型：保守默认 1800s

没有 TTL 数据时用 **1800s（30min）**，理由：多数 provider 的 prompt cache 在 5–60min 量级，
30min 既不会早到离谱（早发只是多花几次小钱），也不至于晚到必然过期（那就白开了）。
这个默认值**可以也建议**用 `PI_HEARTBEAT_TTL` 按实测结果覆盖。

### 覆盖优先级

```
1. PI_HEARTBEAT_INTERVAL  显式固定间隔（最高优先级，便于实验/手动调优；模式变成 fixed-interval）
2. PI_HEARTBEAT_TTL       显式指定 TTL，闸门 = 0.8 × 该值
3. 内置 TTL 表            provider/model 查表
4. 默认 1800s             未知模型
```

注意 `PI_HEARTBEAT_MIN_IDLE` 仍在：最终闸门是 `max(0.8×TTL, MIN_IDLE)`，
默认 120s 远小于 0.8×TTL，实际不起作用，但可以防止 `PI_HEARTBEAT_TTL` 被误设成极小时乱发。

## 什么时候该开 / 该关心跳

同时满足才值得开：

1. **等待时间 > TTL**：等待短于 TTL 时缓存本来就没过期，开了只会多花钱。
2. **等待之后还有后续对话**：这是最后一段、不会再回来，那缓存过期也无所谓。
3. **context 足够大（≳ 5–10K token）**：心跳每次要重读整份前缀，
   上下文很小时心跳费可能比重建费还贵。
4. **等待 < 10 × TTL**：更长的等待里 provider 侧本来就有其它淘汰机制，且人也不会守着。

反例：等 90 秒的子代理（< TTL）→ 不开；等 3 小时（> 10×TTL）→ 不如直接接受一次全价重建。


## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PI_HEARTBEAT` | 关闭 | 设为 `1` 启用 |
| `PI_HEARTBEAT_INTERVAL` | 未设置 | **显式固定间隔（秒），覆盖自适应**。不设时才算 `0.8 × TTL` |
| `PI_HEARTBEAT_TTL` | 未设置 | 显式指定 TTL（秒），覆盖内置 TTL 表；闸门仍是 `0.8 × 该值` |
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
           "ttlMatched":"dashscope/deepseek-v4.1-flash",
           "refreshAfterSec":2160,"idleSec":2172},
 "usage":{"input":12,"cacheRead":40123,"cacheWrite":0,"output":2},
 "cost":{"input":0.000001,"cacheRead":0.000401,"cacheWrite":0,"output":0.000001,"total":0.000403},
 "hit":true,"stopReason":"stop","durationMs":840}
```

- `hit` 就是 `usage.cacheRead > 0`：**这一列是判断心跳有没有真的续上缓存的唯一依据**。
- `timing.ttlSource` 取值 `env` / `table` / `provider` / `prefix` / `default`，
  `idleSec` 是发心跳时的实际空闲秒数——用来校核"是不是真的到了 0.8×TTL 才发"。
持续 `hit:false` 说明前缀或 cache key 对不上（见下节排查）。

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

27 个用例（测试用 `PI_HEARTBEAT_INTERVAL` 固定闸门，避免每次等 36min）：

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
   - TTL 查表：`deepseek-v4.1-flash` → 2700s；`deepseek-v4*` 前缀命中；sol/kimi 占位值；未知模型查不到。
   - `未知模型 → DEFAULT_TTL_SEC (1800s)`，来源标为 `default`。
   - `0.8 × TTL` 闸门：deepseek 2160s（36min）、默认 1440s（24min）；且 `闸门 + cadence ≤ TTL`（留余量）。
   - 覆盖优先级：`PI_HEARTBEAT_INTERVAL` > `PI_HEARTBEAT_TTL` > 表 > 默认；非法值（`0` / `-5` / `abc`）忽略；
     `INTERVAL` 模式下 `timing.mode === "fixed-interval"`。
   - 真打到 deepseek 上：30min 时不发、36min+1s 发一次、再 10min 内不重复发；日志 `timing.idleSec ≥ 2160`。
   - 换模型立即生效（deepseek 36min → 未知模型 24min）；定时器 cadence 由 TTL 推出，不是旧的固定 240s。

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

这是本项目的核心实验，由主会话执行。建议三组（用自适应默认，不用固定间隔）：

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

## 已知边界

- **budget 型 thinking 模型**（旧 Anthropic、Bedrock Anthropic）：心跳不带 `reasoning`。
  原因是 pi 的 `streamSimple` 会把 `max_tokens` 抬到 `思考预算 + 答案`，`minimal` 也要
  1024 起，会让单次心跳比省下的钱更贵。心跳只需要触发缓存重读，不需要模型思考。
- **`tools` 复用是按模型缓存的**：换模型后第一次心跳不带 tools（避免把别的模型的序列化
  格式塞进去），下一轮真实请求后自动恢复。
- **只对支持 `payload.tools` 的 provider 生效**；其它协议仍然正确（只是少了 tools 段）。
- **进程退出**：定时器 `unref()`，不会拖住 pi 退出；`session_shutdown` 时清理。