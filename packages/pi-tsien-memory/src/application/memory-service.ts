import { MemoryConfirmationRequiredError, MemoryError, MemoryNotFoundError } from "../domain/errors.ts";
import { claimKey, contentHash, extractClaim, normalizeText } from "../domain/normalize.ts";
import type {
  ForgetPreview,
  MemoryAggregate,
  MemorySearchRequest,
  MemoryScope,
  MemoryStatus,
  RecallBundle,
  RecallQuery,
  RevisionUpdate,
  ScopeContext,
} from "../domain/types.ts";
import type { CaptureStrategy, MemoryRepository, ScopeResolver, SearchBackend, SecretFilter, SettledTurn } from "../ports/memory.ts";
import { memoryId, sha256 } from "../shared/hash.ts";
import { estimateTokens, fitRecallItems, rankRecall } from "./ranking.ts";

export interface RememberOptions {
  profileId: string;
  scope: MemoryScope;
  explicit: boolean;
  explicitGlobal: boolean;
  sourceType?: "user_message" | "assistant_summary" | "tool_result" | "session_summary" | "knowledge_chunk" | "manual_review";
  authority?: "user_explicit" | "user_confirmed" | "verified_tool" | "current_source" | "agent_inference";
  sourceUri?: string;
  sourceEntryId?: string;
  createdBy?: "user" | "rule-capture" | "review" | "migration";
  kind?: MemoryAggregate["kind"];
}

export interface SearchOptions {
  profileId: string;
  scopes: MemoryScope[];
  statuses?: MemoryStatus[];
  limit?: number;
}

export class MemoryService {
  constructor(
    private readonly repository: MemoryRepository,
    private readonly searchBackend: SearchBackend,
    private readonly secretFilter: SecretFilter,
    private readonly scopeResolver: ScopeResolver,
    private readonly captureStrategy: CaptureStrategy,
    private readonly now: () => number = Date.now,
  ) {}

  async remember(content: string, options: RememberOptions): Promise<{ memory: MemoryAggregate; created: boolean; conflict?: MemoryAggregate; receiptId?: string }> {
    const decision = this.secretFilter.inspect(content);
    if (decision.action === "reject") throw new MemoryError("Memory was not saved because it contains sensitive data", "MEMORY_SECRET_BLOCKED");
    if (looksLikeSourceBody(content)) throw new MemoryError("Memory was not saved because the content looks like source code or log output", "MEMORY_SOURCE_BODY_BLOCKED");
    const normalized = normalizeText(content);
    if (!normalized) throw new MemoryError("Memory content is empty", "MEMORY_EMPTY_CONTENT");
    const extracted = extractClaim(normalized);
    const claim = extracted.claim;
    const key = claim ? claimKey(claim) : undefined;
    const existing = key ? await this.repository.findByClaim(options.profileId, options.scope, key) : [];
    const source = {
      sourceType: options.sourceType ?? "user_message",
      sourceUri: options.sourceUri ?? "memory://explicit",
      sourceEntryId: options.sourceEntryId,
      authority: options.authority ?? (options.explicit ? "user_explicit" : "agent_inference"),
      verified: options.explicit,
    } as const;

    for (const current of existing) {
      const currentContent = normalizeText(current.currentRevision?.content ?? "");
      if (currentContent === normalized) {
        await this.repository.markObserved(current.id);
        return { memory: (await this.repository.getById(current.id)) ?? current, created: false };
      }
      if (options.explicit && current.status !== "forgotten") {
        const updated = await this.repository.updateRevision(current.id, current.version, {
          content: normalized,
          claim,
          claimKey: key,
          contentHash: contentHash(normalized),
          createdBy: options.createdBy ?? "user",
          source,
          status: "active",
          confidence: 0.99,
        });
        await this.searchBackend.synchronize(updated.id);
        const receiptId = await this.createUndoReceipt("update", updated.id, current.currentRevision?.id, current.status);
        return { memory: updated, created: false, receiptId };
      }
      const candidate = await this.create(normalized, options.kind ?? extracted.kind, options, key, claim, 0.68, source);
      await this.searchBackend.synchronize(candidate.id);
      await this.repository.relate(candidate.id, current.id, "conflicts_with");
      const receiptId = await this.createUndoReceipt("create", candidate.id);
      return { memory: candidate, created: true, conflict: current, receiptId };
    }

    const status: MemoryStatus = options.explicit ? "active" : "candidate";
    const confidence = options.explicit ? 0.98 : 0.68;
    const memory = await this.create(normalized, options.kind ?? extracted.kind, options, key, claim, confidence, source, status);
    await this.searchBackend.synchronize(memory.id);
    const receiptId = await this.createUndoReceipt("create", memory.id);
    return { memory, created: true, receiptId };
  }

