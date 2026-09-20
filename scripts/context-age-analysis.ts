/**
 * Replay-weighted context analysis.
 *
 * Why this exists: the cost of a piece of context is `tokens x (number of
 * requests it survives in)`, not its share of one context window. A tool result
 * produced early in a session is re-sent on every later request; one produced at
 * the end is re-sent twice. Ranking sources by "share of context" therefore
 * gives the wrong answer.
 *
 * Correctness note: session files record the full tree history, but pi only ever
 * sends the active chain *after the most recent compaction boundary*. A naive
 * linear scan counts compacted-away history as if it were still live and can
 * inflate the total by ~10x. This script honours `compaction`
 * (`summary` + `firstKeptEntryId`) boundaries, and self-validates:
 *
 *   sum over requests of (estimated live message tokens)   ~= sum(entries x survives)
 *
 * Both numbers are printed; they must match within a few percent. The second
 * comparison against real `usage` prompt tokens is expected to be < 1 because
 * the system prompt and tool definitions are not part of this estimate.
 *
 * Usage: npx tsx scripts/context-age-analysis.ts [sinceISO]
 */
import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

interface LiveEntry {
	readonly tokens: number;
	readonly atRequest: number;
	readonly source: string;
	readonly isToolResult: boolean;
	readonly pos: number;
}

interface ReplayEntry {
	readonly tokens: number;
	readonly survives: number;
	readonly source: string;
	readonly isToolResult: boolean;
}

function estimateTokens(chars: number): number {
	return Math.ceil(chars / 4);
}

function estimateCharsOfString(value: string): number {
	return estimateTokens(value.length);
}

function contentChars(content: unknown): number {
	if (typeof content === "string") return content.length;
	if (!Array.isArray(content)) return 0;
	let chars = 0;
	for (const block of content as Record<string, unknown>[]) {
		if (!block || typeof block !== "object") continue;
		const type = block.type;
		if (type === "text" && typeof block.text === "string") chars += block.text.length;
		else if (type === "thinking" && typeof block.thinking === "string") chars += block.thinking.length;
		else if (type === "toolCall") chars += JSON.stringify(block.arguments ?? {}).length;
		else if (type === "image") chars += 4000;
	}
	return chars;
}

async function findSessionFiles(root: string): Promise<string[]> {
	const found: string[] = [];
	async function walk(dir: string): Promise<void> {
		let entries;
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) await walk(path);
			else if (entry.name.endsWith(".jsonl")) found.push(path);
		}
	}
	await walk(root);
	return found;
}

interface Tally {
	sessions: number;
	requests: number;
	promptTokens: number;
	inputTokens: number;
	cacheReadTokens: number;
	liveSum: number;
	entryTokensOnce: number;
	compactions: number;
}

const tally: Tally = {
	sessions: 0,
	requests: 0,
	promptTokens: 0,
	inputTokens: 0,
	cacheReadTokens: 0,
	liveSum: 0,
	entryTokensOnce: 0,
	compactions: 0,
};

const replayEntries: ReplayEntry[] = [];
const tokensBefore: number[] = [];

