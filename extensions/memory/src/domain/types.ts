export type MemoryId = string;
export type RevisionId = string;
export type ProfileId = string;
export type ReceiptId = string;

export type MemoryStatus =
  | "candidate"
  | "active"
  | "stale"
  | "superseded"
  | "rejected"
  | "forgotten";

export type MemoryKind = "preference" | "decision" | "experience" | "continuity";

export type ScopeType = "global" | "repository" | "branch" | "session";

export interface MemoryScope {
  type: ScopeType;
  key: string;
  repositoryId?: string;
  branch?: string;
  sessionId?: string;
}

export interface ScopeContext {
  profileId: ProfileId;
  sessionId: string;
  repositoryId?: string;
  branch?: string;
  cwd: string;
}

export interface StructuredClaim {
  subject: string;
  predicate: string;
  value: string | number | boolean | string[];
  polarity: "positive" | "negative";
  qualifiers: Record<string, string>;
}

export interface MemoryRevision {
  id: RevisionId;
  memoryId: MemoryId;
  revisionNo: number;
  content: string;
  claim?: StructuredClaim;
  contentHash: string;
  createdBy: "user" | "rule-capture" | "review" | "migration";
  createdAt: number;
}

export interface MemorySource {
  id: string;
  revisionId: RevisionId;
  sourceType: "user_message" | "assistant_summary" | "tool_result" | "session_summary" | "knowledge_chunk" | "manual_review";
  sourceUri: string;
  sourceEntryId?: string;
  sourceHash: string;
  evidenceSummary?: string;
  authority: "user_explicit" | "user_confirmed" | "verified_tool" | "current_source" | "agent_inference";
  verified: boolean;
  createdAt: number;
}

export interface MemoryAggregate {
  id: MemoryId;
  profileId: ProfileId;
  kind: MemoryKind;
  status: MemoryStatus;
  scope: MemoryScope;
  claimKey?: string;
  currentRevision?: MemoryRevision;
  confidence: number;
  observedCount: number;
  verifiedCount: number;
  appliedCount: number;
  correctedCount: number;
  version: number;
  validFrom: number;
  validUntil?: number;
  supersededById?: MemoryId;
  createdAt: number;
  updatedAt: number;
}

export interface NewMemory {
  id: MemoryId;
  profileId: ProfileId;
  kind: MemoryKind;
  status: MemoryStatus;
  scope: MemoryScope;
  claimKey?: string;
  content: string;
  claim?: StructuredClaim;
  contentHash: string;
  confidence: number;
  validFrom: number;
  validUntil?: number;
  createdBy: MemoryRevision["createdBy"];
  source: Omit<MemorySource, "id" | "revisionId" | "sourceHash" | "createdAt"> & { sourceHash?: string };
  receiptId?: ReceiptId;
}

export interface RevisionUpdate {
  content: string;
  claim?: StructuredClaim;
  claimKey?: string;
  contentHash: string;
  createdBy: MemoryRevision["createdBy"];
  source: Omit<MemorySource, "id" | "revisionId" | "sourceHash" | "createdAt"> & { sourceHash?: string };
  status?: MemoryStatus;
  confidence?: number;
}

export interface MemorySearchRequest {
  query: string;
  profileId: ProfileId;
  allowedScopes: MemoryScope[];
  statuses: MemoryStatus[];
  limit: number;
  now: number;
}

export interface MemorySearchHit {
  memory: MemoryAggregate;
  lexicalScore: number;
  rank: number;
  reasonCodes: string[];
}

export interface RecallQuery {
  query: string;
  scope: ScopeContext;
  maxItems: number;
  maxTokens: number;
  minScore: number;
  now?: number;
  route?: "memory" | "knowledge" | "mixed" | "none";
  currentSessionContents?: string[];
}

export interface RankedMemory {
  memory: MemoryAggregate;
  score: number;
  reasonCodes: string[];
}

export interface RecallBundle {
  runId: string;
  items: RankedMemory[];
  estimatedTokens: number;
  createdAt: number;
}

export interface ForgetPreview {
  receiptId: ReceiptId;
  memory: MemoryAggregate;
  expiresAt: number;
  eraseKinds: string[];
}

export interface MutationReceipt {
  id: ReceiptId;
  operation: "create" | "update" | "activate" | "reject" | "forget_preview";
  memoryId: MemoryId;
  previousRevisionId?: RevisionId;
  previousStatus?: MemoryStatus;
  previewHash?: string;
  expiresAt: number;
  consumedAt?: number;
  createdAt: number;
}

export interface SearchHealth {
  ok: boolean;
  sqliteVersion: string;
  fts5: boolean;
  secureDelete: boolean;
  details?: string;
}

export interface MemoryEventInput {
  memoryId: MemoryId;
  eventType: string;
  fromStatus?: MemoryStatus;
  toStatus?: MemoryStatus;
  revisionId?: RevisionId;
  actor: "user" | "agent" | "system";
  reasonCode: string;
  metadata?: Record<string, unknown>;
}

export interface ProcessedTurn {
  turnKey: string;
  sessionId: string;
  userEntryId: string;
  extractorVersion: string;
  processedAt: number;
}

export interface RecallAudit {
  runId: string;
  sessionId: string;
  queryHash: string;
  route: "memory" | "knowledge" | "mixed" | "none";
  status: "completed" | "timeout" | "error" | "disabled";
  latencyMs: number;
  injectedCount: number;
  items: Array<{ memoryId: string; revisionId: string; rank: number; score: number; reasonCodes: string[] }>;
}

export interface ApplicationStats {
  verifiedApplications: number;
  distinctTasks: number;
  distinctRepositories: number;
  unresolvedConflicts: number;
}

export interface MemoryApplicationEvent {
  memoryId: MemoryId;
  sessionId?: string;
  taskKeyHash?: string;
  outcome: "injected" | "verified" | "corrected" | "rejected";
  createdAt?: number;
}
