# capability

把重复出现的任务沉淀成**可复用、可验证、可分层共享**的执行单元。

一个 capability = 一份契约（`CAPABILITY.yaml`）+ 一套实现（`impl/run.mjs`，可选 `prompts/`）+ 证据（`cases.jsonl`）。代码在 `node --permission` 沙箱里跑：无网络、读写受限，因此 **API key 永不进入沙箱**；模型调用由宿主代理，并统一记账。

## 零依赖接入

本扩展不假设任何特定仓库存在。capability 目录放在哪里都行，以下来源都会被扫描（**后者覆盖前者**，同名时业务能力压过通用能力）：

| 层 | 位置 | 说明 |
|---|---|---|
| L1 | `src/capability/capabilities/` | 随本扩展内置的通用能力 |
| L2 | `<项目目录>/.pi/capabilities/` | **任何仓库带上这个目录就能用，无需配置** |
| L2 | `~/.pi/agent/capability/capabilities/` | 用户全局 |
| L2 | `~/.pi/agent/capability.json` 的 `roots` | 指向任意仓库或目录 |
| L2 | 环境变量 `PI_CAPABILITY_ROOTS` | 测试 / 临时覆盖，`:` 分隔 |

例：让一个团队仓库贡献能力，只要在 `~/.pi/agent/capability.json` 写

```json
{ "roots": ["/path/to/your-team-repo/capabilities"] }
```

## 目录布局

两种都支持：

```
<root>/<name>/CAPABILITY.yaml              # 扁平
<root>/<name>/current/CAPABILITY.yaml      # marketplace 包布局
```

一个能力自包含：

```
<name>/
  CAPABILITY.yaml     # 契约
  impl/run.mjs        # 沙箱入口：stdin 收 job，stdout 出帧
  prompts/*.md        # llm 步骤的模板，{key} 占位符
  cases.jsonl         # 回归用例
```

## CAPABILITY.yaml

```yaml
name: log-triage
version: 0.1.0
sensitivity: public | internal | local   # 决定它属于哪一层
status: draft | trusted                  # 只有人工能改成 trusted
description: 一句话说明
when: 何时该用（会进入系统提示）
steps:
  - id: parse
    kind: code                           # 沙箱内确定性步骤
  - id: triage
    kind: llm                            # 宿主代理的模型调用
    prompt: prompts/triage.md
    model: provider/model
    max_tokens: 256
limits:
  max_llm_calls: 1
  timeout_ms: 30000
```

## 实现协议

`impl/run.mjs` 通过 stdout/stdin 每行一个 JSON 帧通信：

```js
// 沙箱 -> 宿主
{ "__frame__": "rpc", id, prompt_id, input, max_tokens }  // 请求模型
{ "__frame__": "result", output }                          // 终止帧
// 宿主 -> 沙箱
{ "__frame__": "job", input }
{ "__frame__": "rpc_result", id, ok, data?, error? }
```

沙箱里拿不到密钥、也连不上网，只能这样请求模型。

## 工具与命令

| 入口 | 谁触发 | 作用 |
|---|---|---|
| `capability_ls` | 模型 | 列出能力（层、状态、敏感度、when） |
| `capability_run` | 模型 | 在沙箱执行某个能力 |
| `/capability` | 用户 | 列出能力 |
| `/capability promote <name>` | **仅用户** | `draft → trusted` |
| `/capability demote <name>` | **仅用户** | `trusted → draft` |

promote/demote 做成命令而不是工具，因为工具是模型可调的——晋升必须由人决定。

## 运行产物

都写在用户目录，不污染任何仓库：

```
~/.pi/agent/capability/ledger/YYYY-MM-DD.jsonl     # 每次调用的 token / 成本 / 耗时
~/.pi/agent/capability/skills/capability/SKILL.md  # 自动生成，用于让模型知道有哪些能力
```

## 为什么值得用

子任务在对话里做，成本是**这一轮携带的完整上下文**；作为 capability 执行，是**独立的最小调用**。实测单步能力约 60–190 tokens，而长会话单轮上下文是 2,000–39,000 tokens。

代价是多一次工具往返（约 1 秒）和常驻的工具 schema。所以它适合**重复出现、需要固定输出结构、需要留痕**的任务，不适合一次性小问题。