  async search(query: string, options: SearchOptions): Promise<MemoryAggregate[]> {
    const safeQuery = this.secretFilter.scrubQuery(query);
    const request: MemorySearchRequest = {
      query: safeQuery,
      profileId: options.profileId,
      allowedScopes: options.scopes,
      statuses: options.statuses ?? ["active"],
      limit: Math.max(1, Math.min(20, options.limit ?? 10)),
      now: this.now(),
    };
    const hits = await this.searchBackend.search(request);
    return hits.map((hit) => hit.memory);
  }

  async recall(query: RecallQuery): Promise<RecallBundle> {
    const startedAt = this.now();
    const runId = memoryId("run");
    const safeQuery = this.secretFilter.scrubQuery(query.query);
    if (!normalizeText(safeQuery)) return { runId, items: [], estimatedTokens: 0, createdAt: this.now() };
    const request: MemorySearchRequest = {
      query: safeQuery,
      profileId: query.scope.profileId,
      allowedScopes: this.scopeResolver.visibleScopes(query.scope),
      statuses: ["active"],
      limit: 30,
      now: this.now(),
    };
    const hits = await this.searchBackend.search(request);
    const ranked = await rankRecall({ ...query, query: safeQuery, now: query.now ?? this.now() }, hits);
    const fitted = fitRecallItems(ranked, query.maxTokens);
    await Promise.all(fitted.items.map((item) => this.repository.markObserved(item.memory.id).catch(() => undefined)));
    const route = query.route ?? "memory";
    await this.repository.recordRecall({ runId, sessionId: query.scope.sessionId, queryHash: sha256(safeQuery), route, status: "completed", latencyMs: Math.max(0, this.now() - startedAt), injectedCount: fitted.items.length, items: fitted.items.map((item, rank) => ({ memoryId: item.memory.id, revisionId: item.memory.currentRevision?.id ?? "", rank, score: item.score, reasonCodes: item.reasonCodes })) }).catch(() => undefined);
    await Promise.all(fitted.items.map((item) => this.repository.recordApplication({ memoryId: item.memory.id, sessionId: query.scope.sessionId, outcome: "injected" }).catch(() => undefined)));
    return { runId, items: fitted.items, estimatedTokens: fitted.estimatedTokens, createdAt: this.now() };
  }

  async update(target: string, replacement: string, options: { profileId: string; scopes: MemoryScope[]; explicit: boolean }): Promise<MemoryAggregate & { undoReceiptId?: string }> {
    if (!options.explicit) throw new MemoryError("An explicit user correction is required before updating memory", "MEMORY_EXPLICIT_INTENT_REQUIRED");
    const memory = await this.resolveUniqueTarget(target, options.profileId, options.scopes, ["active", "candidate", "stale"]);
    const decision = this.secretFilter.inspect(replacement);
    if (decision.action === "reject") throw new MemoryError("Replacement contains sensitive data", "MEMORY_SECRET_BLOCKED");
    const normalized = normalizeText(replacement);
    const extracted = extractClaim(normalized);
    if (!normalized) throw new MemoryError("Replacement is empty", "MEMORY_EMPTY_CONTENT");
    if (looksLikeSourceBody(replacement)) throw new MemoryError("Replacement was not saved because it looks like source code or log output", "MEMORY_SOURCE_BODY_BLOCKED");
    const updated = await this.repository.updateRevision(memory.id, memory.version, {
      content: normalized,
      claim: extracted.claim,
      claimKey: extracted.claim ? claimKey(extracted.claim) : undefined,
      contentHash: contentHash(normalized),
      createdBy: "user",
      status: "active",
      confidence: 0.99,
      source: { sourceType: "manual_review", sourceUri: `memory://${memory.id}/update`, authority: "user_explicit", verified: true },
    });
    await this.searchBackend.synchronize(updated.id);
    const receiptId = await this.createUndoReceipt("update", updated.id, memory.currentRevision?.id, memory.status);
    return Object.assign(updated, { undoReceiptId: receiptId });
  }

