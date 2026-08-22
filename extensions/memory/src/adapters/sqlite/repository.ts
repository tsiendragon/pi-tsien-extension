import type { StatementSync } from "node:sqlite";
import { MemoryConflictError, MemoryError, MemoryNotFoundError } from "../../domain/errors.ts";
import { assertTransition } from "../../domain/state.ts";
import { buildSearchText, claimValueText } from "../../domain/normalize.ts";
import type {
  ApplicationStats,
  MemoryAggregate,
  MemoryApplicationEvent,
  MemoryEventInput,
  MemoryRevision,
  MemoryScope,
  MemorySearchRequest,
  MemorySource,
  MemoryStatus,
  MutationReceipt,
  NewMemory,
  ProcessedTurn,
  RecallAudit,
  RevisionUpdate,
  SearchHealth,
  StructuredClaim,
} from "../../domain/types.ts";
import type { MemoryRepository } from "../../ports/memory.ts";
import { memoryId, sha256 } from "../../shared/hash.ts";
import { withTransaction, type SqliteDb } from "./driver.ts";
import { MEMORY_SELECT, rowToMemory, type MemoryRow } from "./rows.ts";

export class SqliteMemoryRepository implements MemoryRepository {
  constructor(private readonly db: SqliteDb, private profileId = "") {}

  async initialize(profileId: string): Promise<void> {
    this.profileId = profileId;
    const now = Date.now();
    this.db.prepare("INSERT OR IGNORE INTO profiles(id, created_at) VALUES (?, ?)").run(profileId, now);
  }

  async close(): Promise<void> {
    this.db.close();
  }

  async getById(id: string): Promise<MemoryAggregate | undefined> {
    const row = this.db.prepare(`${MEMORY_SELECT} WHERE i.id = ?`).get(id) as MemoryRow | undefined;
    return row ? rowToMemory(row) : undefined;
  }

  async create(input: NewMemory): Promise<MemoryAggregate> {
    const now = Date.now();
    const revisionId = memoryId("rev");
    const receiptId = input.receiptId;
    const result = withTransaction(this.db, () => {
      this.db.prepare(`INSERT INTO memory_items(
        id, profile_id, kind, status, scope_type, scope_key, claim_key,
        current_revision_id, confidence, valid_from, valid_until, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`)
        .run(input.id, input.profileId, input.kind, input.status, input.scope.type, input.scope.key, input.claimKey ?? null, input.confidence, input.validFrom, input.validUntil ?? null, now, now);
      insertRevision(this.db, revisionId, input.id, 1, input.content, input.claim, input.contentHash, input.createdBy, now);
      this.db.prepare("UPDATE memory_items SET current_revision_id = ?, updated_at = ? WHERE id = ?").run(revisionId, now, input.id);
      insertSource(this.db, revisionId, input.source, now);
      upsertSearchDocument(this.db, input.id, buildSearchText(input.content, input.claim), now);
      insertEvent(this.db, {
        memoryId: input.id,
        eventType: "created",
        toStatus: input.status,
        revisionId,
        actor: input.createdBy === "user" ? "user" : "agent",
        reasonCode: input.status === "active" ? "explicit_memory" : "capture_candidate",
      }, now);
      enqueueIndex(this.db, input.id, "upsert", now);
      if (receiptId) {
        insertReceipt(this.db, {
          id: receiptId,
          operation: "create",
          memoryId: input.id,
          expiresAt: now + 10 * 60_000,
        }, now);
      }
      return revisionId;
    });
    const aggregate = await this.getById(input.id);
    if (!aggregate || aggregate.currentRevision?.id !== result) throw new MemoryError("Created memory could not be read back", "MEMORY_READBACK_FAILED");
    return aggregate;
  }

