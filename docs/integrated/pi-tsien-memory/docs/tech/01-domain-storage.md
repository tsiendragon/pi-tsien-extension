# Tech Design 1：领域模型、存储与冲突状态机

## 1. 领域对象

### 1.1 Memory Aggregate

```ts
export type MemoryStatus =
  | "candidate"
  | "active"
  | "stale"
  | "superseded"
  | "rejected"
  | "forgotten";

export type MemoryKind =
  | "preference"
  | "decision"
  | "experience"
  | "continuity";

export type ScopeType =
  | "global"
  | "repository"
  | "branch"
  | "session";

export interface MemoryScope {
  type: ScopeType;
  key: string;
  repositoryId?: string;
  branch?: string;
  sessionId?: string;
}

export interface StructuredClaim {
  subject: string;
  predicate: string;
  value: string | number | boolean | string[];
  polarity: "positive" | "negative";
  qualifiers: Record<string, string>;
}

export interface MemoryAggregate {
  id: string;
  kind: MemoryKind;
  status: MemoryStatus;
  scope: MemoryScope;
  claimKey?: string;
  currentRevision?: MemoryRevision;
  confidence: number;
  observedCount: number;
  verifiedCount: number;
  appliedCount: number;
  version: number;
  validFrom: number;
  validUntil?: number;
  supersededById?: string;
  createdAt: number;
  updatedAt: number;
}

export interface MemoryRevision {
  id: string;
  memoryId: string;
  revision: number;
  content: string;
  claim?: StructuredClaim;
  contentHash: string;
  createdBy: "user" | "rule-capture" | "review" | "migration";
  createdAt: number;
}
```

`kind` 是内部排序和保留策略，不要求用户手工分类。

计数字段语义：

| 字段 | 含义 |
|---|---|
| `observedCount` | 独立来源中出现相同内容的次数 |
| `verifiedCount` | 证明该 claim 本身正确的验证次数 |
| `appliedCount` | 使用该记忆后结果被确认成功的次数；单纯注入不计 |
| `correctedCount` | 用户或权威来源纠正的次数 |

### 1.2 Claim Key

结构化 claim 用于确定性去重与冲突检测：

```text
claim_key = SHA-256(
  normalize(subject) + "\0" +
  normalize(predicate)
)
```

scope 不写入 claim key。冲突解析时同时比较 scope overlap。

示例：

```json
{
  "subject": "repository.runtime.node",
  "predicate": "required_version",
  "value": "22",
  "polarity": "positive",
  "qualifiers": {}
}
```

自由文本 experience 无法可靠结构化时 `claimKey = null`，只做重复检测，不自动替代旧知识。

## 2. Scope 解析

### 2.1 Repository ID

按以下顺序生成：

1. 执行 `git rev-parse --show-toplevel`；
2. 读取并规范化 `remote.origin.url`，移除用户名、token 和尾部 `.git`；
3. 有 remote 时：`repo_id = SHA-256("remote:" + normalizedRemote)`；
4. 无 remote 时：`repo_id = SHA-256("local:" + realpath(gitCommonDir))`；
5. 非 Git 目录：`repo_id = SHA-256("workspace:" + realpath(cwd))`。

同一 Git worktree 集合共享 repository memory。不同 Git branch 使用相同 repository ID、不同 branch scope key。

### 2.2 查询可见范围

当前 Git branch 下只允许：

```text
global:<profile-id>
repository:<repo-id>
branch:<repo-id>:<exact-branch-name>
session:<pi-session-id>
```

scope 过滤必须进入 SQL `WHERE`，禁止先全库搜索再在应用层过滤。

优先级：

```text
session > branch > repository > global
```

不同 scope 的同一 claim 可以并存。更具体 scope 在召回时覆盖更宽 scope，但不会把宽 scope 标记为 superseded。

### 2.3 默认写入范围

| 内容 | 默认 scope |
|---|---|
| “我一直喜欢简洁回复” | global，仅限明确用户表达 |
| “这个项目使用 pnpm” | repository |
| “这个实验分支暂时关闭缓存” | branch |
| 临时继续工作信息 | session 或不保存 |
| Agent 推断出的 global 偏好 | 禁止自动 active，只能 candidate |

## 3. 状态机

### 3.1 允许转换

