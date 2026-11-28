import { createHash } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { GoalState } from "./types.ts";

export const DEFAULT_GOAL_LEDGER_PATH = join(homedir(), ".pi", "agent", "pi-goal.sqlite");

/**
 * Resolved at call time so tests (and alternate agent homes) can point the
 * ledger somewhere else with PI_GOAL_LEDGER_PATH.
 */
export function resolveGoalLedgerPath(): string {
	const configured = process.env.PI_GOAL_LEDGER_PATH?.trim();
	return configured ? configured : DEFAULT_GOAL_LEDGER_PATH;
}

export interface GoalLedger {
	syncGoal(sessionId: string, branchKey: string, goal: GoalState): void;
	compact(): void;
	close(): void;
}

/** Keep at most this many days between one-time database compactions. */
const COMPACT_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
/** Only bother compacting when at least this many pages are free. */
const COMPACT_MIN_FREE_PAGES = 500;

export function openGoalLedger(path = resolveGoalLedgerPath()): GoalLedger {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const database = new DatabaseSync(path);
	try {
		chmodSync(path, 0o600);
	} catch {
		/* Best-effort on filesystems without POSIX permissions. */
	}
	database.exec(`
		CREATE TABLE IF NOT EXISTS goal_runs (session_id TEXT NOT NULL, branch_key TEXT NOT NULL, goal_id TEXT NOT NULL, state_json TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (session_id, branch_key, goal_id));
		CREATE TABLE IF NOT EXISTS work_items (goal_id TEXT NOT NULL, item_id TEXT NOT NULL, state_json TEXT NOT NULL, PRIMARY KEY (goal_id, item_id));
		CREATE TABLE IF NOT EXISTS work_item_dependencies (goal_id TEXT NOT NULL, item_id TEXT NOT NULL, depends_on TEXT NOT NULL, PRIMARY KEY (goal_id, item_id, depends_on));
		CREATE TABLE IF NOT EXISTS blockers (goal_id TEXT NOT NULL, blocker_id TEXT NOT NULL, state_json TEXT NOT NULL, PRIMARY KEY (goal_id, blocker_id));
		CREATE TABLE IF NOT EXISTS blocker_work_items (goal_id TEXT NOT NULL, blocker_id TEXT NOT NULL, item_id TEXT NOT NULL, PRIMARY KEY (goal_id, blocker_id, item_id));
		CREATE TABLE IF NOT EXISTS blocker_attempts (goal_id TEXT NOT NULL, attempt_id TEXT NOT NULL, state_json TEXT NOT NULL, PRIMARY KEY (goal_id, attempt_id));
		CREATE TABLE IF NOT EXISTS continuation_state (goal_id TEXT NOT NULL, branch_key TEXT NOT NULL, state_json TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (goal_id, branch_key));
		CREATE TABLE IF NOT EXISTS blocker_reports (goal_id TEXT NOT NULL, revision INTEGER NOT NULL, checksum TEXT NOT NULL, markdown TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (goal_id, revision));
		CREATE TABLE IF NOT EXISTS ledger_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
	`);
	const replaceGoal = database.prepare("INSERT OR REPLACE INTO goal_runs VALUES (?, ?, ?, ?, ?)");
	const replaceItem = database.prepare("INSERT OR REPLACE INTO work_items VALUES (?, ?, ?)");
	const replaceDependency = database.prepare(
		"INSERT OR REPLACE INTO work_item_dependencies VALUES (?, ?, ?)",
	);
	const replaceBlocker = database.prepare("INSERT OR REPLACE INTO blockers VALUES (?, ?, ?)");
	const replaceBlockerItem = database.prepare("INSERT OR REPLACE INTO blocker_work_items VALUES (?, ?, ?)");
	const replaceAttempt = database.prepare("INSERT OR REPLACE INTO blocker_attempts VALUES (?, ?, ?)");
	const replaceContinuation = database.prepare(
		"INSERT OR REPLACE INTO continuation_state VALUES (?, ?, ?, ?)",
	);
	const replaceReport = database.prepare("INSERT OR REPLACE INTO blocker_reports VALUES (?, ?, ?, ?, ?)");
	// The transcript already keeps the full history, so the ledger only needs the
	// newest snapshot per (session, goal). Without this every state write grew the
	// table by one full copy of the goal.
	const pruneGoalRuns = database.prepare(
		"DELETE FROM goal_runs WHERE session_id = ? AND goal_id = ? AND branch_key <> ? AND updated_at <= ?",
	);
	const pruneContinuation = database.prepare(
		"DELETE FROM continuation_state WHERE goal_id = ? AND branch_key <> ? AND updated_at <= ?",
	);
	const readMeta = database.prepare("SELECT value FROM ledger_meta WHERE key = ?");
	const writeMeta = database.prepare("INSERT OR REPLACE INTO ledger_meta VALUES (?, ?)");
	return {
		syncGoal(sessionId, branchKey, goal) {
			const stateJson = JSON.stringify(goal);
			database.exec("BEGIN");
			try {
				replaceGoal.run(sessionId, branchKey, goal.goalId, stateJson, goal.updatedAt);
				replaceContinuation.run(
					goal.goalId,
					branchKey,
					JSON.stringify({ stateChecksum: checksum(stateJson) }),
					goal.updatedAt,
				);
				for (const item of goal.workItems ?? []) {
					replaceItem.run(goal.goalId, item.id, JSON.stringify(item));
					for (const dependency of item.dependsOn) replaceDependency.run(goal.goalId, item.id, dependency);
				}
				for (const blocker of goal.blockers ?? []) {
					replaceBlocker.run(goal.goalId, blocker.id, JSON.stringify(blocker));
					for (const itemId of blocker.workItemIds) replaceBlockerItem.run(goal.goalId, blocker.id, itemId);
				}
				for (const attempt of goal.blockerAttempts ?? [])
					replaceAttempt.run(goal.goalId, attempt.id, JSON.stringify(attempt));
				for (const report of goal.reports ?? [])
					replaceReport.run(goal.goalId, report.revision, report.checksum, report.markdown, report.createdAt);
				pruneGoalRuns.run(sessionId, goal.goalId, branchKey, goal.updatedAt);
				pruneContinuation.run(goal.goalId, branchKey, goal.updatedAt);
				database.exec("COMMIT");
			} catch (error) {
				database.exec("ROLLBACK");
				throw error;
			}
		},
		compact() {
			try {
				const lastVacuum = Number(readMeta.get("last_vacuum_at")?.value ?? 0);
				if (Number.isFinite(lastVacuum) && lastVacuum > 0 && Date.now() - lastVacuum < COMPACT_INTERVAL_MS) return;
				const stats = database
					.prepare(
						"SELECT (SELECT * FROM pragma_freelist_count()) AS freelist, (SELECT * FROM pragma_page_count()) AS total",
					)
					.get() as { freelist?: number; total?: number } | undefined;
				const freelist = Number(stats?.freelist ?? 0);
				if (!Number.isFinite(freelist) || freelist < COMPACT_MIN_FREE_PAGES) return;
				database.exec("VACUUM");
				writeMeta.run("last_vacuum_at", String(Date.now()));
			} catch {
				/* Compaction is best effort; a busy database keeps its pages and retries later. */
			}
		},
		close() {
			database.close();
		},
	};
}

export function branchLedgerKey(
	entries: Array<{ type: string; customType?: string; data?: unknown }>,
): string {
	return checksum(
		JSON.stringify(
			entries
				.filter(
					(entry) =>
						entry.type === "custom" &&
						(entry.customType === "goal-state" || entry.customType === "goal-continuation"),
				)
				.map((entry) => entry.data),
		),
	);
}

function checksum(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}
