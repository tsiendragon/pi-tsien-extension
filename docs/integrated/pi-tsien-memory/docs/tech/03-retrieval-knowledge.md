# Tech Design 3：召回、pi-knowledge 协作与知识晋升

## 1. Memory Search Pipeline

```text
query
  → SecretScrubber
  → QueryNormalizer
  → SQL scope/status/time filter
  → exact claim lookup + FTS5 top 30
  → current-session duplicate filter
  → conflict collapse
  → RecallRanker
  → min-score gate
  → diversity by claim/kind
  → token budget
```

### 1.1 SQL 候选

只搜索：

- `status = active`；
- `valid_until IS NULL OR valid_until > now`；
- 当前 profile；
- 当前可见 scope；
- `current_revision_id IS NOT NULL`。

手工 `memory_search` 可以显式搜索 candidate/stale/superseded，但自动 recall 永远不包含这些状态。

### 1.2 Exact Claim

QueryNormalizer 识别 package manager、runtime version、语言偏好、回复风格等已知 subject 时，先按 `claim_key` 查找。Exact hit 的 lexical score 为 1.0。

无法提取 claim 时使用 FTS。

### 1.3 FTS

```sql
SELECT i.id, i.scope_type, i.scope_key, i.confidence,
       i.kind, i.updated_at, i.applied_count,
       r.id AS revision_id, r.content,
       bm25(memory_fts) AS raw_rank
FROM memory_fts
JOIN memory_search_documents d ON d.rowid = memory_fts.rowid
JOIN memory_items i ON i.id = d.memory_id
JOIN memory_revisions r ON r.id = i.current_revision_id
WHERE memory_fts MATCH :safe_query
  AND i.profile_id = :profile_id
  AND i.status = 'active'
  AND i.scope_key IN (:scope0, :scope1, :scope2, :scope3)
  AND (i.valid_until IS NULL OR i.valid_until > :now)
ORDER BY raw_rank ASC
LIMIT 30;
```

最多四个可见 scope 使用固定具名占位符绑定，不拼接用户文本；缺少的 scope 绑定为 `NULL`。`MATCH` 参数只来自 QueryNormalizer 生成并转义的 token，不直接使用原始 query。

SQLite raw BM25 只用于排序，不直接当成 0～1 置信度。按结果 rank 转换：

```text
lexicalScore = 1 / log2(rank + 2)
```

rank 从 0 开始。

## 2. Ranking

默认评分：

```text
score =
  0.55 * lexicalScore +
  0.20 * scopeScore +
  0.15 * confidence +
  0.05 * freshnessScore +
  0.05 * utilityScore
```

### 2.1 Scope Score

| scope | score |
|---|---:|
| exact session | 1.00 |
| exact branch | 1.00 |
| repository | 0.90 |
| global | 0.75 |

同一 claim 在多个 scope 命中时，只保留最具体 scope。

### 2.2 Freshness

指数衰减半衰期：

| kind | half-life |
|---|---:|
| preference | 365 天 |
| decision | 180 天 |
| experience | 90 天 |
| continuity | 14 天 |

用户显式设置 `validUntil` 时，以有效期为硬门槛。

### 2.3 Utility

```text
utilityScore = min(1, log2(verifiedApplications + 1) / 3)
```

仅 `application_events.outcome = verified` 计入成功应用。单纯 injected 不算成功，避免“被注入得多”自我强化。

### 2.4 Gate

- 默认 `minScore = 0.62`；
- exact claim hit 且 scope 可见时允许 0.55；
- 最多 6 条；
- 同一 claim 只保留 1 条；
- 同 kind 最多 3 条；
- 无结果优于低质量结果。

## 3. 当前 Session 重复抑制

对 `ctx.sessionManager.buildContextEntries()` 的结果调用公开函数 `sessionEntryToContextMessages()`，再从得到的当前 context messages 生成：

- normalized sentence hash set；
- 5-token shingle set；
- session source entry ID set。

Memory 满足任一条件时不注入：

