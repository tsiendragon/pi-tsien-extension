import { memoryId } from "../shared/hash.ts";
import type { KnowledgeBridge, RetrievalCapability, RetrievalEventBus, RetrievalProviderResponse, RetrievalRequest, UnifiedRetrievalItem } from "../ports/knowledge.ts";
import type { RetrievalRoute } from "../domain/retrieval.ts";

export class PiKnowledgeBridge implements KnowledgeBridge {
  constructor(private readonly events: RetrievalEventBus | undefined, private readonly now: () => number = Date.now) {}

  async discover(): Promise<RetrievalCapability[]> {
    if (!this.events) return [];
    const capabilities: RetrievalCapability[] = [];
    this.events.emit("eagleeye.retrieval.discover.v1", { register: (capability: RetrievalCapability) => {
      if (capability.protocolVersion === 1 && !capabilities.some((item) => item.providerId === capability.providerId)) capabilities.push(capability);
    } });
    return capabilities;
  }

  async search(request: RetrievalRequest, signal?: AbortSignal): Promise<UnifiedRetrievalItem[]> {
    if (!this.events || signal?.aborted) return [];
    const capabilities = await this.discover();
    if (capabilities.length === 0) return [];
    const providerIds = new Set(capabilities.map((capability) => capability.providerId));
    const responses = new Map<string, RetrievalProviderResponse>();
    const deadline = Math.max(1, request.deadlineAt - this.now());
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let aborted = false;
    let abortHandler: (() => void) | undefined;
    const done = new Promise<void>((resolve) => {
      const finish = () => { if (responses.size >= providerIds.size) resolve(); };
      this.events?.emit("eagleeye.retrieval.search.v1", {
        request,
        respond: (response: RetrievalProviderResponse) => {
          if (response.requestId !== request.requestId || !providerIds.has(response.providerId) || this.now() > request.deadlineAt) return;
          responses.set(response.providerId, response);
          finish();
        },
      });
      finish();
    });
    const deadlineReached = new Promise<void>((resolve) => { timeout = setTimeout(resolve, deadline); });
    const abortedPromise = signal ? new Promise<void>((resolve) => {
      abortHandler = () => { aborted = true; resolve(); };
      if (signal.aborted) abortHandler(); else signal.addEventListener("abort", abortHandler, { once: true });
    }) : undefined;
    try {
      await Promise.race([done, deadlineReached, ...(abortedPromise ? [abortedPromise] : [])]);
    } finally {
      if (timeout) clearTimeout(timeout);
      if (abortHandler) signal?.removeEventListener("abort", abortHandler);
    }
    if (aborted) return [];
    const merged: UnifiedRetrievalItem[] = [];
    const seen = new Set<string>();
    for (const response of responses.values()) {
      for (const item of response.results) {
        const key = item.provenance.hash ? `${item.kind}:${item.provenance.hash}` : `${item.providerId}:${item.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(item);
      }
    }
    return merged.sort((a, b) => b.score - a.score).slice(0, request.limit);
  }

  announceCoordinator(runId: string, sessionId: string, expiresAt: number): void {
    this.events?.emit("eagleeye.context.coordinator.v1", { runId, sessionId, owner: "pi-tsien-memory", expiresAt });
  }
}

export function retrievalRequest(query: string, route: RetrievalRoute, cwd: string, repositoryId: string | undefined, branch: string | undefined, limit: number, deadlineMs: number, now = Date.now()): RetrievalRequest {
  return { requestId: memoryId("retrieval"), query, route, scope: { cwd, repositoryId, branch }, limit, deadlineAt: now + deadlineMs };
}
