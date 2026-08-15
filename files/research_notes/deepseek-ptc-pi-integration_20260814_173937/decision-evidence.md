# compact_result_v1

**status**: completed（仅给决策框架，不替代最终路线决策）

## 事实边界

- PTC（程序化工具调用）的核心不是“让模型调用一个 bash 工具”，而是：模型生成程序；程序在隔离环境中循环、条件化或并行调用受控工具；中间结果留在执行环境，最终压缩结果才回到模型上下文。
- Anthropic 的公开合同证明这类能力需要处理暂停/续跑、`caller` 关联、容器状态和特殊结果格式；其 `allowed_callers` 只是模型引导，**不是安全边界**。
- Anthropic 数据只能作为 PTC 参考语义和 workload 假设，不能直接当作 DeepSeek 协议合同或收益证明。进入实现前必须取得目标 DeepSeek 端点的请求/流式响应 fixture、版本与错误语义。

## 加权决策标准（总计 100）

采用 1–5 分，`加权分 = Σ(权重 × 分数/5)`；只认可原型或测试证据，不凭架构直觉打分。**任一硬门槛失败即淘汰该路线，不用总分抵消。**

| 标准 | 权重 | 5 分所需证据 | 路线敏感点 |
|---|---:|---|---|
| 安全隔离与最小权限 | 22 | 逃逸/越权/外联/秘密读取测试全阻断，策略默认拒绝 | 扩展与 Pi 同用户权限运行，必须另设 OS/VM 边界；核心接入也不能把进程内检查当沙箱 |
| 协议与语义完整度 | 17 | 暂停/续跑、并行、取消、部分失败、容器过期、直接调用降级均与目标 provider fixture 一致 | 核心可增加原生状态；扩展钩子可改请求，但标准消息循环只认识普通 `toolCall`/`toolResult` |
| 能力代理正确性 | 13 | 每次子调用都经过 schema、allowlist、参数规范化、用户门禁和审计 | 扩展公开 API 能列工具元数据，但没有通用“执行任意已注册工具”的稳定 broker；通常要自有/包装代理 |
| 性能与成本收益 | 12 | 在目标流量混合上，质量不降且 token、往返或端到端时延至少一项跨阈值 | provider 原生 PTC 更可能保留中间结果；本地仿真可能增加启动和 IPC 成本 |
| 可观测性与可审计性 | 11 | 外层 turn→program→子调用 DAG 100% 可关联，含限额、取消、重试和脱敏 | 核心最容易复用事件流；扩展需补内层事件，不能只把所有工作折叠成一个工具结果 |
| 确定性与可重放 | 9 | 固定程序+录制代理结果可稳定重放；副作用不被重复执行 | 需要持久化程序、策略/镜像/schema 哈希、调度顺序，而不只是最终文本 |
| Provider 可移植性 | 8 | 通用 IR/能力合同通过至少两个后端或“原生+仿真”一致性套件 | 原生协议易锁定 `caller/container`；扩展仿真更通用但语义保真度较低 |
| 上线风险与维护成本 | 8 | 可热关、可回退直接调用、会话兼容、故障域清晰 | 扩展适合低爆炸半径试验；核心改动面更大但可避免长期双栈和重复 broker |

### 硬门槛

1. 模型生成程序不得在 Pi/扩展宿主进程内直接执行；必须有真实 OS、容器、微虚机或远端沙箱边界。
2. 子程序只拿显式能力，不拿宿主文件系统、环境变量、网络、任意 shell 或 provider 凭证。
3. CPU、内存、进程数、磁盘、墙钟、输出字节、工具调用数、并发数和租户速率全部可强制终止。
4. 每个子调用可审计、可取消；敏感参数/结果默认脱敏。
5. 有单开关回退到传统直接工具调用，且回退不破坏会话。
6. 目标 provider 的真实协议 fixture 通过；不得把 Anthropic 的字段名假定为 DeepSeek 字段名。

## 威胁模型

