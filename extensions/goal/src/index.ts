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
	createGoalCompaction,
	createGoalContextMessage,
	createGoalContinuationState,
	DEFAULT_GOAL_CONTINUATION_MAX_TURNS,
	DEFAULT_GOAL_CONTINUATION_MAX_NO_PROGRESS_TURNS,
	DEFAULT_GOAL_CONTINUATION_WATCHDOG_SILENCE_MINUTES,
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
	executeCreateGoal,
	executeGetGoal,
	executeProposeGoalDraft,
	executeUpdateGoalGraph,
	executeUpdateGoalProgress,
	formatGoalToolCall,
	formatGoalToolResult,
	getGoalParams,
	proposeGoalDraftParams,
	proposeGoalDraftPromptGuidelines,
	proposeGoalDraftPromptSnippet,
	registerGoalTools,
	updateGoalGraphParams,
	updateGoalProgressParams,
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
