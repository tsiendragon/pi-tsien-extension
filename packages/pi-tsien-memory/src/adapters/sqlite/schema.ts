export const SCHEMA_VERSION = 2;

export const SCHEMA_SQL = `
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;
PRAGMA secure_delete = ON;
PRAGMA auto_vacuum = INCREMENTAL;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL,
  checksum TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS profiles (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS repositories (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  fingerprint_source TEXT NOT NULL,
  root_path TEXT,
  remote_hash TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  pi_session_id TEXT NOT NULL UNIQUE,
  session_file_hash TEXT,
  repository_id TEXT,
  git_branch TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  FOREIGN KEY (repository_id) REFERENCES repositories(id)
);

CREATE TABLE IF NOT EXISTS memory_items (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('preference','decision','experience','continuity')),
  status TEXT NOT NULL CHECK (status IN ('candidate','active','stale','superseded','rejected','forgotten')),
  scope_type TEXT NOT NULL CHECK (scope_type IN ('global','repository','branch','session')),
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
  FOREIGN KEY (current_revision_id) REFERENCES memory_revisions(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (superseded_by_id) REFERENCES memory_items(id)
);

CREATE TABLE IF NOT EXISTS memory_revisions (
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

CREATE TABLE IF NOT EXISTS memory_sources (
  id TEXT PRIMARY KEY,
  revision_id TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('user_message','assistant_summary','tool_result','session_summary','knowledge_chunk','manual_review')),
  source_uri TEXT NOT NULL,
  source_entry_id TEXT,
  source_hash TEXT NOT NULL,
  evidence_summary TEXT,
  authority TEXT NOT NULL CHECK (authority IN ('user_explicit','user_confirmed','verified_tool','current_source','agent_inference')),
  verified INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (revision_id) REFERENCES memory_revisions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS memory_relations (
  from_memory_id TEXT NOT NULL,
  to_memory_id TEXT NOT NULL,
  relation TEXT NOT NULL CHECK (relation IN ('supersedes','conflicts_with','same_as','derived_from')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (from_memory_id, to_memory_id, relation),
  FOREIGN KEY (from_memory_id) REFERENCES memory_items(id) ON DELETE CASCADE,
  FOREIGN KEY (to_memory_id) REFERENCES memory_items(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS memory_search_documents (
  rowid INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id TEXT NOT NULL UNIQUE,
  search_text TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (memory_id) REFERENCES memory_items(id) ON DELETE CASCADE
);

CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
  search_text,
  content='memory_search_documents',
  content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
);

INSERT INTO memory_fts(memory_fts, rank) VALUES ('secure-delete', 1);

CREATE TRIGGER IF NOT EXISTS memory_docs_ai AFTER INSERT ON memory_search_documents BEGIN
  INSERT INTO memory_fts(rowid, search_text) VALUES (new.rowid, new.search_text);
END;

CREATE TRIGGER IF NOT EXISTS memory_docs_ad AFTER DELETE ON memory_search_documents BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, search_text) VALUES ('delete', old.rowid, old.search_text);
END;

CREATE TRIGGER IF NOT EXISTS memory_docs_au AFTER UPDATE ON memory_search_documents BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, search_text) VALUES ('delete', old.rowid, old.search_text);
  INSERT INTO memory_fts(rowid, search_text) VALUES (new.rowid, new.search_text);
END;

CREATE TABLE IF NOT EXISTS memory_events (
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

CREATE TABLE IF NOT EXISTS processed_turns (
  turn_key TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  user_entry_id TEXT NOT NULL,
  extractor_version TEXT NOT NULL,
  processed_at INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS recall_runs (
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

CREATE TABLE IF NOT EXISTS recall_items (
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

CREATE TABLE IF NOT EXISTS application_events (
  id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL,
  session_id TEXT,
  task_key_hash TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('injected','verified','corrected','rejected')),
  created_at INTEGER NOT NULL,
  FOREIGN KEY (memory_id) REFERENCES memory_items(id) ON DELETE CASCADE,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS mutation_receipts (
  id TEXT PRIMARY KEY,
  operation TEXT NOT NULL CHECK (operation IN ('create','update','activate','reject','forget_preview')),
  memory_id TEXT NOT NULL,
  previous_revision_id TEXT,
  previous_status TEXT,
  preview_hash TEXT,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (memory_id) REFERENCES memory_items(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS index_outbox (
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

CREATE INDEX IF NOT EXISTS idx_memory_scope_status ON memory_items(profile_id, scope_type, scope_key, status);
CREATE INDEX IF NOT EXISTS idx_memory_claim ON memory_items(profile_id, claim_key, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_claim_per_scope ON memory_items(profile_id, scope_type, scope_key, claim_key) WHERE status = 'active' AND claim_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_memory_updated ON memory_items(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_sources_revision ON memory_sources(revision_id);
CREATE INDEX IF NOT EXISTS idx_applications_memory ON application_events(memory_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_outbox_pending ON index_outbox(state, created_at);

`;

export const MIGRATIONS: ReadonlyArray<{ version: number; sql: string }> = [
  {
    version: 1,
    sql: "SELECT 1;",
  },
  {
    version: 2,
    sql: `CREATE TABLE IF NOT EXISTS promotion_proposals (
      id TEXT PRIMARY KEY,
      memory_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('proposed','dismissed','snoozed','approved')),
      suggested_type TEXT NOT NULL CHECK (suggested_type IN ('knowledge','rule','skill','agent','hook','plugin')),
      bundle_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      snoozed_until INTEGER,
      dismissed_reason TEXT,
      FOREIGN KEY (memory_id) REFERENCES memory_items(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_promotion_memory ON promotion_proposals(memory_id, status, updated_at DESC);`,
  },
];
