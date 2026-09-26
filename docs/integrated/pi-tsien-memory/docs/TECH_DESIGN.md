# pi-tsien-memory Tech Design

- **版本**：0.1
- **状态**：Implemented（Stage 0～7）
- **对应 PRD**：[PRD v0.2](PRD.md)
- **实现记录**：[IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md)
- **兼容基线**：Node.js 22.13+、Pi 0.84.1 公开 Extension API
- **运行时**：Pi extension，Node.js 22.13+

## 1. 设计目标

本设计把 PRD 中的用户任务落实为可编码、可测试、可替换的 TypeScript 模块。

首版必须做到：

1. 用户明确说“记住、以后、不要再”时能可靠沉淀；
2. 新 session 开始工作时自动召回相关 active memory；
3. 记忆只通过 Pi `context` 临时注入，不写回 session 对话；
4. 用户可以自然语言纠正、遗忘和撤销最近写入；
5. 新旧知识冲突时不静默覆盖；
6. repository、Git branch 和 global scope 严格隔离；
7. 不依赖远程服务、Embedding 或额外 LLM 才能工作；
8. 存储、搜索、捕获、排序和外部集成都能单独替换。

## 2. 明确不做

首版不实现：

- Vector Search；
- 图数据库；
- 团队同步；
- 自动读取整个仓库；
- 自动调用或修改 `pi-knowledge` 私有代码；
- 自动写入 marketplace-knowledge；
- 自动创建或发布 Marketplace 包；
- 默认后台模型推理；
- 复杂 TUI 管理后台；
- OMP 兼容承诺。

## 3. 已确定的技术决策

| 主题 | 决策 | 原因 |
|---|---|---|
| 语言 | TypeScript ESM | 与 Pi extension 原生一致 |
| Node | 22.13+ | 使用内置 `node:sqlite`，避免原生 addon ABI/安装问题 |
| 数据库 | SQLite + WAL | 本地、事务、并发读、易迁移 |
| 驱动 | `node:sqlite` `DatabaseSync` | Node 内置、同步事务、无额外 native binding |
| 关键词搜索 | FTS5 + 中英文规范化 | 无模型依赖、低延迟、可诊断 |
| 默认语义检索 | 不启用 | 避免模型、下载和 CPU fallback 依赖 |
| 记忆版本 | 不可变 revision | 支持审计、撤销和冲突解释 |
| 遗忘 | 删除正文、来源摘要、FTS 文档和缓存，仅留无正文 tombstone | 满足“遗忘后不可召回” |
| Prompt 注入 | `context` event + `CustomMessage` | 临时生效，不污染 session JSONL |
| 自动捕获 | 首版规则优先 | 确定性强、可离线测试 |
| 额外模型提取 | 默认关闭 | 避免隐藏成本和不受控推理 |
| pi-knowledge | 先工具检测，后版本化 event bridge | 不绑定其 SQLite 或私有 engine |
| Marketplace | 仅生成晋升证据包 | 正式写入和发布必须由既有流程完成 |

## 4. 总体架构

```text
┌──────────────────────────── Pi Runtime ────────────────────────────┐
│ input / before_agent_start / context / tool_result / agent_settled │
└───────────────────────────────┬─────────────────────────────────────┘
                                │
                    ┌───────────▼───────────┐
                    │  Pi Extension Adapter │
                    │ events/tools/commands │
                    └───────────┬───────────┘
                                │
┌──────────────────────── Application Layer ─────────────────────────┐
│ RememberExplicit  CaptureSettledTurn  SearchMemory                  │
│ BuildRecallContext UpdateMemory      ForgetMemory                  │
│ ReviewCandidates   ResolveConflict   ExplainRecall                 │
└─────────────┬──────────────┬──────────────┬─────────────────────────┘
              │              │              │
       ┌──────▼──────┐ ┌─────▼──────┐ ┌────▼────────────┐
       │ Domain      │ │ Ports      │ │ Policy Modules  │
       │ state/rules │ │ stable API │ │ scope/security  │
       └──────┬──────┘ └─────┬──────┘ └────┬────────────┘
              │              │              │
┌─────────────▼──────────────▼──────────────▼────────────────────────┐
│ Adapters                                                           │
│ SQLiteRepository | FtsSearch | RuleCapture | PiScopeResolver       │
│ SecretFilter     | TokenEstimator | KnowledgeBridge | Clock/Id     │
└────────────────────────────────────────────────────────────────────┘
```

