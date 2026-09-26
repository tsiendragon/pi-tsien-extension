# 效率机制技术方案设计（RTK 对齐 + SoL-Pi 借鉴）

状态：**设计；S0–S3 已完成，扩展已于 2026-09-15 在用户级配置中启用**
范围：`<repo>`
参考：NVIDIA `NVlabs/SoL-Pi`（MIT，基于 Pi 公开扩展 API）、已安装的 `npm:pi-rtk`
本地 API 基线：`@earendil-works/pi-coding-agent` 0.85.1（`>=0.84.2`）

> 修订记录
> - r1：初稿（RTK 对照、P0 方案、Action Fusion 借鉴、待决问题）
> - r2：收敛三项决策 —— 归档根目录改为配置、保真度选「接受」、`run_code` 结果纳入归档；§6 改为「已决记录」
> - r4：完成 S2 小样本 A/B，补充 §8.1 实验结论
> - r3：采纳 `sol-medium` 独立复核结论 —— 每请求开销控制、TTL 改手动清理、收窄压缩承诺、offset 字符边界、session 路径安全校验、措辞修正

---

## 1. 结论先行

| 问题 | 结论 |
|---|---|
| 已装的 RTK 是否等价 P0（ObservationPack） | **不等价，方向互补**。RTK 在「产出时刻」有损压缩工具结果；ObservationPack 在「重放时刻」归档 + 占位召回。RTK 已覆盖 SoL-Pi idea C11，P0 对应 C23/C24，仍缺。 |
| Action Fusion 是否有可借鉴设计 | **有，且价值主要在工程设计而非功能**。功能与本地 `extensions/ptc.ts` 的 `run_code` full 模式高度重叠，不建议重复造；其并发守卫、终态标记契约、fail-open、继承内置工具定义四点值得吸收。 |
| 是否实施 | 本次不写代码。本文件为待评审方案。 |

---

## 2. RTK 现状（已安装）

- 位置：`~/.pi/agent/npm/node_modules/pi-rtk`（`pi-rtk@0.1.4`，Matt Cowger，MIT）
- 加载：`~/.pi/agent/extensions.config.json` 的 `loadOrder` 第 2 项（**早于所有 tsien 扩展**）
- 机制：`pi.on("tool_result")` handler **返回 `{content}` 补丁**进行**有损**改写（非就地改写入参）
- 覆盖范围：**仅** `isBashToolResult` / `isReadToolResult` / `isGrepToolResult` 三类；自定义工具（含 `run_code`）**不被改写**
- 技术集合：ANSI 剥离、硬截断、源码过滤（minimal 去注释 / aggressive 只留签名）、smart truncation（头尾保留）、build/test/linter 聚合、git 紧凑、search 分组
- 能力副作用（真实存在）：`sourceCodeFiltering` 在**删改目标文本时**可能导致 edit 精确文本匹配失败，因此 RTK 自行向 system prompt 注入提示，要求失败时用 `rtk_configure` 临时关掉再重读。这是「为省 token 而可能损失能力」的典型，需在验收里设能力下限。

RTK 的落点是「第一次进入 prompt 前的体积」，不含「同一条结果在后续每次请求里反复重放」的问题。

---

## 3. 机制对照与职责边界

| 层 | 机制 | 落点 | 是否已有 | SoL-Pi idea |
|---|---|---|---|---|
| 产出层 | RTK（有损过滤） | `tool_result` | ✅ 已装 | C11 |
| 重放层 | ObservationPack（归档 + 占位召回） | `context`（投影层） | ❌ 缺 → 本方案 A | C23/C24 |
| 委托层 | Evidence-Preserving Reducer | 子代理结果 | ❌ 缺（另案） | — |
| 上下文层 | Online Context Compact（经济性门控） | 压缩触发 | 🟡 半有 | C1/C6 |
| 工具层 | Action Fusion（edit/write + then_run） | `registerTool` | 🟡 被 PTC 覆盖 | — |

四原则（沿用 SoL-Pi，与 marketplace 规则一致）：不打 Pi 补丁；显式 opt-in 默认关；证据必须保留；鉴权/模型/URL/shell 归 Pi 管。

---

## 4. 方案 A：`extensions/observation-pack.ts`（P0）

### 4.1 目标与能力边界（r3 收窄）

大工具结果只在最初若干次请求里带全量，之后在**投影层**替换为短占位符；归档字节按稳定 id 落盘；Agent 需要时用 `obs_recall` 精确分页取回。

**明确保证**：不修改已存会话历史；**已知 observation id 时**，会话恢复（resume）后仍可读取。

