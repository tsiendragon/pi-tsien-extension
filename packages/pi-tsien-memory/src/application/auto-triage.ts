import type { MemoryAggregate, MemoryScope, MemorySource } from "../domain/types.ts";

/**
 * How far memory may manage itself without asking the user.
 *
 * Automatic acceptance is deliberately limited to candidates that rest on a
 * verified source and have no unresolved conflict: search frequency, model
 * confidence alone, or repetition of a guess never promote a memory.
 */
export interface AutoTriagePolicy {
  enabled: boolean;
  minConfidence: number;
  allowGlobal: boolean;
}

export type TriageDecision = "auto_accept" | "needs_review" | "hold";

export interface TriageCandidateInput {
  status: MemoryAggregate["status"];
  scopeType: MemoryScope["type"];
  confidence: number;
  authority?: MemorySource["authority"];
  verified: boolean;
  unresolvedConflicts: number;
}

export interface TriageResult {
  decision: TriageDecision;
  reasonCode: string;
  explanation: string;
}

const TRUSTED_AUTHORITIES: ReadonlySet<MemorySource["authority"]> = new Set<MemorySource["authority"]>([
  "user_explicit",
  "user_confirmed",
  "verified_tool",
]);

export function triageCandidate(input: TriageCandidateInput, policy: AutoTriagePolicy): TriageResult {
  if (!policy.enabled) {
    return { decision: "hold", reasonCode: "auto_triage_disabled", explanation: "automatic triage is disabled" };
  }
  if (input.status !== "candidate") {
    return { decision: "hold", reasonCode: "not_candidate", explanation: `memory is already ${input.status}` };
  }
  if (input.unresolvedConflicts > 0) {
    return { decision: "needs_review", reasonCode: "conflict_unresolved", explanation: `${input.unresolvedConflicts} unresolved conflict(s)` };
  }
  if (input.scopeType === "global" && !policy.allowGlobal) {
    return { decision: "needs_review", reasonCode: "scope_escalation", explanation: "global scope needs confirmation" };
  }
  if (!input.verified || !input.authority || !TRUSTED_AUTHORITIES.has(input.authority)) {
    return { decision: "needs_review", reasonCode: "unverified_inference", explanation: "no verified source behind this candidate" };
  }
  if (input.confidence < policy.minConfidence) {
    return { decision: "needs_review", reasonCode: "low_confidence", explanation: `confidence ${input.confidence.toFixed(2)} is below ${policy.minConfidence}` };
  }
  return { decision: "auto_accept", reasonCode: "evidence_backed", explanation: "verified source and no conflict" };
}