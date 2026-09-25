import type {
  ApplicationStats,
  MemoryAggregate,
  MemoryApplicationEvent,
  MemoryEventInput,
  MemoryScope,
  MemorySearchHit,
  MemorySearchRequest,
  MemorySource,
  MemoryStatus,
  MemoryRevision,
  MutationReceipt,
  NewMemory,
  ProcessedTurn,
  RecallAudit,
  RevisionUpdate,
  SearchHealth,
} from "../domain/types.ts";

export interface MemoryRepository {
  initialize(profileId: string): Promise<void>;
  close(): Promise<void>;
  getById(id: string): Promise<MemoryAggregate | undefined>;
  create(input: NewMemory): Promise<MemoryAggregate>;
  updateRevision(id: string, expectedVersion: number, input: RevisionUpdate): Promise<MemoryAggregate>;
  transition(id: string, to: MemoryStatus, actor: MemoryEventInput["actor"], reasonCode: string): Promise<MemoryAggregate>;
  restoreStatus(id: string, expectedVersion: number, status: MemoryStatus): Promise<MemoryAggregate>;
  findByClaim(profileId: string, scope: MemoryScope, claimKey: string, statuses?: MemoryStatus[]): Promise<MemoryAggregate[]>;
  list(statuses: MemoryStatus[], profileId: string, limit: number): Promise<MemoryAggregate[]>;
  resolveByIdOrText(target: string, request: MemorySearchRequest): Promise<MemoryAggregate[]>;
  forget(id: string, actor: MemoryEventInput["actor"]): Promise<void>;
  createReceipt(input: Omit<MutationReceipt, "createdAt">): Promise<MutationReceipt>;
  getReceipt(id: string): Promise<MutationReceipt | undefined>;
  consumeReceipt(id: string, now: number): Promise<void>;
  appendEvent(input: MemoryEventInput): Promise<void>;
  relate(fromId: string, toId: string, relation: "supersedes" | "conflicts_with" | "same_as" | "derived_from"): Promise<void>;
  markObserved(id: string): Promise<void>;
  markApplied(id: string, verified: boolean): Promise<void>;
  markProcessedTurn(input: ProcessedTurn): Promise<boolean>;
  getRevisionHistory(id: string): Promise<MemoryRevision[]>;
  listSources(id: string): Promise<MemorySource[]>;
  recordRecall(audit: RecallAudit): Promise<void>;
  recordApplication(input: MemoryApplicationEvent): Promise<void>;
  applicationStats(id: string): Promise<ApplicationStats>;
  listApplications(id: string): Promise<MemoryApplicationEvent[]>;
  cleanupCandidates(before: number): Promise<number>;
  ensureSession(input: { sessionId: string; piSessionId: string; repositoryId?: string; branch?: string; startedAt: number }): Promise<void>;
  health(): Promise<SearchHealth>;
}

export interface SearchBackend {
  search(input: MemorySearchRequest, signal?: AbortSignal): Promise<MemorySearchHit[]>;
  synchronize(memoryId: string): Promise<void>;
  remove(memoryId: string): Promise<void>;
  repair(): Promise<{ documents: number; active: number }>;
  health(): Promise<SearchHealth>;
}

export interface SecretFilter {
  inspect(input: string): SecretDecision;
  scrubQuery(input: string): string;
}

export type SecretDecision =
  | { action: "allow" }
  | { action: "redact"; redactedText: string; findings: string[] }
  | { action: "reject"; findings: string[] };

export interface ScopeResolver {
  visibleScopes(scope: import("../domain/types.js").ScopeContext): MemoryScope[];
  requestedScope(scope: import("../domain/types.js").ScopeContext, requested: MemoryScope["type"] | undefined, explicitGlobal: boolean): MemoryScope;
}

export interface CaptureProposal {
  content: string;
  kind: import("../domain/types.js").MemoryKind;
  scope: MemoryScope;
  confidence: number;
  explicit: boolean;
  explicitGlobal: boolean;
  sourceType: MemorySource["sourceType"];
  authority: MemorySource["authority"];
  sourceUri: string;
  sourceEntryId?: string;
}

export interface SettledTurn {
  turnKey: string;
  profileId: string;
  sessionId: string;
  userEntryId: string;
  userText: string;
  assistantText: string;
  verifiedToolNames?: string[];
  taskKey?: string;
  scope: MemoryScope;
  settledAt: number;
}

export interface CaptureStrategy {
  detectExplicitIntent(text: string): ExplicitMemoryIntent | undefined;
  extract(turn: SettledTurn): Promise<CaptureProposal[]>;
}

export interface ExplicitMemoryIntent {
  action: "remember" | "update" | "forget" | "inspect";
  explicit: true;
  targetHint?: string;
  requestedScope?: MemoryScope["type"];
}
