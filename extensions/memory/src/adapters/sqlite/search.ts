import type { MemorySearchHit, MemorySearchRequest, SearchHealth, MemoryScope, MemoryStatus } from "../../domain/types.ts";
import { buildSearchText, escapeFtsTerm, extractSearchTerms } from "../../domain/normalize.ts";
import type { SearchBackend } from "../../ports/memory.ts";
import type { SqliteDb } from "./driver.ts";
import { MEMORY_SELECT, rowToMemory, type MemoryRow } from "./rows.ts";

export class SqliteSearchBackend implements SearchBackend {
  constructor(private readonly db: SqliteDb) {}

  async search(input: MemorySearchRequest, signal?: AbortSignal): Promise<MemorySearchHit[]> {
    if (signal?.aborted) return [];
    const terms = extractSearchTerms(input.query);
    if (terms.length === 0) return [];
    const match = terms.map(escapeFtsTerm).join(" OR ");
    const statuses = input.statuses.length > 0 ? input.statuses : ["active"];
    const scopeClauses = input.allowedScopes.length > 0 ? input.allowedScopes.map(() => "(i.scope_type = ? AND i.scope_key = ?)").join(" OR ") : "0";
    const statusPlaceholders = statuses.map(() => "?").join(",");
    const sql = `${MEMORY_SELECT}
JOIN memory_search_documents d ON d.memory_id = i.id
JOIN memory_fts ON memory_fts.rowid = d.rowid
WHERE memory_fts MATCH ?
  AND i.profile_id = ?
  AND i.status IN (${statusPlaceholders})
  AND (${scopeClauses})
  AND (i.valid_until IS NULL OR i.valid_until > ?)
ORDER BY bm25(memory_fts), i.updated_at DESC
LIMIT ?`;
    const params: unknown[] = [match, input.profileId, ...statuses];
    for (const scope of input.allowedScopes) params.push(scope.type, scope.key);
    params.push(input.now, Math.max(1, Math.min(50, input.limit)));
    const rows = this.db.prepare(sql).all<MemoryRow>(...params);
    return rows.map((row, index) => ({
      memory: rowToMemory(row),
      lexicalScore: 1 / Math.log2(index + 2),
      rank: index,
      reasonCodes: ["fts5"],
    }));
  }

  async synchronize(memoryId: string): Promise<void> {
    const row = this.db.prepare(`SELECT i.status, r.content, r.subject, r.predicate, r.value_json, r.polarity, r.qualifiers_json
      FROM memory_items i LEFT JOIN memory_revisions r ON r.id = i.current_revision_id WHERE i.id = ?`).get(memoryId) as {
      status: MemoryStatus;
      content: string | null;
      subject: string | null;
      predicate: string | null;
      value_json: string | null;
      polarity: "positive" | "negative" | null;
      qualifiers_json: string | null;
    } | undefined;
    if (!row || row.status === "forgotten" || row.content === null) {
      await this.remove(memoryId);
      return;
    }
    const claim = row.subject && row.predicate && row.value_json && row.polarity && row.qualifiers_json
      ? { subject: row.subject, predicate: row.predicate, value: JSON.parse(row.value_json) as import("../../domain/types.js").StructuredClaim["value"], polarity: row.polarity, qualifiers: JSON.parse(row.qualifiers_json) as Record<string, string> }
      : undefined;
    this.db.prepare("INSERT INTO memory_search_documents(memory_id, search_text, updated_at) VALUES (?, ?, ?) ON CONFLICT(memory_id) DO UPDATE SET search_text = excluded.search_text, updated_at = excluded.updated_at").run(memoryId, buildSearchText(row.content, claim), Date.now());
  }

  async remove(memoryId: string): Promise<void> {
    this.db.prepare("DELETE FROM memory_search_documents WHERE memory_id = ?").run(memoryId);
  }

  async repair(): Promise<{ documents: number; active: number }> {
    this.db.exec("DELETE FROM memory_search_documents");
    const rows = this.db.prepare(`${MEMORY_SELECT} WHERE i.status = 'active' AND i.current_revision_id IS NOT NULL`).all<MemoryRow>();
    const insert = this.db.prepare("INSERT INTO memory_search_documents(memory_id, search_text, updated_at) VALUES (?, ?, ?)");
    for (const row of rows) insert.run(row.id, buildSearchText(row.content ?? "", rowToMemory(row).currentRevision?.claim), Date.now());
    return { documents: rows.length, active: rows.length };
  }

  async health(): Promise<SearchHealth> {
    const version = this.db.prepare("SELECT sqlite_version() AS version").get() as { version: string };
    const fts = this.db.prepare("SELECT sqlite_compileoption_used('ENABLE_FTS5') AS enabled").get() as { enabled: number };
    const secure = this.db.prepare("SELECT v FROM memory_fts_config WHERE k = 'secure-delete'").get() as { v?: number } | undefined;
    const result: SearchHealth = {
      ok: fts.enabled === 1 && secure?.v === 1,
      sqliteVersion: version.version,
      fts5: fts.enabled === 1,
      secureDelete: secure?.v === 1,
    };
    if (!secure) result.details = "FTS5 secure-delete status unavailable";
    return result;
  }
}

export function scopeMatch(scopes: MemoryScope[]): string {
  return scopes.map((scope) => `${scope.type}:${scope.key}`).join(",");
}

export function searchTextFor(content: string, claim?: import("../../domain/types.js").StructuredClaim): string {
  return buildSearchText(content, claim);
}

export function safeStatusList(statuses: MemoryStatus[]): MemoryStatus[] {
  return statuses.filter((status) => ["candidate", "active", "stale", "superseded", "rejected", "forgotten"].includes(status));
}
