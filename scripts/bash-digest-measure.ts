/**
 * Measure the REAL behavior of the shipped digest prompt.
 *
 * The prototype experiment used a shorter prompt; the shipped prompt keeps
 * structured rows and lets the model answer KEEP when compressing would drop
 * distinct facts. This script runs the exact same code path as the extension
 * (`extensions/bash-digest/model.ts`) over a stratified sample of real bash
 * results and reports a ratio-estimator projection over the whole population.
 *
 * Usage:
 *   npx tsx scripts/bash-digest-measure.ts [days=3] [samples=30] [concurrency=4]
 *   npx tsx scripts/bash-digest-measure.ts 3 12 3 --bucket=1000-3000 --dump
 */

import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";

import { digestText } from "pi-tsien-rtk-fork/src/bash-digest/model.ts";
import { decideDigest, loadBashDigestConfig } from "pi-tsien-rtk-fork/src/bash-digest/core.ts";
import { collectBashResults, stratifiedSample } from "./bash-digest-scan.ts";

interface Bucket {
	readonly label: string;
	readonly min: number;
	readonly max: number;
}

const BUCKETS: readonly Bucket[] = [
	{ label: "300-500", min: 300, max: 500 },
	{ label: "500-1000", min: 500, max: 1000 },
	{ label: "1000-3000", min: 1000, max: 3000 },
	{ label: ">3000", min: 3000, max: Number.POSITIVE_INFINITY },
];

function bucketOf(tokens: number): Bucket | undefined {
	return BUCKETS.find((bucket) => tokens >= bucket.min && tokens < bucket.max);
}

function percentile(values: readonly number[], p: number): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

function pct(value: number): string {
	return `${(value * 100).toFixed(1)}%`;
}

