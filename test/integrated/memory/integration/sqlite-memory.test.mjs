import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, withTransaction } from "../../../../extensions/memory/src/adapters/sqlite/driver.ts";
import { SqliteMemoryRepository } from "../../../../extensions/memory/src/adapters/sqlite/repository.ts";
import { SqliteSearchBackend } from "../../../../extensions/memory/src/adapters/sqlite/search.ts";
import { DefaultSecretFilter } from "../../../../extensions/memory/src/adapters/security/secret-filter.ts";
import { DefaultScopeResolver } from "../../../../extensions/memory/src/adapters/pi/scope-resolver.ts";
import { RuleCaptureStrategy } from "../../../../extensions/memory/src/application/capture-rules.ts";
import { MemoryService } from "../../../../extensions/memory/src/application/memory-service.ts";

const dirs = [];
const scope = { type: "repository", key: "repository:r1", repositoryId: "r1" };

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "pi-tsien-memory-test-"));
  dirs.push(dir);
  const db = await openDatabase(dir);
  const repository = new SqliteMemoryRepository(db);
  await repository.initialize("profile");
  await repository.ensureSession({ sessionId: "session-1", piSessionId: "session-1", repositoryId: "r1", branch: "main", startedAt: Date.now() });
  const search = new SqliteSearchBackend(db);
  const service = new MemoryService(repository, search, new DefaultSecretFilter(), new DefaultScopeResolver(), new RuleCaptureStrategy());
  return { dir, db, repository, search, service };
}

afterEach(async () => {
  while (dirs.length > 0) await rm(dirs.pop(), { recursive: true, force: true });
});

test("two SQLite connections serialize writes and failed migrations roll back", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-tsien-memory-connections-"));
  dirs.push(dir);
  const db1 = await openDatabase(dir);
  const db2 = await openDatabase(dir);
  const repository1 = new SqliteMemoryRepository(db1);
  const repository2 = new SqliteMemoryRepository(db2);
  await repository1.initialize("profile");
  await repository2.initialize("profile");
  await Promise.all([
    repository1.ensureSession({ sessionId: "connection-1", piSessionId: "connection-1", repositoryId: "r1", startedAt: Date.now() }),
    repository2.ensureSession({ sessionId: "connection-2", piSessionId: "connection-2", repositoryId: "r2", startedAt: Date.now() }),
  ]);
  const search1 = new SqliteSearchBackend(db1);
  const search2 = new SqliteSearchBackend(db2);
  const service1 = new MemoryService(repository1, search1, new DefaultSecretFilter(), new DefaultScopeResolver(), new RuleCaptureStrategy());
  const service2 = new MemoryService(repository2, search2, new DefaultSecretFilter(), new DefaultScopeResolver(), new RuleCaptureStrategy());
  const [one, two] = await Promise.all([
    service1.remember("connection one", { profileId: "profile", scope: { type: "repository", key: "repository:r1", repositoryId: "r1" }, explicit: true, explicitGlobal: false }),
    service2.remember("connection two", { profileId: "profile", scope: { type: "repository", key: "repository:r2", repositoryId: "r2" }, explicit: true, explicitGlobal: false }),
  ]);
  assert.notEqual(one.memory.id, two.memory.id);
  assert.ok(await repository1.getById(two.memory.id));
  assert.throws(() => withTransaction(db1, () => { db1.exec("CREATE TABLE rollback_probe(value TEXT)"); throw new Error("migration failure"); }), /migration failure/);
  assert.throws(() => db1.prepare("SELECT * FROM rollback_probe").all(), /no such table/u);
  db1.close();
  db2.close();
});

test("SQLite FTS supports create, immutable revision update, and recall", async () => {
  const { repository, search, service } = await setup();
  const health = await search.health();
  assert.equal(health.ok, true);
  assert.equal(health.secureDelete, true);
  const created = await service.remember("use pnpm", { profileId: "profile", scope, explicit: true, explicitGlobal: false });
  assert.equal(created.memory.status, "active");
  assert.equal((await service.search("pnpm", { profileId: "profile", scopes: [scope] })).length, 1);
  const updated = await service.update(created.memory.id, "use yarn", { profileId: "profile", scopes: [scope], explicit: true });
  assert.equal(updated.currentRevision.revisionNo, 2);
  assert.equal((await service.search("pnpm", { profileId: "profile", scopes: [scope] })).length, 0);
  assert.equal((await service.search("yarn", { profileId: "profile", scopes: [scope] })).length, 1);
  const recall = await service.recall({ query: "yarn", scope: { profileId: "profile", sessionId: "session-1", repositoryId: "r1", branch: "main", cwd: "." }, maxItems: 6, maxTokens: 1000, minScore: 0 });
  assert.equal(recall.items.length, 1);
  await repository.close();
});

test("doctor repairs a missing FTS projection", async () => {
  const { db, repository, service } = await setup();
  const created = await service.remember("use pnpm", { profileId: "profile", scope, explicit: true, explicitGlobal: false });
  db.exec("DELETE FROM memory_search_documents");
  assert.equal((await service.search("pnpm", { profileId: "profile", scopes: [scope] })).length, 0);
  const result = await service.doctor("profile", true);
  assert.equal(result.repair.documents, 1);
  assert.equal((await service.search("pnpm", { profileId: "profile", scopes: [scope] })).length, 1);
  assert.ok(created.memory.id);
  await repository.close();
});