**明确不保证**（r3）：原生压缩会从活动上下文省略旧 toolResult，而占位符只存在于临时投影、**不写入历史**，因此**不保证压缩后模型仍知道 observation id**。压缩摘要由存储历史（全量）生成，故**摘要质量不受本机制影响**；需要长期留存的结论应写入 memory/goal，而非依赖 `obs_recall`。

### 4.2 触发与判定（`pi.on("context", handler)`）

`ContextEvent.messages: AgentMessage[]` → 返回 `{ messages }` 替换本次 provider payload。

对每条消息：
1. 仅处理 `role === "toolResult"` 且 `!isError` 且 `content` 全为 text（`isPureTextResult`）。**不按工具名白名单**，因此 bash/read/grep/`run_code` 等一律适用。
2. 若文本含 reducer 收据标记（`sol_pi_evidence_receipt_v1`）→ 跳过，避免二次压缩已验证证据。
3. `bytes = Buffer.byteLength(text,"utf8")`；`bytes <= thresholdBytes` → 跳过（默认 10 KiB，可配）。
4. `contentHash = sha256(text)`；`id = "obs_" + sha256(toolName + "\0" + toolCallId + "\0" + contentHash).slice(0,24)`。

**id 语义（r3 修正）**：id 由「调用标识 + 内容指纹」派生，是**稳定调用级 id**，不是严格内容寻址；相同字节由不同调用产生时**会重复落盘**，不承诺跨调用去重。

### 4.3 发送计数与每请求开销控制（r3 核心修正）

「已参与过多少次 provider 请求」= 该消息之后出现的 assistant 消息个数（`priorAssistantCounts[i]`），`requestIndex = assistantCount + 1`。
另维护内存 `Map<root+"\0"+id, sends>` 作为跨压缩的权威计数：
- `sends < fullSends`（默认 2）→ 保留全量，记 `full` 事件，计数 +1；
- 否则 → 生成占位符，记 `placeholder` 事件，计数 +1；恰好 `sends === fullSends` 时展示一次节省提示。

**每请求开销控制（r3 新增，解决复核 high #1）**：
- 维护会话级 `observationCache: Map<toolCallId, Observation | undefined>`。
- 首次遇到某条消息：计算 hash → `createObservation` → `ensureStored`（创建或**完整校验一次**）→ 写入 cache 并标记已验证。
- 后续每次请求：直接复用 cache，**不再对全文做 SHA-256、不再读盘校验**。
- 处理顺序：先查 cache 与 `sends`，只有需要新建/落盘时才做 I/O，避免每请求 O(全部归档字节) 的开销。
- resume 时 cache 为空，每个对象在恢复后**至多重新校验一次**，随后走 cache。
- 任何异常 → 清除该 toolCallId 的 cache 项并 fail-open。

恢复/Fork 行为：resume 复用同一 session id 与目录；fork 得到新 session id，历史里仍是全量 toolResult 消息，会在投影层被**重新归档**到新目录，自动自愈。

### 4.4 占位符格式（稳定、可解析）

```
[large tool result replaced after its first 2 provider requests]
id: obs_xxx
tool: bash
archived_bytes: 4194304
archived_lines: 51200
estimated_tokens: 1048576
retrieve: call obs_recall with {"id":"obs_xxx","offset":0}; continue with returned next_offset
[first complete lines, up to 512 bytes]
...
[middle omitted; last complete lines, up to 512 bytes]
...
[4194304 archived bytes omitted]
```
头尾各取整行，各 512 B，合计 1024 B。

**字段语义**：`archived_*` 指**归档时刻的字节**，不等于磁盘真原文。原因见 §4.9 与 §6。

### 4.5 `obs_recall` 工具

- 参数：`{ id: string, offset?: integer }`
- 校验 id 形如 `obs_[a-f0-9]{24}`；非法/ENOENT → 报 `Unknown observation id`
- `offset` 合法域 `0 <= offset <= size`；超界报错
- **UTF-8 边界（r3 新增，解决复核 medium #4）**：请求起点若落在多字节字符中间，**向后对齐到下一个字符起始字节**，并在响应头回显实际起点 `offset=<actual>`（默认 `offset:0` 不受影响）；`next_offset` 始终落在字符边界。
- 分页：`maxBytes = 16 KiB - 512`，`maxLines = 400 - 2`；EOF 处回退 UTF-8 边界
- 返回头部含 `next_offset` / `eof`，正文为切片；超硬上限直接报错
- 记 `recall` 事件

### 4.6 存储与清理（r3 定稿）

