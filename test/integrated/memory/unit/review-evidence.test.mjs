import test from "node:test";
import assert from "node:assert/strict";
import { verifyUserExplicitReview } from "pi-tsien-memory/src/application/review-evidence.ts";

const base = {
  userText: "记住：本项目以后使用 pnpm。",
  scopeType: "repository",
  reviewed: {
    content: "本项目以后使用 pnpm",
    kind: "preference",
    basis: "user_explicit",
    evidence: "以后使用 pnpm",
  },
};

test("an exact low-risk user directive is eligible for automatic acceptance", () => {
  assert.deepEqual(verifyUserExplicitReview(base), { verified: true, reasonCode: "user_explicit_low_risk" });
});

test("missing, forged, or non-directive evidence stays inference", () => {
  for (const reviewed of [
    { ...base.reviewed, evidence: undefined },
    { ...base.reviewed, evidence: "用户没有说过这句话" },
    { ...base.reviewed, evidence: "本项目" },
    { ...base.reviewed, basis: "tool_inference" },
  ]) {
    assert.equal(verifyUserExplicitReview({ ...base, reviewed }).verified, false);
  }
});

test("sensitive, global, and failure-experience content needs human judgement", () => {
  for (const reviewed of [
    { ...base.reviewed, content: "以后删除旧数据", evidence: "以后删除旧数据" },
    { ...base.reviewed, content: "以后所有项目使用 pnpm", evidence: "以后所有项目使用 pnpm" },
    { ...base.reviewed, kind: "experience", basis: "recovery_inference" },
  ]) {
    assert.equal(verifyUserExplicitReview({ ...base, reviewed }).verified, false);
  }
  assert.equal(verifyUserExplicitReview({ ...base, scopeType: "global" }).verified, false);
});