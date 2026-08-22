# Luna 真实模型实验报告

- 生成时间：2026-08-15T13:37:15.051Z
- 测试提交：`372b371e406934680c7e9a8faa50d838ff2d1db4`
- Pi：0.84.1
- Provider：`openai-codex`
- Model：`gpt-5.6-luna`
- Thinking：minimal
- 命令：`npm run experiment:luna`

## 结论

**PASS：5/5 项真实模型实验通过。**

共发生 7 次真实 Luna 调用；输入 12827 tokens，输出 349 tokens，总计 13176 tokens，报告费用 $0.0029842。

## 实验矩阵

| ID  | 实验                         | 结果 |  耗时 ms |
| --- | ---------------------------- | ---- | -------: |
| L1  | 简单精确指令                 | PASS | 34984.74 |
| L2  | 复杂优先级调度推理           | PASS | 10937.18 |
| L3  | 64 KiB 长 prompt 保真        | PASS |  5689.38 |
| L4  | 超大 prompt 在模型调用前拒绝 | PASS |     0.59 |
| L5  | activeLimit=2 的四路真实并发 | PASS | 10291.27 |

## 详细结果

### L1 简单精确指令

- 结果：**PASS**
- 耗时：34984.74 ms
- `output`: LUNA_SIMPLE_OK
- `runId`: run_753368023f47
- `latencyMs`: 34983.73
- `inputTokens`: 50
- `outputTokens`: 8
- `totalTokens`: 58
- `costUsd`: 0.000019600000000000002
- `stopReason`: stop
- `eventCount`: 16
- 结论：Luna 经 Pi CLI provider 和 SubagentService 返回精确结果。

### L2 复杂优先级调度推理

- 结果：**PASS**
- 耗时：10937.18 ms
- `observedOrder`: C1 → B1 → A1 → D1 → A2
- `expectedOrder`: C1 → B1 → A1 → D1 → A2
- `runId`: run_9d9a059e53ca
- `latencyMs`: 10936.8
- `inputTokens`: 146
- `outputTokens`: 186
- `totalTokens`: 332
- `costUsd`: 0.00025239999999999996
- `stopReason`: stop
- `eventCount`: 55
- 结论：Luna 正确应用严格优先级、subject FIFO 和 round-robin。

### L3 64 KiB 长 prompt 保真

- 结果：**PASS**
- 耗时：5689.38 ms
- `taskBytes`: 65697
- `markers`: BEGIN_LUNA_64K → MIDDLE_LUNA_64K → END_LUNA_64K
- `runId`: run_57b055aad54e
- `latencyMs`: 5689.03
- `inputTokens`: 12391
- `outputTokens`: 30
- `totalTokens`: 12421
- `costUsd`: 0.0025142000000000003
- `stopReason`: stop
- `eventCount`: 38
- 结论：64 KiB 输入经过 runtime 和真实模型后保留首、中、尾标记。

### L4 超大 prompt 在模型调用前拒绝

- 结果：**PASS**
- 耗时：0.59 ms
- `taskBytes`: 1048577
- `limitBytes`: 1048576
- `errorCode`: task_too_large
- `modelCalls`: 0
- 结论：1 MiB+1 prompt 在 Session/provider/model 前拒绝，真实模型调用数为 0。

### L5 activeLimit=2 的四路真实并发

- 结果：**PASS**
- 耗时：10291.27 ms
- `submitted`: 4
- `completed`: 4
- `activeLimit`: 2
- `maxActiveProcesses`: 2
- `elapsedMs`: 10291.11
- `outputs`: LUNA_CONCURRENT_A → LUNA_CONCURRENT_B → LUNA_CONCURRENT_C → LUNA_CONCURRENT_D
- `activeAfterCompletion`: 0
- `queuedAfterCompletion`: 0
- 结论：四次 Luna 调用均完成，真实 Pi 子进程峰值严格受 activeLimit=2 约束。

## 验证边界

- 真实调用通过 Pi 0.84.1 JSON 模式和 `SubagentService` process provider seam。
- Pi CLI 禁用 tools、extensions、skills、prompt templates、context files 和 session 持久化。
- 64 KiB 是实际发送给 Luna 的长 prompt；1 MiB+1 实验应在模型调用前拒绝，因此不会产生模型费用。
- 四路并发要求真实 Pi 子进程峰值严格等于 activeLimit=2，结束后 active/queued 为 0。

## 未验证与风险

- 该 provider 是实验适配器，不是最终 native/process production provider。
- 未发送接近模型最大 context 的 prompt；这样做费用高且不能替代 provider context-window 元数据验证。
- 未验证工具调用、真实 transcript continuation、RPC/mux、长期 soak、网络重试和服务端限流。
- 首次调用可能包含 OAuth 刷新、进程启动或服务端冷启动；本次 L1 延迟明显高于后续调用，不能只用单样本估算稳定延迟。
- 模型输出与延迟可能随服务端版本和负载变化，重跑报告会产生不同指标。

原始结果：[luna-model-experiment-report.json](luna-model-experiment-report.json)。