  async previewForget(target: string, options: { profileId: string; scopes: MemoryScope[] }): Promise<ForgetPreview> {
    const memory = await this.resolveUniqueTarget(target, options.profileId, options.scopes, ["active", "candidate", "stale", "superseded", "rejected"]);
    if (!memory.currentRevision) throw new MemoryNotFoundError();
    const receiptId = memoryId("confirm");
    const previewHash = sha256(`${memory.id}:${memory.currentRevision.id}`);
    const expiresAt = this.now() + 10 * 60_000;
    await this.repository.createReceipt({ id: receiptId, operation: "forget_preview", memoryId: memory.id, previewHash, expiresAt });
    return { receiptId, memory, expiresAt, eraseKinds: ["content", "revision history", "source metadata", "FTS index", "recall cache", "promotion drafts"] };
  }

  async confirmForget(receiptId: string): Promise<string> {
    const receipt = await this.repository.getReceipt(receiptId);
    if (!receipt || receipt.operation !== "forget_preview" || receipt.consumedAt || receipt.expiresAt <= this.now()) throw new MemoryConfirmationRequiredError("Confirmation token is invalid or expired");
    const memory = await this.repository.getById(receipt.memoryId);
    if (!memory?.currentRevision || receipt.previewHash !== sha256(`${memory.id}:${memory.currentRevision.id}`)) throw new MemoryConfirmationRequiredError("Memory changed; request a new forget preview");
    await this.repository.consumeReceipt(receiptId, this.now());
    await this.repository.forget(memory.id, "user");
    await this.searchBackend.remove(memory.id);
    return memory.id;
  }

  async reconcileCurrentSource(source: { text: string; uri: string; stale?: boolean }, profileId: string, scopes: MemoryScope[]): Promise<string[]> {
    if (source.stale === true) return [];
    const extracted = extractClaim(normalizeText(source.text));
    if (!extracted.claim) return [];
    const key = claimKey(extracted.claim);
    const active = await this.list(["active"], profileId, scopes, 100);
    const staleIds: string[] = [];
    for (const memory of active) {
      const claim = memory.currentRevision?.claim;
      if (!claim || claimKey(claim) !== key || JSON.stringify(claim.value) === JSON.stringify(extracted.claim.value)) continue;
      await this.markSourceStale(memory.id, source.uri, source.text);
      staleIds.push(memory.id);
    }
    return staleIds;
  }

  async markSourceStale(memoryIdValue: string, sourceUri: string, _sourceSummary: string): Promise<{ stale: MemoryAggregate; candidate: MemoryAggregate }> {
    const memory = await this.repository.getById(memoryIdValue);
    if (!memory || memory.status !== "active") throw new MemoryNotFoundError();
    const uriDecision = this.secretFilter.inspect(sourceUri);
    const safeSourceUri = uriDecision.action === "reject" ? "knowledge://redacted-source" : sourceUri.slice(0, 1000);
    const stale = await this.repository.transition(memory.id, "stale", "system", "authoritative_source_conflict");
    const candidate = await this.remember("Current source contradicts this memory; verify the source pointer before accepting a replacement.", { profileId: memory.profileId, scope: memory.scope, explicit: false, explicitGlobal: false, sourceType: "knowledge_chunk", authority: "current_source", sourceUri: safeSourceUri, createdBy: "rule-capture" });
    await this.repository.relate(candidate.memory.id, memory.id, "conflicts_with");
    return { stale, candidate: candidate.memory };
  }