  async updateRevision(id: string, expectedVersion: number, input: RevisionUpdate): Promise<MemoryAggregate> {
    const now = Date.now();
    withTransaction(this.db, () => {
      const current = this.db.prepare(`${MEMORY_SELECT} WHERE i.id = ?`).get(id) as MemoryRow | undefined;
      if (!current) throw new MemoryNotFoundError();
      if (current.status === "forgotten") throw new MemoryError("Forgotten memory cannot be updated", "MEMORY_FORGOTTEN");
      if (current.version !== expectedVersion) throw new MemoryConflictError();
      const revisionNo = Number((this.db.prepare("SELECT COALESCE(MAX(revision_no), 0) + 1 AS next FROM memory_revisions WHERE memory_id = ?").get(id) as { next: number }).next);
      const revisionId = memoryId("rev");
      insertRevision(this.db, revisionId, id, revisionNo, input.content, input.claim, input.contentHash, input.createdBy, now);
      this.db.prepare(`UPDATE memory_items SET current_revision_id = ?, claim_key = ?, status = ?, confidence = COALESCE(?, confidence), version = version + 1, corrected_count = corrected_count + 1, updated_at = ? WHERE id = ? AND version = ?`)
        .run(revisionId, input.claimKey ?? null, input.status ?? current.status, input.confidence ?? null, now, id, expectedVersion);
      insertSource(this.db, revisionId, input.source, now);
      upsertSearchDocument(this.db, id, buildSearchText(input.content, input.claim), now);
      insertEvent(this.db, {
        memoryId: id,
        eventType: "revision_appended",
        fromStatus: current.status,
        toStatus: input.status ?? current.status,
        revisionId,
        actor: input.createdBy === "user" ? "user" : "agent",
        reasonCode: "explicit_revision",
      }, now);
      enqueueIndex(this.db, id, "upsert", now);
    });
    const aggregate = await this.getById(id);
    if (!aggregate) throw new MemoryNotFoundError();
    return aggregate;
  }

  async transition(id: string, to: MemoryStatus, actor: MemoryEventInput["actor"], reasonCode: string): Promise<MemoryAggregate> {
    const now = Date.now();
    withTransaction(this.db, () => {
      const row = this.db.prepare("SELECT status, version FROM memory_items WHERE id = ?").get(id) as { status: MemoryStatus; version: number } | undefined;
      if (!row) throw new MemoryNotFoundError();
      assertTransition(row.status, to);
      this.db.prepare("UPDATE memory_items SET status = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ?").run(to, now, id, row.version);
      insertEvent(this.db, { memoryId: id, eventType: "status_changed", fromStatus: row.status, toStatus: to, actor, reasonCode }, now);
      enqueueIndex(this.db, id, to === "forgotten" ? "remove" : "upsert", now);
    });
    const aggregate = await this.getById(id);
    if (!aggregate) throw new MemoryNotFoundError();
    return aggregate;
  }

  async restoreStatus(id: string, expectedVersion: number, status: MemoryStatus): Promise<MemoryAggregate> {
    const now = Date.now();
    withTransaction(this.db, () => {
      const row = this.db.prepare("SELECT status, version FROM memory_items WHERE id = ?").get(id) as { status: MemoryStatus; version: number } | undefined;
      if (!row || row.version !== expectedVersion || row.status === "forgotten") throw new MemoryConflictError();
      this.db.prepare("UPDATE memory_items SET status = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ? AND status <> 'forgotten'").run(status, now, id, expectedVersion);
      insertEvent(this.db, { memoryId: id, eventType: "status_restored", fromStatus: row.status, toStatus: status, actor: "user", reasonCode: "undo_receipt" }, now);
      enqueueIndex(this.db, id, status === "forgotten" ? "remove" : "upsert", now);
    });
    const aggregate = await this.getById(id);
    if (!aggregate) throw new MemoryNotFoundError();
    return aggregate;
  }

  async findByClaim(profileId: string, scope: MemoryScope, key: string, statuses: MemoryStatus[] = ["active", "candidate", "stale"]): Promise<MemoryAggregate[]> {
    const placeholders = statuses.map(() => "?").join(",");
    const rows = this.db.prepare(`${MEMORY_SELECT} WHERE i.profile_id = ? AND i.scope_type = ? AND i.scope_key = ? AND i.claim_key = ? AND i.status IN (${placeholders}) ORDER BY i.updated_at DESC`).all<MemoryRow>(profileId, scope.type, scope.key, key, ...statuses);
    return rows.map(rowToMemory);
  }

