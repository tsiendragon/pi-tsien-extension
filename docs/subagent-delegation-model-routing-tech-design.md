# 主模型＋子模型分工与模型路由 技术设计

- 状态：设计稿，未实施。日期：2026-10-23。源码基线：pi-tsien-extension `f050471`。
- 上游调研：`/home/tsien/files/reports/pi-agent-delegation-20261023-1959/方案.md`（公开实践、源码证据、独立审阅记录）。
- 范围：`pi-tsien-subagent-workbench` 的模型选择、候选切换、执行约束、结果契约与恢复；Dashboard 提供模型档位设置页，并展示运行情况，但不负责权限控制。不改 Pi 宿主。
- 已确认决策（2026-10-23，用户）：① 一档模型全部不可用时，轻量档最多等待 2 分钟后升到普通档；普通档只等待，不升到强档。② 所有已登记服务商均可处理证件图片和个人信息，不做按数据级别筛选模型。③ 候选模型与顺序由用户设定，并在 Dashboard 中为每个模型设置档位（第 10.1 节）。④ 共四档：轻量（light，便宜档）/ 普通（medium）/ 强（heavy）/ 超强（ultra）。超强档只在主模型明确选择时使用，任何自动升档都不会升到强档或超强档。⑤ 轻量档顺序已确认（第 5.3 节）。⑥ 子任务超时要足够长，可以超过 24 小时，以支持训练等长期任务（第 8.1 节）。

## 1. 目标与非目标

目标：

1. 强主模型负责拆分、取舍、验收；子模型执行边界清楚的任务；固定操作交给程序。
2. 子模型用哪个模型由**配置**决定，主模型只选“档位”，不自己编模型名。
3. 每个档位配置一个**有序候选列表**，依次使用；某个模型撞到频率限制、额度用完、过载或不可用时，**自动切换**到下一个候选，不需要主模型介入。
4. 切换和失败全部留痕：实际用了哪个模型、为什么切换、花了多少。
5. 在执行入口落实分工和权限，而不是靠提示词。

非目标：多个模型自由协商、子模型再派子模型、按回答质量自动反复换模型、跨机器共享额度状态（第二期再议）。

## 2. 现状与问题（源码证据）

| 问题 | 证据 | 后果 |
|---|---|---|
| 只有单一模型，没有候选列表 | `runner-stage.ts:36-60` `selectExecution` 只返回一个 `model` | 一个模型撞限制，整批子任务失败 |
| 硬编码默认值不存在于本机 | `runner-stage.ts:3` `DEFAULT_EXECUTION_MODEL = "azure-gateway/gpt-5.6-luna"`；`~/.pi/agent/models.json` 无 `azure-gateway` 提供方 | 2026-10-23 两个子任务启动即报 `Model not found` |
| 文档与实现不一致 | `delegate-work` 技能写“省略 model 即继承”，实现是 任务→工作流→显式继承→环境变量→硬编码默认 | 主模型以为用了某模型，实际不是 |
| 重试只在同一模型上 | Pi 自带 `retry.maxRetries=3` 指数退避，仅重试当前模型（Pi `docs/settings.md` Retry 节）；扩展未分类错误 | 额度耗尽时白等，且等待期间不换模型 |
| 进程失败只给原始文本 | `pi-rpc-process-provider.ts:349-350` 以 `process_exited`+stderr 报错 | 无法区分“模型不存在”“限流”“用户取消” |
| 角色权限事后检查 | `pi-rpc-process-provider.ts:1046-1057` 在 `tool_execution_start` 后才比对并中止 | 不能保证越权操作未发生 |
| 工作流不传角色 | `workbench-controller.ts:1684` 调 `selectExecution` 未传 `role`，落到默认 `code` | 研究型工作流拿到写工具 |

## 3. 总体结构

```text
主模型 ──提交任务（档位/角色、目标、范围、验收）──▶ 子任务入口（subagent_start / workflow）
                                                      │
                     ┌────────────────────────────────┼─────────────────────────┐
                     ▼                                ▼                         ▼
              执行策略检查                        模型路由器                   资源调度
       （角色、工具、路径、预算）        （配置→候选→健康状态→选模型）     （并发、队列）
                     │                                │                         │
                     └──────────────▶ 子进程（Pi RPC）◀┘─────────────────────────┘
                                          │  错误事件
                                          ▼
                                     错误分类 ──▶ 同模型重试 / 切换候选 / 等待 / 升档 / 失败
                                          │
                                          ▼
                              结果契约校验 ──▶ 主模型验收
```

