# Luna Subagent 标准回归案例

这是 Workbench 的真实 Luna 回归套件，不属于默认的 `npm test`，需要显式运行：

```bash
npm run experiment:luna-regression
```

模型固定为 `openai-codex/gpt-5.6-luna`，传输固定为 `pi --mode rpc`。每个案例独立创建并销毁 `PiRpcProcessProvider`，避免前一个案例的 Session、effort 或资源开关污染后一个案例。

## 覆盖矩阵

案例定义位于 `experiments/luna-regression-cases.ts`，运行器位于 `experiments/run-luna-regression.ts`。

| 案例 | effort | skills | extensions | context | 输出/行为 |
|---|---|---:|---:|---|---|
| R01 | off | off | off | fresh、短 | 精确文本 |
| R02 | minimal | off | off | fresh、短 | JSON 字段 |
| R03 | low | off | off | explicit、短 | explicit context marker |
| R04 | medium | on | off | explicit、中 | skills 开关与中等 context |
| R05 | high | off | on | fresh、中 | extensions 开关 |
| R06 | xhigh | on | on | fresh、中 | skills + extensions |
| R07 | max | on | on | explicit、长 | 长 context marker |
| R08 | minimal | off | off | 同 Session continuation | 跨 Run 记忆 |
| R09 | low | on | on | fresh、长 | 4 路并发、activeLimit=2 |
| R10 | medium | on | on | fresh、长 | interrupt 后同 Session resume |

所有案例关闭 tools，避免真实回归产生文件、网络或其他工具副作用；skills 和 extensions 的加载开关仍按矩阵变化。输出校验允许 global preference 合法添加的前导 `喵`，但不会放宽模型、JSON 字段、上下文记忆、并发回收或中断状态校验。

## 通过标准

- 所有案例 PASS。
- 返回的模型必须是 `openai-codex/gpt-5.6-luna`。
- 覆盖 `off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`。
- 覆盖 `fresh`、`explicit` 和 continuation。
- 覆盖短、中、长 context，以及不同 UTF-8 字节量。
- 覆盖 skills/extensions 的四种开关组合。
- 并发案例结束后 `active=0`、`queued=0`，且不超过 `activeLimit=2`。
- 中断案例必须得到 `interrupted`，并能在同一 ChildSession 中恢复调用。
- 每个案例结束后 RPC provider 都必须释放子进程。

## 报告与成本

运行器生成：

- `docs/reports/luna-regression-report.json`
- `docs/reports/luna-regression-report.md`

这些报告包含耗时、usage、cost、effort、资源开关和失败堆栈；报告文件是运行产物，不应作为固定回归基线提交。真实 Luna 调用可能产生模型费用，执行前应确认凭证和预算。