| From | To | 触发 |
|---|---|---|
| candidate | active | 用户确认，或满足确定性重复验证规则 |
| candidate | rejected | 用户拒绝、到期或 secret policy |
| active | stale | 当前权威来源反驳，尚未确认替代 |
| active | superseded | 用户明确更新，或审查后由新知识替代 |
| active | forgotten | 用户明确遗忘 |
| stale | active | 重新验证旧知识仍有效 |
| stale | superseded | 新 revision/新 memory 生效 |
| stale | forgotten | 用户遗忘 |
| superseded | forgotten | 用户要求清除历史 |
| rejected | forgotten | 用户要求清除候选痕迹 |

禁止：

- `forgotten → active`；
- `rejected → active`，必须创建新 candidate；
- 无来源地 `stale → active`；
- candidate 自动覆盖 active。

### 3.2 更新与替代

两种情况必须区分：

1. **同一逻辑记忆修订**：在同一个 `memory_id` 下追加 immutable revision；
2. **独立知识替代**：创建新 `memory_id`，旧 item 变为 superseded，并建立 `supersedes` relation。

Node 20 改为 Node 22 属于第一种。两个独立解决方案中 B 取代 A 属于第二种。

## 4. 冲突决策表

| 新证据 | 旧状态 | 相同 claim | 行为 |
|---|---|---:|---|
| 用户明确纠正 | active | 是 | 追加 revision，新值立即 active；旧 revision 保留 |
| 用户明确提出新规则 | active | 是 | 同 scope 更新；更具体 scope 新建覆盖 |
| 当前源码/正式文档 | active | 是 | 旧 item → stale；新内容进入 candidate，除非用户确认 |
| Agent 推断 | active | 是 | 新 candidate + `conflicts_with`，旧 active 不变 |
| 工具验证成功 | candidate | 是 | 合并 evidence，增加 verifiedCount；达到规则后 active |
| 相同内容重复出现 | active/candidate | 是且值相同 | 合并 evidence，不新建 item |
| 无法结构化的相似经验 | 任意 | 否 | 保留两条，禁止自动合并 |
| 不同 scope | active | 是 | 共存；召回时使用更具体 scope |

### 4.1 自动激活门槛

首版只允许以下自动 active：

- 用户明确记忆意图；
- 用户明确确认的 preference；
- 用户明确确认的 decision；
- 相同 preference 在两个不同 session 中被用户直接表达，且没有反例。

工具验证出的 experience 默认 candidate。至少两个独立任务得到同一结果后，才允许在 review 中建议激活；首版不静默激活。

## 5. SQLite Schema v1

初始化：

```sql
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;
PRAGMA secure_delete = ON;
PRAGMA auto_vacuum = INCREMENTAL;
```

启动时还必须确认 `sqlite_version() >= 3.42.0` 且 `sqlite_compileoption_used('ENABLE_FTS5') = 1`；否则禁用 Memory 并由 `/memory doctor` 报告。

Schema：