新增一个模块 `model-router.ts`（纯逻辑：配置解析、候选选择、错误分类、健康状态），其余在现有文件内增量修改。

## 4. 谁决定用哪个模型

| 决定者 | 决定什么 | 不能做什么 |
|---|---|---|
| 用户（Dashboard 设置页或配置文件） | 每个模型属于哪一档；同档内顺序；思考强度；并发上限；角色默认档位；切换与升档规则 | — |
| 主模型（每次派任务） | 选档位 `light / medium / heavy / ultra`，或只给角色、用角色默认档位；ultra 只用于强档已失败或确实需要的最难任务 | 不能使用配置外的模型名；不能自行开启继承主模型（除非配置允许） |
| 模型路由器（程序） | 在档位候选中按顺序挑第一个可用的；撞限制时切换；记录实际模型 | 不能越档升级，除非配置的耗尽规则允许 |
| 主模型（验收后） | 结果质量不合格时，决定是否升一档重做一次 | 不能用“换个同档模型多试几次”代替判断 |

两类切换严格分开：

- **可用性切换**（限流、额度、过载、模型不存在）：程序自动做，同档内换，不消耗主模型上下文。
- **质量升级**（答错、做不出）：主模型决定，最多升一档一次。

主模型显式指定 `model` 仅用于调试或固定复现：必须是配置中某档的候选，否则拒绝；固定模型的任务不自动切换（除非同时给了 `allowFallback: true`）。

## 5. 配置设计

### 5.1 位置与加载

- 全局：`~/.pi/agent/subagent-models.json`。
- 日常编辑入口是 Dashboard 设置页（第 10.1 节），它只写这个全局文件；也可以手工编辑。
- 项目覆盖：`<project>/.pi/subagent-models.json`，仅受信任项目加载；按档位整体替换（项目写了 `light` 就替换全局 `light`），其余继承全局。Dashboard 第一期不编辑项目覆盖文件，只提示它存在。
- 环境变量 `PI_SUBAGENT_MODEL_CONFIG` 可指定全局文件路径。
- 每次选择前比对文件修改时间，变了就重新加载；也可用 `/subagent-models reload`。
- 加载失败（格式错误）时保留上一次有效配置并显示告警；从未成功加载过则子任务直接报错，**不静默回退**到任何内置模型。
- 兼容：没有配置文件但设置了旧变量 `PI_SUBAGENT_EXECUTION_MODEL` 时，视为只有一个候选的 `medium` 档并告警；删除硬编码默认模型。

### 5.2 字段

```jsonc
{
  "version": 1,
  "defaultTier": "medium",
  "roles": { "read_only": "light", "research": "medium", "code": "medium" },
  "allowInherit": false,            // 是否允许主模型要求“继承主会话模型”
  "explicitModel": "allowlist",     // 显式 model：allowlist=必须在候选里 / deny
  "tiers": {
    "light": {
      "candidates": [
        {
          "model": "dashscope/deepseek-v4.1-flash-1017",  // 精确 provider/model
          "thinking": "low",
          "maxConcurrency": 4,       // 本模型同时运行的子任务上限
          "quotaGroup": "dashscope"  // 共用额度的分组，默认=provider
        }
      ],
      "strategy": "ordered",         // ordered=按顺序取第一个可用；spillover 见 6.2
      "spillover": true,
      "onExhausted": { "action": "wait_then_escalate", "maxWaitMs": 120000, "escalateTo": "medium" }
    }
  },
  "fallback": {                       // 按错误类别的处理，可覆盖默认值（见第 7 节）
    "rate_limited":   { "action": "switch", "cooldownMs": 60000 },
    "quota_exhausted":{ "action": "switch", "cooldownMs": 1800000, "scope": "quotaGroup" }
  },
  "errorPatterns": {                  // 可选：补充本地提供方的错误文本识别
    "quota_exhausted": ["insufficient_quota", "usage limit", "余额不足"]
  },
  "timeouts": {                      // 见第 8.1 节
    "workHardMs": 259200000,          // 单次模型工作硬上限，默认 72 小时
    "workHardMaxMs": 1209600000,      // 任务可申请的最大值，14 天
    "externalWaitMs": 604800000,      // 等待外部任务默认上限，7 天
    "externalWaitMaxMs": 2592000000,  // 最大 30 天
    "pollIntervalMs": 600000          // 外部任务状态检查间隔，10 分钟
  },
  "budgets": {
    "maxModelCallsPerTask": 2000,     // 超过即暂停并通知主模型，防止长超时下空转烧钱
    "maxCostUsdPerTask": null        // 可选，按估算费用暂停
  }
}
```

