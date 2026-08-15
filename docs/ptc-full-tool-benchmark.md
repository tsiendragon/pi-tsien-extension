# PTC Tool Benchmark：只读与读写运行

## 总览

本报告统一展示两个阶段：

1. **阶段一：只读 PTC**——读取分片并完成过滤、聚合、排序和 checksum。
2. **阶段二：读写运行 PTC full**——读取代码、写入修复、运行测试并迭代。

节省率只统计普通模式和 PTC 都语义正确的同级样本。正数表示 PTC 节省，负数表示 PTC 增加。语义正确与 clean run 分开：clean run 还要求严格 JSON、工具完全合规且无工具错误。

# 阶段一：只读

完整原始结果仍保存在 [ptc-model-complexity-results.json](./ptc-model-complexity-results.json)，详细方法见 [ptc-model-complexity-benchmark.md](./ptc-model-complexity-benchmark.md)。

## 能力上限

| 模型 | 最高语义正确级别 | 该级正确率 |
|---|---:|---:|
| GPT-5.6 Sol | C6 | 2/2 |
| GPT-5.6 Terra | C6 | 2/2 |
| GPT-5.6 Luna | C6 | 2/2 |
| DeepSeek V4 Flash | C6 | 1/1 |
| DeepSeek V4 Pro | C5 | 1/1 |

C4 上普通模式五个模型均错误或 300 秒超时，PTC 五个模型均达到至少 3/3 正确。DeepSeek Pro 在 C6 为 0/2；Flash 虽能完成 C6，但约消耗 149 万 token，不具备实用性。

## 双方正确样本的节省

| 模型 | 可比级别 | 时间节省 | token 节省 |
|---|---|---:|---:|
| GPT-5.6 Sol | C1, C2 | 67.8% | 54.5% |
| GPT-5.6 Terra | C1 | 50.9% | 40.3% |
| GPT-5.6 Luna | 无 | 不可比 | 不可比 |
| DeepSeek V4 Flash | C2 | 93.2% | 73.9% |
| DeepSeek V4 Pro | C1, C2 | 62.5% | -20.9% |

Luna 没有普通/PTC 同时正确的只读基础样本，因此不报告节省率。Pro 的只读 PTC 虽节省时间，但 token 增加 20.9%。

# 阶段二：读、写、运行

## 公平对照

- 普通模式：Pi 顶层 `read/find/grep/ls/write/bash`；bash 仅允许运行 `node tests/run.mjs`。
- PTC 模式：顶层只有 `run_code`，内部调用等价的 `read/find/grep/ls/write/run`。
- 两边使用独立但内容相同的夹具、相同模型、相同 300 秒超时和相同独立测试。
- F1–F4 共 40 次正式成对运行；20 对在语义层面全部双方正确。

## F1–F4 汇总节省

| 模型 | 普通语义正确 | PTC 语义正确 | 普通 clean | PTC clean | 时间节省 | token 节省 |
|---|---:|---:|---:|---:|---:|---:|
| GPT-5.6 Sol | 4/4 | 4/4 | 4/4 | 3/4 | 32.5% | 26.6% |
| GPT-5.6 Terra | 4/4 | 4/4 | 4/4 | 1/4 | 14.1% | 48.8% |
| GPT-5.6 Luna | 4/4 | 4/4 | 4/4 | 3/4 | 51.1% | 42.9% |
| DeepSeek V4 Flash | 4/4 | 4/4 | 0/4 | 0/4 | 43.5% | 19.8% |
| DeepSeek V4 Pro | 4/4 | 4/4 | 1/4 | 1/4 | 53.7% | 37.3% |

说明：DeepSeek native 的语义结果全部正确，但部分不是 clean run。Flash 自动给测试命令增加 `cd`/重定向；Pro 有一次用额外 `echo` 辅助输出；多个模型还出现 Markdown JSON fence。它们不影响独立测试真值，但计为工具或格式不合规。

## 每级绝对值与节省率