  async list(statuses: MemoryStatus[], profileId: string, limit: number): Promise<MemoryAggregate[]> {
    const placeholders = statuses.map(() => "?").join(",");
    const rows = this.db.prepare(`${MEMORY_SELECT} WHERE i.profile_id = ? AND i.status IN (${placeholders}) ORDER BY i.updated_at DESC LIMIT ?`).all<MemoryRow>(profileId, ...statuses, Math.max(1, Math.min(100, limit)));
    return rows.map(rowToMemory);
  }

  async resolveByIdOrText(target: string, request: MemorySearchRequest): Promise<MemoryAggregate[]> {
    const byId = await this.getById(target);
    if (byId && request.statuses.includes(byId.status) && byId.profileId === request.profileId && request.allowedScopes.some((scope) => scope.type === byId.scope.type && scope.key === byId.scope.key)) return [byId];
    const scopes = request.allowedScopes.length > 0 ? request.allowedScopes.map(() => "(i.scope_type = ? AND i.scope_key = ?)").join(" OR ") : "0";
    const statuses = request.statuses.map(() => "?").join(",");
    const rows = this.db.prepare(`${MEMORY_SELECT} WHERE i.profile_id = ? AND i.status IN (${statuses}) AND (${scopes}) AND r.content LIKE ? ESCAPE '\\' ORDER BY i.updated_at DESC LIMIT 10`).all<MemoryRow>(request.profileId, ...request.statuses, ...request.allowedScopes.flatMap((scope) => [scope.type, scope.key]), `%${target.replaceAll("%", "\\%").replaceAll("_", "\\_")}%`);
    return rows.map(rowToMemory);
  }