```sql
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL,
  checksum TEXT NOT NULL
);

CREATE TABLE profiles (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);

CREATE TABLE repositories (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  fingerprint_source TEXT NOT NULL,
  root_path TEXT,
  remote_hash TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  pi_session_id TEXT NOT NULL UNIQUE,
  session_file_hash TEXT,
  repository_id TEXT,
  git_branch TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  FOREIGN KEY (repository_id) REFERENCES repositories(id)
);

CREATE TABLE memory_items (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (
    kind IN ('preference','decision','experience','continuity')
  ),
  status TEXT NOT NULL CHECK (
    status IN ('candidate','active','stale','superseded','rejected','forgotten')
  ),
  scope_type TEXT NOT NULL CHECK (
    scope_type IN ('global','repository','branch','session')
  ),
  scope_key TEXT NOT NULL,
  claim_key TEXT,
  current_revision_id TEXT,
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  observed_count INTEGER NOT NULL DEFAULT 1,
  verified_count INTEGER NOT NULL DEFAULT 0,
  applied_count INTEGER NOT NULL DEFAULT 0,
  corrected_count INTEGER NOT NULL DEFAULT 0,
  valid_from INTEGER NOT NULL,
  valid_until INTEGER,
  superseded_by_id TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (profile_id) REFERENCES profiles(id),
  FOREIGN KEY (current_revision_id) REFERENCES memory_revisions(id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (superseded_by_id) REFERENCES memory_items(id)
);

CREATE TABLE memory_revisions (
  id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL,
  revision_no INTEGER NOT NULL,
  content TEXT NOT NULL,
  subject TEXT,
  predicate TEXT,
  value_json TEXT,
  polarity TEXT CHECK (polarity IS NULL OR polarity IN ('positive','negative')),
  qualifiers_json TEXT NOT NULL DEFAULT '{}',
  content_hash TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(memory_id, revision_no),
  FOREIGN KEY (memory_id) REFERENCES memory_items(id) ON DELETE CASCADE
);

CREATE TABLE memory_sources (
  id TEXT PRIMARY KEY,
  revision_id TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (
    source_type IN ('user_message','assistant_summary','tool_result',
                    'session_summary','knowledge_chunk','manual_review')
  ),
  source_uri TEXT NOT NULL,
  source_entry_id TEXT,
  source_hash TEXT NOT NULL,
  evidence_summary TEXT,
  authority TEXT NOT NULL CHECK (
    authority IN ('user_explicit','user_confirmed','verified_tool',
                  'current_source','agent_inference')
  ),
  verified INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (revision_id) REFERENCES memory_revisions(id) ON DELETE CASCADE
);

CREATE TABLE memory_relations (
  from_memory_id TEXT NOT NULL,
  to_memory_id TEXT NOT NULL,
  relation TEXT NOT NULL CHECK (
    relation IN ('supersedes','conflicts_with','same_as','derived_from')
  ),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (from_memory_id, to_memory_id, relation),
  FOREIGN KEY (from_memory_id) REFERENCES memory_items(id) ON DELETE CASCADE,
  FOREIGN KEY (to_memory_id) REFERENCES memory_items(id) ON DELETE CASCADE
);

CREATE TABLE memory_search_documents (
  rowid INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id TEXT NOT NULL UNIQUE,
  search_text TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (memory_id) REFERENCES memory_items(id) ON DELETE CASCADE
);

CREATE VIRTUAL TABLE memory_fts USING fts5(
  search_text,
  content='memory_search_documents',
  content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
);

INSERT INTO memory_fts(memory_fts, rank)
VALUES ('secure-delete', 1);

CREATE TRIGGER memory_docs_ai AFTER INSERT ON memory_search_documents BEGIN
  INSERT INTO memory_fts(rowid, search_text)
  VALUES (new.rowid, new.search_text);
END;

CREATE TRIGGER memory_docs_ad AFTER DELETE ON memory_search_documents BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, search_text)
  VALUES ('delete', old.rowid, old.search_text);
END;

CREATE TRIGGER memory_docs_au AFTER UPDATE ON memory_search_documents BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, search_text)
  VALUES ('delete', old.rowid, old.search_text);
  INSERT INTO memory_fts(rowid, search_text)
  VALUES (new.rowid, new.search_text);
END;

CREATE TABLE memory_events (
  id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT,
  revision_id TEXT,
  actor TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  FOREIGN KEY (memory_id) REFERENCES memory_items(id) ON DELETE CASCADE
);

CREATE TABLE processed_turns (
  turn_key TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  user_entry_id TEXT NOT NULL,
  extractor_version TEXT NOT NULL,
  processed_at INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE TABLE recall_runs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  query_hash TEXT NOT NULL,
  route TEXT NOT NULL,
  status TEXT NOT NULL,
  latency_ms INTEGER NOT NULL,
  injected_count INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE TABLE recall_items (
  recall_id TEXT NOT NULL,
  memory_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  rank INTEGER NOT NULL,
  score REAL NOT NULL,
  reason_codes_json TEXT NOT NULL,
  PRIMARY KEY (recall_id, memory_id),
  FOREIGN KEY (recall_id) REFERENCES recall_runs(id) ON DELETE CASCADE,
  FOREIGN KEY (memory_id) REFERENCES memory_items(id) ON DELETE CASCADE
);

CREATE TABLE application_events (
  id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL,
  session_id TEXT,
  task_key_hash TEXT,
  outcome TEXT NOT NULL CHECK (
    outcome IN ('injected','verified','corrected','rejected')
  ),
  created_at INTEGER NOT NULL,
  FOREIGN KEY (memory_id) REFERENCES memory_items(id) ON DELETE CASCADE,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE SET NULL
);

CREATE TABLE mutation_receipts (
  id TEXT PRIMARY KEY,
  operation TEXT NOT NULL CHECK (operation IN ('create','update','activate','reject')),
  memory_id TEXT NOT NULL,
  previous_revision_id TEXT,
  previous_status TEXT,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (memory_id) REFERENCES memory_items(id) ON DELETE CASCADE
);

CREATE TABLE index_outbox (
  id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('upsert','remove')),
  state TEXT NOT NULL CHECK (state IN ('pending','done','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (memory_id) REFERENCES memory_items(id) ON DELETE CASCADE
);
```

