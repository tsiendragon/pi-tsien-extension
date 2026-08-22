import { initialWorkItems } from "./goal-graph.ts";
import type {
	GoalBlocker,
	GoalBlockerAttempt,
	GoalOwner,
	GoalProgress,
	GoalReport,
	GoalSourceDoc,
	GoalState,
	GoalStateEntry,
	GoalStateEvent,
	GoalStateSnapshot,
	WorkItem,
} from "./types.ts";

export const GOAL_CUSTOM_TYPE = "goal-state";
export const MAX_OBJECTIVE_LENGTH = 4000;

interface GoalSessionEntry {
	type: string;
	customType?: string;
	data?: unknown;
}

interface GoalSessionContext {
	sessionManager: {
		getBranch(): GoalSessionEntry[];
	};
}

interface GoalAppendAPI {
	appendEntry(customType: string, data?: unknown): unknown;
}

export class GoalStateValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "GoalStateValidationError";
	}
}

export function validateObjective(objective: string): string {
	const trimmed = objective.trim();
	if (trimmed.length === 0) {
		throw new GoalStateValidationError("Goal objective must be non-empty.");
	}
	if (trimmed.length > MAX_OBJECTIVE_LENGTH) {
		throw new GoalStateValidationError(`Goal objective must be ${MAX_OBJECTIVE_LENGTH} characters or fewer.`);
	}
	return trimmed;
}

export function createGoalState(event: Extract<GoalStateEvent, { action: "create" | "replace" }>): GoalState {
	const objective = validateObjective(event.objective);
	return {
		version: 2,
		goalId: event.goalId,
		objective,
		status: "active",
		sourceDocs: [...(event.sourceDocs ?? [])],
		constraints: [...(event.constraints ?? [])],
		acceptanceCriteria: [...(event.acceptanceCriteria ?? [])],
		progress: normalizeProgress(event.progress),
		workItems: initialWorkItems(event.goalId, event.acceptanceCriteria ?? [], event.now),
		blockers: [],
		blockerAttempts: [],
		reports: [],
		createdAt: event.now,
		updatedAt: event.now,
		owner: event.owner ?? "user",
	};
}

export function reduceGoalState(current: GoalState | null, event: GoalStateEvent): GoalState | null {
	switch (event.action) {
		case "create":
			return current ?? createGoalState(event);
		case "replace":
			return createGoalState(event);
		case "edit": {
			if (!isCurrentGoal(current, event.goalId)) return current;
			return {
				...current,
				objective: event.objective === undefined ? current.objective : validateObjective(event.objective),
				sourceDocs: event.sourceDocs === undefined ? current.sourceDocs : [...event.sourceDocs],
				constraints: event.constraints === undefined ? current.constraints : [...event.constraints],
				acceptanceCriteria:
					event.acceptanceCriteria === undefined ? current.acceptanceCriteria : [...event.acceptanceCriteria],
				updatedAt: event.now,
			};
		}
		case "pause": {
			if (!isCurrentGoal(current, event.goalId) || current.status !== "active") return current;
			return { ...current, status: "paused", updatedAt: event.now, completedAt: undefined };
		}
		case "resume": {
			if (!isCurrentGoal(current, event.goalId) || current.status !== "paused") return current;
			return { ...current, status: "active", updatedAt: event.now, completedAt: undefined };
		}
		case "clear":
			return isCurrentGoal(current, event.goalId) ? null : current;
		case "complete": {
			if (!isCurrentGoal(current, event.goalId) || current.status !== "active") return current;
			return { ...current, status: "complete", updatedAt: event.now, completedAt: event.now };
		}
		case "progress": {
			if (!isCurrentGoal(current, event.goalId) || current.status !== "active") return current;
			if (!hasProgressUpdate(event.progress)) return current;
			return {
				...current,
				progress: normalizeProgress(event.progress, current.progress),
				updatedAt: event.now,
			};
		}
		case "import-docs": {
			if (!isCurrentGoal(current, event.goalId) || current.status !== "active") return current;
			return {
				...current,
				sourceDocs: mergeSourceDocs(current.sourceDocs, event.sourceDocs),
				constraints:
					event.constraints === undefined
						? current.constraints
						: mergeStringLists(current.constraints, event.constraints),
				acceptanceCriteria:
					event.acceptanceCriteria === undefined
						? current.acceptanceCriteria
						: mergeStringLists(current.acceptanceCriteria, event.acceptanceCriteria),
				updatedAt: event.now,
			};
		}
		case "graph": {
			if (!isCurrentGoal(current, event.goalId) || current.status !== "active") return current;
			return {
				...current,
				version: 2,
				workItems: event.workItems === undefined ? current.workItems : cloneWorkItems(event.workItems),
				blockers: event.blockers === undefined ? current.blockers : cloneBlockers(event.blockers),
				blockerAttempts: event.attempt
					? [...(current.blockerAttempts ?? []), { ...event.attempt }]
					: current.blockerAttempts,
				reports: event.report ? [...(current.reports ?? []), { ...event.report }] : current.reports,
				updatedAt: event.now,
			};
		}
		default:
			return current;
	}
}