**资产**：宿主源码与会话、用户/云凭证、内网和外部服务、工具写权限、算力/账单、审计记录。<br>
**不可信输入**：模型生成程序、仓库/网页提示注入、用户输入、外部工具返回文本。<br>
**信任边界**：provider 响应解析 → PTC 调度器 → 沙箱 → 能力代理 → 真实工具/外部系统。

| 威胁 | 典型攻击 | 必需控制 |
|---|---|---|
| 沙箱逃逸/秘密泄露 | 读 `$HOME`、env、socket、宿主挂载；DNS/HTTP 外传 | 非 root、只读根、最小只读输入、独立临时盘、禁网、无宿主 socket/凭证、镜像固定摘要 |
| Confused deputy | 通过通用 `invoke(name,args)` 绕过权限，路径穿越/符号链接越界 | 默认拒绝的 `ptcCallable` allowlist；预绑定窄函数；路径 canonicalize；每次调用再鉴权；短期委托令牌 |
| 工具结果注入 | 工具返回代码/命令，被程序再次解释执行 | 结构化序列化；结果仅作数据；禁止 `eval/exec` 结果；schema 与大小校验 |
| 资源耗尽 | 无限循环、fork bomb、内存/磁盘/输出爆炸、工具 fan-out、重试风暴 | cgroup/VM 限额、PID 限额、deadline、调用预算、并发信号量、输出截断、队列配额、熔断 |
| 副作用放大/重放 | 批量写、重复支付/提交、取消后仍执行 | PTC 默认只读；写工具独立授权；幂等键、dry-run、补偿记录；取消信号贯穿代理 |
| 并发竞态 | 并行写同一资源、乱序结果污染 | 资源级锁/版本前置条件；记录实际完成顺序；有副作用工具默认串行 |
| 审计欺骗 | 内层调用被折叠，程序或结果被篡改 | append-only 调用 DAG；记录 program hash、tool schema hash、策略版本、镜像摘要、父调用 ID、状态/耗时/字节/限额原因 |

**建议的只读 canary 初始上限**（需压测后调）：程序 64 KiB、32 次子调用、并发 4、嵌套深度 1、单调用 20 秒、整段 60 秒、输出 1 MiB；这些是保护性起点，不是产品常量。

## 两条路线需要分别证明什么

### 核心原生候选

建立 provider adapter → 通用 PTC IR（program start / pause / child call / result / complete）→ 统一 tool broker → 沙箱；扩展 AgentMessage、流式事件和 session entry，而不是让 Anthropic/DeepSeek 私有字段泄漏到 Agent loop。它应证明：原生 provider 状态可无损续跑；所有内层调用仍经过 Pi 的门禁、事件和持久化；旧 provider/旧 session 不受影响。

### 扩展候选

把 PTC 明确定位为**仿真或 provider 专用试验层**：注册 `ptc_execute`，程序在子进程/VM 中运行，只连接扩展拥有的能力代理。`before_provider_request`/`after_provider_response` 标准钩子不足以无损接管 provider 的 server-tool 流；完整自定义 provider 虽可隐藏协议处理，但仍无法给核心新增原生内容块、暂停状态和内层工具事件。它应证明：无需复制大量 Pi 工具实现；内层审计和取消完整；扩展卸载后会话仍可读。

## 确定性与重放合同

- 不承诺“模型再次生成同一程序”；只承诺**固定 program artifact + 固定 runtime + 录制代理响应**的执行重放。
- 记录：程序原文与 hash、模型/provider/request ID、工具 schema/catalog hash、策略版本、沙箱镜像摘要、随机种子、虚拟时钟、locale/env allowlist、调用 DAG 与完成顺序。
- replay 模式禁止访问真实工具；读录制结果。外部写操作只验证幂等键/预期调用，不重新执行。
- 验收对象是最终规范化输出和调用 DAG；并行任务不要求真实时间戳或完成时序逐字节相同。

## 验证矩阵