核心层不 import Pi、`node:sqlite` 或 `pi-knowledge`。

## 5. 包结构

```text
pi-tsien-memory/
├── extension.js                       # 启动轻量 shim
├── package.json
├── tsconfig.json
├── src/
│   ├── extension/
│   │   ├── index.ts                   # Pi factory
│   │   ├── runtime-state.ts
│   │   ├── events/
│   │   │   ├── input.ts
│   │   │   ├── before-agent-start.ts
│   │   │   ├── context.ts
│   │   │   ├── tool-result.ts
│   │   │   ├── agent-settled.ts
│   │   │   └── session.ts
│   │   ├── tools.ts
│   │   └── command.ts
│   ├── domain/
│   │   ├── memory.ts
│   │   ├── claim.ts
│   │   ├── scope.ts
│   │   ├── conflict.ts
│   │   └── errors.ts
│   ├── application/
│   │   ├── remember-explicit.ts
│   │   ├── capture-settled-turn.ts
│   │   ├── search-memory.ts
│   │   ├── build-recall-context.ts
│   │   ├── update-memory.ts
│   │   ├── forget-memory.ts
│   │   └── review-candidates.ts
│   ├── ports/
│   │   ├── memory-repository.ts
│   │   ├── search-backend.ts
│   │   ├── capture-strategy.ts
│   │   ├── secret-filter.ts
│   │   ├── scope-resolver.ts
│   │   ├── knowledge-bridge.ts
│   │   └── telemetry.ts
│   ├── adapters/
│   │   ├── sqlite/
│   │   ├── fts/
│   │   ├── capture-rules/
│   │   ├── pi/
│   │   └── knowledge/
│   └── config/
├── test/
│   ├── unit/
│   ├── contract/
│   ├── integration/
│   ├── extension/
│   └── e2e/
└── docs/
```

`extension.js` 只动态 import `dist/extension/index.js`。`node:sqlite` adapter 在第一次 `session_start` 或 memory 工具调用时加载；启动时检查 SQLite `ENABLE_FTS5`，不满足时禁用 Memory 并给出诊断。

### 5.1 包与兼容基线

```json
{
  "type": "module",
  "engines": { "node": ">=22.13.0" },
  "pi": { "extensions": ["./extension.js"] },
  "files": ["extension.js", "dist/", "README.md", "docs/"]
}
```

- 首个测试基线：`@earendil-works/pi-coding-agent` 0.84.1；
- 发布包不携带第二份 Pi runtime；Pi API 只作为开发期类型依赖和 host-provided runtime；
- 使用的公开能力包括 `agent_settled`、`context`、`appendEntry`、`getAllTools`、`buildContextEntries` 和 `sessionEntryToContextMessages`；
- 低于兼容版本时 extension 拒绝启用 Memory 功能并输出升级说明，不能静默缺失 capture；
- `typebox` schema 版本与测试基线保持一致，发布前执行真实 Pi load smoke。

## 6. 稳定端口

