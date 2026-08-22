import { MemoryConflictError, MemoryError, MemoryNotFoundError } from "../../domain/errors.ts";
import { assertTransition } from "../../domain/state.ts";
import { buildSearchText, extractSearchTerms } from "../../domain/normalize.ts";
import type {
  MemoryAggregate,
  MemoryEventInput,
  MemoryRevision,
  MemoryScope,
  MemorySearchHit,
  MemorySearchRequest,
  MemorySource,
  MemoryStatus,
  MutationReceipt,
  NewMemory,
  ProcessedTurn,
  RecallAudit,
  RevisionUpdate,
  SearchHealth,
} from "../../domain/types.ts";
import type { MemoryRepository, SearchBackend } from "../../ports/memory.ts";
import { memoryId } from "../../shared/hash.ts";

export class InMemoryMemoryRepository implements MemoryRepository {
  private readonly memories = new Map<string, MemoryAggregate>();
  private readonly revisions = new Map<string, MemoryRevision[]>();
  private readonly receipts = new Map<string, MutationReceipt>();
  private readonly processedTurns = new Set<string>();
  private readonly events: MemoryEventInput[] = [];
  private readonly sources = new Map<string, MemorySource[]>();
  private readonly audits: RecallAudit[] = [];
  private readonly applications: Array<{ memoryId: string; sessionId?: string; taskKeyHash?: string; outcome: "injected" | "verified" | "corrected" | "rejected"; createdAt: number }> = [];
  private readonly sessions = new Map<string, { repositoryId?: string }>();
  private readonly relations = new Set<string>();
  private profileId = "";

  async initialize(profileId: string): Promise<void> { this.profileId = profileId; }
  async close(): Promise<void> {}

  async getById(id: string): Promise<MemoryAggregate | undefined> { return clone(this.memories.get(id)); }

  async create(input: NewMemory): Promise<MemoryAggregate> {
    if (this.memories.has(input.id)) throw new MemoryError("Memory already exists", "MEMORY_DUPLICATE");
    const now = Date.now();
    const revision: MemoryRevision = {
      id: memoryId("rev"), memoryId: input.id, revisionNo: 1, content: input.content, claim: input.claim,
      contentHash: input.contentHash, createdBy: input.createdBy, createdAt: now,
    };
    const aggregate: MemoryAggregate = {
      id: input.id, profileId: input.profileId, kind: input.kind, status: input.status, scope: input.scope,
      claimKey: input.claimKey, currentRevision: revision, confidence: input.confidence, observedCount: 1,
      verifiedCount: input.source.verified ? 1 : 0, appliedCount: 0, correctedCount: 0, version: 1,
      validFrom: input.validFrom, validUntil: input.validUntil, createdAt: now, updatedAt: now,
    };
    this.memories.set(input.id, aggregate);
    this.revisions.set(input.id, [revision]);
    this.sources.set(input.id, [{ id: memoryId("src"), revisionId: revision.id, sourceType: input.source.sourceType, sourceUri: input.source.sourceUri, sourceEntryId: input.source.sourceEntryId, sourceHash: input.source.sourceHash ?? "", authority: input.source.authority, verified: input.source.verified, createdAt: now }]);
    return clone(aggregate)!;
  }

  async updateRevision(id: string, expectedVersion: number, input: RevisionUpdate): Promise<MemoryAggregate> {
    const current = this.memories.get(id);
    if (!current) throw new MemoryNotFoundError();
    if (current.status === "forgotten") throw new MemoryError("Forgotten memory cannot be updated", "MEMORY_FORGOTTEN");
    if (current.version !== expectedVersion) throw new MemoryConflictError();
    const revision: MemoryRevision = {
      id: memoryId("rev"), memoryId: id, revisionNo: (this.revisions.get(id)?.length ?? 0) + 1,
      content: input.content, claim: input.claim, contentHash: input.contentHash, createdBy: input.createdBy, createdAt: Date.now(),
    };
    const next = { ...current, currentRevision: revision, claimKey: input.claimKey, status: input.status ?? current.status,
      confidence: input.confidence ?? current.confidence, version: current.version + 1, correctedCount: current.correctedCount + 1, updatedAt: Date.now() };
    this.memories.set(id, next);
    this.revisions.set(id, [...(this.revisions.get(id) ?? []), revision]);
    const currentSources = this.sources.get(id) ?? [];
    this.sources.set(id, [...currentSources, { id: memoryId("src"), revisionId: revision.id, sourceType: input.source.sourceType, sourceUri: input.source.sourceUri, sourceEntryId: input.source.sourceEntryId, sourceHash: input.source.sourceHash ?? "", authority: input.source.authority, verified: input.source.verified, createdAt: revision.createdAt }]);
    return clone(next)!;
  }

