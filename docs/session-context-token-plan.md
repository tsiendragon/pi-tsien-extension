# batch 压缩落地实施方案（bash 摘要 + 统一压缩触发）

状态：**A 已落地并实测收敛到安全口径；B 已落地生效**；配套分析见 `docs/session-context-token-analysis.md §7`
日期：2026-09-19（三轮 A/B 后更新）

## 0. 结论先行

| 项 | 状态 | 实测 |
|---|---|---|
| B 统一压缩触发 | ✅ 已落地 + sync | 12 单测；`tokensBefore` 待真实会话复核 |
| A bash 摘要机制 | ✅ 已落地，正确性与失败降级已验证 | 147 单测；真模型端到端 smoke PASS |
| A 的收益天花板 | ⚠️ **远低于早前预测** | 安全口径只覆盖 **7.0%** 的 bash token → bash 省 **6.0%** |
| 激进口径 | ❌ **不采用** | 覆盖 71.5%、bash 省 59.9%，但**实测丢行导致 1 次任务答错** |
| 需要你决策 | 🔸 是否接受激进口径的质量换收益 | 见 §5 |

早前"总上下文 −51%"的预测**不成立**，原因写清楚在 §1.6：那 51% 里绝大部分来自"条目列表"，而条目列表的摘要会丢行。

---

## 1. 方案 A：bash 摘要

### 1.1 注入点

`pi.on("tool_result")`，与 RTK 同层但 loadOrder 更靠后。

已在 pi 源码确认（`dist/core/extensions/runner.js`）：`tool_result` 的多个 handler 是**链式**的，前一个返回的 `content` 会写回 event 再传给下一个。所以：
- 摘的是 **RTK 过滤后**的文本；
- handler 抛错会被 runner 捕获（额外一层保险），且自身仍全程 fail-open。

`run_code`（PTC）不改：3 天实测它只占上下文 2.2%。

### 1.2 判定规则（最终版）

```
digest 当且仅当：
  1. isBashToolResult && !isError && content 全为 text
  2. 命令未命中 excludePatterns（默认排除"列出条目"类命令，见 1.5）
  3. preclean 后字符数 > thresholdBytes（默认 1200 ≈ 300 token）
  4. 不是源码 dump：代码特征行占比 <= codeDumpRatio（默认 0.3）
  5. 信号量未饱和
采纳摘要还需：
  6. 摘要 token < maxDigestRatio(0.6) × 原文 token，否则回落原文
```

`excludePatterns` 按**子命令边界**匹配，只测真正产出 stdout 的那一段（`outputProducerCommands`）：
`python3 s.py | head -20` → 产出段是 `head`；`cat f | grep x` → 产出段是 `grep`，`cat` 只是喂数据。

### 1.3 处理流程

```
原始文本 → preclean → 判定 → 归档(obs id) → digest 模型 → 大小守卫
  采纳 → content = [digest 头 + 摘要]，usage 记入 tool result
  任一环节失败/超时/守卫不过 → 原样返回（fail-open），归档保留
```

改写形如：

```
[digest 2500 tok -> 70 tok | raw: obs_xxxx]
<摘要正文>
```

硬约束：**observation-pack 未启用时本扩展完全惰性**——没有 `obs_recall` 召回路径的有损改写不做。

### 1.4 提示词与 API 坑

- 目标 40 token；预算按原文比例给（`resolveMaxTokens`：`clamp(0.6 × 原文, 128, 256)`），否则长列表会被 `maxTokens` 截断成静默丢行。
- 规则要点：错误/警告/路径/数字/计数/版本/hash/名字 **always keep**；列出条目时"保持原顺序、整条缩短、不许用子集或 and more 代替"；散文/样板/进度/重复前缀 always drop。
- `temperature=0`、`samplingParams: { enable_thinking: false }`。
- **API 坑**：`streamSimple` 传 `reasoning: "minimal"` 会让 dashscope 适配器发 `reasoning_effort`，与 `enable_thinking:false` 冲突报 400。不传 `reasoning`。

### 1.5 配置（`~/.pi/agent/bash-digest.json`）

```json
{
  "enabled": true,
  "thresholdBytes": 1200,
  "targetTokens": 40,
  "maxTokens": 128,
  "timeoutMs": 6000,
  "maxConcurrent": 2,
  "digestModel": "dashscope/qwen3.8-flash",
  "codeDumpRatio": 0.3,
  "maxDigestRatio": 0.6,
  "excludePatterns": [
    "^(ls|find|tree|du|df|grep|rg|ag|ack|wc|head|tail|cat|sed|awk|cut|sort|uniq|jq)\\b",
    "^git\\s+(log|show|status|diff|shortlog|blame)\\b",
    "^pip\\s+(list|show)\\b"
  ]
}
```

`excludePatterns` 的语义：**这些命令的语义就是"把条目列出来"，调用方要的是条目集合本身，摘要只能靠丢行来压缩，而丢掉的行就是丢事实**。用户可清空该数组切到激进口径（风险见 §1.7）。

### 1.6 实测：三种口径的取舍

真实 3 天数据离线回放 + 生产提示词实测（`scripts/bash-digest-replay.ts`、`scripts/bash-digest-measure.ts`）：