  async review(action: "accept" | "reject", target: string, options: { profileId: string; scopes: MemoryScope[] }): Promise<MemoryAggregate & { undoReceiptId?: string }> {
    const candidate = await this.resolveUniqueTarget(target, options.profileId, options.scopes, ["candidate"], "Candidate was not found");
    if (action === "reject") {
      const rejected = await this.repository.transition(candidate.id, "rejected", "user", "candidate_rejected");
      await this.searchBackend.synchronize(rejected.id);
      const receiptId = await this.createUndoReceipt("reject", rejected.id, rejected.currentRevision?.id, "candidate");
      return Object.assign(rejected, { undoReceiptId: receiptId });
    }
    if (candidate.claimKey) {
      const conflicts = await this.repository.findByClaim(options.profileId, candidate.scope, candidate.claimKey, ["active"]);
      for (const conflict of conflicts) {
        if (conflict.id === candidate.id) continue;
        await this.repository.transition(conflict.id, "superseded", "user", "candidate_confirmed_replacement");
        await this.repository.relate(candidate.id, conflict.id, "supersedes");
      }
    }
    const accepted = await this.repository.transition(candidate.id, "active", "user", "candidate_confirmed");
    await this.searchBackend.synchronize(accepted.id);
    const receiptId = await this.createUndoReceipt("activate", accepted.id, accepted.currentRevision?.id, "candidate");
    return Object.assign(accepted, { undoReceiptId: receiptId });
  }

  async undo(receiptId: string): Promise<MemoryAggregate> {
    const receipt = await this.repository.getReceipt(receiptId);
    if (!receipt || !["create", "update", "activate", "reject"].includes(receipt.operation) || receipt.consumedAt || receipt.expiresAt <= this.now()) throw new MemoryError("Undo receipt is invalid or expired", "MEMORY_INVALID_RECEIPT");
    const memory = await this.repository.getById(receipt.memoryId);
    if (!memory) throw new MemoryNotFoundError();
    if (receipt.operation === "create") {
      await this.repository.consumeReceipt(receiptId, this.now());
      await this.repository.forget(memory.id, "user");
      await this.searchBackend.remove(memory.id);
      return (await this.repository.getById(memory.id)) ?? { ...memory, status: "forgotten", currentRevision: undefined };
    }
    if (receipt.operation === "update") {
      const previousId = receipt.previousRevisionId;
      const previous = (await this.repository.getRevisionHistory(memory.id)).find((revision) => revision.id === previousId);
      if (!previous) throw new MemoryError("Previous revision is unavailable", "MEMORY_UNDO_REVISION_MISSING");
      const claim = previous.claim;
      const restored = await this.repository.updateRevision(memory.id, memory.version, { content: previous.content, claim, claimKey: claim ? claimKey(claim) : undefined, contentHash: previous.contentHash, createdBy: "review", status: receipt.previousStatus ?? memory.status, source: { sourceType: "manual_review", sourceUri: `memory://${memory.id}/undo`, authority: "user_confirmed", verified: true } });
      await this.repository.consumeReceipt(receiptId, this.now());
      await this.searchBackend.synchronize(restored.id);
      return restored;
    }
    const restored = await this.repository.restoreStatus(memory.id, memory.version, receipt.previousStatus ?? "candidate");
    await this.repository.consumeReceipt(receiptId, this.now());
    await this.searchBackend.synchronize(restored.id);
    return restored;
  }

  async list(statuses: MemoryStatus[], profileId: string, scopes: MemoryScope[], limit = 20): Promise<MemoryAggregate[]> {
    const all = await this.repository.list(statuses, profileId, limit * 3);
    return all.filter((memory) => scopes.some((scope) => scope.type === memory.scope.type && scope.key === memory.scope.key)).slice(0, limit);
  }

  async capture(turn: SettledTurn): Promise<MemoryAggregate[]> {
    if (!(await this.repository.markProcessedTurn({ turnKey: turn.turnKey, sessionId: turn.sessionId, userEntryId: turn.userEntryId, extractorVersion: "rules-v1", processedAt: turn.settledAt }))) return [];
    const proposals = await this.captureStrategy.extract(turn);
    const created: MemoryAggregate[] = [];
    for (const proposal of proposals) {
      const extracted = extractClaim(proposal.content);
      const result = await this.remember(proposal.content, {
        profileId: turn.profileId,
        scope: proposal.explicitGlobal ? { type: "global", key: `global:${turn.profileId}` } : proposal.scope,
        explicit: proposal.explicit,
        explicitGlobal: proposal.explicitGlobal,
        sourceType: proposal.sourceType,
        authority: proposal.authority,
        sourceUri: proposal.sourceUri,
        sourceEntryId: proposal.sourceEntryId,
        createdBy: proposal.explicit ? "user" : "rule-capture",
      });
      void extracted;
      created.push(result.memory);
    }
    return created;
  }