```ts
export interface MemoryRepository {
  transact<T>(work: (tx: MemoryTransaction) => Promise<T>): Promise<T>;
  get(id: MemoryId): Promise<MemoryAggregate | undefined>;
  resolveTarget(input: ResolveTargetInput): Promise<ResolvedTarget[]>;
  listCandidates(input: CandidateQuery): Promise<MemoryAggregate[]>;
}

export interface MemoryTransaction {
  create(input: NewMemory): Promise<MemoryAggregate>;
  appendRevision(input: NewRevision): Promise<MemoryAggregate>;
  transition(input: StateTransition): Promise<void>;
  addEvidence(input: NewEvidence): Promise<void>;
  addRelation(input: NewRelation): Promise<void>;
  appendEvent(input: NewMemoryEvent): Promise<void>;
  eraseContent(memoryId: MemoryId): Promise<void>;
  stageIndexMutation(input: IndexMutation): Promise<void>;
  saveReceipt(input: MutationReceipt): Promise<void>;
}

export interface SearchBackend {
  search(input: MemorySearchRequest, signal?: AbortSignal): Promise<MemorySearchHit[]>;
  synchronize(memoryId: MemoryId): Promise<void>;
  remove(memoryId: MemoryId): Promise<void>;
  health(): Promise<SearchHealth>;
}

export interface CaptureStrategy {
  detectExplicitIntent(text: string): ExplicitMemoryIntent | undefined;
  extract(turn: SettledTurn): Promise<CaptureProposal[]>;
}

export interface RecallRanker {
  rank(query: RecallQuery, hits: MemorySearchHit[]): Promise<RankedMemory[]>;
}

export interface KnowledgeBridge {
  capabilities(): Promise<KnowledgeCapabilities | undefined>;
  search(request: KnowledgeSearchRequest, signal?: AbortSignal): Promise<KnowledgeResult[]>;
}
```

约束：

- Use Case 只能依赖 Ports；
- Adapter contract tests 对所有实现复用；
- `MemoryRepository` 与 `SearchBackend` 不共享私有类型；
- future vector adapter 通过 index outbox 同步，不修改 Use Case；
- `KnowledgeBridge` 不 import `pi-knowledge/src/*`。

## 7. 核心状态

```text
candidate ──确认/重复验证──► active
    │                         │
    ├──拒绝────────────────► rejected
    │                         ├──来源过期──► stale
    │                         ├──被替代────► superseded
    │                         └──用户遗忘──► forgotten
    └──到期────────────────► rejected

stale ──重新验证──► active
stale ──替代──────► superseded
```

`forgotten` 是 tombstone：没有正文、revision、来源摘要、FTS 文档或缓存，不能回到 active。

完整冲突和版本规则见：[领域与存储设计](tech/01-domain-storage.md)。

## 8. 三条关键执行流

### 8.1 显式记住

```text
input 检测“记住/以后/不要再”
  → before_agent_start 注入固定工具指引
  → Agent 调用 memory_remember
  → SecretFilter
  → ScopeResolver
  → ClaimNormalizer
  → ConflictResolver
  → SQLite transaction
  → FTS 同步
  → tool result + agent 正常回复
  → agent_settled 显示轻量通知
```

显式工具调用生成 idempotency key：

```text
<pi-session-id>:<user-entry-id>:memory_remember:<normalized-content-hash>
```

重复调用返回原结果，不生成重复记忆。

### 8.2 自动召回

```text
before_agent_start
  → 读取用户 prompt
  → 解析 repository / branch / session
  → FTS 检索 active memory
  → scope SQL 过滤
  → 排序、冲突过滤、session 去重
  → 缓存在当前 agent run

context（每次 LLM call）
  → 插入同一个 CustomMessage
  → 不写入 session
  → 不重复累积
```

### 8.3 自动沉淀

```text
agent_settled
  → 读取本轮 branch delta
  → 排除 thinking、大块日志、源码正文和 memory 工具结果
  → RuleCapture 提取 proposal
  → SecretFilter
  → Deduplicator / ConflictResolver
  → active 或 candidate
  → 写 processed_turns cursor
```

`session_before_compact` 只处理尚未完成的 turn，不修改 Pi 的 compaction summary。

Pi 事件细节见：[Pi Runtime 集成](tech/02-pi-runtime.md)。

## 9. 用户接口

### LLM 工具

