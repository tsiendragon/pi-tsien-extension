# Harness 公平对比实验：pi vs codex vs claude（Vasile 不等式）

日期：2026-11-27
状态：已完成，三方均产出机器验证通过的证书

## 目的

在同一个**有明确正确答案、可机器验证**的数学任务上，用**同一个模型**（kimi-k3.1-pro）公平对比三个 harness（pi / codex / claude）的**成果、成本、速度**，验证 pi 的缓存/成本优化的实际价值。

## 方法

### 题目

Vasile 不等式：对任意实数 x,y,z，证明
`p = (x²+y²+z²)² − 3(x³y+y³z+z³x) >= 0`。

- 该不等式**有 SOS 证书**（已用 `proof_certify` 的 sos-rational 适配器确认可证）。
- **非平凡**：只用对角矩阵（单项式平方和）不可行，必须允许交叉项；循环错位使对称 ansatz 失配。考察模型是否知道建模成 SOS/SDP，而非靠背答案。

### 公平控制

- **同模型**：三方均 kimi-k3.1-pro。
- **同 prompt**：三方 TASK.md 逐字节相同（md5 一致）。
- **同起始状态**：三个相同独立目录 `/tmp/vasile-bench/{pi,codex,claude}/`。
- **纯推理**：要求手写 SOS 证书，**禁止调用任何 SOS/SDP 搜索求解工具**（proof_sos_search / sos-search / cvxpy / Clarabel / SCS / MOSEK / sympy SDP / 在线服务），禁止联网检索答案，禁止数值优化结果四舍五入。允许用精确有理数脚本**验证**自己写的证书（不得用来搜索）。
- **统一机器验证**：三方证书均由 `proof_certify`（sos-rational）独立验证，不采信任一方自称。

### 三方接入方式（同模型 kimi-k3.1-pro）

| 方 | 接入 |
|---|---|
| pi | `--model dashscope/kimi-k3.1-pro`（普通目录，proof_* 工具不激活，天然无 SOS 搜索工具） |
| codex | `codex exec --sandbox workspace-write`，自定义 provider `wire_api=responses` → `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` |
| claude | `claude -p`，`ANTHROPIC_BASE_URL=https://dashscope-intl.aliyuncs.com/apps/anthropic`，`ANTHROPIC_API_KEY=$DASHSCOPE_API_KEY` |

## 结果

三方**均产出 VERIFIED 证书**（proof_certify："exact identity holds and all Gram matrices are PSD"）。

| 方 | 成果 | 总 token¹ | input | cacheRead | output | 时间 | 轮数 |
|---|---|---|---|---|---|---|---|
| **pi** | VERIFIED | **141,057** | 22,218 | 96,256 | 22,583 | 669s | 6 |
| **codex** | VERIFIED | **1,051,395** | 528,614 | 514,048 | 8,733 | **198s** | 6 |
| **claude** | VERIFIED | 296,102 | 46,255 | 223,232 | 26,615 | 652s | 9 |

¹ 每轮累计的 input+cacheRead+output（真实 API 调用量）。measure.py 对 codex 自报的 total 用 input+output，与 pi/claude 口径不同，此处统一为三者之和。

证书形式（数学等价）：
- **pi**：6×6 循环对称 Gram 矩阵，秩 2，精确合同对角化 diag(0,0,0,0,1,3)。
- **claude**：6×6 Gram 矩阵（基 x²,y²,z²,xy,yz,zx），G = ½·Σ v_kv_kᵀ。
- **codex**：squares 形式 p = A² + ¾B²，A=x²−½y²−½z²−(3/2)xy+(3/2)yz，B=y²−z²−xy−yz+2zx。

## 分析

### 成本：pi 最省

- **总 token**：pi 141K < claude 296K < codex 1,051K。pi 只有 codex 的 **13%**。
- **缓存复用效率**（cacheRead/(input+cacheRead)）：pi **81%**、claude **83%**、codex **49%**。
- codex 每轮重发大量历史（input 累计 528K），缓存复用差；pi 的缓存优化（context-slim、稳定前缀）使 cacheRead 占比高、总 token 少。

### 速度：codex 最快（198s），原因是推理/输出量少

| 方 | output | reasoning | 平均每轮 |
|---|---|---|---|
| codex | **8,733** | **6,196** | ~33s |
| pi | 22,583 | 20,986 | ~112s |
| claude | 26,615 | （thinking 计入 output） | ~72s |