  async forget(id: string, actor: MemoryEventInput["actor"]): Promise<void> {
    const now = Date.now();
    withTransaction(this.db, () => {
      const row = this.db.prepare("SELECT status FROM memory_items WHERE id = ?").get(id) as { status: MemoryStatus } | undefined;
      if (!row) throw new MemoryNotFoundError();
      if (row.status === "forgotten") return;
      this.db.prepare("UPDATE memory_items SET status = 'forgotten', current_revision_id = NULL, claim_key = NULL, superseded_by_id = NULL, version = version + 1, updated_at = ? WHERE id = ?").run(now, id);
      this.db.prepare("DELETE FROM memory_search_documents WHERE memory_id = ?").run(id);
      this.db.prepare("DELETE FROM memory_sources WHERE revision_id IN (SELECT id FROM memory_revisions WHERE memory_id = ?)").run(id);
      this.db.prepare("DELETE FROM memory_revisions WHERE memory_id = ?").run(id);
      this.db.prepare("DELETE FROM memory_relations WHERE from_memory_id = ? OR to_memory_id = ?").run(id, id);
      this.db.prepare("DELETE FROM recall_items WHERE memory_id = ?").run(id);
      this.db.prepare("DELETE FROM mutation_receipts WHERE memory_id = ?").run(id);
      this.db.prepare("DELETE FROM index_outbox WHERE memory_id = ?").run(id);
      enqueueIndex(this.db, id, "remove", now);
      insertEvent(this.db, { memoryId: id, eventType: "forgotten", fromStatus: row.status, toStatus: "forgotten", actor, reasonCode: "user_forget" }, now);
    });
    try { this.db.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA incremental_vacuum;"); } catch { /* another reader may hold the WAL; content and FTS rows are already erased */ }
  }

  async createReceipt(input: Omit<MutationReceipt, "createdAt">): Promise<MutationReceipt> {
    const now = Date.now();
    insertReceipt(this.db, input, now);
    return { ...input, createdAt: now };
  }

  async getReceipt(id: string): Promise<MutationReceipt | undefined> {
    const row = this.db.prepare("SELECT id, operation, memory_id, previous_revision_id, previous_status, preview_hash, expires_at, consumed_at, created_at FROM mutation_receipts WHERE id = ?").get(id) as ReceiptRow | undefined;
    if (!row) return undefined;
    return receiptFromRow(row);
  }

  async consumeReceipt(id: string, now: number): Promise<void> {
    const result = this.db.prepare("UPDATE mutation_receipts SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL AND expires_at > ?").run(now, id, now);
    if (Number(result.changes) !== 1) throw new MemoryError("Receipt is expired, already used, or invalid", "MEMORY_INVALID_RECEIPT");
  }

  async appendEvent(input: MemoryEventInput): Promise<void> {
    insertEvent(this.db, input, Date.now());
  }

  async relate(fromId: string, toId: string, relation: "supersedes" | "conflicts_with" | "same_as" | "derived_from"): Promise<void> {
    this.db.prepare("INSERT OR IGNORE INTO memory_relations(from_memory_id, to_memory_id, relation, created_at) VALUES (?, ?, ?, ?)").run(fromId, toId, relation, Date.now());
  }

  async markObserved(id: string): Promise<void> {
    this.db.prepare("UPDATE memory_items SET observed_count = observed_count + 1, updated_at = ? WHERE id = ? AND status <> 'forgotten'").run(Date.now(), id);
  }

  async markApplied(id: string, verified: boolean): Promise<void> {
    this.db.prepare("UPDATE memory_items SET applied_count = applied_count + ?, verified_count = verified_count + ?, updated_at = ? WHERE id = ? AND status = 'active'").run(verified ? 1 : 0, verified ? 1 : 0, Date.now(), id);
  }

  async markProcessedTurn(input: ProcessedTurn): Promise<boolean> {
    const result = this.db.prepare("INSERT OR IGNORE INTO processed_turns(turn_key, session_id, user_entry_id, extractor_version, processed_at) VALUES (?, ?, ?, ?, ?)").run(input.turnKey, input.sessionId, input.userEntryId, input.extractorVersion, input.processedAt);
    return Number(result.changes) === 1;
  }

  async getRevisionHistory(id: string): Promise<MemoryRevision[]> {
    const rows = this.db.prepare("SELECT id, memory_id, revision_no, content, subject, predicate, value_json, polarity, qualifiers_json, content_hash, created_by, created_at FROM memory_revisions WHERE memory_id = ? ORDER BY revision_no ASC").all<RevisionRow>(id);
    return rows.map(revisionFromRow);
  }

  async listSources(id: string): Promise<MemorySource[]> {
    const rows = this.db.prepare(`SELECT s.id, s.revision_id, s.source_type, s.source_uri, s.source_entry_id, s.source_hash, s.evidence_summary, s.authority, s.verified, s.created_at
      FROM memory_sources s JOIN memory_revisions r ON r.id = s.revision_id WHERE r.memory_id = ? ORDER BY s.created_at ASC`).all<SourceRow>(id);
    return rows.map(sourceFromRow);
  }

  async recordRecall(audit: RecallAudit): Promise<void> {
    withTransaction(this.db, () => {
      this.db.prepare("INSERT INTO recall_runs(id, session_id, query_hash, route, status, latency_ms, injected_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(audit.runId, audit.sessionId, audit.queryHash, audit.route, audit.status, audit.latencyMs, audit.injectedCount, Date.now());
      const statement = this.db.prepare("INSERT INTO recall_items(recall_id, memory_id, revision_id, rank, score, reason_codes_json) VALUES (?, ?, ?, ?, ?, ?)");
      for (const item of audit.items) statement.run(audit.runId, item.memoryId, item.revisionId, item.rank, item.score, JSON.stringify(item.reasonCodes));
    });
  }

  async recordApplication(input: MemoryApplicationEvent): Promise<void> {
    this.db.prepare("INSERT INTO application_events(id, memory_id, session_id, task_key_hash, outcome, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(memoryId("app"), input.memoryId, input.sessionId ?? null, input.taskKeyHash ?? null, input.outcome, Date.now());
  }

  async applicationStats(id: string): Promise<ApplicationStats> {
    const row = this.db.prepare(`SELECT
      COUNT(CASE WHEN a.outcome = 'verified' THEN 1 END) AS verified_applications,
      COUNT(DISTINCT CASE WHEN a.outcome = 'verified' THEN a.task_key_hash END) AS distinct_tasks,
      COUNT(DISTINCT CASE WHEN a.outcome = 'verified' THEN s.repository_id END) AS distinct_repositories
      FROM application_events a LEFT JOIN sessions s ON s.id = a.session_id WHERE a.memory_id = ?`).get(id) as { verified_applications: number; distinct_tasks: number; distinct_repositories: number };
    const conflict = this.db.prepare(`SELECT COUNT(*) AS count FROM memory_relations r JOIN memory_items i ON i.id = r.to_memory_id WHERE r.from_memory_id = ? AND r.relation = 'conflicts_with' AND i.status IN ('active','candidate','stale')`).get(id) as { count: number };
    return { verifiedApplications: Number(row.verified_applications), distinctTasks: Number(row.distinct_tasks), distinctRepositories: Number(row.distinct_repositories), unresolvedConflicts: Number(conflict.count) };
  }

  async listApplications(id: string): Promise<MemoryApplicationEvent[]> {
    const rows = this.db.prepare("SELECT memory_id, session_id, task_key_hash, outcome, created_at FROM application_events WHERE memory_id = ? ORDER BY created_at ASC").all<{ memory_id: string; session_id: string | null; task_key_hash: string | null; outcome: MemoryApplicationEvent["outcome"]; created_at: number }>(id);
    return rows.map((row) => ({ memoryId: row.memory_id, sessionId: row.session_id ?? undefined, taskKeyHash: row.task_key_hash ?? undefined, outcome: row.outcome, createdAt: row.created_at }));
  }

  async cleanupCandidates(before: number): Promise<number> {
    const ids = this.db.prepare("SELECT id FROM memory_items WHERE status = 'candidate' AND updated_at < ? LIMIT 1000").all<{ id: string }>(before).map((row) => row.id);
    for (const id of ids) await this.forget(id, "system");
    return ids.length;
  }

  async ensureSession(input: { sessionId: string; piSessionId: string; repositoryId?: string; branch?: string; startedAt: number }): Promise<void> {
    if (input.repositoryId) {
      this.db.prepare("INSERT INTO repositories(id, display_name, fingerprint_source, root_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET display_name = excluded.display_name, updated_at = excluded.updated_at").run(input.repositoryId, input.repositoryId.slice(0, 12), input.repositoryId, null, input.startedAt, input.startedAt);
    }
    this.db.prepare("INSERT INTO sessions(id, pi_session_id, repository_id, git_branch, started_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET repository_id = excluded.repository_id, git_branch = excluded.git_branch").run(input.sessionId, input.piSessionId, input.repositoryId ?? null, input.branch ?? null, input.startedAt);
  }

  async health(): Promise<SearchHealth> {
    const version = this.db.prepare("SELECT sqlite_version() AS version").get() as { version: string };
    const fts = this.db.prepare("SELECT sqlite_compileoption_used('ENABLE_FTS5') AS enabled").get() as { enabled: number };
    const secure = this.db.prepare("SELECT v FROM memory_fts_config WHERE k = 'secure-delete'").get() as { v?: number } | undefined;
    return { ok: fts.enabled === 1 && secure?.v === 1, sqliteVersion: version.version, fts5: fts.enabled === 1, secureDelete: secure?.v === 1 };
  }
}

type RevisionRow = {
  id: string;
  memory_id: string;
  revision_no: number;
  content: string;
  subject: string | null;
  predicate: string | null;
  value_json: string | null;
  polarity: "positive" | "negative" | null;
  qualifiers_json: string;
  content_hash: string;
  created_by: MemoryRevision["createdBy"];
  created_at: number;
};

type SourceRow = {
  id: string;
  revision_id: string;
  source_type: MemorySource["sourceType"];
  source_uri: string;
  source_entry_id: string | null;
  source_hash: string;
  evidence_summary: string | null;
  authority: MemorySource["authority"];
  verified: number;
  created_at: number;
};

function revisionFromRow(row: RevisionRow): MemoryRevision {
  const revision: MemoryRevision = { id: row.id, memoryId: row.memory_id, revisionNo: row.revision_no, content: row.content, contentHash: row.content_hash, createdBy: row.created_by, createdAt: row.created_at };
  if (row.subject && row.predicate && row.value_json && row.polarity) revision.claim = { subject: row.subject, predicate: row.predicate, value: JSON.parse(row.value_json) as StructuredClaim["value"], polarity: row.polarity, qualifiers: JSON.parse(row.qualifiers_json) as Record<string, string> };
  return revision;
}

function sourceFromRow(row: SourceRow): MemorySource {
  const source: MemorySource = { id: row.id, revisionId: row.revision_id, sourceType: row.source_type, sourceUri: row.source_uri, sourceHash: row.source_hash, authority: row.authority, verified: row.verified === 1, createdAt: row.created_at };
  if (row.source_entry_id !== null) source.sourceEntryId = row.source_entry_id;
  if (row.evidence_summary !== null) source.evidenceSummary = row.evidence_summary;
  return source;
}

type ReceiptRow = {
  id: string;
  operation: MutationReceipt["operation"];
  memory_id: string;
  previous_revision_id: string | null;
  previous_status: MemoryStatus | null;
  preview_hash: string | null;
  expires_at: number;
  consumed_at: number | null;
  created_at: number;
};

function receiptFromRow(row: ReceiptRow): MutationReceipt {
  const receipt: MutationReceipt = { id: row.id, operation: row.operation, memoryId: row.memory_id, expiresAt: row.expires_at, createdAt: row.created_at };
  if (row.previous_revision_id) receipt.previousRevisionId = row.previous_revision_id;
  if (row.previous_status) receipt.previousStatus = row.previous_status;
  if (row.preview_hash) receipt.previewHash = row.preview_hash;
  if (row.consumed_at !== null) receipt.consumedAt = row.consumed_at;
  return receipt;
}

function insertRevision(db: SqliteDb, id: string, memoryIdValue: string, revisionNo: number, content: string, claim: StructuredClaim | undefined, hash: string, createdBy: string, now: number): void {
  db.prepare(`INSERT INTO memory_revisions(id, memory_id, revision_no, content, subject, predicate, value_json, polarity, qualifiers_json, content_hash, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, memoryIdValue, revisionNo, content, claim?.subject ?? null, claim?.predicate ?? null, claim ? JSON.stringify(claim.value) : null, claim?.polarity ?? null, claim ? JSON.stringify(claim.qualifiers) : "{}", hash, createdBy, now);
}

function insertSource(db: SqliteDb, revisionId: string, source: NewMemory["source"] | RevisionUpdate["source"], now: number): void {
  db.prepare("INSERT INTO memory_sources(id, revision_id, source_type, source_uri, source_entry_id, source_hash, evidence_summary, authority, verified, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(memoryId("src"), revisionId, source.sourceType, source.sourceUri, source.sourceEntryId ?? null, source.sourceHash ?? sha256(source.sourceUri), source.evidenceSummary ?? null, source.authority, source.verified ? 1 : 0, now);
}

function insertEvent(db: SqliteDb, input: MemoryEventInput, now: number): void {
  db.prepare("INSERT INTO memory_events(id, memory_id, event_type, from_status, to_status, revision_id, actor, reason_code, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(memoryId("evt"), input.memoryId, input.eventType, input.fromStatus ?? null, input.toStatus ?? null, input.revisionId ?? null, input.actor, input.reasonCode, JSON.stringify(input.metadata ?? {}), now);
}

function insertReceipt(db: SqliteDb, input: Omit<MutationReceipt, "createdAt">, now: number): void {
  db.prepare("INSERT INTO mutation_receipts(id, operation, memory_id, previous_revision_id, previous_status, preview_hash, expires_at, consumed_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(input.id, input.operation, input.memoryId, input.previousRevisionId ?? null, input.previousStatus ?? null, input.previewHash ?? null, input.expiresAt, input.consumedAt ?? null, now);
}

function upsertSearchDocument(db: SqliteDb, memoryIdValue: string, searchText: string, now: number): void {
  db.prepare("INSERT INTO memory_search_documents(memory_id, search_text, updated_at) VALUES (?, ?, ?) ON CONFLICT(memory_id) DO UPDATE SET search_text = excluded.search_text, updated_at = excluded.updated_at").run(memoryIdValue, searchText, now);
}

function enqueueIndex(db: SqliteDb, memoryIdValue: string, operation: "upsert" | "remove", now: number): void {
  db.prepare("INSERT INTO index_outbox(id, memory_id, operation, state, created_at, updated_at) VALUES (?, ?, ?, 'done', ?, ?)").run(memoryId("idx"), memoryIdValue, operation, now, now);
}
