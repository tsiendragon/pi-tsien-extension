# 实施状态与验收记录

> 本文记录当前工作树的实现状态；未包含用户 Session、Memory 数据库、proposal 正文或外部提交。

## Stage Gate

| Stage | 当前实现 | 验收证据 |
|---|---|---|
| 0 | 已完成 | `src/adapters/memory/in-memory.ts`、Ports、状态机、SecretFilter、`test/contract/memory-contract.test.mjs` |
| 1 | 已完成 | SQLite WAL/FTS5、schema migration v2、integrity check、repair-index、immutable revision、tombstone forget；SQLite 集成测试 |
| 2 | 已完成 | 五个基础 Memory 工具、undo receipt、forget confirmation、`/memory` command、无 UI 仍返回确定性结果；扩展集成测试 |
| 3 | 已完成 | route、session 内容去重、RecallRanker、token budget、recall audit、Pi `before_agent_start`/`context`；扩展集成测试 |
| 4 | 已完成 | 规则捕获、临时命令过滤、tool verification、processed turn 幂等、candidate retention、回合结束 UI candidate review、compaction flush；capture/SQLite/extension 测试 |
| 5 | 已完成 | immutable revision history、source pointer、authoritative conflict → stale + candidate、branch override、undo；SQLite 集成测试 |
| 6 | 已完成 | `eagleeye.retrieval.discover.v1`、`search.v1`、`context.coordinator.v1`；Memory coordinator、pi-knowledge provider、无 bridge fallback、deadline；两端 build/typecheck 与 bridge e2e |
| 7 | 已完成 | verified application tracking、资格门槛、privacy review、JSON/Markdown evidence bundle、dismiss/snooze；不执行外部仓库/Marketplace 写入；promotion e2e |

## 验证命令与结果

```text
npm run check                                      # PASS：23 个测试全绿
node --input-type=module -e "import('./extension.js')" # PASS
npm pack --dry-run                                # PASS
```

`pi-knowledge` 当前工作树的验证结果：`npm run typecheck`、`npm run build`、extension load、provider capability smoke 均 PASS；`npx vitest --run test/unit/ --testTimeout 30000` 为 189/189 PASS；`npm run test:e2e -- --testTimeout 30000` 为 2 PASS、2 SKIP。原生 `better-sqlite3` 仅在本地 `node_modules` 重建，未修改源码或 Git 状态。

Stage 6 的 provider 变更所在 `pi-knowledge` 工作树仍包含本任务开始前的未提交改动，因此没有执行 reset、stash、commit 或外部仓库写入。

## 安全与边界

- SecretFilter 在正文、搜索文档、来源摘要和 proposal 生成前执行；敏感正文不写入长期 Memory。
- Recall 只注入 `active`，通过隐藏 `CustomMessage` 临时进入 context，不写入 Pi session JSONL。
- Forget 固定为 preview → 短时 token → 明确确认；删除正文、revision、source、FTS、managed proposal 与缓存，且不可 undo。
- promotion 只生成本地 evidence bundle；未获得用户确认不会修改 `eagleeye-knowledge`、Marketplace 包或外部仓库。
- pi-knowledge 不存在、旧版本没有 bridge 或 provider 超时，Memory 仍独立工作。
- candidate 自动审核只在有 UI 的 Pi 会话中启用，默认逐条提供 Accept/Reject/Later；无 UI、超时或配置关闭时 candidate 保留为待审核状态。
- 首版不提供应用层数据库加密、远程 Embedding、CPU fallback 或用户导出副本的自动清理。
- `pi-knowledge` 的 E2E 测试中有 2 项因环境条件被跳过；全部 189 个 unit tests 已在提高本地模型测试超时后通过。
- `pi-knowledge` 的 Git 脏工作树未被本任务清理，后续提交/发布前仍需维护者先确认文件归属。