  async transition(id: string, to: MemoryStatus, actor: MemoryEventInput["actor"], reasonCode: string): Promise<MemoryAggregate> {
    const current = this.memories.get(id);
    if (!current) throw new MemoryNotFoundError();
    assertTransition(current.status, to);
    const next = { ...current, status: to, version: current.version + 1, updatedAt: Date.now() };
    this.memories.set(id, next);
    this.events.push({ memoryId: id, eventType: "status_changed", fromStatus: current.status, toStatus: to, actor, reasonCode });
    return clone(next)!;
  }

  async restoreStatus(id: string, expectedVersion: number, status: MemoryStatus): Promise<MemoryAggregate> {
    const current = this.memories.get(id);
    if (!current) throw new MemoryNotFoundError();
    if (current.version !== expectedVersion) throw new MemoryConflictError();
    const next = { ...current, status, version: current.version + 1, updatedAt: Date.now() };
    this.memories.set(id, next);
    this.events.push({ memoryId: id, eventType: "status_restored", fromStatus: current.status, toStatus: status, actor: "user", reasonCode: "undo_receipt" });
    return clone(next)!;
  }

  async findByClaim(profileId: string, scope: MemoryScope, key: string, statuses: MemoryStatus[] = ["active", "candidate", "stale"]): Promise<MemoryAggregate[]> {
    return [...this.memories.values()].filter((memory) => memory.profileId === profileId && memory.scope.type === scope.type && memory.scope.key === scope.key && memory.claimKey === key && statuses.includes(memory.status)).map((memory) => clone(memory)!);
  }

  async list(statuses: MemoryStatus[], profileId: string, limit: number): Promise<MemoryAggregate[]> {
    return [...this.memories.values()].filter((memory) => memory.profileId === profileId && statuses.includes(memory.status)).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit).map((memory) => clone(memory)!);
  }

  async resolveByIdOrText(target: string, request: MemorySearchRequest): Promise<MemoryAggregate[]> {
    const exact = this.memories.get(target);
    if (exact && visible(exact, request)) return [clone(exact)!];
    const needle = target.toLocaleLowerCase();
    return [...this.memories.values()].filter((memory) => visible(memory, request) && (memory.currentRevision?.content.toLocaleLowerCase().includes(needle) ?? false)).slice(0, 10).map((memory) => clone(memory)!);
  }

  async forget(id: string, actor: MemoryEventInput["actor"]): Promise<void> {
    const current = this.memories.get(id);
    if (!current) throw new MemoryNotFoundError();
    if (current.status === "forgotten") return;
    this.memories.set(id, { ...current, status: "forgotten", currentRevision: undefined, claimKey: undefined, supersededById: undefined, version: current.version + 1, updatedAt: Date.now() });
    this.revisions.delete(id);
    this.sources.delete(id);
    for (const relation of [...this.relations]) if (relation.startsWith(`${id}:`) || relation.includes(`:${id}:`)) this.relations.delete(relation);
    this.events.push({ memoryId: id, eventType: "forgotten", fromStatus: current.status, toStatus: "forgotten", actor, reasonCode: "user_forget" });
  }

  async createReceipt(input: Omit<MutationReceipt, "createdAt">): Promise<MutationReceipt> { const receipt = { ...input, createdAt: Date.now() }; this.receipts.set(input.id, receipt); return { ...receipt }; }
  async getReceipt(id: string): Promise<MutationReceipt | undefined> { return clone(this.receipts.get(id)); }
  async consumeReceipt(id: string, now: number): Promise<void> { const receipt = this.receipts.get(id); if (!receipt || receipt.consumedAt || receipt.expiresAt <= now) throw new MemoryError("Receipt is expired, already used, or invalid", "MEMORY_INVALID_RECEIPT"); this.receipts.set(id, { ...receipt, consumedAt: now }); }
  async appendEvent(input: MemoryEventInput): Promise<void> { this.events.push({ ...input }); }
  async relate(fromId: string, toId: string, relation: "supersedes" | "conflicts_with" | "same_as" | "derived_from"): Promise<void> { this.relations.add(`${fromId}:${toId}:${relation}`); }
  async markObserved(id: string): Promise<void> { const memory = this.memories.get(id); if (memory && memory.status !== "forgotten") this.memories.set(id, { ...memory, observedCount: memory.observedCount + 1, updatedAt: Date.now() }); }
  async markApplied(id: string, verified: boolean): Promise<void> { const memory = this.memories.get(id); if (memory?.status === "active") this.memories.set(id, { ...memory, appliedCount: memory.appliedCount + 1, verifiedCount: memory.verifiedCount + (verified ? 1 : 0), updatedAt: Date.now() }); }
  async markProcessedTurn(input: ProcessedTurn): Promise<boolean> { if (this.processedTurns.has(input.turnKey)) return false; this.processedTurns.add(input.turnKey); return true; }
  async getRevisionHistory(id: string): Promise<MemoryRevision[]> { return clone(this.revisions.get(id) ?? [])!; }
  async listSources(id: string): Promise<MemorySource[]> { return clone(this.sources.get(id) ?? [])!; }
  async recordRecall(audit: RecallAudit): Promise<void> { this.audits.push(clone(audit)!); }
  async recordApplication(input: { memoryId: string; sessionId?: string; taskKeyHash?: string; outcome: "injected" | "verified" | "corrected" | "rejected" }): Promise<void> { this.applications.push({ ...input, createdAt: Date.now() }); }
  async listApplications(id: string) { return this.applications.filter((event) => event.memoryId === id).map((event) => ({ ...event })); }
  async applicationStats(id: string) {
    const events = this.applications.filter((event) => event.memoryId === id);
    const verified = events.filter((event) => event.outcome === "verified");
    const tasks = new Set(verified.map((event) => event.taskKeyHash).filter(Boolean));
    const repositories = new Set(verified.map((event) => event.sessionId ? this.sessions.get(event.sessionId)?.repositoryId : undefined).filter(Boolean));
    const conflicts = [...this.relations].filter((relation) => relation.startsWith(`${id}:`) && relation.endsWith(":conflicts_with")).length;
    return { verifiedApplications: verified.length, distinctTasks: tasks.size, distinctRepositories: repositories.size, unresolvedConflicts: conflicts };
  }
  async cleanupCandidates(before: number): Promise<number> {
    let count = 0;
    for (const [id, memory] of this.memories) if (memory.status === "candidate" && memory.updatedAt < before) { await this.forget(id, "system"); count += 1; }
    return count;
  }
  async ensureSession(input: { sessionId: string; piSessionId: string; repositoryId?: string; branch?: string; startedAt: number }): Promise<void> { this.sessions.set(input.sessionId, { repositoryId: input.repositoryId }); }
  async health(): Promise<SearchHealth> { return { ok: true, sqliteVersion: "in-memory", fts5: false, secureDelete: true }; }
}