| 工具 | 权限 | 用途 |
|---|---|---|
| `memory_search` | read | 查看历史、定位纠错目标、解释召回 |
| `memory_remember` | write | 显式保存用户要求 |
| `memory_update` | write | 追加 revision 或替代冲突知识 |
| `memory_forget` | destructive | 删除正文和所有检索副本 |
| `memory_review` | write | 接受或拒绝 candidate |

### Slash Command

只注册一个 `/memory` 命令：

```text
/memory show [query]
/memory recent
/memory recalled
/memory review
/memory undo
/memory forget [query]
/memory on|off
/memory settings
/memory doctor
```

自然语言仍是主路径。命令用于精确控制和诊断。

## 10. 数据目录

默认：

```text
~/.pi/tsien-memory/
├── memory.db
├── memory.db-wal
├── memory.db-shm
└── config.json
```

覆盖变量：`PI_TSIEN_MEMORY_DIR`。

权限：目录 `0700`，数据库和配置 `0600`。项目目录不会被修改；项目级配置只有用户主动创建 `.pi/tsien-memory.json` 时读取，并且必须 `ctx.isProjectTrusted() === true`。

## 11. 默认配置

```json
{
  "schemaVersion": 1,
  "capture": {
    "enabled": true,
    "strategy": "rules",
    "candidateRetentionDays": 30,
    "reviewCandidates": true,
    "reviewPromptTimeoutMs": 15000
  },
  "recall": {
    "enabled": true,
    "maxItems": 6,
    "maxTokens": 1000,
    "minScore": 0.62,
    "timeoutMs": 150
  },
  "privacy": {
    "storeEvidenceSummary": false,
    "remoteProcessing": false
  },
  "knowledge": {
    "bridge": "auto",
    "combinedContextBudget": 1400
  }
}
```

首版不提供 CPU 模型 fallback。任何未来模型型 extractor 必须显式开启，并使用已有 GPU 推理 provider；不可在本机静默降级到 CPU。

## 12. 性能与失败预算

| 操作 | 目标 | 超时行为 |
|---|---:|---|
| extension factory | < 20 ms | 不加载数据库 |
| `session_start` 初始化 | P95 < 100 ms | 禁用 capture/recall，主会话继续 |
| Memory recall | P95 < 100 ms，hard timeout 150 ms | 返回空上下文 |
| 显式写入 | P95 < 80 ms | 工具返回可重试错误 |
| settled rule capture | P95 < 100 ms | 记录 job failure，不阻塞退出 |
| context 注入 | < 5 ms（使用缓存） | 不注入 |
| shutdown flush | 最多 1 s | 关闭 DB，不执行模型任务 |

所有 event hook 均 fail-open：Memory 故障不能阻塞主 Agent。唯一例外是 Memory 自己的破坏性工具，失败时必须 fail-closed。

## 13. 详细设计

1. [领域模型、SQLite Schema 与冲突状态机](tech/01-domain-storage.md)
2. [Pi Extension 事件、工具与 Prompt 注入](tech/02-pi-runtime.md)
3. [召回排序、pi-knowledge Bridge 与知识晋升](tech/03-retrieval-knowledge.md)
4. [安全、遗忘、配置、可观测性与测试](tech/04-security-testing.md)
5. [代码实施顺序与验收 Gate](tech/05-implementation-plan.md)

## 14. PRD 追踪矩阵

| PRD 能力 | Tech Design |
|---|---|
| 自动沉淀 | `CaptureStrategy`、`agent_settled`、processed turn |
| 自动召回 | FTS、RecallRanker、`context` cache |
| 查看与解释 | `memory_search`、recall_runs |
| 纠正 | immutable revision、ConflictResolver |
| 遗忘 | content erasure、FTS remove、WAL truncate |
| scope 隔离 | ScopeResolver + SQL predicate |
| pi-knowledge 协作 | versioned event bridge |
| Marketplace 晋升 | PromotionEvidenceBundle，只读输出 |
| 模块可替换 | Ports + contract tests + outbox |
