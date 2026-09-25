import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { branchLedgerKey, openGoalLedger } from "pi-tsien-goal/src/ledger.ts";

import type { GoalState } from "pi-tsien-goal/src/types.ts";

const goal: GoalState = {
	version: 2,
	goalId: "goal-1",
	objective: "Persist safely",
	status: "active",
	sourceDocs: [],
	constraints: [],
	acceptanceCriteria: [],
	progress: { done: [], blocked: [], lastSummary: "" },
	workItems: [],
	blockers: [],
	blockerAttempts: [],
	reports: [],
	createdAt: 1,
	updatedAt: 2,
	owner: "user",
};

describe("goal SQLite ledger", () => {
	it("creates the local materialized ledger and produces branch-specific keys", () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-goal-ledger-"));
		try {
			const ledger = openGoalLedger(join(directory, "pi-goal.sqlite"));
			const first = branchLedgerKey([
				{ type: "custom", customType: "goal-state", data: { action: "create" } },
			]);
			const second = branchLedgerKey([
				{ type: "custom", customType: "goal-state", data: { action: "replace" } },
			]);
			expect(first).not.toBe(second);
			expect(() => ledger.syncGoal("session-1", first, goal)).not.toThrow();
			ledger.close();
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