**根目录 = 配置项**，解析优先级：
1. 环境变量 `PI_OBSERVATION_DIR`
2. `observation-pack.json` 的 `archiveDir`
3. 内置默认 `<agent dir>/archiv`

> 注：默认值按用户原文写作 `archiv`；若本意是 `archive` 请指出，仅改默认值即可。

布局（按 session 隔离）：
```
<archiveRoot>/<sessionId>/observation-pack/
├── objects/<id>.txt
└── ledger.jsonl
<archiveRoot>/.trash/            # 手动清理的延迟删除区
```

- session id 取自 `ctx.sessionManager.getSessionId()`
- **安全校验（r3 新增，解决复核 medium #6）**：
  - session id 必须匹配 `/^[A-Za-z0-9][A-Za-z0-9._-]*$/`；
  - 最终 session 路径经 `resolve()` 后必须仍位于 `archiveRoot` 之内（防路径穿越）；
  - 取不到持久 session id 或校验失败 → 本 session **fail-open（不打包）**，不报错中断。
- 目录 `0700`、文件 `0600`
- 写盘：`O_NOFOLLOW` 防符号链接；`O_CREAT|O_EXCL` 创建；已存在则按 **size + sha256** 校验后才复用；**校验每进程每对象至多一次**（见 §4.3）
- 账本事件：`full` / `placeholder` / `recall`

**清理（r3 改为手动优先，解决复核 high #2）**：
- `cleanupEnabled` 默认 **`false`**，不提供自动删除。
- `retentionDays`（默认 30）仅作为手动清理的筛选口径。
- 手动命令 `/obs-prune [--days N] [--dry-run]`：
  - 筛选 = 目录 mtime 早于 N 天 **且非当前 session**；
  - 先 dry-run 输出待删列表；确认后 rename 到 `<archiveRoot>/.trash/`，延迟删除；
  - 记录删除日志；支持并发安全（跳过被占用/近期访问的 session）。
- 自动清理留作后续可选，需先补齐活跃会话锁与 heartbeat。

### 4.7 失败降级

任何打包/落盘/清理异常 → 仅提示警告并**保留原消息**（fail-open），绝不因省 token 丢观察。

### 4.8 配置（`~/.pi/agent/observation-pack.json`，默认全关）

```json
{
  "version": 1,
  "observationPack": {
    "enabled": false,
    "archiveDir": "<agent dir>/archiv",
    "thresholdBytes": 10240,
    "fullSends": 2,
    "placeholderExcerptBytes": 1024,
    "recallMaxBytes": 16384,
    "recallMaxLines": 400,
    "cleanupEnabled": false,
    "retentionDays": 30
  }
}
```

### 4.9 与现有扩展的交互

- **RTK**：RTK 在 `tool_result` 层改写，本扩展在 `context` 层归档。因 RTK 先加载，二者存在**保真度不对称**：
  - `bash` / `read` / `grep`：归档到的是 **RTK 过滤后**的文本，RTK 的硬截断/源码过滤不可逆，`obs_recall` 取回的也是过滤后内容。
  - `run_code`（PTC）及任何自定义工具：RTK **不处理**，因此归档到的是 **PTC 产出的真原文**。
- 该不对称已被接受（§6），设计上不额外补偿；如需真原文需改变加载顺序或前置归档，另案评估。
- **trajectory-recorder**：记录点在 provider 请求前，投影层改写**不应**影响 trace 的历史记录；需在实施时验证 trace 拿到的是改写前还是改写后（列为首个验收项）。
- **context-powerline / sidebar**：可复用其用量口径展示「避免的 token」，不新增独立 UI。

### 4.10 `run_code`（PTC）纳入归档

- **纳入方式**：无需白名单——§4.2 通用判定天然覆盖 `run_code` 顶层 toolResult 消息。
- **可见范围**：PTC 内部的 `read/find/grep/ls/write/run` 子调用是子运行时内部行为，不产生独立 context 消息；只归档 **`run_code` 的聚合结果**。
- **触发概率高**：PTC 上限 `MAX_RUN_OUTPUT_BYTES = 128 KiB`，远超默认 10 KiB 阈值，属主要归档来源。
- **无双重改写**：RTK 不处理 `run_code`，仅由 ObservationPack 改写一次。
- **模式覆盖**：`/ptc on|both` 只读模式与 `/ptc full` 的 `run_code` 结果一视同仁。
- **口径统一**：与 bash/read/grep 共用 `thresholdBytes` 与 `fullSends`，不单独放宽。

---

## 5. 方案 B：Action Fusion 设计的可借鉴点

