import test from "node:test";
import assert from "node:assert/strict";
import { InMemoryMemoryRepository, InMemorySearchBackend } from "pi-tsien-memory/src/adapters/memory/in-memory.ts";
import { DefaultSecretFilter } from "pi-tsien-memory/src/adapters/security/secret-filter.ts";
import { DefaultScopeResolver } from "pi-tsien-memory/src/adapters/pi/scope-resolver.ts";
import { RuleCaptureStrategy } from "pi-tsien-memory/src/application/capture-rules.ts";
import { MemoryService } from "pi-tsien-memory/src/application/memory-service.ts";

async function setup() {
  const repository = new InMemoryMemoryRepository();
  await repository.initialize("profile");
  await repository.ensureSession({ sessionId: "s", piSessionId: "s", repositoryId: "r", startedAt: Date.now() });
  const search = new InMemorySearchBackend(repository);
  const service = new MemoryService(repository, search, new DefaultSecretFilter(), new DefaultScopeResolver(), new RuleCaptureStrategy());
  return { repository, search, service };
}

test("InMemory adapter follows the repository/search contract", async () => {
  const { repository, service } = await setup();
  const scope = { type: "repository", key: "repository:r", repositoryId: "r" };
  const created = await service.remember("use pnpm", { profileId: "profile", scope, explicit: true, explicitGlobal: false });
  assert.equal((await service.search("pnpm", { profileId: "profile", scopes: [scope] })).length, 1);
  const updated = await service.update(created.memory.id, "use yarn", { profileId: "profile", scopes: [scope], explicit: true });
  assert.equal((await repository.getRevisionHistory(created.memory.id)).length, 2);
  await assert.rejects(() => repository.updateRevision(created.memory.id, 1, { content: "use npm", contentHash: "x", createdBy: "user", source: { sourceType: "manual_review", sourceUri: "memory://test", authority: "user_explicit", verified: true } }), /concurrently/);
  const preview = await service.previewForget(updated.id, { profileId: "profile", scopes: [scope] });
  await service.confirmForget(preview.receiptId);
  assert.equal((await service.search("yarn", { profileId: "profile", scopes: [scope] })).length, 0);
});

test("InMemory processed turns are idempotent", async () => {
  const { repository } = await setup();
  const input = { turnKey: "turn", sessionId: "s", userEntryId: "e", extractorVersion: "v1", processedAt: Date.now() };
  assert.equal(await repository.markProcessedTurn(input), true);
  assert.equal(await repository.markProcessedTurn(input), false);
});