export class InMemorySearchBackend implements SearchBackend {
  private readonly documents = new Map<string, string>();
  constructor(private readonly repository: MemoryRepository) {}

  async search(input: MemorySearchRequest, signal?: AbortSignal): Promise<MemorySearchHit[]> {
    if (signal?.aborted) return [];
    const terms = extractSearchTerms(input.query).map((term) => term.toLocaleLowerCase());
    if (terms.length === 0) return [];
    const results: MemorySearchHit[] = [];
    for (const id of this.documents.keys()) {
      if (signal?.aborted) return [];
      const memory = await this.repository.getById(id);
      if (!memory || !visible(memory, input)) continue;
      const text = this.documents.get(id)?.toLocaleLowerCase() ?? "";
      const matched = terms.filter((term) => text.includes(term)).length;
      if (matched === 0) continue;
      results.push({ memory, lexicalScore: matched / terms.length, rank: results.length, reasonCodes: ["in-memory"] });
    }
    return results.sort((a, b) => b.lexicalScore - a.lexicalScore).slice(0, input.limit);
  }

  async synchronize(memoryId: string): Promise<void> { const memory = await this.repository.getById(memoryId); if (memory?.currentRevision) this.documents.set(memoryId, buildSearchText(memory.currentRevision.content, memory.currentRevision.claim)); else this.documents.delete(memoryId); }
  async remove(memoryId: string): Promise<void> { this.documents.delete(memoryId); }
  async repair(): Promise<{ documents: number; active: number }> { let active = 0; for (const id of [...this.documents.keys()]) { const memory = await this.repository.getById(id); if (!memory?.currentRevision || memory.status === "forgotten") this.documents.delete(id); else active += 1; } return { documents: this.documents.size, active }; }
  async health(): Promise<SearchHealth> { return { ok: true, sqliteVersion: "in-memory", fts5: false, secureDelete: true }; }
}

function visible(memory: MemoryAggregate, request: MemorySearchRequest): boolean {
  return memory.profileId === request.profileId && request.statuses.includes(memory.status) && (memory.validUntil === undefined || memory.validUntil > request.now) && request.allowedScopes.some((scope) => scope.type === memory.scope.type && scope.key === memory.scope.key);
}

function clone<T>(value: T | undefined): T | undefined {
  return value === undefined ? undefined : structuredClone(value);
}