1. 来源 entry 仍存在于当前 context；
2. content normalized hash 完全相同；
3. shingle Jaccard ≥ 0.8；
4. 本轮已经由 memory tool 写入且用户消息仍在 context。

只在当前 agent run 构建一次，不能在每个 tool loop 重算。

## 4. Token Budget

`ContextBudgeter`：

```ts
interface ContextBudget {
  maxItems: number;   // 6
  maxTokens: number;  // 1000
  maxItemChars: number; // 500
}
```

首版 token 估算：

```text
estimatedTokens =
  ceil(asciiLettersAndDigits / 4) +
  ceil(cjkCharacters / 1.5) +
  ceil(otherCharacters / 2)
```

从高分到低分加入，超过预算即停止，不截断结构化 claim；长 content 截成完整句并标记 `truncated=true`。

## 5. Query Router

### 5.1 路由标签

```ts
type RetrievalRoute = "memory" | "knowledge" | "mixed" | "none";
```

规则：

| 特征 | route |
|---|---|
| 上次、之前、我偏好、为什么决定、继续 | memory |
| 当前代码、哪个函数、文档规定、配置键 | knowledge |
| “按之前决策检查当前实现” | mixed |
| 纯闲聊或无持久信息需求 | none |

首版 Memory recall 可以在低成本下对所有非空 prompt 运行，但 route 为 knowledge 时把 maxItems 降为 2、minScore 提高到 0.75。

## 6. 与当前 pi-knowledge 的兼容方式

当前 `pi-knowledge` 提供 `knowledge_search`、`knowledge_symbol_search` 等 LLM tools，并可通过 `PI_KNOWLEDGE_AUTO_INJECT=true` 独立处理 `context`。

Phase 1/2：

- Memory 自动 recall 自己的数据；
- Agent 按 pi-knowledge 的 tool guidance 查询文件事实；
- Memory 只检测工具是否存在；
- 不调用 `pi-knowledge` 私有 `KnowledgeEngine`；
- 推荐统一集成前关闭 `PI_KNOWLEDGE_AUTO_INJECT`，避免双重注入；
- 若检测到该变量为 true，Memory maxTokens 自动降为 600，并在 `/memory doctor` 报告无法统一去重。

## 7. Versioned Retrieval Bridge

Phase 3 在两个 extension 中实现共享 event contract。

### 7.1 Capability Discovery

事件名：

```text
eagleeye.retrieval.discover.v1
```

请求：

```ts
interface DiscoveryEvent {
  register(capability: RetrievalCapability): void;
}

interface RetrievalCapability {
  providerId: "pi-tsien-memory" | "pi-knowledge" | string;
  protocolVersion: 1;
  kinds: ("historical-memory" | "source-knowledge")[];
  supportsAbort: boolean;
  ownsContextInjection: boolean;
}
```

Provider 在 factory 阶段注册 listener。Coordinator 在每次 `before_agent_start` emit discovery，因此不依赖 extension load order。

### 7.2 Search Request

事件名：

```text
eagleeye.retrieval.search.v1
```

```ts
interface RetrievalRequestEvent {
  request: {
    requestId: string;
    query: string;
    route: RetrievalRoute;
    scope: {
      cwd: string;
      repositoryId?: string;
      branch?: string;
    };
    limit: number;
    deadlineAt: number;
  };
  respond(response: RetrievalProviderResponse): void;
}

interface RetrievalProviderResponse {
  requestId: string;
  providerId: string;
  results: UnifiedRetrievalItem[];
  warnings: string[];
  latencyMs: number;
}

interface UnifiedRetrievalItem {
  id: string;
  kind: "historical-memory" | "source-knowledge";
  text: string;
  score: number;
  trust: "user-explicit" | "historical-evidence" | "source-evidence";
  provenance: {
    uri: string;
    hash?: string;
    stale?: boolean;
  };
}
```

Coordinator 使用 callback + deadline 等待 provider。迟到 response 被丢弃。Provider 不因错误 throw 到 event bus，而是返回 warning。

### 7.3 Context Ownership

事件名：