### 5.3 本机示例（仅示意，最终由用户在设置页设定）

下列模型均在本机 `models.json` 中登记。档位和顺序由用户设定；第 12 节的代表任务评测结果可作为调整参考，不按名字猜测。

用户已定档（2026-10-23，后一次覆盖前一次）：luna（azure、codex、网关三个入口）和 qwen3.8-flash 为轻量档；glm-5.3、sonnet 为普通档；kimi-k3、sol、opus 为强档；gpt-6-astra 为超强档。轻量档顺序经用户确认。同一模型如果有多个服务商入口，就全部列为候选（各自的额度单独计算）。同档内顺序由用户在设置页调整，下表顺序只是初始值。

| 档位 | 候选顺序（初始值） | 说明 |
|---|---|---|
| light 轻量（便宜） | `azure-okx/gpt-6-luna` → `openai-codex/gpt-6-luna` → `llm-gateway/gpt-6-luna` → `dashscope/qwen3.8-flash` → `dashscope/deepseek-v4.1-flash-1017` → `llm-gateway/glm-5.3-flash` → `azure-okx-claude/claude-haiku-5-5` | 字段提取、日志初筛、格式转换、只读定位 |
| medium 普通 | `azure-okx-claude/claude-sonnet-5-5` → `llm-gateway/claude-sonnet-5-5` → `llm-gateway/glm-5.3` | 同一模型经不同服务商使用时，额度分开计算，可作同质量备份 |
| heavy 强 | `azure-okx/gpt-6.1-sol` → `openai-codex/gpt-6.1-sol` → `llm-gateway/gpt-6.1-sol` → `azure-okx-claude/claude-opus-5-5` → `llm-gateway/claude-opus-5-5` → `dashscope/kimi-k3` → `llm-gateway/kimi-k3` | 只在配置或主模型明确要求时使用 |
| ultra 超强 | `azure-okx/gpt-6-astra` → `llm-gateway/gpt-6-astra` | 只在主模型明确选择时使用；全部不可用时直接失败 |
| 不用（未分档） | 其余已登记模型，如 qwen3-coder-plus、kimi-k2.7-code、deepseek-v4-flash、deepseek-v4-pro、qwen3.8-max、gpt-4o、gpt-5、`dsw/deepseek_v41_flash` | 用户在设置页分档前，子任务不会使用 |

按用户确认，所有已登记服务商都可以处理证件图片和个人信息，因此路由器不按数据级别筛选候选。今后若需要限制，应作为单独需求增加，不在第一期预留。

### 5.4 启动校验

加载配置时逐个候选检查，结果在 `/subagent-models` 中可见：

- 模型在 Pi 模型注册表中存在（对应本次 `Model not found` 的问题，提前发现）。
- 提供方已配置认证（只检查是否存在，不读取或输出凭证）。
- 思考强度在该模型支持范围内。
- 不通过的候选标记为 `disabled`，带原因；某档全部不可用时告警。

真实请求探活会花钱，只作为手动命令 `/subagent-models probe <tier>`，不自动执行。

## 6. 路由算法

### 6.1 候选状态

每个候选在主 Pi 进程内维护：

| 状态 | 含义 | 何时恢复 |
|---|---|---|
| `available` | 可用 | — |
| `cooldown(until)` | 撞限制，冷却中 | 到期自动恢复；成功一次后清零连续失败计数 |
| `disabled(reason)` | 模型不存在、认证失败、配置错 | 配置重载或手动 `/subagent-models enable` |

`quotaGroup` 级别冷却：额度耗尽时同组候选一起冷却（例如同一网关密钥下的多个模型）。频率限制默认只冷却该模型。