Indexes：

```sql
CREATE INDEX idx_memory_scope_status
  ON memory_items(profile_id, scope_type, scope_key, status);

CREATE INDEX idx_memory_claim
  ON memory_items(profile_id, claim_key, status);

CREATE UNIQUE INDEX idx_one_active_claim_per_scope
  ON memory_items(profile_id, scope_type, scope_key, claim_key)
  WHERE status = 'active' AND claim_key IS NOT NULL;

CREATE INDEX idx_memory_updated
  ON memory_items(updated_at DESC);

CREATE INDEX idx_sources_revision
  ON memory_sources(revision_id);

CREATE INDEX idx_applications_memory
  ON application_events(memory_id, created_at DESC);

CREATE INDEX idx_outbox_pending
  ON index_outbox(state, created_at);
```

## 6. 中英文 Search Text

FTS5 `unicode61` 前先生成 `search_text`：

1. Unicode NFKC；
2. 英文转小写；
3. 移除控制字符；
4. Latin/数字按词切分；
5. 连续 CJK 文本生成单字、二元组和三元组；
6. 拼接 subject、predicate、value、自然语言 content 和非敏感标签；
7. 最大 4096 字符。

例：

```text
原文：这个项目以后使用 pnpm
search_text：这个 项目 以后 使用 pnpm 这个 个项 项目 目以 以后 后使 使用 ...
```

查询也使用同一 normalizer，所有 FTS token 通过参数绑定，禁止字符串拼接 SQL。

## 7. 写入事务

### 7.1 创建

```text
BEGIN IMMEDIATE
  validate active partial unique constraint
  insert memory_items
  insert memory_revisions
  set current_revision_id
  insert sources
  insert search document
  insert event
  insert receipt
  stage FTS document + insert outbox
COMMIT
```

### 7.2 更新

```text
BEGIN IMMEDIATE
  SELECT item WHERE id=? AND version=?
  INSERT immutable revision
  UPDATE current_revision_id, version=version+1
  stage FTS document update
  INSERT event + receipt + outbox
COMMIT
```

`version` 提供 optimistic concurrency。版本不匹配返回 `MEMORY_CONFLICT_RETRY`，Use Case 重新解析一次；不无限重试。

### 7.3 遗忘

```text
BEGIN IMMEDIATE
  UPDATE memory_items
    SET status='forgotten', current_revision_id=NULL,
        claim_key=NULL, superseded_by_id=NULL, version=version+1
  DELETE memory_search_documents
  DELETE memory_sources for all revisions
  DELETE memory_revisions
  DELETE mutation_receipts
  INSERT body-free event
  STAGE index remove + INSERT outbox(remove)
COMMIT
clear in-process caches
PRAGMA wal_checkpoint(TRUNCATE)
PRAGMA incremental_vacuum
verify no FTS/search/revision/source rows remain
```

FTS adapter 在同一 SQLite transaction 中完成 projection mutation，并把 outbox 标为 done。未来外部索引 adapter 可以消费 pending outbox，但所有 hit 在注入前仍必须回查 Repository 的 status/scope；forgotten hit 永远不可水合为正文。

遗忘没有 undo。确认发生在删除之前。`current_revision_id` 的 deferred foreign key 保证 commit 时不会指向不存在的 revision；应用层和 `/memory doctor` 还要验证该 revision 属于同一个 memory item。

## 8. Undo

只支持 10 分钟内的 create/update/activate/reject：

- create undo：执行与 forget 相同的正文擦除，但 reason 为 `undo_create`；
- update undo：把 previous revision 恢复为 current，追加 `undo_update` event；
- activate/reject undo：恢复 previous status；
- receipt consumed 后不可重复使用；
- forget 不生成 receipt。

## 9. 数据保留

| 数据 | 默认保留 |
|---|---|
| active | 无期限或 validUntil |
| candidate | 30 天 |
| rejected | 30 天后删除正文，保留无正文事件 |
| stale | 90 天后提醒 review，不自动删除 |
| superseded revision | 保留，除非用户清除历史 |
| recall_runs/items | 30 天，仅 hash/ID/score |
| processed_turns | 90 天 |
| mutation_receipts | 10 分钟后清理 |

任何清理任务只在 `session_start` 后或显式 `/memory doctor` 执行，不在 extension factory 启动后台定时器。
