import { describe, expect, it } from "vitest";
import { latestResearchFeedback, normalizeResearchFeedback } from "pi-tsien-goal/src/research-feedback.ts";
import type { ResearchCheckpoint } from "pi-tsien-goal/src/types.ts";

const reinforce = { method: "Candidate A", scope: "Fixed sample budget", outcome: "reinforce", gate: "Loss below frozen baseline", independentCheck: "replay.json", challenge: "Test an independently tuned stronger baseline" } as const;
const checkpoint = (evidence: string, feedback?: ResearchCheckpoint["feedback"]): ResearchCheckpoint => ({ evidence, feedback, kind: "gate_decision", decision: "Next bounded check" });

describe("research route feedback", () => {
	it.each(["gate", "independentCheck", "challenge"] as const)("rejects reinforcement without %s", key => {
		expect(normalizeResearchFeedback({ ...reinforce, [key]: "  " })).toBeUndefined();
		expect(normalizeResearchFeedback(reinforce)).toEqual(reinforce);
	});

	it("replaces stale advice only within the same method and scope", () => {
		const old = checkpoint("pilot.json", reinforce);
		const adjacent = checkpoint("time.json", { method: "Candidate A", scope: "Equal wall time", outcome: "resource_limit" });
		const repair = checkpoint("review.md", { method: " candidate  a ", scope: "fixed sample budget", outcome: "proof_gap" });
		const routine = ["a", "b", "c", "d"].map(evidence => checkpoint(evidence));
		expect(latestResearchFeedback([old, adjacent, repair, ...routine])).toEqual([adjacent, repair]);
	});
});