export function toGoalStateEntry(event: GoalStateEvent, current: GoalState | null): GoalStateEntry {
	const next = reduceGoalState(current, event);
	return {
		action: event.action,
		state: cloneGoalState(next),
		event: cloneEvent(event),
		reason: event.reason,
	};
}

export function saveGoalState(
	pi: GoalAppendAPI,
	event: GoalStateEvent,
	current: GoalState | null,
): GoalState | null {
	if (event.action === "progress" && !hasProgressUpdate(event.progress)) return cloneGoalState(current);
	const entry = toGoalStateEntry(event, current);
	pi.appendEntry(GOAL_CUSTOM_TYPE, entry);
	return cloneGoalState(entry.state);
}

export function loadGoalState(ctx: GoalSessionContext): GoalState | null {
	return createGoalStateSnapshot(ctx.sessionManager.getBranch()).current;
}

export function createGoalStateSnapshot(branchEntries: GoalSessionEntry[]): GoalStateSnapshot {
	let current: GoalState | null = null;
	const entries: GoalStateEntry[] = [];

	for (const branchEntry of branchEntries) {
		if (branchEntry.type !== "custom" || branchEntry.customType !== GOAL_CUSTOM_TYPE) continue;

		const goalEntry = parseGoalStateEntry(branchEntry.data);
		if (!goalEntry) continue;

		if (goalEntry.event) {
			current = reduceGoalState(current, goalEntry.event);
		} else {
			current = reducePersistedState(current, goalEntry);
		}
		entries.push({ ...goalEntry, state: cloneGoalState(current) });
	}

	return { current: cloneGoalState(current), entries };
}

export function getCurrentGoal(snapshot: GoalStateSnapshot): GoalState | null {
	return cloneGoalState(snapshot.current);
}

function isCurrentGoal(current: GoalState | null, goalId: string): current is GoalState {
	return current !== null && current.goalId === goalId;
}

function hasProgressUpdate(progress: Partial<GoalProgress>): boolean {
	return Object.values(progress).some((value) => value !== undefined);
}

function normalizeProgress(progress: Partial<GoalProgress> = {}, base?: GoalProgress): GoalProgress {
	return {
		done: [...(progress.done ?? base?.done ?? [])],
		current: progress.current ?? base?.current,
		blocked: [...(progress.blocked ?? base?.blocked ?? [])],
		lastSummary: progress.lastSummary ?? base?.lastSummary ?? "",
	};
}

function mergeSourceDocs(existing: GoalSourceDoc[], incoming: GoalSourceDoc[]): GoalSourceDoc[] {
	const byPath = new Map(existing.map((doc) => [doc.path, doc]));
	for (const doc of incoming) {
		byPath.set(doc.path, doc);
	}
	return [...byPath.values()];
}

function mergeStringLists(existing: string[], incoming: string[]): string[] {
	return [...new Set([...existing, ...incoming].map((value) => value.trim()).filter(Boolean))];
}

function parseGoalStateEntry(data: unknown): GoalStateEntry | null {
	if (!isRecord(data) || !isGoalStateAction(data.action) || !("state" in data)) return null;
	return {
		action: data.action,
		state: isGoalState(data.state) ? cloneGoalState(data.state) : null,
		event: parseGoalStateEvent(data.event),
		reason: typeof data.reason === "string" ? data.reason : undefined,
	};
}

