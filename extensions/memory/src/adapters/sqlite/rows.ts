import type { MemoryAggregate, MemoryRevision, MemoryScope, MemoryStatus, StructuredClaim } from "../../domain/types.ts";

export interface MemoryRow {
  id: string;
  profile_id: string;
  kind: MemoryAggregate["kind"];
  status: MemoryStatus;
  scope_type: MemoryScope["type"];
  scope_key: string;
  claim_key: string | null;
  current_revision_id: string | null;
  confidence: number;
  observed_count: number;
  verified_count: number;
  applied_count: number;
  corrected_count: number;
  version: number;
  valid_from: number;
  valid_until: number | null;
  superseded_by_id: string | null;
  created_at: number;
  updated_at: number;
  revision_id: string | null;
  revision_no: number | null;
  content: string | null;
  subject: string | null;
  predicate: string | null;
  value_json: string | null;
  polarity: "positive" | "negative" | null;
  qualifiers_json: string | null;
  content_hash: string | null;
  created_by: MemoryRevision["createdBy"] | null;
  revision_created_at: number | null;
}

export function rowToMemory(row: MemoryRow): MemoryAggregate {
  const memory: MemoryAggregate = {
    id: row.id,
    profileId: row.profile_id,
    kind: row.kind,
    status: row.status,
    scope: scopeFromKey(row.scope_type, row.scope_key),
    confidence: row.confidence,
    observedCount: row.observed_count,
    verifiedCount: row.verified_count,
    appliedCount: row.applied_count,
    correctedCount: row.corrected_count,
    version: row.version,
    validFrom: row.valid_from,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.claim_key) memory.claimKey = row.claim_key;
  if (row.valid_until !== null) memory.validUntil = row.valid_until;
  if (row.superseded_by_id) memory.supersededById = row.superseded_by_id;
  if (row.revision_id && row.content !== null && row.content_hash && row.created_by && row.revision_created_at !== null) {
    const revision: MemoryRevision = {
      id: row.revision_id,
      memoryId: row.id,
      revisionNo: row.revision_no ?? 1,
      content: row.content,
      contentHash: row.content_hash,
      createdBy: row.created_by,
      createdAt: row.revision_created_at,
    };
    if (row.subject && row.predicate && row.value_json && row.polarity && row.qualifiers_json) {
      const claim: StructuredClaim = {
        subject: row.subject,
        predicate: row.predicate,
        value: JSON.parse(row.value_json) as StructuredClaim["value"],
        polarity: row.polarity,
        qualifiers: JSON.parse(row.qualifiers_json) as Record<string, string>,
      };
      revision.claim = claim;
    }
    memory.currentRevision = revision;
  }
  if (row.current_revision_id && !memory.currentRevision) {
    throw new Error(`Memory ${row.id} has an invalid current revision`);
  }
  return memory;
}

export function scopeFromKey(type: MemoryScope["type"], key: string): MemoryScope {
  if (type === "global") return { type, key };
  if (type === "repository") return { type, key, repositoryId: key.slice("repository:".length) };
  if (type === "session") return { type, key, sessionId: key.slice("session:".length) };
  const value = key.slice("branch:".length);
  const separator = value.indexOf(":");
  return separator < 0
    ? { type, key, repositoryId: value }
    : { type, key, repositoryId: value.slice(0, separator), branch: value.slice(separator + 1) };
}

export const MEMORY_SELECT = `
SELECT i.id, i.profile_id, i.kind, i.status, i.scope_type, i.scope_key, i.claim_key,
       i.current_revision_id, i.confidence, i.observed_count, i.verified_count,
       i.applied_count, i.corrected_count, i.version, i.valid_from, i.valid_until,
       i.superseded_by_id, i.created_at, i.updated_at,
       r.id AS revision_id, r.revision_no, r.content, r.subject, r.predicate,
       r.value_json, r.polarity, r.qualifiers_json, r.content_hash,
       r.created_by, r.created_at AS revision_created_at
FROM memory_items i
LEFT JOIN memory_revisions r ON r.id = i.current_revision_id
`;