test("candidate never enters automatic recall and can be reviewed", async () => {
  const { repository, service } = await setup();
  const candidate = await service.remember("use bun", { profileId: "profile", scope, explicit: false, explicitGlobal: false });
  assert.equal(candidate.memory.status, "candidate");
  const recall = await service.recall({ query: "bun", scope: { profileId: "profile", sessionId: "session-1", repositoryId: "r1", branch: "main", cwd: "." }, maxItems: 6, maxTokens: 1000, minScore: 0 });
  assert.equal(recall.items.length, 0);
  assert.equal((await service.list(["candidate"], "profile", [scope])).length, 1);
  const accepted = await service.review("accept", candidate.memory.id, { profileId: "profile", scopes: [scope] });
  assert.equal(accepted.status, "active");
  assert.equal((await service.recall({ query: "bun", scope: { profileId: "profile", sessionId: "session-1", repositoryId: "r1", branch: "main", cwd: "." }, maxItems: 6, maxTokens: 1000, minScore: 0 })).items.length, 1);
  await repository.close();
});

test("conflicting candidate does not replace active memory", async () => {
  const { repository, service } = await setup();
  const active = await service.remember("use pnpm", { profileId: "profile", scope, explicit: true, explicitGlobal: false });
  const candidate = await service.remember("use yarn", { profileId: "profile", scope, explicit: false, explicitGlobal: false });
  assert.equal(active.memory.status, "active");
  assert.equal(candidate.memory.status, "candidate");
  assert.equal((await service.search("pnpm", { profileId: "profile", scopes: [scope] })).length, 1);
  await repository.close();
});

test("forget requires a preview token and erases FTS content across reopen", async () => {
  const { dir, repository, service } = await setup();
  const created = await service.remember("use pnpm", { profileId: "profile", scope, explicit: true, explicitGlobal: false });
  const preview = await service.previewForget(created.memory.id, { profileId: "profile", scopes: [scope] });
  await assert.rejects(() => service.confirmForget("forged-token"), /invalid or expired/);
  await service.confirmForget(preview.receiptId);
  const forgotten = await repository.getById(created.memory.id);
  assert.equal(forgotten.status, "forgotten");
  assert.equal(forgotten.currentRevision, undefined);
  await repository.close();
  const files = await readdir(dir);
  for (const file of files.filter((name) => name.endsWith(".db") || name.endsWith("-wal") || name.endsWith("-shm"))) {
    assert.doesNotMatch(await readFile(join(dir, file), "utf8").catch(() => ""), /use pnpm/);
  }
  const db = await openDatabase(dir);
  const search = new SqliteSearchBackend(db);
  const hits = await search.search({ query: "pnpm", profileId: "profile", allowedScopes: [scope], statuses: ["active", "candidate", "stale"], limit: 10, now: Date.now() });
  assert.equal(hits.length, 0);
  db.close();
});

test("update undo restores the previous immutable revision", async () => {
  const { repository, service } = await setup();
  const created = await service.remember("use pnpm", { profileId: "profile", scope, explicit: true, explicitGlobal: false });
  const updated = await service.update(created.memory.id, "use yarn", { profileId: "profile", scopes: [scope], explicit: true });
  assert.ok(updated.undoReceiptId);
  await service.undo(updated.undoReceiptId);
  const restored = await repository.getById(created.memory.id);
  assert.equal(restored.currentRevision.content, "use pnpm");
  assert.equal((await repository.getRevisionHistory(created.memory.id)).length, 3);
  await repository.close();
});

test("authoritative source conflict makes old memory stale and creates a candidate", async () => {
  const { repository, service } = await setup();
  const created = await service.remember("use pnpm", { profileId: "profile", scope, explicit: true, explicitGlobal: false });
  const result = await service.markSourceStale(created.memory.id, "knowledge://kb/chunk", "current source says use yarn");
  assert.equal(result.stale.status, "stale");
  assert.equal(result.candidate.status, "candidate");
  assert.equal((await service.recall({ query: "pnpm", scope: { profileId: "profile", sessionId: "session-1", repositoryId: "r1", branch: "main", cwd: "." }, maxItems: 6, maxTokens: 1000, minScore: 0 })).items.length, 0);
  await repository.close();
});

test("branch override does not supersede repository memory", async () => {
  const { repository, service } = await setup();
  const repositoryScope = { type: "repository", key: "repository:r1", repositoryId: "r1" };
  const branchScope = { type: "branch", key: "branch:r1:main", repositoryId: "r1", branch: "main" };
  const base = await service.remember("use pnpm", { profileId: "profile", scope: repositoryScope, explicit: true, explicitGlobal: false });
  const override = await service.remember("use yarn", { profileId: "profile", scope: branchScope, explicit: true, explicitGlobal: false });
  assert.equal(base.memory.status, "active");
  assert.equal(override.memory.status, "active");
  await repository.close();
});

test("repository scope is isolated", async () => {
  const { repository, service } = await setup();
  const other = { type: "repository", key: "repository:r2", repositoryId: "r2" };
  await service.remember("use pnpm", { profileId: "profile", scope: other, explicit: true, explicitGlobal: false });
  assert.equal((await service.search("pnpm", { profileId: "profile", scopes: [scope] })).length, 0);
  await repository.close();
});