### 5.1 功能层：与本地 PTC 重叠，不建议重复实现

本地 `extensions/ptc.ts` 的 `run_code` full 模式已支持在**一次调用**里 `read/find/grep/ls/write/run`，比 Action Fusion 更通用。Action Fusion 只是把「edit/write + 一条后续命令」做成可选参数，能力是其子集。

**建议：不新增 `then_run` 工具；如需要，作为 PTC 的一个轻量默认开路径再评估。**

### 5.2 工程层：四点值得吸收（无论是否实现 Action Fusion）

1. **继承内置工具定义，不重写**
   `createEditToolDefinition(cwd, opts)` / `createWriteToolDefinition` 复用，仅扩 `parameters` 增加可选 `then_run`；`renderCall/renderResult` 透传内置实现后包一层。符合「不打补丁、只走公开 API」。

2. **可选参数 = 零状态、零默认行为变化**
   `then_run` 由模型按需给；不给则完全等同内置行为。这比「全局开关」更安全。

3. **终态标记契约（机器可读）**
   返回文本用 `[then_run:succeeded]` / `[then_run:failed]` / `[then_run:skipped]` 标记，供模型与渲染器分支，而非散文描述。语义：mutation 失败 → 命令跳过；命令失败 → **保留 mutation 结果**并附标记 + 输出；非零退出如实报告但不回滚编辑（fail-open，保留证据）。

4. **并发与干扰防护**
   - **干扰守卫**：命令前对目标文件算 sha256，`setImmediate` yield 后再算一次；不一致则跳过并标 `[then_run:skipped]`（防 edit 与 run 之间被外部进程改动）。
   - **按文件串行队列**：以 canonical realpath 为 key（处理 `~`、`file://`、`@` 前缀、路径段不存在的情况）。
   - 注意（已由复核确认）：Pi 内置 edit/write **已在同一个非重入队列中执行**；外层若再持有 `withFileMutationQueue` 并等待 `base.execute` 会**自锁**。要采用需自建独立队列（照抄 SoL-Pi `file-queue.ts` 做法），或在回调外调用。
   - **内置定义按 cwd 记忆化**：闭包捕获 cwd，避免每次调用/重绘重建。

---

## 6. 已决记录

| # | 问题 | 决策 | 依据 |
|---|---|---|---|
| 6.1 | 归档根目录 | 作为配置项，默认 `<agent dir>/archiv`；`PI_OBSERVATION_DIR` 可覆盖；按 session 隔离 | 用户确定 |
| 6.2 | 归档保真度 | 接受：bash/read/grep 归档为 RTK 过滤后字节，`run_code` 为真原文；不补偿 | 用户确定 |
| 6.3 | 与 PTC 分工 | `run_code` 结果纳入归档，统一阈值与计数，无白名单 | 用户确定 |
| 6.4 | 压缩后 id 发现性 | **收窄承诺**，不做压缩钩子；仅保证「已知 id 时 resume 后可读」 | 大观测多为探索性；摘要由全量历史生成；重要结论应入 memory/goal |
| 6.5 | TTL 清理 | **默认关闭自动清理**，改手动 `/obs-prune`（dry-run + 排除当前 session + trash） | 避免误删在用归档；保留未来自动化钩子 |
| 6.6 | 对象存储键 | 保持 `id = f(toolName, toolCallId, contentHash)`；措辞改「稳定调用级 id」，不承诺跨调用去重 | 跨调用去重收益低，真内容寻址需额外映射层 |
| 6.7 | 每请求开销 | 会话级 `observationCache` 记忆化，跳过重复哈希与读盘 | 复核 high #1 |
| 6.8 | offset 字符边界 | 起点非 UTF-8 边界时向后对齐并回显实际 offset | 复核 medium #4 |
| 6.9 | session 路径安全 | session id 白名单 + resolve 后归属校验，失败 fail-open | 复核 medium #6 |
| 6.10 | RTK 表述 | 改为「返回 content 补丁」「可能破坏精确匹配」 | 复核 low #7 |

---

## 7. 验收与实验设计（能力下限 gate）

沿用 SoL-Pi 的约束式效率观：
- **能力下限**：任务质量/关键能力指标须落在预先声明的容差内，否则该「节省」不算数
- **效率提升**：≥1 项效率指标改善
- **一次只验一个机制**：避免多个大改动同时上
- **held-out 隔离**：调参/迭代用的任务集与最终验收集分离，验收结果不回流

指标来源（复用本地基建）：`extensions/trajectory-recorder.ts` 的计时账本（model 调用数、ttft、thinking、cache 读写、tool 时长）+ `extensions/usage-analytics.ts`。基线 = 当前栈（RTK 开、ObservationPack 关）。

