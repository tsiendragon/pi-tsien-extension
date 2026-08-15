# PTC Model Complexity Benchmark

## 结论

- GPT-5.6 Sol、Terra、Luna 在最高测试级 C6（80 个分片、2,560 条记录、约 83 次只读子调用，至少 3 个 run_code）均达到 2/2 语义正确。
- DeepSeek V4 Flash 在 C6 仍正确，但 C5/C6 分别消耗约 110 万/149 万 token，不具备实用性。
- DeepSeek V4 Pro 在 C5 正确、C6 为 0/2，因此能力边界位于 48 到 80 个分片之间；无人值守建议限制在 C4。
- 普通模式在 C3 开始频繁计算错误，在 C4 五个模型均错误或 300 秒超时；PTC 在 C4 的五个模型都达到 3/3 语义正确。
- DeepSeek 经常用 Markdown JSON 代码块返回结果，因此必须做 JSON fence 归一化和结果校验。

## 复杂度阶梯

| 级别 | 分片 | 每片记录 | 总记录 | 估算子调用 | 最少 run_code |
|---|---:|---:|---:|---:|---:|
| C1 | 2 | 16 | 32 | 5 | 1 |
| C2 | 6 | 24 | 144 | 9 | 1 |
| C3 | 14 | 28 | 392 | 17 | 1 |
| C4 | 28 | 32 | 896 | 31 | 1 |
| C5 | 48 | 32 | 1536 | 51 | 2 |
| C6 | 80 | 32 | 2560 | 83 | 3 |

每条记录需要跨文件应用过滤规则、覆盖倍率、区域聚合、Top-7 排序和模校验和。答案由本地脚本计算，不向模型暴露。单次运行超时为 300 秒。

## 模型能力与建议上限

| 模型 | 最高正确级别 | 最高级成功率 | C4 PTC | C6 PTC | 建议最大分片 |
|---|---|---:|---:|---:|---:|
| GPT-5.6 Sol | C6 | 2/2 | 3/3 | 2/2 | 80 |
| GPT-5.6 Terra | C6 | 2/2 | 3/3 | 2/2 | 80 |
| GPT-5.6 Luna | C6 | 2/2 | 4/4 | 2/2 | 80 |
| DeepSeek V4 Flash | C6 | 1/1 | 3/3 | 1/1 | 28 |
| DeepSeek V4 Pro | C5 | 1/1 | 3/3 | 0/2 | 28 |

“最高正确级别”表示本次测试能力，不等于生产建议。完整建议见 [ptc-model-complexity-config.json](./ptc-model-complexity-config.json)。

### PTC 语义正确率矩阵

| 模型 | C1 | C2 | C3 | C4 | C5 | C6 |
|---|---:|---:|---:|---:|---:|---:|
| GPT-5.6 Sol | 1/1 | 1/1 | 1/1 | 3/3 | 1/1 | 2/2 |
| GPT-5.6 Terra | 1/1 | 1/1 | 2/2 | 3/3 | 1/1 | 2/2 |
| GPT-5.6 Luna | 1/1 | 1/1 | 1/1 | 4/4 | 1/1 | 2/2 |
| DeepSeek V4 Flash | 1/2 | 1/1 | 3/3 | 3/3 | 1/1 | 1/1 |
| DeepSeek V4 Pro | 1/1 | 1/1 | 3/4 | 3/3 | 1/1 | 0/2 |

此表按最终 JSON 的数值是否完全等于本地真值评分；Markdown 包裹但数值正确计为语义正确，工具或格式重试不计为 clean run。

## C4 对照

| 模型 | 普通模式正确 | PTC 正确 | PTC 正确样本平均耗时 | PTC 正确样本平均 token |
|---|---:|---:|---:|---:|
| GPT-5.6 Sol | 0/1 | 3/3 | 21590 ms | 10472 |
| GPT-5.6 Terra | 0/1 | 3/3 | 32773 ms | 14350 |
| GPT-5.6 Luna | 0/1 | 4/4 | 37438 ms | 20254 |
| DeepSeek V4 Flash | 0/1 | 3/3 | 23374 ms | 31029 |
| DeepSeek V4 Pro | 0/1 | 3/3 | 36234 ms | 56418 |

C4 中普通模式全部错误或超时，因此无法计算严格的“双方都正确”节省比例；PTC 已在质量上形成明显优势。

## 可比样本的节省比例

只聚合普通模式与 PTC 都语义正确的同级样本。正数表示 PTC 节省，负数表示 PTC 增加。

| 模型 | 可比级别 | 耗时节省 | token 节省 |
|---|---|---:|---:|
| GPT-5.6 Sol | C1, C2 | 67.8% | 54.5% |
| GPT-5.6 Terra | C1 | 50.9% | 40.3% |
| GPT-5.6 Luna | 无 | 不可比 | 不可比 |
| DeepSeek V4 Flash | C2 | 93.2% | 73.9% |
| DeepSeek V4 Pro | C1, C2 | 62.5% | -20.9% |

Luna 没有普通/PTC 同时正确的基础级样本，因此不报告节省率。DeepSeek Pro 虽然耗时下降，但 PTC 的自我修正导致 token 增加。

## 模型配置建议

- **GPT-5.6 Sol**：允许到 C6；单次程序仍限制 32 子调用，总体最多 4 个 run_code，建议 55k token / 90 秒预算。
- **GPT-5.6 Terra**：允许到 C6；最多 4 个 run_code，建议 65k token / 100 秒预算。
- **GPT-5.6 Luna**：允许到 C6，但更容易路径重试；最多 5 个 run_code，建议 85k token / 110 秒预算。
- **DeepSeek V4 Flash**：能力可到 C6，但实用上限设为 C4；禁止默认进入跨程序级别，建议 60k token / 90 秒预算。
- **DeepSeek V4 Pro**：能力到 C5，C6 失败 0/2；无人值守上限设为 C4，建议 150k token / 90 秒预算。

扩展现在按模型执行 run_code 次数、总子调用、活跃耗时和 token 边界；分片数、记录数仍因无法从任意程序可靠推断而保持建议值。`resultContract` 可校验必需键、精确键、整数计数/checksum 和数组长度；失败返回结构化错误。

## 已发现并修复的原型问题

边界复测发现子进程完成后仍可能有只读调用回写 stdin，触发 `ERR_STREAM_WRITE_AFTER_END` 并导致 Pi 退出。已在 `extensions/ptc.ts` 增加关闭状态检查和 stdin 错误处理。受该缺陷影响的 3 次运行已从统计中剔除，并在修复后复测。

## 复现

```bash
node scripts/ptc-model-complexity-benchmark.mjs \
  --models=openai-codex/gpt-5.6-sol \
  --levels=C1,C2,C3,C4,C5,C6 \
  --modes=native,ptc \
  --trials=1 \
  --output=/tmp/ptc-results.json
```

原始合并数据见 [ptc-model-complexity-results.json](./ptc-model-complexity-results.json)。

## 限制

- C1-C4 基础矩阵每格 1 次；C3/C4 边界和 C6 对关键模型做了额外复测，仍不是大样本统计。
- 延迟受外部 provider 负载影响；OpenAI 与 DashScope 分两条队列并行，同一 provider 内串行。
- 普通模式 C4 的 token 是超时前部分用量，不能用来计算严格 token 节省。
- 合成任务主要覆盖结构化读取、过滤、连接和聚合，不代表写代码、搜索开放问题或非结构化推理。
