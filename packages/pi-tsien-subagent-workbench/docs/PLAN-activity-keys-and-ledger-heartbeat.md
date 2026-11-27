# 计划：workflow 任务 activity key + 心跳落 job ledger

状态：**已完成**（未提交 git）。目标包只有 `packages/pi-tsien-subagent-workbench`，未改其他包。

## 背景（现状）

- `job-activity.ts` 的 `JobActivityTracker` 是进程内的观测表，key 由 provider 的
  `activityKeyFor()` 决定：`traceContext.workId ?? runId`。
- workflow 的每个任务 run 携带的 `traceContext.workId` 是**父 workflow job 的 workId**，
  因此同一 workflow 的所有任务写进同一个 key，一个任务真卡住会被兄弟任务的 busy 掩盖。
- `lastActivityAt` 只存在内存里，进程重启即丢；`JobLedger` 只追加 launch/settlement 行。

## 改动（已落地）

### 1) activity key 用 taskId

- `src/job-activity.ts` 新增 `activityKeyForTrace()`：`taskId → workId → runId`，作为
  writer（provider）与 reader（tools）**唯一**的 key 定义，避免两处手写规则漂移。
- `src/providers/pi-rpc-process-provider.ts`：`activityKeyFor()` 改用它；新增
  `activityMetaFor()` 把 `kind/workId/taskId/taskKey` 写进 tracker 元数据供持久化使用。
- `src/workbench-controller.ts`：新增导出 `workflowTaskActivityKey()`；
  新增 `workflowTaskActivity(workId)` 返回运行中 task 的 key（`taskId`）+ taskKey + label。
- `src/index.ts`：`formatJobQuery` 对 workflow pending job 用
  `summarizeWorkflowTaskActivity()` 聚合——任务级独立分类，最差 phase 决定 job
  （`stalled` > `busy` > `active`），`lastActivityAt` 取最老值；行前缀写明
  `task <taskKey>`；部分产物摘要按该 taskKey 定向取（`partialJobOutput` 新增可选
  `target` 参数，向后兼容）。
- 向后兼容：`submitAgent` 无 `taskId` → `workId`；无 trace 的 provider 调用 → `runId`。

### 2) 心跳落 job ledger

- `src/job-ledger.ts`：新增 `JobActivityLedgerRecord`（`event: "heartbeat"`、
  `activityKey`、`workId`、`lastActivityAt`、`busy`、`settled`、可选 `taskId/taskKey`）
  与 `recordActivity()`；`JobActivityLedgerRecord` **故意不含 `status`**，现有
  dashboard 等按 `workId`+`status` 统计的消费者自动跳过。
  新增 `readJobLedgerActivity(path, {tailBytes})`：读文件尾部窗口、容忍缺失/损坏/半行/
  旧格式行，返回每个 `activityKey` 的最新心跳。
- `src/job-activity.ts`：tracker 支持 `onPersist` sink + `persistIntervalMs` 节流
  （`PI_SUBAGENT_ACTIVITY_PERSIST_MS`，默认 15000，0 = 不节流），`flushPersist()`、
  `restoreFromLedger()`（只恢复 `lastActivityAt/eventCount/lastEventType`，in-flight
  不可恢复；`settled` 行跳过；内存更新者优先），`setPersistSink()` 支持运行时挂接。
- `src/workbench-controller.ts`：构造时把 sink 接到自己的 `JobLedger`（`jobLedger: null`
  时保持不落盘）；`noteRunSettled` 写 `settled: true` 终结行；`dispose()` 只移除
  **自己安装的** sink（`clearJobActivityPersistSink` 做所有权校验，不会清掉别的
  controller 的 sink）。
- `src/index.ts`：进程启动时一次性 `readJobLedgerActivity()` → `restoreFromLedger()`，
  失败静默。

## 验收（已跑）

```bash
cd /home/user/pi-stack/pi-tsien-extension
env -u PI_SUBAGENT_WORKBENCH_CHILD npx tsc --noEmit   # 仅剩前序 4 个无关错误（capability/context-slim）
env -u PI_SUBAGENT_WORKBENCH_CHILD -u PI_TRACE_CONTEXT -u PI_SESSION_ID \
  npx vitest run --config vitest.integrated.config.ts test/integrated/workbench/
# 252 passed / 1 failed（唯一失败是前序已有的 model-router 跨 tier 去重用例）
```

新增/扩展用例：

- `test/integrated/workbench/job-activity.test.ts`（22 用例，本次 +11）
  - key 优先级：`taskId > workId > runId`，空白串不算 key。
  - **workflow 单任务 idle 独立计算**：同 workflow 的 busy 兄弟（1s 在飞）+ 静默任务
    （400s 无事件）→ job 判 `stalled`、指向 `task wedged`、`idleMs=400s`、父 workId key
    不参与；全任务都活跃时仍为 `busy`；无事件时不返回汇总；渲染行走 `task wedged` 前缀
    且部分产物按该 taskKey 定向取。
  - **重启恢复**：写 heartbeat → 新 tracker `restoreFromLedger` → `lastActivityAt`
    一致、`busy=false`、按 600s idle 判 `stalled`；`settled` 行不复活；内存中更新的状态
    不被覆盖；缺失文件/launch 行/尾部半行都容忍；`PI_SUBAGENT_ACTIVITY_PERSIST_MS`
    解析。
- `test/integrated/workbench/pi-rpc-process-provider.test.ts`：真实 provider 链路，
  带 `traceContext.taskId` 的 run 事件只写 task key，父 `workId` key 始终为空，
  run 结束后 key 清理干净。
- `test/integrated/workbench/workbench-controller.test.ts`：controller 级端到端，
  workflow 两任务各自 key、心跳行带 `workId/kind` 且无 `status`；从 ledger 恢复到新
  tracker 判 `stalled`；**sink 所有权**——dispose 旧 controller 不影响新 controller
  继续写心跳。

## 已知取舍

- 恢复后 in-flight 状态不可知，因此重启瞬间不会报 `busy`/escalated；只会按
  `lastActivityAt` 判 `active`/`stalled?`。
- ledger 是无界追加文件，读取只看尾部窗口（默认 4 MiB）；未加轮转。