| 口径 | bash token 覆盖 | 摘要路径压缩 | bash 总节省 | 估算总上下文 | 质量 |
|---|---|---|---|---|---|
| 激进（无排除、原提示词） | 71.5% | ~92% | **59.9%** | ~40% | ❌ 实测丢行答错 |
| 行保留提示词 + 无排除 | 71.5% | 85.5% | 59.9% | ~40% | ❌ 模型不总遵守"不许丢行" |
| 形状规则（短行占比 ≥0.7 排除） | 18.5% | ~88% | ~15.7% | ~10% | 未 A/B（启发式边界噪声大） |
| **安全（默认排除命令）** | **7.0%** | **88.2%** | **6.0%** | **~4%** | 未观察到失败；且 A/B 任务全被排除，行为与 OFF 构造性一致 |

要点：**这套工作流里的大块 bash 输出，绝大多数本身就是条目列表或文件内容**，不是可安全摘要的冗长日志。所以"便宜又安全"的池子只有 7%。

摘要自身开销：`qwen3.8-flash`，延迟 p50 3.4s / max 5.7s（超时 6000ms），156 次/3 天，≈ $0.02/3 天。对照 bash 命令均耗时 26.9s，延迟占比可忽略。

### 1.7 A/B 实证（3 轮，子 Agent 进程隔离，配置开关对照）

任务（输出 2.1–3.7KB，介于摘要阈值与 RTK 截断之间，干净隔离变量）：T1 `git log --format='%h %ad %s' -100` 问第 37 行 hash；T2 `ls -la extensions` 问 .ts 数与目录数；T3 `grep -rn 'pi.on('` 问次数 top2。

| 轮次 | 配置 | T1 | T2 | T3 |
|---|---|---|---|---|
| OFF 基线 | 摘要关闭 | ✓ 602cd08，2 次 bash | ✓ 23/11，1 次 | ✓ 11/10，1 次 |
| ON-1 | 行保留提示词（无排除） | ✓ 602cd08，2 次 bash **+2 次 obs_recall** | ✓ 23/11，1 次 **+1 次 obs_recall** | ✓（code-dump 跳过，未摘要） |
| ON-2 | 同上（含"原顺序不丢行"） | ✓ 602cd08，1 次 bash **+1 次 obs_recall** | ✓ 23/11，1 次 **+1 次 obs_recall** | — |
| ON-3 | 同上 | ❌ **无法确定**（摘要被压成"前 20 行 + …and 23 more commits"） | ✓ 23/11，1 次 **+1 次 obs_recall** | — |

判定依据：`obs_recall` 次数来自 observation-pack 的 **ledger**（客观），不是子 Agent 自述。

两类问题分别定性：
- **T1 ON-3 是真失败**：摘要丢行导致"第 37 行"不可得，召回后仍未答出 → 直接违反"任务通过率不下降"。
- **T2 是谨慎性召回**：摘要已验证**完整保留 36 个名字 + 目录 `/` 标记**（.ts=23、目录=11 都能数出来），Agent 仍去读原文。所以"召回次数"不能单独当质量指标。

安全口径下这三个任务的命令全部命中排除规则 → 不摘要 → 行为与 OFF 基线在构造上完全相同，ON-3 那类失败不可能发生。

### 1.8 风险与兜底

| 风险 | 兜底 | 状态 |
|---|---|---|
| 摘要丢关键行 | 原文归档 + `obs_recall`；大小守卫 | 已实测能兜住"摘要过小"，**兜不住"丢行"** |
| 丢行导致答错 | 默认排除条目类命令 | ✅ 已修 |
| 长尾延迟 | `timeoutMs` 6000 + fail-open | ✅ |
| 并行 bash 打爆限流 | `maxConcurrent` 信号量，饱和跳过 | ✅ |
| 摘要调用出错 | 一律返回原文，绝不抛错 | ✅ |

---

## 2. 方案 B：统一压缩触发目标（已落地）

### 2.1 目标规则

```
targetTokens = min(270000, floor(0.75 × contextWindow))
```

| 模型窗口 | 触发目标 | 原生阈值（window − reserveTokens） |
|---|---|---|
| 1,048,576（deepseek-v4.1-flash / kimi-k3） | 270,000 | 1,026,576 |
| 1,050,000（azure-okx/gpt-5.6-luna） | 270,000 | 1,028,000 |
| 1,000,000（qwen3.8-flash） | 270,000 | 978,000 |
| 272,000（openai-codex/gpt-5.6-luna） | 204,000 | 250,000 |
| 262,144（dsw/deepseek_v41_flash，reserveTokens 32768） | 196,608 | 229,376 |
| 128,000（qwen3-coder-plus） | 96,000 | 106,000 |

所有窗口下新目标都低于原生阈值 → 扩展先触发，原生阈值只是最后防线。

### 2.2 为什么不用 `compaction.reserveTokens`

pi 用它推导摘要输出预算：`maxTokens = min(0.8 × reserveTokens, model.maxTokens)`。设 `reserveTokens = 778576` 会得到 `maxTokens = 384000`，每次压缩都发一个 38 万输出预算的请求。因此触发点交给扩展 `ctx.compact()`。