| 维度 | 最小测试集 | 建议通过门槛 |
|---|---|---|
| 协议 | 直接/程序化混合、暂停续跑、多 pending call、过期、取消、部分失败、流式分片 | fixture 全通过；未知 block fail closed；无会话丢失 |
| 能力策略 | 未登记工具、参数越界、路径穿越、symlink、直接调用绕过、写工具 | 100% 阻断；每次拒绝有 reason 和关联 ID |
| 隔离 | 宿主 canary、env、凭证目录、Unix socket、内网/公网、跨沙箱文件 | 0 次可达；沙箱销毁后无可复用秘密 |
| DoS | 无限循环、递归、fork、内存/磁盘/stdout 爆炸、32+ fan-out、慢工具 | 在设定上限内终止；宿主保持响应；资源回收无泄漏 |
| 语义正确性 | loop、条件、并行、聚合、空结果、工具错误 | 与直接调用基线任务成功率非劣；副作用次数完全一致 |
| 重放 | 固定程序+录制结果，含并行和错误 | 规范化输出及 DAG hash 一致；真实工具调用为 0 |
| 可观测性 | 成功、拒绝、超时、取消、重试、回退 | 100% 外层/内层关联；秘密 canary 不出现在日志 |
| 性能 | A: 1–2 次小型顺序；B: 5–10 次混合；C: 20–50 次 fan-out/大结果 | 分层报告，不用总体均值掩盖退化；质量先非劣，再比较收益 |
| 兼容/回滚 | 扩展开关、provider 切换、旧 session、运行中 kill switch | 回退成功率 100%；无重复副作用；旧 session 可恢复 |

**性能测量**：固定模型版本、工具 fixture、提示、并发和缓存状态，做成对 A/B；同时记录任务成功率、模型往返数、billed input/output token、上下文字节、p50/p95/p99 总时延、首调用/沙箱启动时延、工具等待、CPU/内存峰值、provider 执行费用、重试/超时率。Anthropic 自报在适合的多工具负载有明显 token 节省，但单次/少量顺序调用可能约贵 8%；因此不要设“PTC 全流量更快”的验收目标。

## 上线顺序

1. **Trace-only**：解析/记录候选程序，不执行；收集 workload 分层和理论调用预算。
2. **只读 opt-in**：单 provider、少量只读代理、禁网沙箱；默认传统调用。
3. **成对 canary**：只放行 B/C 类 workload；逐级 1%→5%→25%，每级检查质量、p95、拒绝率、账单和资源回收。
4. **能力扩展**：先幂等读，再幂等写；高风险写始终留在程序外做人机门禁。
5. **保持双向开关**：按 provider/model/tool/workload 关闭 PTC；协议未知、沙箱不健康、预算耗尽时自动回退。

**不做最终路线决策的判定规则**：两条候选分别跑同一矩阵并打分。若目标要求 provider 原生暂停/容器语义，而扩展无法通过协议与事件门槛，则该事实进入决策；若扩展仿真已达到质量、安全和收益门槛，则核心改造必须用额外可测收益证明其成本。不要先按“更优雅”选路线。

## 证据（5 条）

1. Anthropic PTC 官方合同、限制与性能边界：https://platform.claude.com/docs/en/agents-and-tools/tool-use/programmatic-tool-calling
2. Anthropic code-execution 官方隔离、资源、网络、计费与留存事实：https://platform.claude.com/docs/en/agents-and-tools/tool-use/code-execution-tool
3. Pi 明确无内置沙箱、扩展与宿主同权限，并要求外部隔离：`/mnt/workspace/lilong/repos/pi-local-release/node/node_modules/@earendil-works/pi-coding-agent/docs/security.md:3-53`
4. Pi 扩展只可改 provider 请求、观察响应头，工具钩子围绕普通调用，工具目录 API 主要暴露元数据：`/mnt/workspace/lilong/repos/pi-local-release/node/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md:678-713,751-854,1650-1680`
5. Pi 当前 Agent loop 从 assistant 内容筛选普通 `toolCall`，执行后回填 `toolResult` 并开始下一轮：`/mnt/workspace/lilong/repos/pi-local-release/node/node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js:78-138,178-254,287-294`
