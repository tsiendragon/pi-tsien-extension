import type { RetrievalRoute } from "../domain/retrieval.ts";

export interface RetrievalCapability {
  providerId: string;
  protocolVersion: 1;
  kinds: Array<"historical-memory" | "source-knowledge">;
  supportsAbort: boolean;
  ownsContextInjection: boolean;
}

export interface UnifiedRetrievalItem {
  id: string;
  kind: "historical-memory" | "source-knowledge";
  text: string;
  score: number;
  trust: "user-explicit" | "historical-evidence" | "source-evidence";
  provenance: { uri: string; hash?: string; stale?: boolean };
  providerId: string;
}

export interface RetrievalRequest {
  requestId: string;
  query: string;
  route: RetrievalRoute;
  scope: { cwd: string; repositoryId?: string; branch?: string };
  limit: number;
  deadlineAt: number;
}

export interface RetrievalProviderResponse {
  requestId: string;
  providerId: string;
  results: UnifiedRetrievalItem[];
  warnings: string[];
  latencyMs: number;
}

export interface RetrievalEventBus {
  emit(channel: string, data: unknown): void;
  on(channel: string, handler: (data: unknown) => void): () => void;
}

export interface KnowledgeBridge {
  discover(): Promise<RetrievalCapability[]>;
  search(request: RetrievalRequest, signal?: AbortSignal): Promise<UnifiedRetrievalItem[]>;
  announceCoordinator(runId: string, sessionId: string, expiresAt: number): void;
}
