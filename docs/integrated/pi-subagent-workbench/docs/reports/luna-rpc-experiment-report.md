# Luna Pi RPC Provider 真实实验报告

- 生成时间：2026-08-15T16:07:00.670Z
- 测试提交：`d802891c5dd2ba81468b51dd677cbaf6a2792853`
- Pi：0.84.1
- Provider：`openai-codex`
- Model：`gpt-5.6-luna`
- Transport：`pi --mode rpc`
- Thinking：minimal
- 命令：`npm run experiment:luna-rpc`

## 结论

**PASS：5/5 项真实 RPC 模型实验通过。**

发起 10 个 Service Run，Pi RPC 接受 10 个真实模型 prompt，其中 8 个正常完成并返回 usage；输入 519 tokens，输出 120 tokens，cache read 0 tokens，正常完成 Run 的报告费用 $0.0002478。被中断和被强制终止的请求可能已在服务端产生未回传 usage，费用不包含在上述数字内。

## 实验矩阵

| ID | 实验 | 结果 | 耗时 ms |
|---|---|---|---:|
| R1 | 同一 RPC ChildSession 两轮续聊 | PASS | 8226.58 |
| R2 | 真实 Luna explicit context | PASS | 3984.67 |
| R3 | activeLimit=2 的四 Session 真实并发 | PASS | 9297.05 |
| R4 | RPC abort 后同 Session 继续 | PASS | 4134.34 |
| R5 | 强制 RPC 退出后的 tombstone | PASS | 2399.71 |

## 详细结果

### R1 同一 RPC ChildSession 两轮续聊

- 结果：**PASS**
- 耗时：8226.58 ms
- `sessionId`: session_6a841a6e16d1
- `firstRunId`: run_829214e38b81
- `secondRunId`: run_3fcd69ae264c
- `processPid`: 3962971
- `sameProcess`: true
- `firstOutput`: ACK_7319
- `secondOutput`: LUNA_RPC_MEMORY_7319
- `firstUsage`: {"input":62,"output":8,"cacheRead":0,"cacheWrite":0,"cost":0.000022}
- `secondUsage`: {"input":91,"output":48,"cacheRead":0,"cacheWrite":0,"cost":0.0000758}
- 结论：同一 Workbench ChildSession 的两个 Run 复用同一 Pi RPC 进程并保留模型上下文。

### R2 真实 Luna explicit context

- 结果：**PASS**
- 耗时：3984.67 ms
- `sessionId`: session_33914a75744f
- `runId`: run_4338faf28110
- `output`: LUNA_EXPLICIT_8842
- `usage`: {"input":72,"output":11,"cacheRead":0,"cacheWrite":0,"cost":0.0000276}
- 结论：explicit context envelope 经持久 RPC provider 到达真实 Luna。

### R3 activeLimit=2 的四 Session 真实并发

- 结果：**PASS**
- 耗时：9297.05 ms
- `submitted`: 4
- `completed`: 4
- `outputs`: ["LUNA_RPC_A_1101","LUNA_RPC_B_2202","LUNA_RPC_C_3303","LUNA_RPC_D_4404"]
- `activeLimit`: 2
- `peakProviderActive`: 2
- `peakGovernorActive`: 2
- `peakQueued`: 2
- `elapsedMs`: 9296.87
- `finalActive`: 0
- `finalQueued`: 0
- 结论：四个真实 Luna RPC Session 全部完成，provider 与 governor 峰值均严格为 2。

### R4 RPC abort 后同 Session 继续

- 结果：**PASS**
- 耗时：4134.34 ms
- `sessionId`: session_02aab16be378
- `interruptedRunId`: run_f51af8f76ed1
- `interruptedStatus`: interrupted
- `resumedRunId`: run_609d337b3f00
- `resumedOutput`: LUNA_AFTER_ABORT_OK
- `resumedUsage`: {"input":82,"output":9,"cacheRead":0,"cacheWrite":0,"cost":0.000027200000000000004}
- 结论：RPC abort 将当前 Run 标为 interrupted，但 ChildSession 保持可继续使用。

### R5 强制 RPC 退出后的 tombstone

- 结果：**PASS**
- 耗时：2399.71 ms
- `sessionId`: session_c5ff5742c17f
- `failedRunId`: run_f5d49dbcdb5c
- `failedStatus`: failed
- `continuationErrorCode`: session_unavailable
- `retainedSessions`: 7
- `unavailableSessions`: 1
- `finalActive`: 0
- `finalQueued`: 0
- 结论：RPC 子进程被强制关闭后 Session 被 tombstone，后续 Run 明确失败而不丢上下文静默重启。

## Cleanup readback

- dispose 前：{"sessions":7,"active":0,"unavailable":1,"limit":8,"acceptedRuns":10,"processIds":[3962971,3963125,3963156,3963157,3963201,3963208,3963247]}
- dispose 后：{"sessions":0,"active":0,"unavailable":8,"limit":8,"acceptedRuns":10,"processIds":[]}

## 验证边界

- 真实调用通过仓库中的 `PiRpcProcessProvider`，不是一次性 JSON provider。
- 每个 ChildSession 固定一个 Pi RPC 子进程；同 Session Run 不允许重叠。
- tools、extensions、skills、prompt templates、context files 和 Pi durable session 均关闭。
- governor activeLimit=2；provider maxSessions=8。

## 未验证与风险

- 初次验收使用统一 30 秒 command timeout，首个冷启动在 `get_state` 阶段超时；修复后启动使用独立 90 秒上限，普通 RPC command 仍为 30 秒。
- usage 只覆盖正常完成并返回 `message_end` 的 Run；abort/kill 后服务端可能仍计费。
- 当前持久性只覆盖 Workbench 进程存活期间；Pi session 文件和 Workbench reload/cold resume 尚未实现。
- 未验证工具调用、fork/summary、mux、自动重试、网络故障注入和 30–60 分钟 soak。
- Luna 的延迟与输出会随服务端负载和版本变化。

原始结果：[luna-rpc-experiment-report.json](luna-rpc-experiment-report.json)。
