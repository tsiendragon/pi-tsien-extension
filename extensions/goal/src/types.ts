export type GoalStatus = "active" | "paused" | "complete";
export type GoalOwner = "user" | "model";
export type WorkItemState = "todo" | "in_progress" | "done" | "blocked" | "deferred";
export type BlockerKind =
	| "technical"
	| "dependency"
	| "external_wait"
	| "permission_or_credential"
	| "user_decision"
	| "policy_or_safety"
	| "scope_unclear";
export type GoalBlockerDisposition = "agent_can_try" | "needs_user" | "external_wait";
export type GoalBlockerState = "open" | "resolved" | "superseded";

export interface GoalSourceDoc {
	path: string;
	kind: "prd" | "doc" | "directory" | "manual";
	brief: string;
	hash?: string;
	extractedAt: number;
}

export interface GoalProgress {
	done: string[];
	current?: string;
	blocked: string[];
	lastSummary: string;
}

export interface WorkItem {
	id: string;
	goalId: string;
	title: string;
	description?: string;
	state: WorkItemState;
	dependsOn: string[];
	acceptanceCriteriaIds: string[];
	updatedAt: number;
}

export interface GoalBlocker {
	id: string;
	goalId: string;
	title: string;
	reason: string;
	kind: BlockerKind;
	disposition: GoalBlockerDisposition;
	state: GoalBlockerState;
	workItemIds: string[];
	evidence?: string;
	proposedResolution?: string;
	owner: "agent" | "user" | "external";
	createdAt: number;
	updatedAt: number;
}

export interface GoalBlockerAttempt {
	id: string;
	goalId: string;
	blockerId: string;
	hypothesis: string;
	action: string;
	result: string;
	evidence?: string;
	createdAt: number;
}

export interface GoalReport {
	id: string;
	goalId: string;
	revision: number;
	trigger: string;
	markdown: string;
	checksum: string;
	createdAt: number;
}

export interface GoalState {
	version: 1 | 2;
	goalId: string;
	objective: string;
	status: GoalStatus;
	sourceDocs: GoalSourceDoc[];
	constraints: string[];
	acceptanceCriteria: string[];
	progress: GoalProgress;
	workItems?: WorkItem[];
	blockers?: GoalBlocker[];
	blockerAttempts?: GoalBlockerAttempt[];
	reports?: GoalReport[];
	createdAt: number;
	updatedAt: number;
	completedAt?: number;
	owner: GoalOwner;
}

export interface GoalCreateEvent {
	action: "create";
	goalId: string;
	objective: string;
	now: number;
	owner?: GoalOwner;
	sourceDocs?: GoalSourceDoc[];
	constraints?: string[];
	acceptanceCriteria?: string[];
	progress?: Partial<GoalProgress>;
	reason?: string;
}
export interface GoalReplaceEvent extends Omit<GoalCreateEvent, "action"> {
	action: "replace";
}
export interface GoalEditEvent {
	action: "edit";
	goalId: string;
	now: number;
	objective?: string;
	sourceDocs?: GoalSourceDoc[];
	constraints?: string[];
	acceptanceCriteria?: string[];
	reason?: string;
}
export interface GoalPauseEvent {
	action: "pause";
	goalId: string;
	now: number;
	reason?: string;
}
export interface GoalResumeEvent {
	action: "resume";
	goalId: string;
	now: number;
	reason?: string;
}
export interface GoalClearEvent {
	action: "clear";
	goalId: string;
	now: number;
	reason?: string;
}
export interface GoalCompleteEvent {
	action: "complete";
	goalId: string;
	now: number;
	reason?: string;
}
export interface GoalProgressEvent {
	action: "progress";
	goalId: string;
	now: number;
	progress: Partial<GoalProgress>;
	reason?: string;
}
export interface GoalImportDocsEvent {
	action: "import-docs";
	goalId: string;
	now: number;
	sourceDocs: GoalSourceDoc[];
	constraints?: string[];
	acceptanceCriteria?: string[];
	reason?: string;
}
export interface GoalGraphEvent {
	action: "graph";
	goalId: string;
	now: number;
	workItems?: WorkItem[];
	blockers?: GoalBlocker[];
	attempt?: GoalBlockerAttempt;
	report?: GoalReport;
	reason?: string;
}

export type GoalStateEvent =
	| GoalCreateEvent
	| GoalReplaceEvent
	| GoalEditEvent
	| GoalPauseEvent
	| GoalResumeEvent
	| GoalClearEvent
	| GoalCompleteEvent
	| GoalProgressEvent
	| GoalImportDocsEvent
	| GoalGraphEvent;
export type GoalStateAction = GoalStateEvent["action"] | "set";

export interface GoalStateEntry {
	action: GoalStateAction;
	state: GoalState | null;
	event?: GoalStateEvent;
	reason?: string;
}
export interface GoalStateSnapshot {
	current: GoalState | null;
	entries: GoalStateEntry[];
}
