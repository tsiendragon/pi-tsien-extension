import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerGoalCommand } from "./commands.ts";
import { registerGoalTools } from "./tools.ts";
import { registerGoalRuntime } from "./runtime.ts";

export {
	confirmGoalReplacement,
	handleGoalCommand,
	offerGoalStartHandoff,
	parseGoalCommand,
	registerGoalCommand,
	reviewGoalProposal,
	saveReviewedGoalAndOfferStart,
	startActiveGoal,
} from "./commands.ts";
export type {
	GoalProposalReviewResult,
	GoalStartAPI,
	GoalWorkflowContext,
	ParsedGoalCommand,
	SaveReviewedGoalOptions,
} from "./commands.ts";
export {
	clearStickyStopForActiveGoal,
	createGoalCompaction,
	createGoalContextMessage,
	createGoalContinuationState,
	filterGoalContextMessages,
	hydrateGoalContinuationState,
	finishRunningGoalContinuation,
	GOAL_CONTINUATION_CUSTOM_TYPE,
	maybeQueueGoalContinuation,
	registerGoalRuntime,
	startQueuedGoalContinuation,
	stopGoalContinuation,
} from "./runtime.ts";
export {
	compactGoalDetails,
	escapeXml,
	GOAL_CONTEXT_CUSTOM_TYPE,
	renderCompactGoalSummary,
	renderContinuationPrompt,
	renderGoalAgentDraftingPrompt,
	renderGoalContext,
	renderGoalStartPrompt,
} from "./prompts.ts";
export { preparePlainGoalDraft } from "./goal-prep.ts";
export type { GoalDraftProposal, GoalProposalGenerator, PreparedGoalDraft } from "./goal-prep.ts";
export {
	normalizeGoalOptimizationDraft,
	optimizationCriterion,
	optimizationObjective,
	OPTIMIZATION_METHOD_FREEDOM,
	validateGoalOptimizationDraft,
} from "./goal-optimization.ts";
export type { GoalOptimizationDraft } from "./goal-optimization.ts";
export {
	normalizeGoalPlanDraft,
	planFromWorkItems,
	validateGoalPlanDraft,
	workItemsFromPlan,
} from "./goal-plan.ts";
export type { GoalMilestoneDraft, GoalPlanDraft } from "./goal-plan.ts";
export {
	auditGoalDraft,
	formatGoalQualityIssues,
	hasBlockingGoalQualityIssues,
} from "./goal-quality.ts";
export type {
	GoalQualityField,
	GoalQualityInput,
	GoalQualityIssue,
	GoalQualitySeverity,
} from "./goal-quality.ts";
export {
	DEFAULT_IMPORT_MAX_FILE_BYTES,
	DEFAULT_IMPORT_MAX_FILES,
	extractGoalBrief,
	GoalImportError,
	importGoalSources,
	parseEditableGoalDraft,
	renderEditableGoalDraft,
	resolveImportPath,
} from "./import.ts";
export {
	completeGoalParams,
	createGoalParams,
	executeCompleteGoal,
	executePauseGoal,
	executeCreateGoal,
	executeGetGoal,
	executeProposeGoalDraft,
	executeUpdateGoalGraph,
	executeUpdateGoalProgress,
	executeUpdateGoal,
	formatGoalToolCall,
	formatGoalToolResult,
	getGoalParams,
	proposeGoalDraftParams,
	proposeGoalDraftPromptGuidelines,
	proposeGoalDraftPromptSnippet,
	pauseGoalParams,
	registerGoalTools,
	updateGoalGraphParams,
	updateGoalProgressParams,
	updateGoalParams,
} from "./tools.ts";
export {
	createGoalState,
	createGoalStateSnapshot,
	getCurrentGoal,
	GOAL_CUSTOM_TYPE,
	GoalStateValidationError,
	loadGoalState,
	MAX_OBJECTIVE_LENGTH,
	reduceGoalState,
	saveGoalState,
	toGoalStateEntry,
	validateObjective,
} from "./state.ts";
export type {
	GoalOwner,
	GoalProgress,
	GoalSourceDoc,
	GoalBlocker,
	GoalBlockerAttempt,
	GoalReport,
	WorkItem,
	GoalState,
	GoalStateAction,
	GoalStateEntry,
	GoalStateEvent,
	GoalStateSnapshot,
	GoalStatus,
} from "./types.ts";

export default function goalExtension(pi: ExtensionAPI): void {
	registerGoalCommand(pi);
	registerGoalTools(pi);
	registerGoalRuntime(pi);
}