第一期状态只在当前主 Pi 进程内共享（同一会话的所有子任务看到同一份状态）。多个 Pi 会话共享额度时的跨进程状态（带锁的状态文件）放第二期。

### 6.2 选择

```text
select(tier, task):
  candidates = tiers[tier].candidates，过滤掉 disabled
  for c in candidates（按配置顺序）:
      if c 在冷却中: continue
      if c 运行中数量 >= maxConcurrency:
          if spillover: continue          # 第一个满了就用下一个
          else: 排队等 c                   # 严格按顺序
      return c
  全部不可用 → 按 onExhausted 处理（6.3）
```

“依次使用”的含义：始终优先第一个；只有它冷却、禁用或（开启 `spillover` 时）满载，才用下一个。冷却到期后新任务自动回到第一个。

### 6.3 一档全部不可用

`onExhausted.action`：

- `wait`：等到最早一个候选冷却结束，最长 `maxWaitMs`，超时失败。
- `wait_then_escalate`：先等，超时后升到 `escalateTo` 指定的档位（只升一档，会更贵）。
- `escalate`：立即升档。
- `fail`：直接失败，交给主模型。

已确认的默认值：light 用 `wait_then_escalate`（最长等 2 分钟）升到 medium；medium 用 `wait`；heavy 和 ultra 用 `fail`。升档**不会**自动升到 heavy 或 ultra；heavy 失败后是否改用 ultra，由主模型决定。

## 7. 错误分类与自动切换

### 7.1 重试只有一个负责方

现在 Pi 子进程会自己在同一模型上重试 3 次（2s/4s/8s），路由器若再叠加重试，会出现“先白等十几秒、再切换”。设计：

- 子进程启动后通过 RPC 发 `set_auto_retry {enabled:false}`，关闭 Pi 自带重试；路由器统一负责重试和切换。
- 保持 Pi 的 `retry.provider.maxRetries = 0`（Pi 文档明确提示：提供方层重试可能在额度耗尽时一直阻塞直到额度重置）。

### 7.2 错误来源

- 子进程启动即退出：`process_exited` + stderr（例如 `Model "..." not found`）。
- 一轮对话以错误结束：助手消息 `stopReason: "error"` 与 `errorMessage`（包含 HTTP 状态码和提供方错误体）。
- 超时、用户取消：由扩展自身产生，可明确区分。

### 7.3 分类与默认处理

| 类别 | 识别依据（默认，可用 `errorPatterns` 补充） | 默认处理 |
|---|---|---|
| `rate_limited` 频率限制 | 429、`rate_limit`、`Too Many Requests` | 立即切换下一个；该模型冷却 `retry-after` 或 60 秒 |
| `quota_exhausted` 额度用完 | `insufficient_quota`、`quota`、`usage limit`、`billing`、`余额` | 立即切换；同 `quotaGroup` 冷却 30 分钟或到提示的重置时间 |
| `overloaded` 过载/服务端错误 | 529、503、500、502、`overloaded` | 同模型等 2～5 秒重试 1 次，再失败则切换并冷却 30 秒 |
| `network` 网络中断 | `ECONNRESET`、`ETIMEDOUT`、`terminated`、非用户发起的 `aborted` | 同上：重试 1 次后切换 |
| `context_overflow` 输入太长 | `context length`、`maximum context`、`prompt is too long` | 换同档中上下文窗口更大的候选；没有则失败交主模型（应拆小任务） |
| `not_found` / `auth` / `config` | `not found`、401、403、`invalid api key`、思考强度不支持 | 该候选 `disabled`，立即切换，并告警需要修配置 |
| `content_refused` 内容拒答 | 提供方安全拒答 | **不自动切换**，交主模型（换提供方绕过拒答需人决定） |
| `cancelled` / `task_timeout` | 用户取消、任务超时 | 不是模型问题，不切换 |
| `unknown` | 以上都不匹配 | 重试 1 次后切换；记录原文供补充规则 |

每个任务的切换次数上限 `maxSwitchesPerTask`（默认 3），防止所有候选来回循环烧钱。

### 7.4 任务进行到一半撞限制怎么办

关键问题是：已经做了的工作不能丢，已经产生的副作用不能重复。

