import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiKnowledgeBridge, retrievalRequest } from "pi-tsien-memory/src/application/knowledge-bridge.ts";
import { PromotionAdvisor } from "pi-tsien-memory/src/application/promotion.ts";
import { InMemoryMemoryRepository, InMemorySearchBackend } from "pi-tsien-memory/src/adapters/memory/in-memory.ts";
import { DefaultSecretFilter } from "pi-tsien-memory/src/adapters/security/secret-filter.ts";
import { DefaultScopeResolver } from "pi-tsien-memory/src/adapters/pi/scope-resolver.ts";
import { RuleCaptureStrategy } from "pi-tsien-memory/src/application/capture-rules.ts";
import { MemoryService } from "pi-tsien-memory/src/application/memory-service.ts";

const dirs = [];

afterEach(async () => { while (dirs.length) await rm(dirs.pop(), { recursive: true, force: true }); });

class FakeBus {
  handlers = new Map();
  on(channel, handler) { const list = this.handlers.get(channel) ?? []; list.push(handler); this.handlers.set(channel, list); return () => this.handlers.set(channel, list.filter((item) => item !== handler)); }
  emit(channel, data) { for (const handler of this.handlers.get(channel) ?? []) handler(data); }
}

test("versioned retrieval bridge discovers, merges, and respects deadline", async () => {
  const bus = new FakeBus();
  bus.on("eagleeye.retrieval.discover.v1", ({ register }) => register({ providerId: "fake-knowledge", protocolVersion: 1, kinds: ["source-knowledge"], supportsAbort: true, ownsContextInjection: false }));
  bus.on("eagleeye.retrieval.search.v1", ({ request, respond }) => respond({ requestId: request.requestId, providerId: "fake-knowledge", results: [{ id: "chunk-1", kind: "source-knowledge", text: "current source", score: 0.9, trust: "source-evidence", providerId: "fake-knowledge", provenance: { uri: "knowledge://kb/chunk", hash: "chunk-hash", stale: false } }], warnings: [], latencyMs: 1 }));
  const bridge = new PiKnowledgeBridge(bus, Date.now);
  const capabilities = await bridge.discover();
  assert.equal(capabilities.length, 1);
  const request = retrievalRequest("current source", "knowledge", "/repo", "r", "main", 3, 100);
  const results = await bridge.search(request);
  assert.equal(results[0].id, "chunk-1");
  let coordinator;
  bus.on("eagleeye.context.coordinator.v1", (data) => { coordinator = data; });
  bridge.announceCoordinator("run-1", "session-1", Date.now() + 1000);
  assert.equal(coordinator.owner, "pi-tsien-memory");

  const fallback = new PiKnowledgeBridge(undefined);
  assert.deepEqual(await fallback.search(request), []);
  const slowBus = new FakeBus();
  slowBus.on("eagleeye.retrieval.discover.v1", ({ register }) => register({ providerId: "slow", protocolVersion: 1, kinds: ["source-knowledge"], supportsAbort: true, ownsContextInjection: false }));
  const slowBridge = new PiKnowledgeBridge(slowBus, Date.now);
  const startedAt = Date.now();
  assert.deepEqual(await slowBridge.search(retrievalRequest("slow", "knowledge", "/repo", "r", "main", 3, 20), undefined), []);
  assert.ok(Date.now() - startedAt < 500);
});

test("promotion preview requires verified use and writes only local evidence files", async () => {
  const repository = new InMemoryMemoryRepository();
  await repository.initialize("profile");
  await repository.ensureSession({ sessionId: "s1", piSessionId: "s1", repositoryId: "repo-1", startedAt: Date.now() });
  await repository.ensureSession({ sessionId: "s2", piSessionId: "s2", repositoryId: "repo-2", startedAt: Date.now() });
  const search = new InMemorySearchBackend(repository);
  const service = new MemoryService(repository, search, new DefaultSecretFilter(), new DefaultScopeResolver(), new RuleCaptureStrategy());
  const scope = { type: "global", key: "global:profile" };
  const created = await service.remember("Always use pnpm for reproducible installs", { profileId: "profile", scope, explicit: true, explicitGlobal: true });
  await repository.recordApplication({ memoryId: created.memory.id, sessionId: "s1", taskKeyHash: "task-1", outcome: "verified" });
  await repository.recordApplication({ memoryId: created.memory.id, sessionId: "s1", taskKeyHash: "task-2", outcome: "verified" });
  await repository.recordApplication({ memoryId: created.memory.id, sessionId: "s2", taskKeyHash: "task-3", outcome: "verified" });
  const dir = await mkdtemp(join(tmpdir(), "pi-promotion-")); dirs.push(dir);
  const advisor = new PromotionAdvisor(repository, new DefaultSecretFilter(), dir);
  const preview = await advisor.preview(created.memory.id);
  assert.equal(preview.eligibility.eligible, true);
  assert.equal(preview.bundle.suggestedType, "rule");
  assert.match(await readFile(preview.jsonPath, "utf8"), /"privacyReview"/);
  assert.match(await readFile(preview.markdownPath, "utf8"), /Promotion Proposal/);
  await advisor.dismiss(preview.proposalId);
  assert.ok((await readdir(dir)).some((name) => name.endsWith(".dismissed.json")));

  const pluginMemory = await service.remember("This plugin should coordinate capture and verification across repositories", { profileId: "profile", scope: { type: "global", key: "global:profile" }, explicit: true, explicitGlobal: true });
  for (const taskKeyHash of ["task-1", "task-2", "task-3"]) await repository.recordApplication({ memoryId: pluginMemory.memory.id, sessionId: taskKeyHash === "task-3" ? "s2" : "s1", taskKeyHash, outcome: "verified" });
  const pluginPreview = await advisor.preview(pluginMemory.memory.id);
  assert.equal(pluginPreview.bundle.suggestedType, "plugin");
  assert.equal(pluginPreview.bundle.components.length, 2);
});