### 2.3 已观察到的行为差异（重要）

本次会话在 `dsw/deepseek_v41_flash`（262,144）上压缩，`tokensBefore = 229,660` ≈ 原生阈值 229,376 —— 说明当时新扩展**尚未加载**。加载后该模型会在 **196,608** 触发，比现在早约 33K。这是预期行为（小窗口按比例收敛），但属于行为变化，需要你知悉。

### 2.4 已知限制

`ctx.isIdle()` 守卫使压缩只在 run 边界触发；长自治 run 可能越过目标。原生阈值仍是最后防线。

---

## 3. 实施与复现

| 步骤 | 内容 | 状态 |
|---|---|---|
| S1 | 方案文档 | ✅ |
| S2 | B：`resolveTargetTokens` + 全模型扩展 | ✅ 12 单测 |
| S3 | A：`extensions/bash-digest/`（core / model / index） | ✅ 25 单测 |
| S4 | 离线回放 + 生产提示词实测 | ✅ 三口径实测 |
| S5 | A/B 能力 gate | ✅ 3 轮（发现并修掉丢行失败） |

`extensions/tool-result-pipeline/bash-digest/model.ts` 是扩展与测量脚本**共用的唯一模型调用路径**，保证"测的就是跑的"。

```bash
cd <repo>
npx tsc --noEmit
npx tsx --test test/*.test.ts                        # 152 pass / 0 fail
npx tsx scripts/bash-digest-replay.ts 3              # 覆盖率与判定分布
npx tsx scripts/bash-digest-measure.ts 3 30 4        # 生产提示词真实压缩比
npx tsx scripts/bash-digest-measure.ts 3 12 3 --bucket=1000-3000 --dump
npx tsx scripts/bash-digest-smoke.ts                 # 真模型端到端 smoke
```

---

## 4. 未验证

- **安全口径下没有跑过 A/B**（论证见 §1.7：测试任务全被排除，与 OFF 构造性等价）。
- `python3`/`echo` 打印的表格类输出仍可能被摘要（命令规则拦不住），存在同类丢行风险；形状规则可作为补充，但其阈值边界噪声大，未采用。
- B 的 `ctx.isIdle()` 限制未做长自治 run 实测。
- 生产环境真实召回率与真实压缩比：observation-pack ledger 已记录 recall，但 digest 事件未单独记账，无法直接算 `recall/digest` 比率。若要测量需在归档时补一条 ledger（约 5 行）。

---

## 5. 需要你决策

> §1–§4 的数字是旧口径（按"占上下文比例"估），已被 §6 的 replay 口径修正。
> 方向性结论仍成立，但量级要按 §6 读。

1. ~~是否采用激进口径（清空 `excludePatterns`）~~：**已不成立**。按 §6 重算只有 15.4% of replay
   （≈9.7% 成本），远小于原先估的 59.9%。
2. 若保持安全口径：接受 bash-digest 只值 **1.5% of replay ≈0.9% 成本**——机制正确但收益很小，不建议再投入。
3. 是否要我用形状规则替代/叠加命令规则：收益上限也在个位数百分比，建议**放弃**，除非要与 P1 一起做。
4. ~~按 §6 改做驱逐方向~~：**§7 已实测否决**。
   - ~~P1 降 observation-pack 阈值~~ → A/B 实测**成本 +41%**（短会话）+ **质量失败**（长会话），见 §7。
   - ~~P2 驱逐老 tool-call 参数~~ → 同属投影时改写，会踩同一个缓存击穿坑。
5. **是否做 §7.6 的方向**（推荐）：把"插入时精简"（`pi.on("tool_result")`，与 bash-digest 同层）
   从 bash 扩到 `read` 等大结果——不击穿缓存，省下的是从未进过上下文的 token。需要单独 A/B。

---

## 6. 重新评估：真正的杠杆是"驱逐"不是"压缩"（全部历史实测）

日期：2026-09-19 追加。脚本：`scripts/context-age-analysis.ts`（`npx tsx scripts/context-age-analysis.ts`）

### 6.1 两个方法论修正（都是我自己踩的坑，先记下来）

**修正一：口径。** 我前面一直用"占上下文的比例"衡量收益。但真实成本是
**token × 它在上下文里存活了多少次请求**（replay 次数）。早上产生的一条结果会被重放上百次，
末尾产生的只重放几次——用"占比"排序会得出错误结论。

**修正二：session 文件不等于上下文。** session jsonl 记录的是完整历史树，但 pi 实际发送的只是
**最近一次 compaction 边界之后的活动链**。直接线性扫描文件会把早已被压缩掉的历史算成"还活着"，
总量可以虚高约 10 倍（实测 SUM 从 118B 掉到 9.7B）。脚本现在按
`compaction`（`summary` + `firstKeptEntryId`）重置活动集，并自校验：

```
Σ 每次请求的活动消息 token  = 9,642,735,940
Σ entries token × survives  = 9,726,939,696     比值 1.009  ✅
```

两个量在数学上必须相等，1.009 说明重建的上下文是对的。第二个对照：
上面的 9.64B 是真实 prompt 15.29B 的 **63%**，剩下 37% 是系统提示 + 工具定义（本估算不含）。