1. **还没有任何工具调用**（例如启动即失败、第一轮就限流）：直接换候选重新开始，没有副作用。
2. **已经有工具调用，子进程仍然存活**：在**同一个会话**里切换模型——RPC 发 `set_model` 和 `set_thinking_level`，再发一条固定提示“上一个模型因限流中断，请从中断处继续，不要重复已完成的操作”。会话历史、已读文件和已完成步骤都保留。
3. **子进程已退出**：
   - 只读角色：换候选重新开始（读操作可重复）。
   - 写角色：不自动重来，标记 `blocked`，附已产生的改动清单，交主模型决定（避免重复写入）。

情况 2 依赖 Pi 跨提供方切换会话时正确转换历史消息（交互模式下手动切换模型就是这条路径），实施时必须用真实的跨提供方切换测试确认；不通过则退回情况 3 的处理。

## 8. 执行约束（与模型路由配合）

- 角色权限前移：子进程中在工具**执行前**检查（Pi 扩展 `tool_call` 拦截），替代现在“执行开始后再中止”；保留事后检查兜底。
- 子进程只加载角色需要的工具和技能；环境变量按白名单传递，不继承全部父进程变量。
- 工作流任务必须传角色，与单任务共用同一套角色配置。
- 禁止递归：子进程的工具集合中不含委派工具。
- 主模型“受控执行模式”：多步骤执行任务中，主模型只保留规划、限定读取、委派、状态查询、验收和正式操作的受控入口；正式入口只接受固定参数（配置引用、批准编号），不接受任意命令。普通问答与小任务例外，例外按工作项限定范围和时长。
- 隔离边界说明：以上是工具层约束；任意脚本的文件、网络和凭证隔离需要容器或操作系统层，未部署前不宣称是安全沙箱。

### 8.1 超时与长期任务

现状（`pi-rpc-process-provider.ts:640-672`、`:829`、`index.ts:1637`）：

- 单次运行硬上限默认 24 小时（`hardRunWallTimeMs`）；无进展 10 分钟、运行 1 小时只提醒不中止。
- 子进程以 `--no-session` 启动，对话不落盘；主会话关闭时（`session_shutdown`）工作台随之关闭。主 Pi 一重启，子任务就会丢失（待实测确认）。

问题：训练动辄跑几天。如果让子模型在一轮对话里反复“睡一会儿、查一次状态”，既会一直花 token、擑大上下文，也会在 Pi 重启后丢掉进度。因此，把时间拆成两类分别管理：

| 时间类型 | 含义 | 默认 | 任务可申请上限 |
|---|---|---|---|
| 模型工作时间 | 子模型在运行、调用工具 | 硬上限 72 小时；无进展 10 分钟、运行 1 小时（之后每 6 小时）只提醒 | 14 天 |
| 等待外部任务时间 | 训练、评测、下载等在集群或后台运行，子模型不工作 | 7 天；每 10 分钟由程序检查一次状态 | 30 天 |

长超时可能让卡死的子模型空转很久。真正的保护靠**预算**而不是超时：每个任务设置模型调用次数上限，可选费用上限；超过后暂停任务，并通知主模型决定继续还是取消，不自动终止。

**等待外部任务模式**（新增）：

1. 主模型通过受控入口提交训练，拿到任务编号（正式提交仍由主模型负责）；然后派子任务负责监控和分析。子任务也可以接管已在运行的外部任务。
2. 子模型调用新工具 `wait_external`，参数为状态检查器名称、外部任务编号和等待上限。状态检查器是预先登记的固定程序，例如 TaskGrid 状态查询，不接受任意命令。
3. 工作台把等待记录写到磁盘（`~/.pi/agent/subagent-workbench/waits/<id>.json`），结束当前这轮对话。子进程退出后不再占用内存，也不再花 token。长期任务子进程改用 `--session-dir` 将对话落盘，不再使用 `--no-session`。
4. 由程序按间隔检查状态，全程不调用模型。外部任务结束、失败或等待超时后，重新打开落盘的对话（`pi --mode rpc --session <file>`），由模型路由器重新选择当前可用模型，并发送“外部任务已结束，状态和日志位置如下，请继续”，让子模型分析结果。
5. 运行中的间隔检查只更新状态和指标摘要，在 Dashboard 和 `/subagent-models`（或子任务列表）中可见；只有异常或结束时才通知主模型。

