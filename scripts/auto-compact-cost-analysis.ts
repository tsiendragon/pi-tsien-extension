/**
 * Where does prompt cost actually come from, and does compacting earlier pay?
 *
 * Motivation: docs/session-context-token-plan.md §7 showed that token savings do
 * not translate into cost savings when a mechanism invalidates the provider
 * prefix cache (`cacheRead` is 10x cheaper than `input`). The auto-compact
 * trigger point was justified with a token-only simulation, so it needs the same
 * scrutiny as the rejected observation-pack change.
 *
 * This script answers two questions from real sessions:
 *
 *  1. Marginal cost of context: cost per request bucketed by real prompt size.
 *     If the >300K buckets are not proportionally more expensive, shrinking them
 *     buys little.
 *  2. Cost of a compaction event: cache-hit rate before/after, to price the
 *     prefix invalidation that every compaction causes.
 *
 * Usage: npx tsx scripts/auto-compact-cost-analysis.ts [sinceISO]
 */
import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** Blended per-million-token prices across the models actually in use. */
const INPUT_PRICE = 0.3;
const CACHE_READ_PRICE = 0.03;

interface RequestSample {
	readonly promptTokens: number;
	readonly inputTokens: number;
	readonly cacheReadTokens: number;
	readonly sinceCompaction: number;
	readonly untilNextCompaction: number;
}

const samples: RequestSample[] = [];

async function findSessionFiles(root: string): Promise<string[]> {
	const found: string[] = [];
	const walk = async (dir: string): Promise<void> => {
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
	};
	await walk(root);
	return found;
}

function scanSession(raw: string, since: number): void {
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
		if (Number.isFinite(at) && at < since) return;
	}

	// Follow the active chain, then index compaction boundaries along it.
	const byId = new Map<string, Record<string, unknown>>();
	for (const record of records) if (typeof record.id === "string") byId.set(record.id, record);
	let leaf: string | undefined;
	for (const record of records) if (record.type === "message" && typeof record.id === "string") leaf = record.id;
	if (!leaf) return;

	const chain: Record<string, unknown>[] = [];
	const seen = new Set<string>();
	let cursor: string | undefined = leaf;
	while (cursor && byId.has(cursor) && !seen.has(cursor)) {
		seen.add(cursor);
		chain.push(byId.get(cursor)!);
		cursor = byId.get(cursor)!.parentId as string | undefined;
	}
	chain.reverse();

	// Request index of each message position, so samples can be tagged with their
	// distance from the nearest compaction boundary.
	const compactionAt: number[] = [];
	let requestIndex = -1;
	const positionRequest: number[] = [];
	for (const record of chain) {
		if (record.type === "message") {
			const message = record.message as Record<string, unknown> | undefined;
			if (message?.role === "assistant") requestIndex += 1;
			positionRequest.push(requestIndex);
		} else {
			positionRequest.push(requestIndex);
			if (record.type === "compaction") compactionAt.push(Math.max(0, requestIndex));
		}
	}

	// Per-request usage.
	const perRequest: { prompt: number; input: number; cacheRead: number }[] = [];
	chain.forEach((record, index) => {
		if (record.type !== "message") return;
		const message = record.message as Record<string, unknown> | undefined;
		if (message?.role !== "assistant") return;
		const usage = message.usage as Record<string, number> | undefined;
		if (!usage) return;
		const input = usage.input ?? 0;
		const cacheRead = usage.cacheRead ?? 0;
		const cacheWrite = usage.cacheWrite ?? 0;
		const prompt = input + cacheRead + cacheWrite;
		perRequest[positionRequest[index]!] = { prompt, input, cacheRead };
	});

	perRequest.forEach((entry, index) => {
		if (!entry || entry.prompt <= 0) return;
		const previous = compactionAt.filter((at) => at <= index).pop();
		const next = compactionAt.find((at) => at > index);
		samples.push({
			promptTokens: entry.prompt,
			inputTokens: entry.input,
			cacheReadTokens: entry.cacheRead,
			sinceCompaction: previous === undefined ? -1 : index - previous,
			untilNextCompaction: next === undefined ? -1 : next - index,
		});
	});
}

function costOf(sample: RequestSample): number {
	return (sample.inputTokens / 1e6) * INPUT_PRICE + (sample.cacheReadTokens / 1e6) * CACHE_READ_PRICE;
}