### 6.2 全量实测

967 个文件 / 948 个有 usage 的 session / **91,742 请求 / 15.29B prompt token**。
Token 结构：cacheRead **91.4%** / input 7.7% / cacheWrite 0.9%。

按 replay 加权的来源分布：

| 来源 | replay 份额 | 备注 |
|---|---|---|
| assistant | **36.9%** | 实测其中 **91.1% 是 tool-call 参数**，思考 7.3%、正文 1.6% |
| read 结果 | **25.8%** | live 体积最大（40.1M tok） |
| bash 结果 | 23.3% | |
| compaction 摘要 | 5.0% | 527 次，摘要平均 ~6.5K tok，且会被后续请求一直重放 |
| background_command_output | 1.7% | |
| bash(error) | 1.2% | |
| 其余（user/knowledge/edit/WebFetch/…） | 各 <1% | |
| **工具结果合计** | **57.1%** | 其余 42.9% 是 user+assistant+摘要 |

工具结果的 replay 体积分布（决定 eviction 阈值该定在哪）：

| 大小区间 | replay 份额 |
|---|---|
| ≤150 tok | 5.8% |
| 150–400 | 9.5% |
| 400–1000 | 19.1% |
| **1000–2500** | **45.1%** |
| 2500–8000 | 12.5% |
| >8000 | 8.1% |

### 6.3 驱逐上限（原文可 `obs_recall` 取回）

把 age > k 的工具结果换成 P token 占位符：

| keep-age | 占位符 40 | 120 | 250 | 400 |
|---|---|---|---|---|
| 0 | **52.8%** | 47.2% | 40.4% | 34.5% |
| 1 | 52.0% | 46.5% | 39.8% | 34.0% |
| 2 | 51.3% | 45.8% | 39.2% | 33.4% |

（表内为"省下的 replay 占全部 replay 的百分比"）

**关键：与 keep-age 几乎无关**（0→2 只差 1.5pp）。说明 replay 体积绝大部分在高龄段——
"早就用完、却一直在被重放"的内容。这正是 eviction 成立的原因。

换算成 **prompt 成本**要乘消息占比 0.63：
占位符 120 tok → **29.7% 的 prompt 成本**；250 tok → 25.5%；40 tok → 33.3%。

#### 6.3.1 占位符实际开销（实测，不是估算）

`npx tsx scripts/observation-pack-placeholder-size.ts`——直接调 `placeholderFor()` 量真实渲染结果：

| 配置 | 固定样板 | 摘录 | 合计 | 占 4000 tok 原文 |
|---|---|---|---|---|
| 当前 `excerptBytes=1024` | 100 tok | 252 tok | **352 tok** | 8.8% |
| `excerptBytes=320` | 100 tok | 72 tok | 172 tok | 4.3% |
| `excerptBytes=250` | 100 tok | 36 tok | **136 tok** | 3.4% |

**固定样板就是 100 token**（8 行文字），这是每个占位符的成本下限。
小结果必须算这笔帐：300 tok 的原文换成 160 tok 占位符只省 47%，500 tok 省 68%，1000 tok 省 85%。
所以阈值不能降太低——低于 ~400 tok 就开始亏。

按实测占位符 136 tok 逐桶重算（阈值 1600B ≈ 400 tok，跳过 150–400 桶）：

| 桶 | replay 份额 | 平均原文 | 占位符后保留 | 净省 |
|---|---|---|---|---|
| 400–1000 | 19.1% | ~700 | 19% | 15.4% |
| 1000–2500 | 45.1% | ~1600 | 9% | 41.0% |
| 2500–8000 | 12.5% | ~4200 | 3% | 12.1% |
| >8000 | 8.1% | ~15000 | 1% | 8.0% |
| 合计 | 84.8% | | | **43.7% of all replay ≈ 27.5% 成本** |

而**当前配置**（阈值 10240B ≈ 2560 tok，占位符 352 tok）只覆盖 `>2500` 两桶：
20.6% of tool replay × ~95% ≈ **11.2% of all replay ≈ 7.0% 成本**。

**所以 P1 的增量 = 27.5% − 7.0% = 约 +20% 成本**（实测口径）。

对照（同口径）：bash-digest 安全口径 **1.5%** of replay（≈0.9% 成本），
激进口径 **15.4%** of replay（≈9.7% 成本）。

### 6.4 结论

1. **压缩方向（bash-digest）天花板是个位数百分比**，不值得继续投入；已完成的部分保留。
2. **驱逐方向上限 34–53% of replay（21–33% 成本）**，而且 observation-pack 已经是这个机制——
   只是阈值定在 10KB。
3. 现配置（`thresholdBytes` 10240 ≈ 2560 tok、占位符实测 **352 tok**（1024B 摘录 + 100 tok 固定样板）、
   `fullSends` 2）只覆盖了 `>2500` 那两格（20.6% of tool replay ≈ 11.2% of replay ≈ 7.0% 成本）。
4. 次大杠杆：老 assistant 消息里的 **tool-call 参数**（占全部 replay ~33%）——目前没有任何机制处理。
   典型是 `run_code` 的整段程序、`write` 的整段文件内容，执行完就永久留在上下文里。