function scanSession(raw: string, since: number): boolean {
	const records: Record<string, unknown>[] = [];
	for (const line of raw.split("\n")) {
		if (line.trim() === "") continue;
		try {
			records.push(JSON.parse(line) as Record<string, unknown>);
		} catch {
			// ignore malformed lines
		}
	}

	if (since > 0) {
		const head = records.find((r) => r.type === "session");
		const at = Date.parse(String(head?.timestamp ?? ""));
		if (Number.isFinite(at) && at < since) return false;
	}

	const byId = new Map<string, Record<string, unknown>>();
	for (const record of records) {
		if (typeof record.id === "string") byId.set(record.id, record);
	}
	let leaf: string | undefined;
	for (const record of records) {
		if (record.type === "message" && typeof record.id === "string") leaf = record.id;
	}
	if (!leaf) return false;

	// Walk parentId links back to the root: the chain is what pi actually sends.
	const chain: Record<string, unknown>[] = [];
	const seen = new Set<string>();
	let cursor: string | undefined = leaf;
	while (cursor && byId.has(cursor) && !seen.has(cursor)) {
		seen.add(cursor);
		chain.push(byId.get(cursor)!);
		cursor = byId.get(cursor)!.parentId as string | undefined;
	}
	chain.reverse();

	const pos = new Map<string, number>();
	chain.forEach((record, index) => {
		if (typeof record.id === "string") pos.set(record.id, index);
	});

	let live: LiveEntry[] = [];
	let requestIndex = -1;
	let touched = false;
	let sessionLiveSum = 0;

	const retire = (keepFrom: number): void => {
		const kept: LiveEntry[] = [];
		for (const entry of live) {
			if (entry.pos >= keepFrom) kept.push(entry);
			else
				replayEntries.push({
					tokens: entry.tokens,
					survives: Math.max(0, requestIndex - entry.atRequest),
					source: entry.source,
					isToolResult: entry.isToolResult,
				});
		}
		live = kept;
	};

	chain.forEach((record, index) => {
		if (record.type === "compaction") {
			const firstKept = record.firstKeptEntryId;
			const keepFrom = typeof firstKept === "string" ? (pos.get(firstKept) ?? Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER;
			retire(keepFrom);
			const summary = String(record.summary ?? "");
			if (summary !== "") {
				live.push({
					tokens: estimateCharsOfString(summary),
					atRequest: Math.max(0, requestIndex),
					source: "compaction-summary",
					isToolResult: false,
					pos: index,
				});
			}
			tally.compactions += 1;
			const before = record.tokensBefore;
			if (typeof before === "number" && before > 0) tokensBefore.push(before);
			return;
		}
		if (record.type !== "message") return;
		const message = record.message;
		if (typeof message !== "object" || message === null) return;
		const m = message as Record<string, unknown>;

		let source: string;
		let isToolResult = false;
		if (m.role === "assistant") {
			requestIndex += 1;
			source = "assistant";
			const usage = m.usage as Record<string, unknown> | undefined;
			if (usage) {
				const input = Number(usage.input ?? 0) || 0;
				const cacheRead = Number(usage.cacheRead ?? 0) || 0;
				const cacheWrite = Number(usage.cacheWrite ?? 0) || 0;
				const prompt = input + cacheRead + cacheWrite;
				if (prompt > 0) {
					tally.requests += 1;
					tally.promptTokens += prompt;
					tally.inputTokens += input;
					tally.cacheReadTokens += cacheRead;
					sessionLiveSum += live.reduce((sum, entry) => sum + entry.tokens, 0);
					touched = true;
				}
			}
		} else if (m.role === "toolResult") {
			const name = typeof m.toolName === "string" ? m.toolName : "tool";
			source = m.isError === true ? `${name}(error)` : name;
			isToolResult = true;
		} else {
			source = typeof m.role === "string" ? m.role : "other";
		}

		const tokens = estimateTokens(contentChars(m.content));
		live.push({ tokens, atRequest: Math.max(0, requestIndex), source, isToolResult, pos: index });
	});

	if (!touched) return false;
	tally.sessions += 1;
	tally.liveSum += sessionLiveSum;
	for (const entry of live) {
		replayEntries.push({
			tokens: entry.tokens,
			survives: Math.max(0, requestIndex - entry.atRequest),
			source: entry.source,
			isToolResult: entry.isToolResult,
		});
	}
	return true;
}

function pct(value: number): string {
	return `${(value * 100).toFixed(1)}%`;
}

async function main(): Promise<void> {
	const sinceArg = process.argv.slice(2).find((arg) => !arg.startsWith("-"));
	const since = sinceArg ? Date.parse(sinceArg) : 0;
	const root = join(homedir(), ".pi", "agent", "sessions");
	const files = await findSessionFiles(root);

	for (const file of files) {
		let raw: string;
		try {
			raw = await readFile(file, "utf8");
		} catch {
			continue;
		}
		scanSession(raw, Number.isFinite(since) ? (since as number) : 0);
	}

	const totalReplay = replayEntries.reduce((sum, entry) => sum + entry.tokens * entry.survives, 0);
	const totalLive = replayEntries.reduce((sum, entry) => sum + entry.tokens, 0);

	console.log(`window            : ${since > 0 ? `since ${sinceArg}` : "all history"} (${files.length} session files scanned)`);
	console.log(`sessions with use : ${tally.sessions}`);
	console.log(`requests          : ${tally.requests}`);
	console.log(`prompt tokens     : ${tally.promptTokens}`);
	console.log(`cacheRead share   : ${pct(tally.cacheReadTokens / Math.max(1, tally.promptTokens))}`);
	console.log("");
	console.log("=== self-validation (these two must agree within a few percent) ===");
	console.log(
		`Σ live message tokens over requests = ${tally.liveSum}   (${(tally.liveSum / Math.max(1, tally.promptTokens) * 100).toFixed(0)}% of real prompt tokens; system prompt + tools are not estimated here)`,
	);
	console.log(
		`Σ entries tokens x survives        = ${Math.round(totalReplay)}   ratio vs previous = ${(totalReplay / Math.max(1, tally.liveSum)).toFixed(3)}`,
	);
	console.log(`TOTAL live (each entry counted once) = ${totalLive}   avg survives = ${(totalReplay / Math.max(1, totalLive)).toFixed(1)}`);

	if (tokensBefore.length > 0) {
		const sorted = [...tokensBefore].sort((a, b) => a - b);
		const at = (q: number): number => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]!;
		console.log(
			`compactions = ${tally.compactions}   tokensBefore p10=${at(0.1)} p50=${at(0.5)} p90=${at(0.9)} max=${sorted[sorted.length - 1]}`,
		);
	}

	const bySource = new Map<string, { count: number; tokens: number; replay: number }>();
	for (const entry of replayEntries) {
		const bucket = bySource.get(entry.source) ?? { count: 0, tokens: 0, replay: 0 };
		bucket.count += 1;
		bucket.tokens += entry.tokens;
		bucket.replay += entry.tokens * entry.survives;
		bySource.set(entry.source, bucket);
	}

	console.log("");
	console.log("=== replay-weighted composition (tokens x requests survived) ===");
	console.log("source                     entries     live tok        replay tok   share");
	for (const [source, bucket] of [...bySource.entries()].sort((a, b) => b[1].replay - a[1].replay)) {
		if (bucket.replay / totalReplay < 0.001) continue;
		console.log(
			`  ${source.padEnd(24)} ${String(bucket.count).padStart(8)} ${String(bucket.tokens).padStart(12)} ${String(
				Math.round(bucket.replay),
			).padStart(16)}   ${pct(bucket.replay / totalReplay).padStart(6)}`,
		);
	}

	const toolReplay = replayEntries.filter((e) => e.isToolResult).reduce((sum, e) => sum + e.tokens * e.survives, 0);
	console.log("");
	console.log(`replay split: tool results ${pct(toolReplay / totalReplay)} | other (user/assistant/summary) ${pct(1 - toolReplay / totalReplay)}`);

	console.log("");
	console.log("=== tool-result replay by size (tokens) ===");
	const sizeBuckets: [string, number, number][] = [
		["<=150", 0, 150],
		["150-400", 150, 400],
		["400-1000", 400, 1000],
		["1000-2500", 1000, 2500],
		["2500-8000", 2500, 8000],
		[">8000", 8000, Number.POSITIVE_INFINITY],
	];
	for (const [label, low, high] of sizeBuckets) {
		const rows = replayEntries.filter((e) => e.isToolResult && e.tokens > low && e.tokens <= high);
		const replay = rows.reduce((sum, e) => sum + e.tokens * e.survives, 0);
		console.log(
			`  ${label.padEnd(10)} entries=${String(rows.length).padStart(8)}  replay=${String(Math.round(replay)).padStart(16)}  ${pct(
				replay / Math.max(1, toolReplay),
			).padStart(6)} of tool replay`,
		);
	}

	console.log("");
	console.log("=== eviction ceiling (tool results only, replaced by a placeholder) ===");
	console.log("  keep  placeholder        saved replay   % of all replay");
	for (const keep of [0, 1, 2]) {
		for (const placeholder of [40, 120, 250, 400]) {
			let saved = 0;
			for (const entry of replayEntries) {
				if (!entry.isToolResult) continue;
				saved += Math.max(0, entry.survives - keep) * Math.max(0, entry.tokens - placeholder);
			}
			console.log(
				`  ${String(keep).padStart(4)}  ${String(placeholder).padStart(11)}   ${String(Math.round(saved)).padStart(16)}   ${pct(
					saved / totalReplay,
				).padStart(6)}`,
			);
		}
	}

	console.log("");
	console.log("=== capture: large-read-pack (cap read results at N tok, archive the original) ===");
	const READ_PLACEHOLDER_TOKENS = 130;
	const readEntries = replayEntries.filter((e) => e.source === "read" || e.source === "read(error)");
	const readReplay = readEntries.reduce((sum, e) => sum + e.tokens * e.survives, 0);
	console.log(`  read replay = ${Math.round(readReplay)} (${pct(readReplay / totalReplay)} of all replay), ${readEntries.length} entries`);
	console.log("    cap tok   entries above    replay saved   % of all   % of read");
	for (const cap of [500, 1000, 2000, 4000, 8000]) {
		const rows = readEntries.filter((e) => e.tokens > cap);
		let saved = 0;
		for (const e of rows) saved += e.survives * Math.max(0, e.tokens - cap - READ_PLACEHOLDER_TOKENS);
		console.log(
			`  ${String(cap).padStart(7)}  ${String(rows.length).padStart(13)}   ${String(Math.round(saved)).padStart(12)}   ${pct(
				saved / totalReplay,
			).padStart(8)}   ${pct(saved / Math.max(1, readReplay)).padStart(9)}`,
		);
	}

	console.log("");
	console.log("=== reference: bash-digest ===");
	for (const [label, path, ratio] of [
		["safe (7% of bash tokens covered)", 0.07, 0.12],
		["aggressive (71.5% covered)", 0.715, 0.12],
	] as [string, number, number][]) {
		let saved = 0;
		for (const entry of replayEntries) {
			if (!entry.isToolResult) continue;
			if (!entry.source.startsWith("bash")) continue;
			saved += entry.tokens * entry.survives * path * (1 - ratio);
		}
		console.log(`  ${label.padEnd(34)} ${pct(saved / totalReplay)} of replay`);
	}
}

await main();
