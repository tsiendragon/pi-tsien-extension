/**
 * Agent-requested compaction: the pending-request store.
 *
 * `ctx.compact()` aborts the current agent run before it summarises, so a tool
 * that compacted inline would kill the very turn that called it and lose the
 * tool result. The tool therefore only records a request here; the extension
 * consumes it at the next idle boundary (`agent_settled`), where compaction is
 * safe — the same guard the threshold trigger already uses.
 *
 * Requests are keyed by session id: one Pi process can host more than one
 * session (forks, side chats), and a request must never be consumed by another.
 */

export interface CompactRequest {
	/** Optional focus instructions for the summary. */
	readonly instructions?: string;
	/** When the request was recorded, for observability. */
	readonly requestedAt: number;
}

export type CompactRequestOutcome = "scheduled" | "already_scheduled";

export interface CompactRequestStore {
	/** Record a request; reports that one is already pending instead of overwriting it. */
	request(
		sessionId: string,
		instructions: string | undefined,
		now?: number,
	): CompactRequestOutcome;
	/** Whether a request is pending for the session. */
	has(sessionId: string): boolean;
	/** Remove and return the pending request, if any. */
	take(sessionId: string): CompactRequest | undefined;
	/** Drop a pending request (session shutdown). */
	clear(sessionId: string): void;
}

export function createCompactRequestStore(): CompactRequestStore {
	const pending = new Map<string, CompactRequest>();

	return {
		request(sessionId, instructions, now = Date.now()) {
			if (pending.has(sessionId)) return "already_scheduled";
			pending.set(sessionId, { instructions, requestedAt: now });
			return "scheduled";
		},
		has(sessionId) {
			return pending.has(sessionId);
		},
		take(sessionId) {
			const request = pending.get(sessionId);
			pending.delete(sessionId);
			return request;
		},
		clear(sessionId) {
			pending.delete(sessionId);
		},
	};
}