5. 新发现：**compaction 摘要本身占 5.0% replay**。摘要平均 ~6.5K tok 且会一直重放——
   这说明"更早/更频繁压缩"不是免费的，调 §2 触发点时要一起算。

### 6.5 建议（优先级）——⚠️ 已被 §7 的实测否决，保留在此仅作记录

> **§7 实测结论：P1（降 observation-pack 阈值）成本反而 +41%，且有质量失败。**
> 本节表格里的"成本"口径是错的：它假设 token 省多少、成本就省多少。
> 真实价格是 `cacheRead 0.03 / input 0.30`（**10 倍**），而投影时改写会击穿缓存。
> 正确的判断见 §7。下面保留原表仅用于对照。

| 优先级 | 动作 | 原预计（错） | 代码量 |
|---|---|---|---|
| ~~P1~~ | ~~调 observation-pack：阈值 10240→1600、摘录 1024→250~~ | ~~+20%~~ | ~~配置~~ |
| P2 | 老 tool-call 参数瘦身 | +15~19% | 新机制 |

---

## 7. 实测否决 P1：投影时改写会在 10 倍缓存价差下亏钱，且有质量风险

日期：2026-09-19。实验目录 `/tmp/p1-ab`（隔离方法见 §7.1），两个 arm 各自独立配置。

### 7.1 隔离实验方法（可复现，不碰线上配置）

已固化为脚本：`npx tsx scripts/extension-ab.ts --task <prompt.txt> --trials 3 --arm control --arm treat:<patch.json>`
——它会自动建隔离目录、跑 trial、按真实单价算成本，并把答案写到 `<root>/<arm>/answer-<trial>.txt` 供对照 ground truth。
arm 规格 `name:<patch.json>` 里的字段会合并进 `observationPack`。

关键能力：`PI_CODING_AGENT_DIR` 可整体重定向 agent 配置目录，`PI_OBSERVATION_DIR` 重定向归档目录，
`pi -p` 是 headless 模式，`--tools` 可限定工具集。

```bash
# 两个 arm：除 observation-pack.json 外全部软链到真实 agent 目录
mkdir -p /tmp/p1-ab/{control,treat}/agent
for f in ~/.pi/agent/*; do b=$(basename "$f")
  case "$b" in sessions|observation-pack.json) continue;; esac
  ln -sfn "$f" "/tmp/p1-ab/$arm/agent/$b"; done
# control = 线上配置(10240/1024/2)；treat = P1(1600/250/1)

PI_CODING_AGENT_DIR=/tmp/p1-ab/treat/agent PI_OBSERVATION_DIR=/tmp/p1-ab/treat/archiv \
  pi -p --session-dir /tmp/p1-ab/treat/sessions \
     --model dashscope/deepseek-v4.1-flash --thinking high --tools read,bash,obs_recall "<task>"
```

**两个踩坑**：
1. 不加 `--tools` 时，模型会用 `run_code`（PTC）把整件事写在代码里执行，根本不产生 `read` 工具结果，
   observation-pack 完全不触发（ledger 为空），实验直接失效。跑机制类 A/B **必须用 `--tools` 限定工具集**。
2. 用 `child_process` 起 `pi -p` 时，stdin 必须显式 `ignore`（脚本里已处理）：stdin 是打开的管道时
   `pi -p` 会一直等输入，表现为挂死。

**第三个坑（更贵）**：任务设计要防止模型把多步合成一批并行工具调用。第一版长任务里
模型把 30 次工具调用压进 3 个请求，年龄跨度根本不够，实验等于没做。需要"每轮只做一个动作"的
逐轮追加（`pi -c`）或天然串行的任务。

### 7.2 实验一：短会话（12–15 请求），恢复手段允许

任务：顺序 read 5 个 ~780 token 的文件（每个读完跑一次 `wc -l`），最后回答 3 个值 +
一字不差贴出某个早期文件的中部某行。文件里的事实放在 60% 位置，避开占位符的首尾摘录。

| trial | control prompt | treat prompt | control cost | treat cost |
|---|---|---|---|---|
| 1 | 201,041 | 156,380 | $0.0154 | $0.0163 |
| 2 | 206,334 | 163,111 | $0.0126 | $0.0179 |
| 3 | 178,273 | 176,130 | $0.0120 | $0.0183 |
| **中位** | **201,041** | **163,111（−19%）** | **$0.0126** | **$0.0178（+41%）** |

质量：6/6 全部答对（含"一字不差"那行），ledger 显示 treat 归档 6 个结果、56–64 条占位事件。

**token 少了 19%，钱多了 41%。** 拆解（中位）：

| 分项 | control | treat | 变化 | 单价 | 成本变化 |
|---|---|---|---|---|---|
| input（全价） | 14,974 | 26,972 | **+80%** | 0.30/M | **+$0.0036** |
| cacheRead | 177,408 | 135,808 | −23% | 0.03/M | −$0.0012 |
| output | 2,358 | 4,676 | **+98%** | 1.20/M | **+$0.0028** |
| 合计 | | | | | **+$0.0052** |