function parseGoalStateEvent(data: unknown): GoalStateEvent | undefined {
	if (!isRecord(data) || !isGoalStateAction(data.action) || data.action === "set") return undefined;
	if (typeof data.goalId !== "string" || typeof data.now !== "number") return undefined;
	const reason = typeof data.reason === "string" ? data.reason : undefined;

	if (data.action === "create" || data.action === "replace") {
		if (typeof data.objective !== "string") return undefined;
		const sourceDocs = readOptionalSourceDocs(data, "sourceDocs");
		const constraints = readOptionalStringArray(data, "constraints");
		const acceptanceCriteria = readOptionalStringArray(data, "acceptanceCriteria");
		const progress = readOptionalProgress(data, "progress");
		if (sourceDocs === null || constraints === null || acceptanceCriteria === null || progress === null)
			return undefined;
		const owner: GoalOwner | undefined =
			data.owner === "model" || data.owner === "user" ? data.owner : undefined;
		const base = {
			goalId: data.goalId,
			objective: data.objective,
			now: data.now,
			...(owner ? { owner } : {}),
			...(sourceDocs ? { sourceDocs } : {}),
			...(constraints ? { constraints } : {}),
			...(acceptanceCriteria ? { acceptanceCriteria } : {}),
			...(progress ? { progress } : {}),
			...(reason ? { reason } : {}),
		};
		return data.action === "create" ? { action: "create", ...base } : { action: "replace", ...base };
	}

	if (data.action === "pause") {
		return { action: "pause", goalId: data.goalId, now: data.now, ...(reason ? { reason } : {}) };
	}
	if (data.action === "resume") {
		return { action: "resume", goalId: data.goalId, now: data.now, ...(reason ? { reason } : {}) };
	}
	if (data.action === "clear") {
		return { action: "clear", goalId: data.goalId, now: data.now, ...(reason ? { reason } : {}) };
	}
	if (data.action === "complete") {
		return { action: "complete", goalId: data.goalId, now: data.now, ...(reason ? { reason } : {}) };
	}

	if (data.action === "edit") {
		const sourceDocs = readOptionalSourceDocs(data, "sourceDocs");
		const constraints = readOptionalStringArray(data, "constraints");
		const acceptanceCriteria = readOptionalStringArray(data, "acceptanceCriteria");
		if (sourceDocs === null || constraints === null || acceptanceCriteria === null) return undefined;
		return {
			action: "edit",
			goalId: data.goalId,
			now: data.now,
			...(typeof data.objective === "string" ? { objective: data.objective } : {}),
			...(sourceDocs ? { sourceDocs } : {}),
			...(constraints ? { constraints } : {}),
			...(acceptanceCriteria ? { acceptanceCriteria } : {}),
			...(reason ? { reason } : {}),
		};
	}

	if (data.action === "progress") {
		const progress = readOptionalProgress(data, "progress");
		if (!progress) return undefined;
		return {
			action: "progress",
			goalId: data.goalId,
			now: data.now,
			progress,
			...(reason ? { reason } : {}),
		};
	}

	if (data.action === "graph") {
		const workItems = readOptionalArray(data, "workItems", isWorkItem);
		const blockers = readOptionalArray(data, "blockers", isGoalBlocker);
		const attempt =
			data.attempt === undefined
				? undefined
				: isGoalBlockerAttempt(data.attempt)
					? { ...data.attempt }
					: null;
		const report =
			data.report === undefined ? undefined : isGoalReport(data.report) ? { ...data.report } : null;
		if (workItems === null || blockers === null || attempt === null || report === null) return undefined;
		return {
			action: "graph",
			goalId: data.goalId,
			now: data.now,
			...(workItems ? { workItems } : {}),
			...(blockers ? { blockers } : {}),
			...(attempt ? { attempt } : {}),
			...(report ? { report } : {}),
			...(reason ? { reason } : {}),
		};
	}

	if (data.action === "import-docs") {
		const sourceDocs = readOptionalSourceDocs(data, "sourceDocs");
		const constraints = readOptionalStringArray(data, "constraints");
		const acceptanceCriteria = readOptionalStringArray(data, "acceptanceCriteria");
		if (!sourceDocs || constraints === null || acceptanceCriteria === null) return undefined;
		return {
			action: "import-docs",
			goalId: data.goalId,
			now: data.now,
			sourceDocs,
			...(constraints ? { constraints } : {}),
			...(acceptanceCriteria ? { acceptanceCriteria } : {}),
			...(reason ? { reason } : {}),
		};
	}
}

