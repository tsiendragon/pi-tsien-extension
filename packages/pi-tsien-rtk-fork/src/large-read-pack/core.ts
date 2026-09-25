/**
 * Core logic of the `large-read-pack` stage: decide when a `read` result is
 * large enough to be replaced by a head + tail pack, and render that pack.
 *
 * Why this stage exists: in a full-history replay (91,742 requests / 15.29B
 * prompt tokens) `read` results are 25.6% of all replay-weighted tokens, and
 * capping only the reads above ~2000 tokens still removes 5.1% of replay
 * (numbers from `scripts/context-age-analysis.ts`).
 *
 * Two rules keep the rewrite honest:
 *   1. the full text is archived with the observation-pack layout first, so the
 *      pack header can carry an observation id and `obs_recall` can return every
 *      dropped byte — the rewrite is a *pointer*, not a deletion;
 *   2. the rewrite must actually pay off (`minSavedRatio`), measured against the
 *      text it replaces.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { agentDir, countLines, estimateTokens } from "pi-tsien-observation-pack/src/core.ts";

export const CONFIG_FILE_NAME = "large-read-pack.json";

export interface LargeReadPackConfig {
	/** Off by default: enabling this changes what the model sees. */
	enabled: boolean;
	/** Only results larger than this (bytes) are considered. */
	thresholdBytes: number;
	/** Kept from the start of the text, cut back to a line boundary. */
	headBytes: number;
	/** Kept from the end of the text, cut forward to a line boundary. */
	tailBytes: number;
	/** Skip the rewrite unless the pack is at most this share of the original. */
	minSavedRatio: number;
}

export const DEFAULT_LARGE_READ_PACK_CONFIG: LargeReadPackConfig = {
	enabled: false,
	thresholdBytes: 8 * 1024,
	headBytes: 6 * 1024,
	tailBytes: 1500,
	minSavedRatio: 0.5,
};

/** Fixed header/footer boilerplate cost, measured in `scripts/observation-pack-placeholder-size.ts`. */
export const PACK_OVERHEAD_TOKENS = 45;

export function loadLargeReadPackConfig(env: NodeJS.ProcessEnv = process.env): LargeReadPackConfig {
	let parsed: Record<string, unknown> = {};
	try {
		const value: unknown = JSON.parse(readFileSync(join(agentDir(env), CONFIG_FILE_NAME), "utf8"));
		if (typeof value === "object" && value !== null) {
			const nest = (value as { largeReadPack?: unknown }).largeReadPack;
			parsed =
				typeof nest === "object" && nest !== null
					? (nest as Record<string, unknown>)
					: (value as Record<string, unknown>);
		}
	} catch {
		return DEFAULT_LARGE_READ_PACK_CONFIG;
	}
	const raw = parsed;
	const number = (value: unknown, fallback: number): number =>
		typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
	return {
		enabled: raw.enabled === true,
		thresholdBytes: number(raw.thresholdBytes, DEFAULT_LARGE_READ_PACK_CONFIG.thresholdBytes),
		headBytes: number(raw.headBytes, DEFAULT_LARGE_READ_PACK_CONFIG.headBytes),
		tailBytes: number(raw.tailBytes, DEFAULT_LARGE_READ_PACK_CONFIG.tailBytes),
		minSavedRatio:
			typeof raw.minSavedRatio === "number" && raw.minSavedRatio > 0 && raw.minSavedRatio <= 1
				? raw.minSavedRatio
				: DEFAULT_LARGE_READ_PACK_CONFIG.minSavedRatio,
	};
}

export interface ReadPackDecision {
	/** Full text to archive. */
	text: string;
	/** Estimated tokens of the original text. */
	tokens: number;
	/** Lines kept from the top / bottom of the text. */
	head: string;
	tail: string;
	headLines: number;
	tailLines: number;
	omittedBytes: number;
	omittedFromLine: number;
	omittedToLine: number;
	omittedTokens: number;
	keptTokens: number;
}