两个原因，缺一不可：
1. **缓存击穿**（主因）。observation-pack 挂在 `pi.on("context")`——**投影时**改写，
   会话历史里是原文、发出去的却是占位符。上下文一变，provider 的前缀缓存从改写点起全部失效，
   那部分 token 从 0.03/M 涨到 0.30/M。**1 个 token 的击穿 ≈ 10 个 token 的节省。**
2. **输出变多**。原文没了，模型改用重新 read 来拿"一字不差"的行（tool_calls 15/15/16 vs control 12/13/11），
   多出来的工具调用与思考让 output 翻倍。

对照：**bash-digest 挂在 `pi.on("tool_result")`——插入时改写**。精简后的内容一进上下文就是最终版，
之后每次请求都命中缓存，**零击穿**。这是两个机制的本质区别，收益模型完全不同。

### 7.3 实验二：长会话（24–25 请求，10 次 `pi -c` 逐轮追加），禁止重读

同样两个 arm。treat 的结果：

- **control：答对了**——给出 `MK-FILE01-5001`，并准确说明在第 117 行。
- **treat：答不出来**——原话："之前对 f01.md 的读取结果过大，只保留了开头一小段…我从未把
  `MK-FILE01-5001` 读进上下文；…必须重新读文件——你禁止了重读，所以我只能如实说：无法提供，不会编造。"

也就是说，在 1600B/250B/fullSends=1 下，一条中部的细节**不可恢复**，而模型并没有想到用
`obs_recall`（它想去 grep / 重读）。这轮 treat 成本低 13%（$0.0160 vs $0.0184），但**质量是失败的**。

### 7.4 结论

1. **P1 否决**：降 observation-pack 阈值在短会话是**成本 +41%**，在长会话是**质量失败**（省 13%）。
2. 根因不是阈值本身，而是**机制层**：投影时改写 vs 插入时改写。在 10 倍缓存价差下，
   任何"改写已经在上下文里的内容"的机制都要先付 9 倍溢价。
3. §6 的"驱逐上限 34–53% of replay ⇒ 21–33% 成本"**不成立**——那个换算假设 token 与成本等比例，
   而击穿会打破这个假设。§6 的**token**质量分布仍然有效（它描述的是体积，不是钱）。
4. 顺带否定了 §6 的 P2 形态："驱逐老 tool-call 参数"同样是投影时改写，会踩同一个坑。
   **正确形态是插入时精简。**

### 7.5 修正后的方向

| 方向 | 机制层 | 是否击穿缓存 | 说明 |
|---|---|---|---|
| ❌ 降 observation-pack 阈值 | `context` | 是 | §7.2/§7.3 已否决 |
| ✅ **插入时精简 `read` 等大结果** | `tool_result` | 否 | 与 bash-digest 同层，省下的是"从未进过上下文"的 token |
| ⚠️ 现有 observation-pack | `context` | 是 | 只在结果**很大**（≥10KB）时才回本：改写一次亏 9×尾部，
  之后每轮省 (原文−占位符)。粗算盈亏平衡 ≈ 剩余 35+ 请求。**建议维持或提高阈值，不要降。** |
| ✅ auto-compact 触发点 | 无改写 | 否 | §2 已完成，不受本结论影响 |

### 7.6 下一步（待验证）

**插入时精简 `read` 结果**的 A/B：在 `pi.on("tool_result")` 里把超过阈值（如 8KB）的 `read` 结果
截断为"首尾保留 + obs id"，原文归档可召回。验收：成本下降且"一字不差"类任务不退化。
注意 `read` 原文是后续 `edit` 的输入，截断要保留足够上下文，且必须实测编辑类任务。

---

## 8. 复验 auto-compact 触发点：方向对，量级腰斩（全量 92,378 请求）

日期：2026-09-20。脚本：`scripts/auto-compact-cost-analysis.ts`（全部历史，92,378 请求 / 15.38B prompt token / 记录成本 $799.87）

§2 那个"524K→270K 触发减 24.9%"是 **token 口径**。按 §7 的教训（token ≠ 钱）复验：

### 8.1 上下文越贵？不，是"新内容"贵

| prompt 大小 | 请求数 | $/请求 | $/100K token | cacheRead% |
|---|---|---|---|---|
| <100K | 27,917 | $0.00442 | **$0.0069** | 85.0% |
| 100–200K | 36,261 | $0.00844 | $0.0058 | 89.3% |
| 200–270K | 14,890 | $0.01178 | $0.0051 | 91.6% |
| 270–400K | 9,351 | $0.01318 | **$0.0041** | 94.4% |
| 400–530K | 3,492 | $0.01809 | $0.0040 | 93.3% |
| >530K | 467 | $0.01802 | $0.0032 | **98.9%** |

**每 100K token 的边际成本随上下文变长而下降**（$0.0069 → $0.0032），因为命中率从 85% 升到 98.9%。
拟合出来每请求成本 ≈ **$0.004（固定，全价的新内容）+ 上下文 × $0.03/M（缓存价）**。

推论：**上下文里"老"的 token 只值 0.03/M，是便宜货；贵的是每轮新产生的全价内容。**
这同时解释了 §7 为什么"驱逐"亏钱（搬走的是便宜 token）、而"插入时精简"划算（省掉的是贵 token）。