| 模型 | 级别 | 普通耗时 ms | PTC 耗时 ms | 时间节省 | 普通 token | PTC token | token 节省 |
|---|---:|---:|---:|---:|---:|---:|---:|
| GPT-5.6 Sol | F1 | 27492 | 27633 | -0.5% | 29791 | 23609 | 20.8% |
| GPT-5.6 Sol | F2 | 50606 | 39541 | 21.9% | 35468 | 31559 | 11% |
| GPT-5.6 Sol | F3 | 62827 | 45646 | 27.3% | 32361 | 22366 | 30.9% |
| GPT-5.6 Sol | F4 | 92722 | 44863 | 51.6% | 41905 | 24947 | 40.5% |
| GPT-5.6 Terra | F1 | 24165 | 29304 | -21.3% | 28590 | 28538 | 0.2% |
| GPT-5.6 Terra | F2 | 31376 | 32958 | -5% | 31154 | 29742 | 4.5% |
| GPT-5.6 Terra | F3 | 72108 | 35118 | 51.3% | 140015 | 21178 | 84.9% |
| GPT-5.6 Terra | F4 | 65806 | 68748 | -4.5% | 35380 | 40950 | -15.7% |
| GPT-5.6 Luna | F1 | 34815 | 21691 | 37.7% | 30794 | 23434 | 23.9% |
| GPT-5.6 Luna | F2 | 34150 | 40281 | -18% | 32216 | 30958 | 3.9% |
| GPT-5.6 Luna | F3 | 78949 | 29026 | 63.2% | 50819 | 20726 | 59.2% |
| GPT-5.6 Luna | F4 | 96116 | 28316 | 70.5% | 58760 | 23388 | 60.2% |
| DeepSeek V4 Flash | F1 | 18932 | 13234 | 30.1% | 41154 | 29710 | 27.8% |
| DeepSeek V4 Flash | F2 | 16322 | 16731 | -2.5% | 35011 | 42027 | -20% |
| DeepSeek V4 Flash | F3 | 34262 | 13888 | 59.5% | 53950 | 20996 | 61.1% |
| DeepSeek V4 Flash | F4 | 43755 | 20191 | 53.9% | 55285 | 55871 | -1.1% |
| DeepSeek V4 Pro | F1 | 28808 | 17809 | 38.2% | 39196 | 23641 | 39.7% |
| DeepSeek V4 Pro | F2 | 39660 | 30445 | 23.2% | 44331 | 31765 | 28.3% |
| DeepSeek V4 Pro | F3 | 69605 | 31473 | 54.8% | 67841 | 41868 | 38.3% |
| DeepSeek V4 Pro | F4 | 84287 | 23271 | 72.4% | 61185 | 35930 | 41.3% |

小任务存在固定开销：例如 Terra F1/F2 和 Luna F2 的 PTC 时间反而增加。随着写入数量上升，PTC 通常开始占优；但 provider 波动会让单次格子不单调。

## PTC 能力上限

以下保留此前 39 个 PTC-only F1–F7 样本，用于测试最大批量写入能力，不用于计算节省率。

| 模型 | F1 | F2 | F3 | F4 | F5 | F6 | F7 |
|---|---:|---:|---:|---:|---:|---:|---:|
| GPT-5.6 Sol | 1/1 | 1/1 | 1/1 | 1/1 | 1/1 | 1/1 | 1/1 |
| GPT-5.6 Terra | 1/1 | 1/1 | 1/1 | 1/1 | 1/1 | 1/1 | 1/1 |
| GPT-5.6 Luna | 1/1 | 1/1 | 1/1 | 1/1 | 1/1 | 2/3 | 2/3 |
| DeepSeek V4 Flash | 1/1 | 1/1 | 1/1 | 1/1 | 1/1 | 1/1 | 1/1 |
| DeepSeek V4 Pro | 1/1 | 1/1 | 1/1 | 1/1 | 1/1 | 1/1 | 1/1 |

- Sol、Terra、Flash、Pro 完成最高测试级 F7：128 个源码写入、1,032 个断言。
- Luna 在 F6、F7 均为 2/3，建议默认限制在 F5 / 48 模块。
- Flash F7 约 28.3 万 token；Pro F7 写入 256 次，相当于完整重写两轮。因此能力上限不等于实用上限。

# 安全边界

- `/ptc on` 和 `/ptc both` 保持只读；只有显式 `/ptc full` 开放受检查的 write/run。
- write 只能写工作区真实路径，并禁止 `.git`、`.pi`、凭据目录和 `node_modules`。
- run 只能以只读工作区权限执行 `.js/.mjs`，没有 shell、网络、子进程、Worker 或原生 addon。
- Node 权限模型只是实验性 containment，不是生产级恶意代码沙箱。

# 复现

```bash
# 阶段一
node scripts/ptc-model-complexity-benchmark.mjs \
  --models=openai-codex/gpt-5.6-sol \
  --levels=C1,C2,C3,C4,C5,C6 \
  --modes=native,ptc --trials=1 --output=/tmp/ptc-readonly.json

# 阶段二成对对照
node scripts/ptc-full-tool-benchmark.mjs \
  --models=openai-codex/gpt-5.6-sol \
  --levels=F1,F2,F3,F4 \
  --modes=native,ptc --trials=1 --output=/tmp/ptc-full-paired.json
```

统一机器可读数据见 [ptc-full-tool-results.json](./ptc-full-tool-results.json)。

# 限制

- 除 Luna 的高复杂度边界外，多数格子只有一次运行；单格耗时受 provider 负载影响。
- 第二阶段只在 F1–F4 做 native/PTC 对照；F5–F7 仅衡量 PTC 能力，避免普通模式产生大量高成本工具上下文。
- 阶段二是规则驱动的批量模块修复，不代表开放式架构设计或任意真实仓库修改。
