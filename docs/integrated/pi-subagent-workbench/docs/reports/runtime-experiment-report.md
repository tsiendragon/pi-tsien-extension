# Runtime 实验报告

- 生成时间：2026-08-15T12:53:52.880Z
- 仓库：`pi-subagent-workbench`
- 测试提交：`0ae97227aa1f63dd727f937c78439de1b13b48fe`
- Node：v26.5.0
- 平台：linux/x64
- GC：显式执行
- 命令：`npm run check && npm run experiment`

## 结论

**PASS：14/14 个实验通过。**

当前实现通过了独立 runtime 核心的简单生命周期、复杂压力和提交边界验证。是否允许默认并发仍应以具体 Pi native provider、真实模型、真实 transcript 和长时间 soak 测试为准。

## 实验矩阵

| ID | 复杂度 | 实验 | 结果 | 耗时 ms |
|---|---|---|---|---:|
| S1 | simple | 单次 Run 生命周期 | PASS | 1.6 |
| S2 | simple | 稳定 ChildSession 连续 20 次 Run | PASS | 0.88 |
| S3 | simple | 缺失 provider 明确失败 | PASS | 0.21 |
| C1 | complex | 200 Run 并发压力与资源回收 | PASS | 192.58 |
| C2 | complex | 严格优先级与同优先级公平性 | PASS | 0.28 |
| C3 | complex | 有界队列、取消与超载保护 | PASS | 0.55 |
| C4 | complex | 同步嵌套任务防死锁 | PASS | 0.08 |
| C5 | complex | Provider 失败隔离与后续恢复 | PASS | 0.34 |
| C6 | complex | 运行中断与观察者错误隔离 | PASS | 1.48 |
| E1 | edge | 非法提交参数在创建 Session 前拒绝 | PASS | 0.25 |
| E2 | edge | 默认 task 上限与 UTF-8 字节计数 | PASS | 1.18 |
| E3 | edge | 默认 context 上限 | PASS | 3.73 |
| E4 | edge | 超大 provider 输出限制与 lease 回收 | PASS | 1.35 |
| E5 | edge | 提交前已取消的 signal | PASS | 0.26 |

## 详细结果

### S1 单次 Run 生命周期

- 复杂度：simple
- 结果：**PASS**
- 耗时：1.6 ms
- `sessionCount`: 1
- `runStatus`: completed
- `activeAfterCompletion`: 0
- 结论：单次任务从 queued→running→completed，资源租约正常释放。

### S2 稳定 ChildSession 连续 20 次 Run

- 复杂度：simple
- 结果：**PASS**
- 耗时：0.88 ms
- `sessionCount`: 1
- `runCount`: 20
- `uniqueRunIds`: 20
- 结论：一个 ChildSession 可稳定承载多个独立 Run，身份没有漂移。

### S3 缺失 provider 明确失败

- 复杂度：simple
- 结果：**PASS**
- 耗时：0.21 ms
- `errorName`: ProviderUnavailableError
- `sessionCount`: 0
- 结论：未注册 process provider 时 fail-loud，没有静默降级为 native。

### C1 200 Run 并发压力与资源回收

- 复杂度：complex
- 结果：**PASS**
- 耗时：192.58 ms
- `submitted`: 200
- `completed`: 200
- `activeLimit`: 4
- `maxProviderActive`: 4
- `maxQueued`: 196
- `elapsedMs`: 185.91
- `throughputPerSecond`: 1075.8
- `latencyP50Ms`: 93.62
- `latencyP95Ms`: 173.21
- `rssBeforeBytes`: 89284608
- `rssAfterBytes`: 91566080
- `rssDeltaBytes`: 2281472
- `activeAfterCompletion`: 0
- `queuedAfterCompletion`: 0
- 结论：200 个并发提交严格受 active=4 约束，并在结束后清空 active/queue。

### C2 严格优先级与同优先级公平性

- 复杂度：complex
- 结果：**PASS**
- 耗时：0.28 ms
- `observedOrder`: P0-C1 → P1-B1 → P2-A1 → P2-D1 → P2-A2
- `expectedOrder`: P0-C1 → P1-B1 → P2-A1 → P2-D1 → P2-A2
- 结论：P0>P1>P2 严格生效，P2 的 workflow-a/workflow-d 发生 round-robin。

### C3 有界队列、取消与超载保护

- 复杂度：complex
- 结果：**PASS**
- 耗时：0.55 ms
- `overflowReason`: queue_full
- `abortReason`: aborted
- `activeAfterRecovery`: 0
- `queuedAfterRecovery`: 0
- 结论：队列满时结构化拒绝；排队任务可取消；恢复后无遗留 permit。

### C4 同步嵌套任务防死锁

