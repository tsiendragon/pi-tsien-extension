# Tool / Skill Usage Analytics PRD

## 1. 背景

Pi 用户安装的 Tool（工具）和 Skill（按需加载的工作流说明）会逐渐增多，但目前缺少本地、可审计的使用数据，难以判断哪些能力常用、哪些长期没有作用，以及哪些可以考虑卸载。

## 2. 目标

提供一个默认本地运行的 Pi Extension，统计 Tool 与 Skill 的使用频率和最近使用时间，并给出保守的“可考虑卸载”候选，不自动卸载任何内容。

## 3. 非目标

- 不评价 Tool 或 Skill 的业务质量。
- 不自动删除、禁用或修改任何 Tool、Skill。
- 不上传遥测数据。
- 不记录用户提示词、Tool 参数、Tool 输出或 Skill 文件内容。
- 不保证识别绕过 Pi 标准事件的外部进程行为。

## 4. 使用口径

### 4.1 Tool

以 `tool_execution_end` 为一次完成调用：

- `calls`：完成调用次数。
- `successes` / `failures`：按 `isError` 统计。
- `totalDurationMs`：由同一 `toolCallId` 的 start/end 时间计算。
- `lastUsedAt`：最近完成时间。
- `source` / `path`：来自 `pi.getAllTools().sourceInfo`。

未收到 end 的中断调用不计入完成次数，避免将未执行调用误记为使用。

### 4.2 Skill

Skill 信号分级，不混为同一种事实：

- `confirmed`：用户显式输入 `/skill:<name>`。
- `inferred`：Agent 使用标准 `read` Tool 成功读取该 Skill 的入口文件。
- `exposed`：Skill 在某个 Agent run 的 `systemPromptOptions.skills` 中可见。

主使用指标为 `confirmed + inferred`。同一 Agent run 内，同一个 Skill 的相同信号最多计一次，避免重复读取造成虚高。`exposed` 只表示有机会被选择，不算实际使用。

## 5. 用户入口

Extension 注册 `/usage` 命令：

- `/usage` 或 `/usage summary`：显示 Tool、Skill 摘要。
- `/usage tools`：按完成调用次数显示 Tool。
- `/usage skills`：显示 confirmed、inferred、exposed。
- `/usage unused [天数]`：列出在统计期内从未使用或超过指定天数未使用的非内置能力，默认 30 天。
- `/usage export [路径]`：导出当前统计 JSON；相对路径以当前工作目录为基准。
- `/usage reset`：交互确认后清空统计。

输出保持紧凑；详细机器可读数据通过 export 获得。

## 6. 数据与隐私

默认数据文件：

```text
${PI_CODING_AGENT_DIR:-~/.pi/agent}/usage-analytics.json
```

仅保存聚合信息：名称、类型、来源、来源路径、次数、成功失败、累计耗时、首次/最近时间、活跃 session 数。写入使用临时文件后 rename，避免进程中断留下半个 JSON。

数据按本机用户隔离，不进行网络请求。损坏数据文件不阻断 Pi：保留备份并从空统计恢复，同时在有 UI 时告警。

## 7. 卸载候选规则

`unused` 只给建议，不做动作：

- 排除 Pi 内置 Tool。
- 已发现且实际使用次数为 0；或最近实际使用早于阈值。
- Skill 的 `exposed` 不视为使用。
- 明确提示：安全门禁、发布检查等低频关键能力仍需人工判断。

## 8. 已知限制

- Agent 用 `bash cat`、第三方文件 Tool 或外部进程读取 `SKILL.md` 时可能漏记。
- 用户要求审查某个 `SKILL.md` 也会形成 inferred 信号，可能误记。
- 独立子进程只有在同样加载本 Extension 并共享数据文件时才会计入；共享文件的读合并写由短时跨进程锁串行化，但不提供数据库级事务或远程文件系统锁保证。
- 显式 Skill 命令在 Agent 真正开始前计为 confirmed；后续模型失败不撤销该用户意图。

## 9. 验收标准

1. Tool 成功和失败完成事件分别正确累计，耗时非负。
2. `/skill:name` 被记为 confirmed；成功读取已知 Skill 入口被记为 inferred；读取失败不记 inferred。
3. 同一 Agent run 重复读取同一 Skill 只增加一次 inferred。
4. 不保存提示词、Tool 参数或 Tool 输出。
5. `/usage tools|skills|unused|export|reset` 可用，reset 有交互确认；无 UI 时拒绝 reset。
6. 数据跨 Pi session 保留，损坏数据不会阻断 Extension 加载。
7. 新增 Extension 通过独立严格 TypeScript 检查并可由 Pi 成功加载；全仓检查不得新增本功能相关错误。