function median(values: readonly number[]): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)]!;
}

async function main(): Promise<void> {
	const sinceArg = process.argv.slice(2).find((arg) => !arg.startsWith("-"));
	const since = sinceArg ? Date.parse(sinceArg) : 0;
	const root = join(homedir(), ".pi", "agent", "sessions");
	const files = await findSessionFiles(root);
	for (const file of files) {
		try {
			scanSession(await readFile(file, "utf8"), Number.isFinite(since) ? (since as number) : 0);
		} catch {
			// unreadable session: skip
		}
	}

	const totalCost = samples.reduce((sum, s) => sum + costOf(s), 0);
	const totalTokens = samples.reduce((sum, s) => sum + s.promptTokens, 0);
	console.log(`requests=${samples.length}  prompt tokens=${totalTokens}  prompt cost=$${totalCost.toFixed(2)}`);

	console.log("\n=== 1. cost per request by real prompt size ===");
	console.log("bucket            requests   prompt tok   $/request   $/100K tok   cacheRead%");
	const buckets: [string, number, number][] = [
		["<100K", 0, 100_000],
		["100-200K", 100_000, 200_000],
		["200-270K", 200_000, 270_000],
		["270-400K", 270_000, 400_000],
		["400-530K", 400_000, 530_000],
		[">530K", 530_000, Number.POSITIVE_INFINITY],
	];
	for (const [label, low, high] of buckets) {
		const rows = samples.filter((s) => s.promptTokens > low && s.promptTokens <= high);
		if (rows.length === 0) continue;
		const cost = rows.reduce((sum, s) => sum + costOf(s), 0);
		const tokens = rows.reduce((sum, s) => sum + s.promptTokens, 0);
		const cacheRead = rows.reduce((sum, s) => sum + s.cacheReadTokens, 0);
		console.log(
			`${label.padEnd(16)} ${String(rows.length).padStart(8)} ${String(Math.round(tokens)).padStart(12)} ` +
				`${`$${(cost / rows.length).toFixed(5)}`.padStart(10)} ${`$${((cost / tokens) * 100_000).toFixed(4)}`.padStart(12)} ` +
				`${((cacheRead / Math.max(1, tokens)) * 100).toFixed(1).padStart(10)}%`,
		);
	}

	console.log("\n=== 2. what a compaction event costs (relative request offset) ===");
	console.log("offset vs compaction   requests   median prompt tok   cacheRead%   $/request");
	const offsets = [-3, -2, -1, 0, 1, 2, 3, 4, 8];
	for (const offset of offsets) {
		const rows = samples.filter((s) => (offset >= 0 ? s.sinceCompaction === offset : s.untilNextCompaction === -offset));
		if (rows.length === 0) continue;
		const cost = rows.reduce((sum, s) => sum + costOf(s), 0);
		const cacheRead = rows.reduce((sum, s) => sum + s.cacheReadTokens, 0);
		const tokens = rows.reduce((sum, s) => sum + s.promptTokens, 0);
		console.log(
			`${String(offset >= 0 ? `+${offset}` : offset).padStart(18)} ${String(rows.length).padStart(10)} ` +
				`${String(Math.round(median(rows.map((s) => s.promptTokens)))).padStart(18)} ` +
				`${((cacheRead / Math.max(1, tokens)) * 100).toFixed(1).padStart(10)}% ${`$${(cost / rows.length).toFixed(5)}`.padStart(11)}`,
		);
	}

	console.log("\n=== 3. how much cost sits above a candidate trigger point ===");
	console.log("trigger   requests above   % of requests   cost above   % of prompt cost");
	for (const trigger of [200_000, 270_000, 350_000, 400_000, 530_000]) {
		const above = samples.filter((s) => s.promptTokens > trigger);
		const cost = above.reduce((sum, s) => sum + costOf(s), 0);
		console.log(
			`${String(trigger).padStart(7)} ${String(above.length).padStart(16)} ${((above.length / samples.length) * 100)
				.toFixed(1)
				.padStart(14)}% ${`$${cost.toFixed(0)}`.padStart(12)} ${((cost / totalCost) * 100).toFixed(1).padStart(15)}%`,
		);
	}
}

await main();
