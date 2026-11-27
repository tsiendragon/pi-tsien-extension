# 已实现：stalled 附部分产物 + busy 超时升级

只改 `packages/pi-tsien-subagent-workbench` 与本包测试，未回退前序改动，未提交 git。

## 1) busy 活动计时与超时升级（`src/job-activity.ts`）

- `MutableRun.tools` 由 `Set` 改为 `Map<toolCallId, startedAt>`；`modelRequests` 由计数改为
  开始时间数组（`message_start` 入栈 / `message_end` 出栈，FIFO 配对；多出来的 `message_end`
  在队列为空时直接忽略，不会把计数压成负数）。
- `JobActivitySnapshot` 新增 `oldestInFlightAt?: number`（最老 in-flight 单元的开始时间）。
- 新增 `DEFAULT_SUBAGENT_BUSY_MAX_MS = 600_000`、`SUBAGENT_BUSY_ENV = "PI_SUBAGENT_BUSY_MAX_MS"`、
  `resolveSubagentBusyMaxMs(env)`（未设 / 非法 / `<= 0` 一律回退默认）。
- `JobActivityClassification` 新增 `busyMs`、`escalated`；`JobActivityFormatOptions` 新增 `busyMaxMs`。
- 升级条件（两者同时成立才升级）：
  1. 最老 in-flight 单元已持续 `>= busyMaxMs`；
  2. `idleMs >= busyMaxMs`（这段时间完全没有子进程事件）。
  满足 → `phase: "stalled"`、`escalated: true`，suffix 报出 in-flight 秒数与无进展秒数，
  并提示"可能在等输入/网络"。未升级的 busy 也报出 in-flight 秒数与门槛。
- 注意 `lastActivityAt` 不会早于 in-flight 开始时间（开始事件本身就刷新过它），所以条件 1 被
  条件 2 蕴含；两个都写是为了在未来改动 `lastActivityAt` 语义时意图仍然清楚。
- 已知取舍：**沉默的健康长构建会被升级**（这正是要识别的形态）。后缀是 `stalled?` 加
  "inspect ... then cancel"，只提示检查，不自动取消；已知慢命令可用 `PI_SUBAGENT_BUSY_MAX_MS` 抬高门槛。

## 2) stalled pending job 自动附部分产物（`src/index.ts`）

- `formatJobQuery(query, includeOutput, options?)` 新增可选第三参数 `JobQueryFormatOptions`：
  `now`、`partialOutput(workId)`、`skipPartialWorkIds`。
- 每个 pending job 只分类一次；suffix 通过 `formatPendingJobLine` 渲染，并把该分类结果
  （`classification`）传进去复用，避免同一 job 因跨时钟 tick 分类两次而"后缀说 busy、摘要说 stalled"。
- `phase === "stalled"` 时调用 `partialOutput(workId)`，追加一行
  `  ↳ partial (unverified, may be incomplete): <尾部文本>`：
  - 总预算 `STALLED_PARTIAL_CHARS = 600`，**含前缀与 `(+N more task(s) omitted)` 后缀**；
    截断时 `…` 也计入预算（严格断言测得超出 1 字符后已修正）。
  - 空白折叠、保留**最新尾部**文本。
  - 无文本时明确说 `no assistant text captured yet`，并说明缺失不能证明任务卡死或为空。
  - provider 抛错则静默跳过，不影响其余行。
- busy / active 的 pending job 不附摘要，`partialOutput` 根本不会被调用（有断言）。
- `subagent_results` 工具：传 `partialOutput: (workId) => current.partialJobOutput(workId, STALLED_PARTIAL_CHARS)`
  与 `skipPartialWorkIds`（已通过 `includePartial` 完整渲染的 workId），避免重复输出。

## 3) 测试

- 新增 `test/integrated/workbench/job-activity.test.ts`（11 用例）：
  - busy 超时升级（等 stdin 的 bash；边界前一秒仍是 busy）；
  - `PI_SUBAGENT_BUSY_MAX_MS` 生效；
  - 持续流式更新 1 小时的长命令不误判；
  - 20 个连续短工具不误判、9 分钟单个长工具不误判；
  - 挂起的模型请求同样按 busy 升级；
  - 环境变量解析（未设 / 非法 / 负数 / 空白）；
  - stalled 附摘要、整行长度上限（`<= STALLED_PARTIAL_CHARS`）、尾部保留、busy/active 不附、
    `skipPartialWorkIds` 去重、无文本提示、provider 抛错不崩。
- `test/integrated/workbench/partial-output.test.ts` 追加 1 个工具级集成用例：经 `subagent_results`
  验证自动附摘要，以及与 `includePartial` 的去重。

## 验收

```bash
cd /home/user/pi-stack/pi-tsien-extension
npx tsc --noEmit                                                       # ✓ 通过
env -u PI_SUBAGENT_WORKBENCH_CHILD -u PI_TRACE_CONTEXT -u PI_SESSION_ID \
  npx vitest run --config vitest.integrated.config.ts \
  test/integrated/workbench/job-activity.test.ts test/integrated/workbench/partial-output.test.ts
# ✓ 2 files / 20 tests passed
env -u PI_SUBAGENT_WORKBENCH_CHILD -u PI_TRACE_CONTEXT -u PI_SESSION_ID \
  npx vitest run --config vitest.integrated.config.ts test/integrated/workbench/
# 238 用例 237 通过
```

唯一失败：`model-router.test.ts > rejects duplicates and automatic escalation to heavy`。
属**前序改动**：`parseRouterConfig` 的 `seen` 去重集合已从全局（`git show HEAD:...` 第 157 行）
改成每个 tier 内部（工作区第 162 行），所以"同一模型出现在 light 与 medium"不再抛
`more than one place`。与本次两项改动无关，未回退。

## 独立验证记录（脚本自查，非仅靠单测）

用一次性脚本直接构造快照核对（脚本已删除，结论如下）：

| 场景 | 结果 |
| --- | --- |
| 等 stdin 挂死的 bash（600s 无事件） | `stalled` / escalated=true ✓ |
| 持续输出进度的 1 小时长命令 | `busy` / escalated=false ✓ |
| 100 个连续 30s 短工具（总 50 分钟） | `busy` / escalated=false ✓ |
| `message_end` 多于 `message_start` | 计数停在 0，不泄漏、不为负 ✓ |
| 两个 `message_start` 后一个 end | 剩 1，FIFO 留最晚那个 ✓ |
| `tool_execution_end` 无 toolCallId | 淘汰插入序最老，剩第二个 ✓ |
| `tool_execution_update` 刷新活动 | idle 6s、busyMs 605s → 仍 `busy` ✓ |
| env 未设 / `"0"` / `"90000"` | 600000 / 600000 / 90000 ✓ |

## 环境注意

本机 shell 继承 `PI_SUBAGENT_WORKBENCH_CHILD=1`、`PI_TRACE_CONTEXT`、`PI_SESSION_ID`：
不 unset 时 `extension.test.ts` 会因"只注册子进程工具"而整体假失败，持久化断言也会被真实
子代理轨迹污染。跑测试请按上面的 `env -u ...` 形式。这是环境差异，不是代码问题。