import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * One line per parent-rated child delivery. This ledger is write-only on
 * purpose: ratings never change routing or budgets by themselves, they exist
 * so a periodic human/agent review can compare models on real work.
 *
 * `model`, `tier`, `kind`, and `status` are denormalized copies of what the
 * job ledger recorded at the same workId. The copy can be missing (memory is
 * gone after a restart), so reviews should join on workId first and fall back
 * to these fields.
 */
export interface RatingLedgerRecord {
  readonly v: 1;
  readonly at: number;
  readonly workId: string;
  /** 1 (unusable) to 5 (directly usable, no rework). */
  readonly score: number;
  readonly tags?: readonly string[];
  readonly note?: string;
  readonly kind?: string;
  readonly status?: string;
  readonly model?: string;
  readonly tier?: string;
}

export const RATING_SCORE_MIN = 1;
export const RATING_SCORE_MAX = 5;
export const RATING_MAX_TAGS = 8;
export const RATING_MAX_TAG_LENGTH = 40;
export const RATING_MAX_NOTE_LENGTH = 500;

export function defaultRatingLedgerPath(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const dir =
    environment.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
  return join(dir, "subagent-ratings.jsonl");
}

/** Serialized appends; a lost statistics row must never break the main turn. */
export class RatingLedger {
  readonly path: string;
  private queue: Promise<void> = Promise.resolve();

  constructor(path: string = defaultRatingLedgerPath()) {
    this.path = path;
  }

  record(entry: RatingLedgerRecord): void {
    const line = `${JSON.stringify(entry)}\n`;
    this.queue = this.queue
      .then(async () => {
        await mkdir(dirname(this.path), { recursive: true });
        await appendFile(this.path, line, "utf8");
      })
      .catch(() => undefined);
  }

  /** Resolves once every queued write has been attempted; used by tests. */
  flush(): Promise<void> {
    return this.queue;
  }
}

export interface RatingInput {
  readonly workId: string;
  readonly score: number;
  readonly tags?: readonly string[];
  readonly note?: string;
}

/** Validates and normalizes a rating before it reaches the ledger. */
export function normalizeRating(input: RatingInput): Omit<RatingLedgerRecord, "v" | "at"> {
  const workId = input.workId.trim();
  if (!workId) throw new TypeError("workId is required.");
  if (!Number.isInteger(input.score) || input.score < RATING_SCORE_MIN || input.score > RATING_SCORE_MAX) {
    throw new TypeError(`score must be an integer from ${RATING_SCORE_MIN} to ${RATING_SCORE_MAX}.`);
  }
  const tags = (input.tags ?? [])
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
  if (tags.length > RATING_MAX_TAGS) {
    throw new TypeError(`At most ${RATING_MAX_TAGS} tags are allowed.`);
  }
  if (tags.some((tag) => tag.length > RATING_MAX_TAG_LENGTH)) {
    throw new TypeError(`Each tag must be at most ${RATING_MAX_TAG_LENGTH} characters.`);
  }
  const note = input.note?.trim();
  if (note && note.length > RATING_MAX_NOTE_LENGTH) {
    throw new TypeError(`note must be at most ${RATING_MAX_NOTE_LENGTH} characters.`);
  }
  return {
    workId,
    score: input.score,
    ...(tags.length ? { tags: Object.freeze(tags) } : {}),
    ...(note ? { note } : {}),
  };
}