### 8.2 compaction 事件的实际代价

| 相对 compaction 的位置 | 请求数 | prompt 中位 | cacheRead% | $/请求 |
|---|---|---|---|---|
| −3 / −2 / −1 | ~523 | 218K–222K | 90.6–92.1% | $0.0118–0.0129 |
| 0（触发那次） | 485 | 225,686 | 93.2% | $0.0113 |
| **+1（压缩后第一次）** | 519 | **53,979** | **16.4%** | **$0.01414** |
| +2 | 517 | 57,686 | 74.3% | $0.0059 |
| +3 / +4 / +8 | ~510 | 60K–72K | 81–85% | $0.0047–0.0053 |

**压缩后第一次请求反而比压缩前更贵**（$0.0141 vs $0.0129）——整段新前缀全价输入，命中率掉到 16.4%。
大约 3 轮后缓存放热，之后每请求成本降到压缩前的 **~40%**。
所以一次 compaction ≈ 一次性 $0.014 的击穿 + 一条常驻摘要；后者体量很小（6.5K tok × 0.03/M）。

### 8.3 修正后的量级

| 触发点 | 超过它的请求 | 占请求数 | 占 prompt 成本 |
|---|---|---|---|
| 200K | 28,200 | 30.5% | 46.3% |
| **270K** | 13,310 | 14.4% | **24.4%** |
| 400K | 3,959 | 4.3% | 9.0% |
| 530K | 467 | 0.5% | 1.1% |

把触发点从 524K 降到 270K，省的不是 24.9% 的**成本**，而是：

```
被削掉的 token 基本都是 cacheRead 价（0.03/M）
原换算用了混合均价（0.052/M）
→ 成本收益 ≈ 24.9% × (0.03 / 0.052) ≈ 10–14%
```

**结论：auto-compact 触发点方向正确、仍然在赚钱（是全项目目前最大的已验证正收益杠杆），
但量级从 24.9% 下修到 ~10–14%。** 压缩次数翻倍带来的额外代价可忽略
（527 次 × $0.014 击穿 ≈ $7，相对 $800 总量 <1%）。

### 8.4 修正后的杠杆排行（成本口径）

| 杠杆 | 成本收益 | 状态 |
|---|---|---|
| auto-compact 触发点 524K→270K | **~10–14%** | ✅ 已上线，§8 复验方向正确 |
| 插入时精简 `read`（§7.6） | ~9–12%（预估） | ⏳ 待 A/B |
| bash-digest（安全口径） | ~0.9% | ✅ 已上线 |
| 降 observation-pack 阈值 | **−41%（亏）** | ❌ §7 已否决 |

---

## 9. `tool_result` 层合并为单一流水线（结构重构，行为零变化）

§7 的结论是"要在**插入时**（`pi.on("tool_result")`）改写，不要在**投影时**（`pi.on("context")`）改写"。据此下一个机制（插入时精简 `read`）也要挂在同一层。但这一层当时已经有 3 个扩展同时抢 `tool_result`：

1. `vendor/pi-rtk/index.ts`（改写）
2. `extensions/bash-digest.ts`（改写）
3. `extensions/trajectory-recorder.ts`（只记账）

它们的先后**只存在于** `~/.pi/agent/extensions.config.json` 的 `loadOrder` 数组里，bash-digest 的注释自认"排在 RTK 之后"，没有任何测试或断言保护；再加一个机制就是第四个扩展，顺序继续靠人记。

### 做法

合并为单一入口 `extensions/tool-result-pipeline.ts`：

```
extensions/
  tool-result-pipeline.ts                 # 唯一 tool_result 入口 + 顺序编排
  tool-result-pipeline/
    rtk/                                  # 原 vendor/pi-rtk（MIT，见 PROVENANCE.md）
    stages/bash-digest.ts                 # 原 extensions/bash-digest.ts 的钩子体
    bash-digest/{core,model}.ts           # 原 extensions/bash-digest/
```

- stage 契约：`(event, ctx) => Promise<{ content } | undefined>`，`undefined` = 不改写；流水线逐段链式传递，前一段的输出即后一段的输入。
- 顺序由 `export const STAGE_ORDER = ["rtk", "bash-digest"]` 声明，`test/tool-result-pipeline.test.ts` 断言。
- 每个 stage fail-open：抛错只退化为"本段不改写"，不丢工具输出。
- RTK 只把 **tool_result 钩子体** 摘成 `applyRtkFilters(event, ctx)`，其余界面（8 个 `rtk-*` 命令、`rtk_configure` 工具、`before_agent_start` 系统提示、配置、metrics）由 `registerRtkSurface(pi)` 原样注册。
- 移入后 `tsconfig` 才第一次真正类型检查这份代码（此前 `vendor/` 不在 `include` 里），导入说明符改为本仓库的 `@earendil-works/*`、`typebox`，相对导入补 `.ts` 后缀。

### 证据（"行为零变化"）