function isGoalStateAction(value: unknown): value is GoalStateEntry["action"] {
	return (
		value === "create" ||
		value === "replace" ||
		value === "edit" ||
		value === "pause" ||
		value === "resume" ||
		value === "clear" ||
		value === "complete" ||
		value === "progress" ||
		value === "import-docs" ||
		value === "graph" ||
		value === "set"
	);
}

function readOptionalStringArray(record: Record<string, unknown>, key: string): string[] | null | undefined {
	const value = record[key];
	if (value === undefined) return undefined;
	return Array.isArray(value) && value.every((item) => typeof item === "string") ? [...value] : null;
}

function readOptionalSourceDocs(
	record: Record<string, unknown>,
	key: string,
): GoalSourceDoc[] | null | undefined {
	const value = record[key];
	if (value === undefined) return undefined;
	return Array.isArray(value) && value.every(isGoalSourceDoc) ? value.map((doc) => ({ ...doc })) : null;
}

function readOptionalProgress(
	record: Record<string, unknown>,
	key: string,
): Partial<GoalProgress> | null | undefined {
	const value = record[key];
	if (value === undefined) return undefined;
	if (!isRecord(value)) return null;
	if (value.done !== undefined && !isStringArray(value.done)) return null;
	if (value.current !== undefined && typeof value.current !== "string") return null;
	if (value.blocked !== undefined && !isStringArray(value.blocked)) return null;
	if (value.lastSummary !== undefined && typeof value.lastSummary !== "string") return null;
	return {
		...(value.done ? { done: [...value.done] } : {}),
		...(typeof value.current === "string" ? { current: value.current } : {}),
		...(value.blocked ? { blocked: [...value.blocked] } : {}),
		...(typeof value.lastSummary === "string" ? { lastSummary: value.lastSummary } : {}),
	};
}

