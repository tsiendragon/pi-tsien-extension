import test from "node:test";
import assert from "node:assert/strict";
import { InMemoryMemoryRepository, InMemorySearchBackend } from "pi-tsien-memory/src/adapters/memory/in-memory.ts";
import { DefaultSecretFilter } from "pi-tsien-memory/src/adapters/security/secret-filter.ts";
import { DefaultScopeResolver } from "pi-tsien-memory/src/adapters/pi/scope-resolver.ts";
import { RuleCaptureStrategy } from "pi-tsien-memory/src/application/capture-rules.ts";
import { MemoryService } from "pi-tsien-memory/src/application/memory-service.ts";
import { triageCandidate } from "pi-tsien-memory/src/application/auto-triage.ts";

const policy = { enabled: true, minConfidence: 0.7, allowGlobal: false };
const verifiedCandidate = {
  status: "candidate",
  scopeType: "repository",
  confidence: 0.8,
  authority: "verified_tool",
  verified: true,
  unresolvedConflicts: 0,
};

test("evidence-backed candidate is accepted without asking the user", () => {
  assert.deepEqual(triageCandidate(verifiedCandidate, policy), {
    decision: "auto_accept",
    reasonCode: "evidence_backed",
    explanation: "verified source and no conflict",
  });
});

test("unresolved conflict always waits for the user", () => {
  const result = triageCandidate({ ...verifiedCandidate, unresolvedConflicts: 1 }, policy);
  assert.equal(result.decision, "needs_review");
  assert.equal(result.reasonCode, "conflict_unresolved");
});

test("global scope needs confirmation unless the policy allows it", () => {
  const result = triageCandidate({ ...verifiedCandidate, scopeType: "global" }, policy);
  assert.equal(result.decision, "needs_review");
  assert.equal(result.reasonCode, "scope_escalation");
  assert.equal(triageCandidate({ ...verifiedCandidate, scopeType: "global" }, { ...policy, allowGlobal: true }).decision, "auto_accept");
});

test("inference without a verified source is never auto accepted", () => {
  for (const input of [
    { ...verifiedCandidate, authority: "agent_inference", verified: true },
    { ...verifiedCandidate, authority: "verified_tool", verified: false },
    { ...verifiedCandidate, authority: undefined, verified: true },
  ]) {
    const result = triageCandidate(input, policy);
    assert.equal(result.decision, "needs_review");
    assert.equal(result.reasonCode, "unverified_inference");
  }
});

test("low confidence, non-candidates, and a disabled policy never reach auto accept", () => {
  assert.equal(triageCandidate({ ...verifiedCandidate, confidence: 0.2 }, policy).reasonCode, "low_confidence");
  assert.equal(triageCandidate({ ...verifiedCandidate, status: "active" }, policy).decision, "hold");
  assert.equal(triageCandidate(verifiedCandidate, { ...policy, enabled: false }).decision, "hold");
});

test("recall records injection only after the context is really built", async () => {
  const repository = new InMemoryMemoryRepository();
  await repository.initialize("profile");
  await repository.ensureSession({ sessionId: "s", piSessionId: "s", repositoryId: "r", startedAt: Date.now() });
  const service = new MemoryService(repository, new InMemorySearchBackend(repository), new DefaultSecretFilter(), new DefaultScopeResolver(), new RuleCaptureStrategy());
  const scope = { type: "repository", key: "repository:r", repositoryId: "r" };
  const created = await service.remember("use pnpm for this repository", { profileId: "profile", scope, explicit: true, explicitGlobal: false });

  const bundle = await service.recall({ query: "pnpm", scope: { profileId: "profile", sessionId: "s", repositoryId: "r", cwd: "/tmp" }, maxItems: 5, maxTokens: 1000, minScore: 0.1, now: Date.now() });
  assert.ok(bundle.items.some((item) => item.memory.id === created.memory.id));
  assert.equal((await repository.listApplications(created.memory.id)).length, 0, "recall alone must not claim injection");

  await service.markContextInjected(bundle.items.map((item) => item.memory.id), "s");
  const events = await repository.listApplications(created.memory.id);
  assert.equal(events.length, 1);
  assert.equal(events[0].outcome, "injected");

  await service.markContextInjected([created.memory.id, created.memory.id], "s");
  assert.equal((await repository.listApplications(created.memory.id)).filter((event) => event.outcome === "injected").length, 2);
  assert.equal((await repository.applicationStats(created.memory.id)).verifiedApplications, 0, "injection is not verification");
});

test("agent-only auto acceptance leaves an event and skips claim conflicts", async () => {
  const repository = new InMemoryMemoryRepository();
  await repository.initialize("profile");
  await repository.ensureSession({ sessionId: "s", piSessionId: "s", repositoryId: "r", startedAt: Date.now() });
  const service = new MemoryService(repository, new InMemorySearchBackend(repository), new DefaultSecretFilter(), new DefaultScopeResolver(), new RuleCaptureStrategy());
  const scope = { type: "repository", key: "repository:r", repositoryId: "r" };

  const candidate = await service.remember("the release branch uses yarn", { profileId: "profile", scope, explicit: false, explicitGlobal: false, authority: "verified_tool", sourceVerified: true, sourceType: "tool_result", sourceUri: "tool:shell" });
  assert.equal(candidate.memory.status, "candidate");
  const inspected = await service.inspectCandidate(candidate.memory.id, { profileId: "profile", scopes: [scope] });
  assert.equal(inspected.authority, "verified_tool");
  assert.equal(inspected.verified, true);
  assert.equal(inspected.unresolvedConflicts, 0);

  const accepted = await service.autoAccept(candidate.memory.id, { profileId: "profile", scopes: [scope], reasonCode: "evidence_backed" });
  assert.equal(accepted.status, "active");
  assert.ok(accepted.undoReceiptId);

  const restored = await service.undo(accepted.undoReceiptId);
  assert.equal(restored.status, "candidate");
});