interface Row {
	readonly bucket: string;
	readonly kind: "digest" | "keep" | "fail";
	readonly originalTokens: number;
	readonly digestTokens: number;
	readonly latencyMs: number;
	readonly firstLine: string;
}

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	const positional = argv.filter((arg) => !arg.startsWith("--"));
	const dump = argv.includes("--dump");
	const onlyBucket = argv.find((arg) => arg.startsWith("--bucket="))?.split("=")[1];
	const days = Number(positional[0] ?? "3");
	const samples = Number(positional[1] ?? "30");
	const concurrency = Number(positional[2] ?? "4");

	const config = { ...loadBashDigestConfig(), enabled: true };
	const buckets = onlyBucket ? BUCKETS.filter((b) => b.label === onlyBucket) : BUCKETS;
	if (buckets.length === 0) throw new Error(`unknown bucket: ${onlyBucket}`);

	console.log(
		`digest model : ${config.digestModel} (maxTokens ${config.maxTokens}, temp 0, maxDigestRatio ${config.maxDigestRatio})`,
	);

	const { results, sessions } = await collectBashResults({ days });
	const scannedTokens = results.reduce(
		(sum, result) => sum + decideDigest({ text: result.text, isError: false, config, command: result.command }).tokens,
		0,
	);
	const eligible = results
		.map((result) => ({
			result,
			decision: decideDigest({ text: result.text, isError: false, config, command: result.command }),
		}))
		.filter((entry) => entry.decision.digest)
		.sort((a, b) => a.decision.tokens - b.decision.tokens);
	const eligibleTokens = eligible.reduce((sum, entry) => sum + entry.decision.tokens, 0);

	console.log(
		`population   : ${sessions} sessions, ${results.length} bash results (${scannedTokens} tok), ` +
			`${eligible.length} eligible (${eligibleTokens} tok, ${pct(eligibleTokens / scannedTokens)} of bash tokens)`,
	);

	const perBucket = Math.max(3, Math.floor(samples / buckets.length));
	const picked = buckets.flatMap((bucket) =>
		stratifiedSample(
			eligible.filter((entry) => entry.decision.tokens >= bucket.min && entry.decision.tokens < bucket.max),
			perBucket,
		).map((entry) => ({ entry, bucket })),
	);
	console.log(`sample       : ${picked.length} results (${perBucket} per bucket)\n`);

	const registry = new ModelRegistry(await ModelRuntime.create());
	const rows: Row[] = [];
	let cursor = 0;

	async function worker(): Promise<void> {
		for (;;) {
			const item = picked[cursor];
			cursor += 1;
			if (!item) return;
			const started = Date.now();
			const digest = await digestText({
				registry,
				modelKey: config.digestModel,
				text: item.entry.decision.text,
				command: item.entry.result.command,
				config,
			});
			const latencyMs = Date.now() - started;
			const firstLine = item.entry.decision.text.split("\n")[0]?.slice(0, 70) ?? "";
			if (!digest) {
				process.stdout.write("x");
				rows.push({ bucket: item.bucket.label, kind: "fail", originalTokens: item.entry.decision.tokens, digestTokens: item.entry.decision.tokens, latencyMs, firstLine });
				continue;
			}
			process.stdout.write(digest.kind === "keep" ? "k" : ".");
			rows.push({
				bucket: item.bucket.label,
				kind: digest.kind,
				originalTokens: item.entry.decision.tokens,
				digestTokens: digest.kind === "keep" ? item.entry.decision.tokens : digest.tokens,
				latencyMs,
				firstLine,
			});
		}
	}
	await Promise.all(Array.from({ length: concurrency }, () => worker()));
	process.stdout.write("\n\n");

	if (dump) {
		console.log("kind  orig  after  bucket         first line");
		for (const row of rows) {
			console.log(
				`${row.kind.padEnd(5)} ${String(row.originalTokens).padStart(5)} ${String(row.digestTokens).padStart(6)}  ${row.bucket.padEnd(14)} ${row.firstLine}`,
			);
		}
		console.log("");
	}

	console.log("bucket         sampled  kept  orig tok  after tok   sample saving");
	const population = new Map<string, number>();
	for (const entry of eligible) {
		const bucket = bucketOf(entry.decision.tokens);
		if (!bucket || !buckets.some((b) => b.label === bucket.label)) continue;
		population.set(bucket.label, (population.get(bucket.label) ?? 0) + entry.decision.tokens);
	}

	// Ratio estimator: apply the sample's saving fraction to the population tokens.
	let sampleOriginal = 0;
	let sampleAfter = 0;
	let populationOriginal = 0;
	for (const bucket of buckets) {
		const bucketRows = rows.filter((row) => row.bucket === bucket.label);
		if (bucketRows.length === 0) continue;
		const original = bucketRows.reduce((sum, row) => sum + row.originalTokens, 0);
		const after = bucketRows.reduce((sum, row) => sum + row.digestTokens, 0);
		const kept = bucketRows.filter((row) => row.kind === "keep").length;
		sampleOriginal += original;
		sampleAfter += after;
		populationOriginal += population.get(bucket.label) ?? 0;
		console.log(
			`${bucket.label.padEnd(14)} ${String(bucketRows.length).padStart(5)} ${String(kept).padStart(6)} ${String(
				original,
			).padStart(9)} ${String(after).padStart(10)}   ${pct(1 - after / original).padStart(6)}`,
		);
	}

	const sampleSaving = sampleOriginal === 0 ? 0 : 1 - sampleAfter / sampleOriginal;
	const populationAfter = populationOriginal * (1 - sampleSaving);
	const latencies = rows.map((row) => row.latencyMs);

	console.log("");
	console.log(`failures                : ${rows.filter((r) => r.kind === "fail").length}/${rows.length}`);
	console.log(`model said KEEP         : ${rows.filter((r) => r.kind === "keep").length}/${rows.length} (left as raw output)`);
	console.log(`sample saving           : ${pct(sampleSaving)}  (ratio estimator over ${sampleOriginal} sampled tok)`);
	console.log(
		`projected on digest path: ${Math.round(populationOriginal)} -> ${Math.round(populationAfter)} tok (${pct(sampleSaving)} saved)`,
	);
	console.log(
		`projected all bash tok  : ${Math.round(scannedTokens)} -> ${Math.round(scannedTokens - populationOriginal * sampleSaving)} tok (${pct(
			(populationOriginal * sampleSaving) / scannedTokens,
		)} saved)`,
	);
	console.log(
		`latency                 : p50 ${percentile(latencies, 50)} ms / p90 ${percentile(latencies, 90)} ms / max ${Math.max(...latencies, 0)} ms`,
	);
}

await main();