```text
eagleeye.context.coordinator.v1
```

Coordinator 在 run 开始 emit：

```ts
{
  runId: string;
  sessionId: string;
  owner: "pi-tsien-memory";
  expiresAt: number;
}
```

支持 bridge 的 `pi-knowledge` 在该 run 跳过自己的 `context` auto-inject，只返回搜索结果，由 coordinator 统一去重和预算。没有 bridge 的旧版本继续独立工作。

### 7.4 Mixed Merge

统一排序前先保持来源类型：

- source knowledge 描述“当前是什么”；
- memory 描述“用户偏好、当时为何决定”；
- 两类内容不能因文本相似被错误合并；
- 相同 `file://` / `knowledge://` provenance 只保留 source knowledge 正文，Memory 保留一句历史结论和指针；
- 总预算默认 1400 tokens，其中 Memory 最多 700、Knowledge 最多 900，允许未使用预算互借。

## 8. Knowledge 冲突

### 8.1 当前事实

如果 source knowledge 的 `stale=false` 且明确反驳 active memory 的 current-state claim：

1. 当前回答使用 source knowledge；
2. Memory item 标记 stale；
3. 创建 body-limited conflict candidate；
4. 不自动追加 active revision；
5. 在结果会影响修改时提示用户确认。

### 8.2 历史理由

Decision memory 的 predicate 是 `decision_rationale` 时，不因实现变化而自动 stale。可以同时返回：

```text
历史：当时因部署限制选择 SQLite。
当前：代码已迁移到 PostgreSQL。
```

### 8.3 Source Pointer

```text
knowledge://<kb-id>/<chunk-id>#<chunk-hash>
file://<repo-id>/<relative-path>@<commit>
session://<session-id>/<entry-id>
```

Memory 只保存 pointer 和短结论。pi-knowledge chunk hash 改变或找不到时，来源状态为 stale。

## 9. Promotion Advisor

Phase 4 添加独立 `PromotionAdvisor`，只读分析 `application_events` 和来源。

### 9.1 成功使用定义

以下才计为 verified application：

- 用户明确说结果有效；
- 使用该 memory 后对应测试/验证工具成功，且 Agent 建立了关联；
- review 中人工标记成功。

以下不计：

- 仅被注入；
- Agent 在回复中引用；
- 工具执行成功但与该 memory 无法建立因果关系。

### 9.2 晋升条件

```ts
interface PromotionEligibility {
  verifiedApplications: number; // >= 3
  distinctTasks: number;        // >= 2
  distinctRepositories: number; // 跨项目候选 >= 2
  unresolvedConflicts: number;  // = 0
  hasSensitiveData: boolean;    // false
  userApproved: boolean;        // true before external action
}
```

### 9.3 类型建议

```text
仍是事实/经验                 → eagleeye-knowledge
短、始终生效、无参数          → Rule
有输入、步骤、输出、验收      → Skill
独立角色型调查                → Agent candidate
生命周期自动触发              → Hook/Extension candidate
至少两个组件必须协作          → Plugin candidate
```

### 9.4 Evidence Bundle

输出 JSON + Markdown：

```ts
interface PromotionEvidenceBundle {
  schemaVersion: 1;
  proposalId: string;
  suggestedType: "knowledge" | "rule" | "skill" | "agent" | "hook" | "plugin";
  problem: string;
  reusablePattern: string;
  scope: string[];
  exclusions: string[];
  evidence: Array<{ taskHash: string; outcome: "verified"; sourceUri: string }>;
  counterexamples: string[];
  privacyReview: { passed: boolean; findings: string[] };
  suggestedTests: string[];
  components?: Array<{ type: string; responsibility: string }>;
}
```

默认写入用户数据目录：

```text
~/.pi/tsien-memory/proposals/<proposal-id>.json
~/.pi/tsien-memory/proposals/<proposal-id>.md
```

生成 proposal 不修改外部仓库。用户明确同意后，Agent 再进入 eagleeye-knowledge 或 Marketplace 既有 Skill 流程。