**跨重启恢复**：

- 训练本身在集群上运行，不受 Pi 或 Dashboard 重启影响。
- Pi 启动时，工作台读取未完成的等待记录并继续检查；停机期间错过的结束事件会在下一次检查时补上。
- 多个 Pi 会话同时在线时，用带过期时间的租约文件保证只有一个会话负责检查和唤醒，避免重复唤醒。唤醒结果写入记录；发起任务的主会话已不在时，结果保留到下次打开，并在 Dashboard 中显示。
- 重启时正在运行的模型会被中断：只读角色可以从落盘的对话继续；会写文件的角色标记为 `blocked`，交给主模型处理（与 7.4 节一致）。

## 9. 任务与结果契约

任务包（主模型提交）：`objective`、`acceptance`、`role`、`tier`、`scope`（读写路径、禁止动作）、`inputs`（引用和版本）、`budget`（时长、最大切换次数、费用估算上限）、`outputDir`。说明正文目标约 1500 token，实际测量整个启动输入。

结果（子模型产出＋宿主补充）：

- 子模型填写：`status`（succeeded / failed / blocked）、`summary`、逐条验收、`artifacts`（绝对路径＋版本）、最多 5 条证据、风险、未检查项。
- 宿主填写（不信任子模型自报）：`execution.tier`、`execution.attempts[]`（每次尝试的模型、开始结束时间、结果、错误类别、`retryAfter`、token 用量与费用）、`execution.finalModel`、切换次数、总耗时。

`status: blocked` 的结果即使格式正确，也不得自动启动依赖它的下游步骤（这是新增的业务状态门禁，当前只有结构校验）。

## 10. 接口变更

`subagent_start` 与工作流任务新增/调整参数：

| 参数 | 说明 |
|---|---|
| `tier` | 新增。`light / medium / heavy / ultra`；省略则用角色默认档，再省略用 `defaultTier` |
| `model` | 保留。必须在候选列表中；设置后默认不自动切换 |
| `allowFallback` | 新增。与 `model` 一起使用时允许切换到同档其他候选 |
| `timeoutMs` | 新增。模型工作硬上限，默认 72 小时，不超过配置的 `workHardMaxMs` |
| `maxWaitMs` | 新增。等待外部任务的上限，默认 7 天，不超过 `externalWaitMaxMs`；设置后对话会落盘 |
| `inheritModel` | 保留。仅当配置 `allowInherit: true` 时有效 |

工具描述改为“选择档位，不要指定模型名”，引导主模型按难度选档。

新增命令 `/subagent-models`：列出各档候选、状态（可用/冷却剩余时间/禁用原因）、运行中数量、今日切换次数；子命令 `reload`、`enable <model>`、`probe <tier>`。

Dashboard 子任务面板（第四期）：显示实际模型、切换记录、切换原因和费用，不作为权限边界。

### 10.1 Dashboard 设置页：子任务模型

位置：设置 → Agent 分组，放在现有 “Model List” 之后，新增标签页 “Subagent Models / 子任务模型”。复用 `/api/models/catalog` 的完整模型目录，不另外维护模型列表。

页面内容：

1. **按模型设置档位**：按服务商分组，列出全部已登记模型。每个模型一行，提供“档位”下拉框：`不用 / 轻量 / 普通 / 强 / 超强`；支持现有的模型与服务商搜索。
2. **档内顺序**：页面上方分四栏显示轻量、普通、强、超强档的候选列表，用“上移 / 下移”调整顺序；新加入某档的模型默认排在末尾。
3. **高级设置（默认折叠）**：每个候选的思考强度、最大并发和额度分组；角色默认档位；一档全部不可用时的处理；超时与预算（第 8.1 节，以小时或天为单位输入）。默认值采用第 6.3 节已确认的规则。
4. **校验提示**：模型已从模型目录中删除、思考强度不受支持、某档为空、显式配置的升档目标为空时，就地提示；仍允许保存草稿，但会标出哪一档不可用。
5. **状态提示**：显示配置文件路径、最近保存时间；检测到项目覆盖文件时，提示“以下项目会覆盖全局设置”。

后端接口（`pi-dashboard`）：