- 复杂度：complex
- 结果：**PASS**
- 耗时：0.08 ms
- `code`: nested_resource_exhausted
- `reason`: nested_capacity_unavailable
- `queuedAfterRejection`: 0
- 结论：permit 已耗尽时同步后代立即失败，不进入可能自锁的队列。

### C5 Provider 失败隔离与后续恢复

- 复杂度：complex
- 结果：**PASS**
- 耗时：0.34 ms
- `failureType`: SubagentExecutionError
- `recoveredOutput`: recovered
- `activeAfterRecovery`: 0
- `needsAttention`: 1
- 结论：单个 provider 异常不会破坏 governor，后续 Run 可正常执行。

### C6 运行中断与观察者错误隔离

- 复杂度：complex
- 结果：**PASS**
- 耗时：1.48 ms
- `interruptAccepted`: true
- `runStatus`: interrupted
- `errorType`: SubagentExecutionError
- `healthyNotifications`: 5
- `activeAfterInterrupt`: 0
- 结论：中断能终止 active Run；坏 listener 不阻塞其他订阅者或资源释放。

### E1 非法提交参数在创建 Session 前拒绝

- 复杂度：edge
- 结果：**PASS**
- 耗时：0.25 ms
- `invalidCases`: 7
- `rejectedCases`: 7
- `providerCalls`: 0
- `sessionCount`: 0
- `errorCodes`: invalid_request → invalid_task → invalid_task → invalid_task → invalid_context → invalid_timeout → invalid_parameter
- 结论：非法类型、空 task 和非法 timeout 在 Session/provider 之前结构化拒绝。

### E2 默认 task 上限与 UTF-8 字节计数

- 复杂度：edge
- 结果：**PASS**
- 耗时：1.18 ms
- `defaultLimitBytes`: 1048576
- `exactBoundaryAccepted`: true
- `overLimitCode`: task_too_large
- `overLimitActualBytes`: 1048577
- `twoEmojiBytes`: 8
- `oversizedProviderCalls`: 0
- 结论：1 MiB task 边界可用；超 1 字节即拒绝；emoji 按 UTF-8 字节计算。

### E3 默认 context 上限

- 复杂度：edge
- 结果：**PASS**
- 耗时：3.73 ms
- `defaultLimitBytes`: 8388608
- `actualBytes`: 8388609
- `errorCode`: context_too_large
- `providerCalls`: 0
- `sessionCount`: 0
- 结论：超过默认 8 MiB 的 explicit context 在 admission 前拒绝。

### E4 超大 provider 输出限制与 lease 回收

- 复杂度：edge
- 结果：**PASS**
- 耗时：1.35 ms
- `defaultLimitBytes`: 8388608
- `actualBytes`: 8388609
- `causeCode`: output_too_large
- `activeAfterRejection`: 0
- `queuedAfterRejection`: 0
- 结论：超过 8 MiB 的 provider 输出被拒绝，异常路径没有泄漏 permit。

### E5 提交前已取消的 signal

- 复杂度：edge
- 结果：**PASS**
- 耗时：0.26 ms
- `reason`: aborted
- `providerCalls`: 0
- `sessionCount`: 0
- `activeAfterRejection`: 0
- `queuedAfterRejection`: 0
- 结论：预先取消的提交不会创建 Session、进入 provider 或占用 active/queue。

## 验收阈值

- 所有实验必须 PASS。
- 200 个并发提交全部完成。
- provider 最大并发不得超过且必须达到配置值 4。
- 压力实验结束后 active 与 queued 均为 0。
- P0/P1/P2 顺序严格正确，同优先级主体 round-robin。
- queue overflow、queued abort、nested capacity 分别返回结构化原因。
- provider 失败、中断和 listener 异常不得泄漏 permit。
- 非法提交参数不得创建 Session 或调用 provider。
- task/context/output 超过默认 UTF-8 字节上限时必须结构化拒绝。

## 已验证范围

- ResourceGovernor admission、优先级、公平性、有界队列和 lease 生命周期。
- ChildSession/Run 分离与连续运行。
- Provider registry fail-loud。
- provider 失败隔离、运行中断和 runtime listener 隔离。
- 非法运行时参数、1 MiB task、8 MiB context、8 MiB output 及 UTF-8 多字节边界。

## 未验证与风险

- 使用 synthetic provider，不代表真实模型准确率、token usage、网络行为或模型延迟。
- 尚无 Pi native、process 或 mux provider，因此未验证真实 Pi 会话、RPC、tmux 和进程清理。
- 尚无 Workflow runtime、持久 transcript、消息 acknowledgment、heartbeat timeout 和内存水位保护。
- RSS 只是在单进程短时压力中的观测值，不等于长期无泄漏；仍需 30–60 分钟 soak。
- TUI 当前仅有组件 smoke test，未做真实终端 IME、resize、焦点和快捷键人工验证。

原始机器可读结果：[runtime-experiment-report.json](runtime-experiment-report.json)。
