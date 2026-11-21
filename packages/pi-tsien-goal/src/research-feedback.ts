import type { ResearchCheckpoint, ResearchFeedback } from "./types.ts";

export const RESEARCH_OUTCOMES = ["reinforce", "falsified", "proof_gap", "resource_limit", "inconclusive"] as const;
export const RESEARCH_FEEDBACK_GUIDANCE = "Use route feedback as advisory evidence within its stated scope. Prefer a reinforced method for the next bounded attempt only when a preset success gate and independent check support it; when capacity and dependencies permit, keep a complementary route that could overturn the result. Retire only the falsified claim or extension, repair a proof gap without calling it a counterexample, and treat resource limits or inconclusive results as no verdict on the method. Do not repeat identical work, exceed budgets, or infer proof, deployment authority, or goal completion from feedback.";

export function normalizeResearchFeedback(value: unknown): ResearchFeedback | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return;
	const { method, scope, outcome, gate, independentCheck, challenge } = value as Partial<ResearchFeedback>;
	const bounded = (s: unknown, max: number): s is string => typeof s === "string" && s.trim().length > 0 && s.length <= max;
	if (!bounded(method, 120) || !bounded(scope, 280) || !outcome || !RESEARCH_OUTCOMES.includes(outcome)) return;
	if (gate !== undefined && !bounded(gate, 300)) return;
	if (independentCheck !== undefined && !bounded(independentCheck, 300)) return;
	if (challenge !== undefined && !bounded(challenge, 300)) return;
	if (outcome === "reinforce" && (!gate || !independentCheck || !challenge)) return;
	return { method: method.trim(), scope: scope.trim(), outcome,
		...(gate ? { gate: gate.trim() } : {}),
		...(independentCheck ? { independentCheck: independentCheck.trim() } : {}),
		...(challenge ? { challenge: challenge.trim() } : {}) };
}

/** Keep general checkpoints and the latest decision per method/scope separately. */
export function latestResearchFeedback(checkpoints: readonly ResearchCheckpoint[] = []): ResearchCheckpoint[] {
	const seen = new Set<string>();
	const selected: ResearchCheckpoint[] = [];
	for (let i = checkpoints.length - 1; i >= 0 && selected.length < 3; i--) {
		const entry = checkpoints[i]!;
		const f = entry.feedback;
		if (!f) continue;
		const key = JSON.stringify([f.method, f.scope].map(s => s.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim()));
		if (seen.has(key)) continue;
		seen.add(key);
		selected.push(entry);
	}
	return selected.reverse();
}