- `GET /api/subagent-models`：返回当前配置、文件修改时间和校验结果。
- `PUT /api/subagent-models`：带上次读取的修改时间提交；发现文件已被他人修改时返回冲突，避免覆盖。写入前备份，采用“先写临时文件再改名”的原子写入；使用串行写入，避免并发保存互相覆盖（参照 `backend/settings-store.ts`）。
- 不读写模型密钥；只引用 `provider/model` 名称。

生效方式：扩展在每次选择模型前检查配置文件修改时间，保存后**下一次派出的子任务**生效，不需要重启 Pi；已经运行的子任务继续使用原来的模型。Dashboard 后端代码首次上线时，仍需用户执行 `./run.sh`。

第四期再增加：显示每个模型的实时状态（可用 / 冷却剩余时间 / 已停用及原因）和今日切换次数，数据通过现有 workbench 的 Dashboard 桥接获取。

## 11. 改动文件

| 文件（绝对路径） | 改动 |
|---|---|
| `/home/tsien/repos/pi-tsien-extension/packages/pi-tsien-subagent-workbench/src/model-router.ts` | 新增：配置解析与校验、候选选择、错误分类、健康状态 |
| `/home/tsien/repos/pi-tsien-extension/packages/pi-tsien-subagent-workbench/src/runner-stage.ts` | `selectExecution` 返回档位与候选；删除硬编码默认模型 |
| `/home/tsien/repos/pi-tsien-extension/packages/pi-tsien-subagent-workbench/src/providers/pi-rpc-process-provider.ts` | 关闭子进程自带重试；上报结构化错误；支持会话内 `set_model` 续跑；执行前权限检查；环境变量白名单 |
| `/home/tsien/repos/pi-tsien-extension/packages/pi-tsien-subagent-workbench/src/workbench-controller.ts` | 尝试循环与切换；工作流传角色；业务状态门禁 |
| `/home/tsien/repos/pi-tsien-extension/packages/pi-tsien-subagent-workbench/src/resource-governor.ts` | 按候选的并发计数 |
| `/home/tsien/repos/pi-tsien-extension/packages/pi-tsien-subagent-workbench/src/external-wait.ts`（新增） | 等待记录落盘、状态检查器登记、租约、唤醒与重启恢复；子进程工具 `wait_external` |
| `/home/tsien/repos/pi-tsien-extension/packages/pi-tsien-subagent-workbench/src/index.ts` | 参数 `tier/allowFallback`；`/subagent-models` 命令 |
| `/home/tsien/repos/pi-tsien-extension/packages/pi-tsien-subagent-workbench/README.md` | 配置说明 |
| `/home/tsien/repos/pi-tsien-extension/test/integrated/workbench/` | 第 12 节测试 |
| `/home/tsien/repos/pi-dashboard/backend/routes/subagent-models.ts`（新增）、`/home/tsien/repos/pi-dashboard/backend/routes/index.ts` | 配置读写接口、校验、冲突检测、备份与原子写入 |
| `/home/tsien/repos/pi-dashboard/frontend/src/pages/SettingsPage.tsx` | 新标签页入口；页面组件放在 `/home/tsien/repos/pi-dashboard/frontend/src/features/subagent-models/`（新增） |
| `/home/tsien/repos/pi-dashboard/guide/config.md`、`/home/tsien/repos/pi-dashboard/guide/extensions.md`、`/home/tsien/repos/pi-dashboard/guide/dashboard.md` | 新配置文件、环境变量和设置页说明（按 Dashboard 仓库规则，在同一次提交中更新） |
| `eagleeye-ai-dev` 中 `delegate-work` 技能源文件 | 模型表改为“选档位”，删除“省略即继承”的错误说法；改源后走同步安装 |

## 12. 测试与验收

单元测试（纯逻辑，`model-router.ts`）：

- 按顺序选择；第一个冷却/禁用/满载时选下一个；冷却到期回到第一个。
- `quotaGroup` 整组冷却；`retry-after` 优先于默认冷却时长。
- 错误分类：用真实采集的错误文本做样本表（含本次 `Model "azure-gateway/gpt-5.6-luna" not found`、`Request aborted`、`This operation was aborted`）。
- 一档耗尽时 `wait / wait_then_escalate / escalate / fail` 四种行为；切换次数上限。
- 显式 `model` 不在候选中被拒绝；旧环境变量兼容并告警；配置损坏保留上一版。

