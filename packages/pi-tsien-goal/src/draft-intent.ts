/**
 * `/goal` and `/goal replan` draft unattended: the drafted goal is saved and
 * started without a review dialog. The drafting turn is an ordinary model turn,
 * so whether that happened used to depend on the model remembering
 * `autoApprove: true`. One omitted flag left the draft waiting on a review
 * dialog nobody was watching, and no goal existed to continue afterwards.
 *
 * The command therefore records its intent here, and the draft tool honors it
 * even when the flag is missing. Intent lives in process memory (the command
 * must not write branch entries), is scoped per session, and expires so a stale
 * intent cannot silently auto-approve a draft the user asked for much later.
 */

export const GOAL_DRAFT_INTENT_TTL_MS = 10 * 60_000;

export interface GoalDraftIntent {
	replan: boolean;
	at: number;
}

interface DraftIntentContext {
	sessionManager?: { getSessionId?: () => string; getBranch?: () => unknown };
}

const intents = new Map<string, GoalDraftIntent>();

const keyOf = (ctx: DraftIntentContext): string => ctx.sessionManager?.getSessionId?.() ?? "";

export function markDraftIntent(ctx: DraftIntentContext, intent: { replan: boolean }, now = Date.now()): void {
	intents.set(keyOf(ctx), { replan: intent.replan, at: now });
}

/** Reads the pending intent without consuming it: an unattended draft rejected by the quality gate may be retried once. */
export function pendingDraftIntent(ctx: DraftIntentContext, now = Date.now()): GoalDraftIntent | undefined {
	const key = keyOf(ctx);
	const intent = intents.get(key);
	if (!intent) return undefined;
	if (now - intent.at > GOAL_DRAFT_INTENT_TTL_MS) {
		intents.delete(key);
		return undefined;
	}
	return intent;
}

export function clearDraftIntent(ctx: DraftIntentContext): void {
	intents.delete(keyOf(ctx));
}

export function resetDraftIntents(): void {
	intents.clear();
}