  async captureReviewedCandidate(turn: SettledTurn, reviewed: { content: string; kind: MemoryAggregate["kind"] }): Promise<MemoryAggregate> {
    const result = await this.remember(reviewed.content, {
      profileId: turn.profileId,
      scope: turn.scope,
      explicit: false,
      explicitGlobal: false,
      sourceType: "assistant_summary",
      authority: "agent_inference",
      sourceUri: `session:${turn.sessionId}`,
      sourceEntryId: turn.userEntryId,
      createdBy: "review",
      kind: reviewed.kind,
    });
    return result.memory;
  }

  async doctor(profileId: string, repairIndex = false): Promise<{ health: Awaited<ReturnType<MemoryRepository["health"]>>; candidates: number; active: number; repair?: { documents: number; active: number } }> {
    const health = await this.repository.health();
    const repair = repairIndex ? await this.searchBackend.repair() : undefined;
    const [candidate, active] = await Promise.all([
      this.repository.list(["candidate"], profileId, 100000).catch(() => []),
      this.repository.list(["active"], profileId, 100000).catch(() => []),
    ]);
    return { health, candidates: candidate.length, active: active.length, ...(repair ? { repair } : {}) };
  }

  private async createUndoReceipt(operation: "create" | "update" | "activate" | "reject", memoryIdValue: string, previousRevisionId?: string, previousStatus?: MemoryStatus): Promise<string> {
    const receiptId = memoryId("undo");
    await this.repository.createReceipt({ id: receiptId, operation, memoryId: memoryIdValue, previousRevisionId, previousStatus, expiresAt: this.now() + 10 * 60_000 });
    return receiptId;
  }

  private async create(
    content: string,
    kind: MemoryAggregate["kind"],
    options: RememberOptions,
    key: string | undefined,
    claim: import("../domain/types.js").StructuredClaim | undefined,
    confidence: number,
    source: RememberOptions["sourceType"] extends never ? never : {
      sourceType: NonNullable<RememberOptions["sourceType"]>;
      sourceUri: string;
      sourceEntryId?: string;
      authority: NonNullable<RememberOptions["authority"]>;
      verified: boolean;
    },
    status: MemoryStatus = options.explicit ? "active" : "candidate",
  ): Promise<MemoryAggregate> {
    return this.repository.create({
      id: memoryId("mem"),
      profileId: options.profileId,
      kind,
      status,
      scope: options.scope,
      claimKey: key,
      content,
      claim,
      contentHash: contentHash(content),
      confidence,
      validFrom: this.now(),
      createdBy: options.createdBy ?? (options.explicit ? "user" : "rule-capture"),
      source,
    });
  }

  private async resolveTarget(target: string, profileId: string, scopes: MemoryScope[], statuses: MemoryStatus[]): Promise<MemoryAggregate[]> {
    const request: MemorySearchRequest = { query: target, profileId, allowedScopes: scopes, statuses, limit: 10, now: this.now() };
    const byText = await this.repository.resolveByIdOrText(target, request);
    if (byText.length > 0) return byText;
    const hits = await this.searchBackend.search(request);
    return hits.map((hit) => hit.memory);
  }

  private async resolveUniqueTarget(target: string, profileId: string, scopes: MemoryScope[], statuses: MemoryStatus[], notFoundMessage = "Memory target was not found"): Promise<MemoryAggregate> {
    const matches = await this.resolveTarget(target, profileId, scopes, statuses);
    if (matches.length === 0) throw new MemoryNotFoundError(notFoundMessage);
    if (matches.length > 1) throw new MemoryError("Multiple memories match this target; specify the memory ID or clarify", "MEMORY_AMBIGUOUS_TARGET");
    return matches[0];
  }
}

function looksLikeSourceBody(text: string): boolean {
  return text.includes("```") || /^diff --git /m.test(text) || /^(?:\s*at .+\n){3,}/m.test(text) || text.split("\n").length > 12;
}