集成测试（模拟提供方返回 429 / 额度错误 / 529 / 模型不存在）：

- 启动即失败 → 换候选成功，结果记录两次尝试。
- 中途限流 → 同会话切换模型续跑，已完成的工具调用不重复。
- 写角色子进程退出 → 标记 blocked，不自动重来。
- 关闭子进程自带重试后，限流到切换的耗时在秒级。
- 越权写入在执行前被拒绝，目标文件未改变。
- 长期任务（用假时钟模拟超过 24 小时）：子任务进入等待后子进程退出、不再产生模型调用；外部任务结束后从落盘对话继续；等待期间重启 Pi 能恢复检查；两个 Pi 会话不会重复唤醒；超过模型调用上限时暂停并通知。

Dashboard 测试：

- 设置页修改档位和顺序后保存，配置文件内容正确；再次打开页面后显示一致。
- 两个窗口先后保存时，后保存者收到冲突提示，不覆盖先保存的内容。
- 模型从目录删除后，页面标出失效候选；保存后扩展将其标记为停用，不会启动失败。
- 保存后派出的新子任务使用新配置，已运行的子任务不受影响。

上线验收：

- 用约 20 个真实代表任务对比当前方式：验收通过率不降；每个合格任务总费用（含失败和重试）、总耗时、主模型上下文增长有可见改善。
- 两周内记录切换日志：各模型撞限制频率、切换后成功率，据此调整候选顺序和并发上限。

## 13. 分期

| 期 | 内容 | 出口 |
|---|---|---|
| 一 | 配置文件＋启动校验＋有序选择＋错误分类＋启动失败切换；删除硬编码默认；`/subagent-models`；Dashboard 设置页（第 10.1 节，不含实时状态）；硬上限改为 72 小时、支持任务级 `timeoutMs` 和模型调用上限 | 用户可在页面设定档位和顺序；模型不存在、限流在启动阶段可自动切换；实际模型可见 |
| 二 | 会话内切换续跑；关闭子进程自带重试；按候选并发；工作流传角色；对话落盘；等待外部任务模式与重启恢复（第 8.1 节） | 中途撞限制不丢进度、不重复操作；多天训练可监控到结束并自动分析 |
| 三 | 执行前权限、环境白名单、主模型受控执行模式、业务状态门禁 | 越权测试全部通过 |
| 四 | 跨会话共享额度状态；Dashboard 显示实时模型状态和子任务切换记录；按评测数据调整候选 | 多会话并发时不集中撞同一模型 |

第一期独立可交付，直接解决本次遇到的启动失败问题。

## 14. 风险与待决

- 错误文本因提供方而异，分类会有漏网：`unknown` 类保守处理并记录原文，持续补规则。
- 同档候选质量不完全相同，切换后结果可能变差：结果里标明实际模型，主模型验收时可见；评测确定候选顺序。
- 跨提供方会话内切换可能在消息格式上出问题：第二期先测，不通过则退回“只读重来、写入交主模型”。
- 超时很长时，卡死的任务可能很久才被发现：用模型调用次数和费用上限暂停任务，并保留无进展提醒；长时间等待一律使用等待外部任务模式，让模型不在等待中空转。
- 等待和升档都会增加时间或费用：由 `onExhausted` 显式配置，默认不升到 heavy 或 ultra。
- 所有服务商都可接收敏感数据（用户已确认）：自动切换可能把同一任务的数据发给多个服务商。切换记录里会写明实际使用的服务商，便于事后追查。
- 设置页和手工编辑同时修改配置文件：用修改时间检测冲突，不静默覆盖。

用户决策均已确认，见文首“已确认决策”。

## 15. 参考

- Pi 文档：`/home/tsien/local-pi/lib/node_modules/@earendil-works/pi-coding-agent/docs/settings.md`（Retry 节）、`docs/rpc.md`（`set_model`、`set_auto_retry`、`auto_retry_start/end`）、`docs/extensions.md`（`tool_call` 拦截）。
- 公开实践：Anthropic《Building effective agents》《How we built our multi-agent research system》；OpenAI Agents SDK 多智能体编排与安全检查文档；Claude Code 子代理文档；LangGraph 检查点文档。链接与要点见上游调研报告附录 A。