- **codex 的 output 和 reasoning 都最少**（output 8.7K、reasoning 6.2K），约为 pi 的 1/3。
- 关键区别在**推理预算/协议**：codex 走 responses API + reasoning effort（medium），kimi 的 reasoning 被压缩；pi 走 chat completions、claude 走 anthropic messages，kimi 的 thinking 更充分。
- **成果相同而 codex 思考更少**，说明该题对 kimi 而言"少思考也够"——codex 的 harness 引导更直接。速度差异主要来自**推理量**，不是 harness 的纯执行速度。

### 成果

三方打平——都独立推导出了数学等价的正确 SOS 证书。

## 公平性限制（诚实记录）

1. **首次运行的配置问题**：codex 第一次默认只读沙箱、claude 第一次非交互权限拒绝，均未能写入证书文件。codex 以写权限重跑、claude 的证书从日志 permission_denials 中提取（未重跑）。
2. **codex 官方自报 "tokens used 23,299"** 是去重口径，与每轮累计（1,051K）差异巨大；每轮累计才反映真实计费调用量。
3. **codex 重跑可能沾首次的 kimi 缓存光**（长保留缓存），但其 input 累计仍最高——缓存复用差是 codex harness 的本身特性，与是否重跑无关。
4. **推理预算不完全一致**：codex 的 reasoning effort 与 pi/claude 的 thinking 量不同（见速度分析）。成果相同说明该差异不影响本题正确性。

## 第二轮：deepseek-v4.1-flash + 统一 medium effort

为消除第一轮"codex 思考少、pi/claude 思考多"的推理预算不一致，第二轮换用 deepseek-v4.1-flash，并**统一三方 reasoning effort 为 medium**（codex `model_reasoning_effort=medium`、pi `--thinking medium`、claude `--effort medium`）。题目、纯推理约束、统一验证方式不变。

| 方 | 成果 | 总 token（每轮累计） | input（全价） | cacheRead | output | 时间 | 轮数 |
|---|---|---|---|---|---|---|---|
| **pi** | VERIFIED | **437,149** | **20,125** | 354,176 | 62,848 | **301s** | 19 |
| **codex** | VERIFIED | 8,200,221 | 4,150,450 | 4,000,128 | 49,643 | 362s | 32 |
| **claude** | VERIFIED | 963,083 | 179,520 | 724,992 | 58,571 | 309s | 21 |

缓存复用效率（cacheRead/(input+cacheRead)）：**pi 95%**、claude 80%、codex 49%。

### 两轮对照（总 token，每轮累计）

| 方 | kimi | deepseek |
|---|---|---|
| pi | 141K（最省） | 437K（最省） |
| codex | 1,051K（最多） | 8,200K（最多） |
| claude | 296K | 963K |

### 第二轮暴露的问题与处理

- **pi 首次输出截断**：pi 对 deepseek 的默认输出上限偏小，thinking medium 下 `Response was truncated`。调大 pi 的输出上限后重跑成功（codex 用同模型同 effort 不截断，证实是 pi 配置问题而非模型能力问题）。
- **claude 两次均权限拒绝**：claude -p 非交互默认拒绝 Write/Bash，证书从日志 permission_denials 提取（未重跑）。这是 claude harness 权限模型严格的体现。
- **codex 自报 "tokens used" 是去重口径**：deepseek 轮自报 199,965，但每轮累计 8.2M（32 轮每轮重发历史）。每轮累计才是真实计费调用量。

## 结论（两轮）

- **成果**：两轮三方均相当（全部 VERIFIED，独立证出 Vasile 不等式）。
- **成本**：**pi 最省 token 在两轮均成立**。pi 的全价 input 最少（deepseek 轮仅 20K，codex 高达 4.15M），缓存复用最高（95%）。这是 pi 缓存/上下文优化的直接价值。
- **速度**：第一轮 codex 最快源于**推理量少**（effort 不一致）；第二轮**统一 effort 后 codex 的速度优势消失，pi 反而最快**（301s < codex 362s）。证实 codex 的速度优势来自推理预算差异，而非 harness 本身更快。

## 复现

- 框架：`/tmp/vasile-bench/`（TASK.md.tmpl、run.sh、verify.sh、measure.py、三方子目录、_verify-project）。
- 启动：`bash /tmp/vasile-bench/run.sh {pi|codex|claude}`。
- 验证：`bash /tmp/vasile-bench/verify.sh <dir>`（`--self-test` 用已知正确证书自测）。
- 测量：`python3 /tmp/vasile-bench/measure.py {pi|codex|claude}`。
- 注意：该框架在 /tmp，重启后丢失；如需保留应归档到持久目录。
