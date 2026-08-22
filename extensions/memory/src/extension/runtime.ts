import { createHash } from "node:crypto";
import { join } from "node:path";
import type { MemoryConfig } from "../config.ts";
import { loadConfig } from "../config.ts";
import { DefaultSecretFilter } from "../adapters/security/secret-filter.ts";
import { openDatabase } from "../adapters/sqlite/driver.ts";
import { SqliteMemoryRepository } from "../adapters/sqlite/repository.ts";
import { SqliteSearchBackend } from "../adapters/sqlite/search.ts";
import { DefaultScopeResolver } from "../adapters/pi/scope-resolver.ts";
import { MemoryService } from "../application/memory-service.ts";
import { RuleCaptureStrategy } from "../application/capture-rules.ts";
import { ModelCandidateReviewer } from "../application/candidate-reviewer.ts";
import type { MemoryScope, RecallBundle, ScopeContext } from "../domain/types.ts";
import type { ExplicitMemoryIntent, SettledTurn } from "../ports/memory.ts";
import type { PiExtensionAPI, ExtensionContext } from "./pi-types.ts";
import { PiKnowledgeBridge } from "../application/knowledge-bridge.ts";
import { PromotionAdvisor } from "../application/promotion.ts";
import type { UnifiedRetrievalItem } from "../ports/knowledge.ts";
import { resolveScope } from "./git-scope.ts";

export type CandidateReviewer = Pick<ModelCandidateReviewer, "review" | "dispose">;

export interface RuntimeDependencies {
  candidateReviewer?: CandidateReviewer;
}

export interface RuntimeState {
  config: MemoryConfig;
  repository: SqliteMemoryRepository;
  search: SqliteSearchBackend;
  service: MemoryService;
  scope: ScopeContext;
  resolver: DefaultScopeResolver;
  secretFilter: DefaultSecretFilter;
  knowledgeBridge: PiKnowledgeBridge;
  promotionAdvisor: PromotionAdvisor;
  candidateReviewer?: CandidateReviewer;
  intent?: ExplicitMemoryIntent;
  inputText?: string;
  inputEntryId?: string;
  assistantText?: string;
  verifiedToolNames: string[];
  recall?: RecallBundle;
  knowledgeResults: UnifiedRetrievalItem[];
  enabled: boolean;
  closing: boolean;
  memoryMutated: boolean;
  memoryToolAttempted: boolean;
}

export async function createRuntime(pi: PiExtensionAPI, ctx: ExtensionContext, dependencies: RuntimeDependencies = {}): Promise<RuntimeState> {
  const config = loadConfig(ctx.cwd, ctx.isProjectTrusted());
  const profileId = createProfileId();
  const sessionId = ctx.sessionManager.getSessionId();
  const scope = await resolveScope(pi, ctx.cwd, sessionId, profileId);
  const db = await openDatabase(config.dataDir);
  const repository = new SqliteMemoryRepository(db);
  await repository.initialize(profileId);
  await repository.ensureSession({ sessionId, piSessionId: sessionId, repositoryId: scope.repositoryId, branch: scope.branch, startedAt: Date.now() });
  const search = new SqliteSearchBackend(db);
  const resolver = new DefaultScopeResolver();
  const secretFilter = new DefaultSecretFilter();
  const service = new MemoryService(repository, search, secretFilter, resolver, new RuleCaptureStrategy());
  const promotionAdvisor = new PromotionAdvisor(repository, secretFilter, join(config.dataDir, "proposals"));
  const candidateReviewer = dependencies.candidateReviewer ?? (config.capture.reviewer.enabled && config.privacy.remoteProcessing
    ? new ModelCandidateReviewer(config.capture.reviewer)
    : undefined);
  return { config, repository, search, service, scope, resolver, secretFilter, knowledgeBridge: new PiKnowledgeBridge(pi.events), promotionAdvisor, candidateReviewer, knowledgeResults: [], enabled: true, closing: false, memoryMutated: false, memoryToolAttempted: false, verifiedToolNames: [] };
}

export async function closeRuntime(runtime: RuntimeState): Promise<void> {
  if (runtime.closing) return;
  runtime.closing = true;
  await runtime.candidateReviewer?.dispose();
  await runtime.repository.close();
}

export function currentScopes(runtime: RuntimeState, requested?: MemoryScope["type"], explicitGlobal = false): MemoryScope {
  return runtime.resolver.requestedScope(runtime.scope, requested, explicitGlobal);
}

export function currentVisibleScopes(runtime: RuntimeState): MemoryScope[] {
  return runtime.resolver.visibleScopes(runtime.scope);
}

export function turnFromState(runtime: RuntimeState): SettledTurn | undefined {
  if (!runtime.inputText || !runtime.inputEntryId) return undefined;
  const turnKey = createHash("sha256").update(`${runtime.scope.sessionId}:${runtime.inputEntryId}:${runtime.inputText}`).digest("hex");
  return {
    turnKey,
    profileId: runtime.scope.profileId,
    sessionId: runtime.scope.sessionId,
    userEntryId: runtime.inputEntryId,
    userText: runtime.inputText,
    assistantText: runtime.assistantText ?? "",
    verifiedToolNames: [...runtime.verifiedToolNames],
    taskKey: runtime.scope.repositoryId ? `${runtime.scope.repositoryId}:${runtime.scope.branch ?? "detached"}` : runtime.scope.sessionId,
    scope: currentDefaultWriteScope(runtime),
    settledAt: Date.now(),
  };
}

function currentDefaultWriteScope(runtime: RuntimeState): MemoryScope {
  if (runtime.scope.repositoryId) return { type: "repository", key: `repository:${runtime.scope.repositoryId}`, repositoryId: runtime.scope.repositoryId };
  return { type: "session", key: `session:${runtime.scope.sessionId}`, sessionId: runtime.scope.sessionId };
}

function createProfileId(): string {
  const configured = process.env.PI_TSIEN_MEMORY_PROFILE?.trim();
  if (configured) return configured.slice(0, 120);
  return createHash("sha256").update(`profile:${process.env.USER ?? process.env.USERNAME ?? "default"}`).digest("hex");
}
