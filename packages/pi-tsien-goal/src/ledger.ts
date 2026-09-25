import { createHash } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { GoalState } from "./types.ts";

export const DEFAULT_GOAL_LEDGER_PATH = join(homedir(), ".pi", "agent", "pi-goal.sqlite");

export interface GoalLedger {
	syncGoal(sessionId: string, branchKey: string, goal: GoalState): void;
	close(): void;
}

export function openGoalLedger(path = DEFAULT_GOAL_LEDGER_PATH): GoalLedger {
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
				database.exec("COMMIT");
			} catch (error) {
				database.exec("ROLLBACK");
				throw error;
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