- `npx tsc --noEmit` 干净（`vendor/` 时期从未通过这一关）。
- `npx tsx --test test/*.test.ts`：147 → **152 pass / 0 fail**（新增 5 条契约测试：单入口、RTK 在流水线内仍生效并第一个执行、顺序与 `STAGE_ORDER` 一致、8 命令 + `rtk_configure` 未丢、无关工具/小输出不改写）。
- `pi-extension-sync` 已 apply 并复验一致；配置侧只做了三件事：删 `rtk` package 与它的 `loadOrder` 条目、删 `extensions/bash-digest.ts` 独立条目、在 RTK 原位置加入 `extensions/tool-result-pipeline.ts`。

### 下一步

同一流水线加 `largeReadPack` stage（即 §7.6 的 A：`read` 结果超阈值时保留头尾 + obs id，原文归档可召回），用 `scripts/extension-ab.ts` 隔离 A/B 判收益（真实单价口径）。

---

## 10. 实测否决 large-read-pack：省的是缓存价，取回是全价，40% 的大 `read` 会被再读

§9 建好流水线后，按计划加 stage 3（`read` 结果超阈值 → 保留头尾 + obs id，全文归档可召回）。**结论：离线机会很大，但线上是亏的；代码保留、默认关闭，不作为降本机制启用。**

### 离线机会（全量 replay，91,742 请求）

| `read` 封顶 | 超过的条目 | 省 replay | 占全部 replay |
|---|---|---|---|
| 500 tok | 19,011 | 1,442,388,817 | 14.7% |
| 1000 tok | 12,921 | 923,394,523 | 9.4% |
| **2000 tok（≈默认配置）** | 4,647 | 500,068,172 | **5.1%** |
| 4000 tok | 1,872 | 242,163,494 | 2.5% |

`read` 本身占 25.6% of replay，所以只看这张表，封顶 2000 tok 该值 ~2.5% 成本。

### 隔离 A/B（3 trial × 2 arm，`scripts/extension-ab.ts`，只给 `read` + `obs_recall`）

任务：读一个 26 KB / 1100 行的文件，回答第 1000 行的 key（落在被省略区），答案 `QPQX-3333`。

| 轮次 | arm | req | prompt | cost | 答对 |
|---|---|---|---|---|---|
| run1（召回有 bug） | control | 2–5 | 33–82K | $0.0054–0.0119 | 3/3 ✓ |
| run1 | treat | 4–5 | 52–78K | $0.0040–0.0085 | 3/3 ✓ |
| **run2（修复后）** | control | 3–4 | 57–68K | **中位 $0.0077** | 3/3 ✓ |
| **run2** | treat | 3–5 | 43–98K | **中位 $0.0113（+47%）** | 3/3 ✓ |

- 质量没有退化（6/6 全对），宿主里 stage 确实生效：`[read-pack 6600 tok -> 1953 tok | kept lines 1-256 and 1038-1100 | omitted lines 257-1037 (18768 bytes, ~4692 tok) | raw: obs_...]`
- treat 变贵的原因不是模型变笨，而是它把省略区**重新拉了一遍**：`recalled=3/1/3`（旧版召回坏掉时改为 `read offset=990 limit=30` 兜底——说明"藏起来"并不阻止它去取回，只是换了工具和更多轮次）。

### 为什么必然亏：单价不对称 + 重取率高

- 省下的 4,700 tok/次是**已经在上下文里、按缓存价计价**的 token（$0.03/M）；被 `obs_recall` 或二次 `read` 取回的字节是**全价新内容**（$0.30/M），差 10 倍。§7 的结论在这里以另一种形式复现。
- 更贵的是**请求数**：每个请求有 ≈$0.004 的固定全价成本（§8），treat 多 1–2 个请求就吃掉全部节省，还倒亏。单次大读的节省上限 ≈ 4,700 tok × 后续请求数 × $0.03/M ≈ **$0.0007**，而多一轮的成本 ≈ **$0.008**，差一个数量级。
- 重取率实测（`scripts/large-read-followup.ts`，全量 969 文件 / 778 个含大 `read` 的 session）：**5,447 个大 `read`（>8KB）中 2,154 个（39.5%，字节口径 38.5%）之后又读了同一路径**，受影响者平均 5.66 次跟进读；40.2% 的 session 至少出现一次。
- 期望值：`0.4 × (−$0.008) + 0.6 × (+$0.0007) ≪ 0`。

### 留下的东西

- **代码保留、`enabled: false`**（`extensions/tool-result-pipeline/stages/large-read-pack.ts` + 8 条单测）：它是这个结论的证据工件，也让"再想一遍这个主意"变成改一行配置就能复现的实验。
- **真正的修复**：A/B 顺带查出 `obs_recall` 在"首块行数填满"的归档上**必然抛 `Recall output exceeded its hard limit`**（守卫按 `text.split("\n").length` 计量，含 2 行头部 + 结尾空元素共 3 行开销，却只预留 2 行）。这影响 bash-digest 和 observation-pack 的全部大归档召回，已修（`recallChunkLimits()` + 回归测试）。
- **可推广的规律**（本项目降本的第 3 条硬约束）：**省的是缓存价，取回是全价——任何"把可能还要用的数据藏起来"的机制都要先量重取率**。要么别生成（保存原文就没有的东西），要么只对"确定不再需要"的部分做有损处理（如 bash-digest 只摘要一次性的大日志）。