function readOptionalArray<T>(
	record: Record<string, unknown>,
	key: string,
	guard: (value: unknown) => value is T,
): T[] | null | undefined {
	const value = record[key];
	if (value === undefined) return undefined;
	return Array.isArray(value) && value.every(guard) ? value.map((item) => structuredClone(item)) : null;
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isGoalSourceDoc(value: unknown): value is GoalSourceDoc {
	return (
		isRecord(value) &&
		typeof value.path === "string" &&
		(value.kind === "prd" || value.kind === "doc" || value.kind === "directory" || value.kind === "manual") &&
		typeof value.brief === "string" &&
		typeof value.extractedAt === "number" &&
		(value.hash === undefined || typeof value.hash === "string")
	);
}

function reducePersistedState(current: GoalState | null, entry: GoalStateEntry): GoalState | null {
	if (entry.action === "clear") return entry.state === null ? null : current;
	if (entry.state === null) return current;
	if (entry.action === "create" || entry.action === "replace" || entry.action === "set")
		return cloneGoalState(entry.state);
	if (!isCurrentGoal(current, entry.state.goalId)) return current;
	return cloneGoalState(entry.state);
}

function isGoalState(value: unknown): value is GoalState {
	return (
		isRecord(value) &&
		(value.version === 1 || value.version === 2) &&
		typeof value.goalId === "string" &&
		typeof value.objective === "string" &&
		(value.status === "active" || value.status === "paused" || value.status === "complete") &&
		Array.isArray(value.sourceDocs) &&
		value.sourceDocs.every(isGoalSourceDoc) &&
		isStringArray(value.constraints) &&
		isStringArray(value.acceptanceCriteria) &&
		isGoalProgress(value.progress) &&
		(value.workItems === undefined ||
			(Array.isArray(value.workItems) && value.workItems.every(isWorkItem))) &&
		(value.blockers === undefined ||
			(Array.isArray(value.blockers) && value.blockers.every(isGoalBlocker))) &&
		(value.blockerAttempts === undefined ||
			(Array.isArray(value.blockerAttempts) && value.blockerAttempts.every(isGoalBlockerAttempt))) &&
		(value.reports === undefined || (Array.isArray(value.reports) && value.reports.every(isGoalReport))) &&
		typeof value.createdAt === "number" &&
		typeof value.updatedAt === "number" &&
		(value.completedAt === undefined || typeof value.completedAt === "number") &&
		(value.owner === "user" || value.owner === "model")
	);
}

function isWorkItem(value: unknown): value is WorkItem {
	return (
		isRecord(value) &&
		typeof value.id === "string" &&
		typeof value.goalId === "string" &&
		typeof value.title === "string" &&
		(value.description === undefined || typeof value.description === "string") &&
		(value.state === "todo" ||
			value.state === "in_progress" ||
			value.state === "done" ||
			value.state === "blocked" ||
			value.state === "deferred") &&
		isStringArray(value.dependsOn) &&
		isStringArray(value.acceptanceCriteriaIds) &&
		typeof value.updatedAt === "number"
	);
}

function isGoalBlocker(value: unknown): value is GoalBlocker {
	return (
		isRecord(value) &&
		typeof value.id === "string" &&
		typeof value.goalId === "string" &&
		typeof value.title === "string" &&
		typeof value.reason === "string" &&
		(value.kind === "technical" ||
			value.kind === "dependency" ||
			value.kind === "external_wait" ||
			value.kind === "permission_or_credential" ||
			value.kind === "user_decision" ||
			value.kind === "policy_or_safety" ||
			value.kind === "scope_unclear") &&
		(value.disposition === "agent_can_try" ||
			value.disposition === "needs_user" ||
			value.disposition === "external_wait") &&
		(value.state === "open" || value.state === "resolved" || value.state === "superseded") &&
		isStringArray(value.workItemIds) &&
		(value.evidence === undefined || typeof value.evidence === "string") &&
		(value.proposedResolution === undefined || typeof value.proposedResolution === "string") &&
		(value.owner === "agent" || value.owner === "user" || value.owner === "external") &&
		typeof value.createdAt === "number" &&
		typeof value.updatedAt === "number"
	);
}

function isGoalBlockerAttempt(value: unknown): value is GoalBlockerAttempt {
	return (
		isRecord(value) &&
		typeof value.id === "string" &&
		typeof value.goalId === "string" &&
		typeof value.blockerId === "string" &&
		typeof value.hypothesis === "string" &&
		typeof value.action === "string" &&
		typeof value.result === "string" &&
		(value.evidence === undefined || typeof value.evidence === "string") &&
		typeof value.createdAt === "number"
	);
}

function isGoalReport(value: unknown): value is GoalReport {
	return (
		isRecord(value) &&
		typeof value.id === "string" &&
		typeof value.goalId === "string" &&
		Number.isInteger(value.revision) &&
		typeof value.trigger === "string" &&
		typeof value.markdown === "string" &&
		typeof value.checksum === "string" &&
		typeof value.createdAt === "number"
	);
}

function isGoalProgress(value: unknown): value is GoalProgress {
	return (
		isRecord(value) &&
		isStringArray(value.done) &&
		(value.current === undefined || typeof value.current === "string") &&
		isStringArray(value.blocked) &&
		typeof value.lastSummary === "string"
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function cloneGoalState(state: GoalState | null): GoalState | null {
	return state === null
		? null
		: {
				...state,
				sourceDocs: state.sourceDocs.map((doc) => ({ ...doc })),
				constraints: [...state.constraints],
				acceptanceCriteria: [...state.acceptanceCriteria],
				progress: normalizeProgress(state.progress),
				workItems: state.workItems ? cloneWorkItems(state.workItems) : undefined,
				blockers: state.blockers ? cloneBlockers(state.blockers) : undefined,
				blockerAttempts: state.blockerAttempts?.map((attempt) => ({ ...attempt })),
				reports: state.reports?.map((report) => ({ ...report })),
			};
}

function cloneWorkItems(items: WorkItem[]): WorkItem[] {
	return items.map((item) => ({
		...item,
		dependsOn: [...item.dependsOn],
		acceptanceCriteriaIds: [...item.acceptanceCriteriaIds],
	}));
}

function cloneBlockers(blockers: GoalBlocker[]): GoalBlocker[] {
	return blockers.map((blocker) => ({ ...blocker, workItemIds: [...blocker.workItemIds] }));
}

function cloneEvent(event: GoalStateEvent): GoalStateEvent {
	return structuredClone(event) as GoalStateEvent;
}
