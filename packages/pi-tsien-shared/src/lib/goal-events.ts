/**
 * Cross-extension events on pi's shared event bus (`pi.events`).
 *
 * The bus payloads are `unknown` by design, so the channel name and the payload
 * shape live here: producers and consumers import the same constant instead of
 * duplicating string literals across packages.
 */

/**
 * Emitted by pi-tsien-goal right after it appends a `goal-state` entry.
 *
 * The live-session bridge listens so the dashboard sees goal changes without
 * waiting for the next reconnect/resync — snapshots are only rebuilt at connect
 * time, so a goal created mid-session otherwise stays invisible.
 */
export const GOAL_STATE_CHANGED_EVENT = "pi-tsien.goal.state-changed.v1";

export type GoalStateChangedStatus = "active" | "paused" | "complete";

export interface GoalStateChangedEvent {
	goalId: string;
	/** Absent when the save cleared the goal — there is no state left to report. */
	status?: GoalStateChangedStatus;
	/** The goal-state action that produced the entry (create / pause / progress / ...). */
	action: string;
}