/** Bytes, not chars: a Chinese read result is ~3x its length in bytes. */
function byteLength(text: string): number {
	return Buffer.byteLength(text, "utf8");
}

/** Cut at a line boundary so the pack never starts or ends mid-line. */
export function headAtLineBoundary(text: string, limit: number): string {
	if (limit <= 0) return "";
	if (text.length <= limit) return text;
	const slice = text.slice(0, limit);
	const nl = slice.lastIndexOf("\n");
	return nl > 0 ? slice.slice(0, nl + 1) : slice;
}

export function tailAtLineBoundary(text: string, limit: number): string {
	if (limit <= 0) return "";
	if (text.length <= limit) return text;
	let slice = text.slice(text.length - limit);
	const nl = slice.indexOf("\n");
	if (nl >= 0) slice = slice.slice(nl + 1);
	return slice;
}

export function decideReadPack(text: string, config: LargeReadPackConfig): ReadPackDecision | undefined {
	if (text === "") return undefined;
	if (byteLength(text) <= config.thresholdBytes) return undefined;

	const head = headAtLineBoundary(text, config.headBytes);
	const tail = tailAtLineBoundary(text, config.tailBytes);
	if (head === "" && tail === "") return undefined;
	if (head.length + tail.length >= text.length) return undefined;

	const headLines = head === "" ? 0 : head.split("\n").length - (head.endsWith("\n") ? 1 : 0);
	const totalLines = countLines(text);
	const tailLines = tail === "" ? 0 : tail.split("\n").length;
	const omittedFromLine = headLines + 1;
	const omittedToLine = Math.max(omittedFromLine, totalLines - tailLines);

	const keptBytes = byteLength(head) + byteLength(tail);
	const tokens = estimateTokens(text);
	const keptTokens = estimateTokens(head + tail) + PACK_OVERHEAD_TOKENS;
	if (tokens <= 0) return undefined;
	if (keptTokens > tokens * config.minSavedRatio) return undefined;

	const omittedBytes = byteLength(text) - keptBytes;
	if (omittedBytes <= 0) return undefined;

	return {
		text,
		tokens,
		head,
		tail,
		headLines,
		tailLines,
		omittedBytes,
		omittedFromLine,
		omittedToLine,
		omittedTokens: Math.max(0, tokens - estimateTokens(head + tail)),
		keptTokens,
	};
}

export interface RenderReadPackInput {
	decision: ReadPackDecision;
	observationId: string;
}

/**
 * Header + kept head + omission marker + kept tail, e.g.
 *
 *   [read-pack 6200 tok -> 1900 tok | kept lines 1-110 and 940-1000 | omitted lines 111-939
 *    (37120 bytes, ~4300 tok) | raw: obs_x | retrieve: call obs_recall with {"id":"obs_x","offset":0}]
 */
export function renderReadPack({ decision, observationId }: RenderReadPackInput): string {
	const lastFromTail = decision.omittedToLine + 1;
	const keptLines =
		decision.tailLines > 0 ? `1-${decision.headLines} and ${lastFromTail}-${lastFromTail + decision.tailLines - 1}` : `1-${decision.headLines}`;
	const header =
		`[read-pack ${decision.tokens} tok -> ${decision.keptTokens} tok | kept lines ${keptLines}` +
		` | omitted lines ${decision.omittedFromLine}-${decision.omittedToLine} (${decision.omittedBytes} bytes, ~${decision.omittedTokens} tok)` +
		` | raw: ${observationId} | retrieve: call obs_recall with {"id":"${observationId}","offset":0}]`;
	const marker =
		`[*** lines ${decision.omittedFromLine}-${decision.omittedToLine} omitted (${decision.omittedBytes} bytes, ~${decision.omittedTokens} tok)` +
		` — call obs_recall with {"id":"${observationId}","offset":0} to read them ***]`;
	const parts = [header, decision.head.trimEnd()];
	if (decision.tail !== "") parts.push(marker, decision.tail.trimEnd());
	return parts.join("\n");
}
