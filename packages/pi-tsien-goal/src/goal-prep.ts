import { normalizeGoalPlanDraft, type GoalPlanDraft } from "./goal-plan.ts";
import { normalizeGoalOptimizationDraft, type GoalOptimizationDraft } from "./goal-optimization.ts";
import { renderGoalProposalPrompt } from "./prompts.ts";

export interface GoalDraftProposal {
	objective: string;
	acceptanceCriteria: string[];
	/** Working rules and boundaries (record/report/review, do not submit, ...). Never acceptance criteria. */
	constraints?: string[];
	/** 2-4 milestones plus the first 1-3 actions. */
	plan?: GoalPlanDraft;
	/** Optional single-metric optimization contract; rendered into objective/criteria. */
	optimization?: GoalOptimizationDraft;
}

export type GoalProposalGenerator = (
	prompt: string,
	input: { objective: string },
) => Promise<GoalDraftProposal | string | undefined>;

export interface PreparedGoalDraft {
	proposal: GoalDraftProposal;
	prompt: string;
	warning?: string;
}

export async function preparePlainGoalDraft(
	objective: string,
	generate?: GoalProposalGenerator,
): Promise<PreparedGoalDraft> {
	const prompt = renderGoalProposalPrompt(objective);
	const fallback = {
		objective,
		acceptanceCriteria: [],
	};

	if (!generate) {
		return {
			proposal: fallback,
			prompt,
			warning: "No acceptance criteria were provided; created a criteria-free goal.",
		};
	}

	try {
		const generated = normalizeGeneratedProposal(await generate(prompt, { objective }));
		if (!generated) throw new Error("Goal proposal generator returned no usable proposal.");
		return { proposal: generated, prompt };
	} catch {
		return {
			proposal: fallback,
			prompt,
			warning:
				"Could not generate acceptance criteria; created the goal with the original objective and no criteria.",
		};
	}
}

function normalizeGeneratedProposal(value: GoalDraftProposal | string | undefined): GoalDraftProposal | null {
	const parsed = typeof value === "string" ? parseJsonObject(value) : value;
	if (!isRecord(parsed)) return null;
	if (typeof parsed.objective !== "string") return null;
	if (!Array.isArray(parsed.acceptanceCriteria)) return null;
	if (!parsed.acceptanceCriteria.every((item) => typeof item === "string")) return null;

	const objective = parsed.objective.trim();
	const acceptanceCriteria = parsed.acceptanceCriteria
		.map((item) => item.trim())
		.filter((item) => item.length > 0);
	const constraints = Array.isArray(parsed.constraints)
		? parsed.constraints
				.filter((item): item is string => typeof item === "string")
				.map((item) => item.trim())
				.filter((item) => item.length > 0)
		: [];
	const plan = normalizeGoalPlanDraft({ milestones: parsed.milestones });
	const optimization = normalizeGoalOptimizationDraft(parsed.optimization);
	if (!objective) return null;
	return {
		objective,
		acceptanceCriteria,
		...(constraints.length > 0 ? { constraints } : {}),
		...(plan ? { plan } : {}),
		...(optimization ? { optimization } : {}),
	};
}

function parseJsonObject(value: string): unknown {
	try {
		return JSON.parse(value);
	} catch {
		return undefined;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
