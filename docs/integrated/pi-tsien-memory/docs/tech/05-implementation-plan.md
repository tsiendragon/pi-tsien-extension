# Tech Design 5：实施顺序与验收 Gate

## 1. 实施原则

- 每个阶段都可单独运行和测试；
- 先实现 Fake 和 contract tests，再实现 SQLite；
- 不用占位实现冒充功能完成；
- 尚未进入阶段的 Adapter 不注册、不返回假结果；
- 每个阶段只引入当期需要的依赖；
- 所有模型能力可缺省，核心路径保持纯本地确定性。

## 2. Stage 0：工程骨架与领域合同

### 交付

- `package.json`、TypeScript ESM、build shim；
- domain types、errors、state transition table；
- Ports；
- `InMemoryMemoryRepository`；
- `InMemorySearchBackend`；
- contract test suite；
- Fake clock、ID、scope 和 secret filter。

### Gate

- 所有 Ports 有 contract tests；
- domain 不 import Pi/SQLite；
- forbidden transition 全覆盖；
- Node 22.13 typecheck/build 通过；
- `extension.js` 可 startup-light import。

## 3. Stage 1：SQLite 与四个原子能力

### 交付

- schema v1 和 migration runner；
- SQLite repository；
- FTS search adapter；
- create/get/update/forget；
- immutable revision；
- tombstone erasure；
- outbox；
- `/memory doctor` storage 检查。

### Gate

- Fake 与 SQLite 同过 repository/search contract；
- update 保留旧 revision；
- forget 后正文、source、FTS、WAL 无 fixture 明文；
- 两连接并发测试通过；
- migration rollback 可恢复。

## 4. Stage 2：显式用户控制

### 交付

- `memory_search`；
- `memory_remember`；
- `memory_update`；
- `memory_forget`；
- `memory_review`；
- `/memory` command；
- intent detector；
- confirmation token；
- mutation receipt 和 undo。

### Gate

- 用户不提供 ID 可定位唯一记忆；
- 多候选不自动修改/删除；
- 无明确 user intent 不能 active global memory；
- forged token 删除失败；
- no-UI 模式行为确定。

## 5. Stage 3：自动召回与 Prompt 注入

### 交付

- scope resolver；
- query normalizer；
- RecallRanker；
- current-session dedupe；
- ContextBudgeter；
- `before_agent_start` cache；
- `context` custom message 注入；
- `/memory recalled`；
- recall audit。

### Gate

- 新 session 自动遵循 repository preference；
- 无关 query 不注入；
- tool loop 只搜索一次；
- context 不写入 session entries；
- branch/global scope 不串；
- recall hard timeout 后 Agent 继续；
- injection corpus 无标签逃逸。

## 6. Stage 4：日常自动沉淀

### 交付

- RuleCaptureStrategy v1；
- turn delta builder；
- tool verification metadata；
- processed turn idempotency；
- candidate lifecycle；
- settled notification；
- compaction flush；
- candidate retention cleanup。

### Gate

- “以后用 pnpm”自动 active；
- 临时命令不保存；
- 失败中间判断不保存；
- 工具验证经验只进入 candidate；
- retry/reload/compaction 不重复；
- SecretFilter 命中无持久副本。

## 7. Stage 5：冲突与来源生命周期

### 交付

- StructuredClaim templates；
- ConflictResolver；
- stale/superseded；
- source pointer；
- revision history；
- update/undo UI；
- stale review。

### Gate

- Node 20 → 22 更新为新 revision；
- 自动 recall 只返回 22；
- 旧 revision 可解释但不自动注入；
- current source 冲突时旧 memory stale，不静默覆盖；
- branch override 不 supersede repository memory。

## 8. Stage 6：pi-knowledge Bridge

### 前置

- 与 `pi-knowledge` 维护者确认 versioned event contract；
- 当前 `pi-knowledge` 增加 provider bridge；
- 两边均保留无 bridge fallback。

### 交付

- capability discovery；
- request/response callback；
- coordinator ownership；
- mixed merge；
- provenance dedupe；
- combined token budget；
- stale chunk detection。

### Gate

- 未安装 pi-knowledge 不退化；
- 旧版 pi-knowledge 不崩溃；
- bridge 版本下只有 coordinator 注入；
- 历史决策与当前实现可同时返回；
- 同一 source chunk 不重复注入；
- provider 超时不阻塞 Agent。

## 9. Stage 7：知识晋升建议

### 交付

- verified application tracking；
- PromotionAdvisor；
- knowledge/rule/skill/plugin classifier；
- privacy review；
- evidence bundle JSON/Markdown；
- `/memory promote-preview`；
- dismiss/snooze。

### Gate

- 少于 3 次 verified use 不提示；
- 单 Rule 不建议 Plugin；
- Plugin 必须列出至少两个组件及协作理由；
- proposal 脱敏；
- 未确认不写外部仓库；
- Marketplace 失败不标记已晋升。

## 10. 推荐首个可发布范围

`v0.1.0`：Stage 0～3。

用户得到：

- 显式记住；
- 自动召回；
- 自然语言更新和遗忘；
- scope 隔离；
- 本地 SQLite；
- 无额外模型依赖。

`v0.2.0`：Stage 4～5。

用户得到：

- 日常自动沉淀；
- candidate；
- 冲突、stale、superseded；
- 更完整来源解释。

`v0.3.0`：Stage 6。

`v0.4.0`：Stage 7。

## 11. Definition of Done

任一 Stage 只有同时满足以下条件才算完成：

1. 对应代码已实现，不是 stub；
2. unit + contract + integration tests 通过；
3. 用户路径有 deterministic e2e；
4. 错误和 timeout 不阻塞主 Agent；
5. 无明文 secret fixture 残留；
6. README、配置和 migration 文档同步；
7. 未扩大到下一 Stage；
8. 未提交用户 session、DB、proposal 或本地路径。