必须验证的高风险项：
1. 投影层改写后，trajectory-recorder 记录的是否仍为完整历史（P0 第 1 验收项）
2. **每请求开销**：多归档对象场景下，无 O(全部归档字节) 的重复哈希/读盘（验证 `observationCache` 生效）
3. 会话恢复后 `obs_recall` 仍可命中；且恢复后每对象至多重新校验一次
4. `run_code` 大结果归档后，PTC 后续迭代行为不退化
5. offset 非法/非字符边界时行为正确，无乱码
6. session id 异常/路径穿越时 fail-open，不越界写盘
7. 手动 `/obs-prune --dry-run` 不删当前 session、不误删近期会话
8. RTK 交互下无内容损坏或重复压缩

---

## 8. 分阶段计划

- ✅ **S0**：决策已定（§6）。
- ✅ **S1**：ObservationPack 骨架已实现（`extensions/observation-pack.ts` + `extensions/observation-pack/core.ts` + `test/observation-pack.test.ts`）；默认关，15 个单测 + 装配级冒烟测试。
- ✅ **S2**：小样本 A/B 已完成，结论见 §8.1。
- ✅ **S3**：已并入 `~/.pi/agent/extensions.config.json` 的 loadOrder（第 24 项，在 trajectory-recorder 之前）并同步；README/CHANGELOG 已追加。已于 2026-09-15 在 `~/.pi/agent/observation-pack.json` 启用（`enabled: true`，`cleanupEnabled: false`）；修改后需 `/reload`。
- **S4（可选）**：吸收 §5.2 的并发守卫 / 终态标记到 PTC 或未来编辑工具

---

## 8.1 S2 小样本 A/B 结论（2026-09-15）

设置：`dashscope/deepseek-v4-flash`；headless 最小扩展集（RTK + observation-pack + ptc，`pi -p --mode json`）；2 个固定 7 步确定性任务 × {off,on} × 3 trials；脚本 `scripts/observation-pack-ab.mjs`。

- **机制确已触发**：ON ledger 出现 2–4 次 `placeholder`；无 `recall`（占位符已足够，模型未调用 `obs_recall`）。
- **单请求上下文显著下降**：打包后每请求 prompt 从 ≈20.5K 降到 ≈4.5K（T1）/ ≈21K → ≈5K（T2），约 −75%~−78%。
- **整轮 prompt tokens**：T1 −46%（106413 → 56988）；T2 −53%（126245 → 59488）。
- **成本**：T1 −17%；T2 −42%（含 cached input 计价）。
- **能力下限**：OFF 6/6 通过；ON 5/6。唯一失败是 PTC `run_code` 子调用预算耗尽（模型误试 `require`/`import`/`Deno`），与 ObservationPack 无关，无 recall 报错。
- **run_code**：`run_code` 结果被正常打包（placeholder 事件），未见机制导致回归。
- **每请求开销**：ON 与 OFF 墙钟相当，未见 O(归档字节) 放大。

局限：单一模型、3 trials、步数方差大（3–10 次调用）；headless 使用最小扩展集，因为完整全局扩展栈在 `-p` 下会因 stale-ctx 报错而不产出回复；任务为合成场景，无 held-out 集。以上数值仅作方向性证据，不作精确因果估计。

---

## 9. 复核采纳记录（`azure-okx/gpt-5.6-sol`，thinking=medium，只读）

- 正面核实：`context` 可返回 `{messages}`；`tool_result` 可返回补丁；`create{Edit,Write,Bash}ToolDefinition` 与 `withFileMutationQueue` 均公开导出；发送计数算法与上游一致；mutation 队列自锁判断成立。
- 采纳并已落入 r3：high #1（每请求开销）、high #2（TTL）、high #3（压缩承诺）、medium #4（UTF-8 起点）、medium #5（内容寻址措辞）、medium #6（session 路径安全）、low #7（RTK 措辞）。
- 未采纳项：改为真正内容寻址 + 压缩钩子（理由见 §6.4 / §6.6）。

---

## 10. 参考

- SoL-Pi：https://github.com/NVlabs/SoL-Pi ・ blog：https://nvlabs.github.io/SoL-Pi/
- Action Fusion 源码：`src/sol-pi/extensions/action-fusion/{index,then-run,file-queue}.ts`
- ObservationPack 源码：`src/sol-pi/extensions/observation-pack/{index,observation,ledger}.ts`
- RTK：https://github.com/mcowger/pi-rtk