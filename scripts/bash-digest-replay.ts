/**
 * Offline replay of the bash-digest decision rules over real session history.
 *
 * Reads `~/.pi/agent/sessions/**\/*.jsonl`, replays every bash tool result
 * through the same `decideDigest` used at runtime, and reports how much bash
 * context would enter the digest path and why the rest is skipped.
 *
 * Usage: npx tsx scripts/bash-digest-replay.ts [days=3] [--verbose]
 */

import {
	decideDigest,
	estimateTokens,
	loadBashDigestConfig,
	type DigestDecision,
} from "../extensions/tool-result-pipeline/bash-digest/core.ts";
import { collectBashResults } from "./bash-digest-scan.ts";

function percent(part: number, whole: number): string {
	if (whole === 0) return "0.0%";
	return `${((part / whole) * 100).toFixed(1)}%`;
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const verbose = args.includes("--verbose");
	const days = Number(args.find((arg) => !arg.startsWith("--")) ?? "3");
	const config = { ...loadBashDigestConfig(), enabled: true };

	const { results, sessions } = await collectBashResults({ days });

	const byReason = new Map<string, { count: number; tokens: number }>();
	let totalTokens = 0;
	let digestedTokens = 0;
	let digestedCount = 0;

	for (const result of results) {
		const decision: DigestDecision = decideDigest({
			text: result.text,
			isError: false,
			config,
			command: result.command,
		});
		totalTokens += decision.tokens;
		const bucket = byReason.get(decision.reason) ?? { count: 0, tokens: 0 };
		bucket.count += 1;
		bucket.tokens += decision.tokens;
		byReason.set(decision.reason, bucket);
		if (decision.digest) {
			digestedCount += 1;
			digestedTokens += decision.tokens;
		}
		if (verbose) {
			console.log(
				`${decision.reason.padEnd(16)} ${String(decision.tokens).padStart(6)} tok  ${String(
					decision.bytes,
				).padStart(7)} B`,
			);
		}
	}

	console.log(`window          : last ${days} days (${sessions} sessions)`);
	console.log(`bash results    : ${results.length}`);
	console.log(`bash tokens     : ${totalTokens}`);
	console.log(
		`digest path     : ${digestedCount} results, ${digestedTokens} tok (${percent(
			digestedTokens,
			totalTokens,
		)} of bash tokens)`,
	);
	console.log("");
	console.log("reason           count      tokens   share");
	for (const reason of ["digest", "below-threshold", "code-dump", "empty", "is-error", "excluded"]) {
		const bucket = byReason.get(reason);
		if (!bucket) continue;
		console.log(
			`${reason.padEnd(16)} ${String(bucket.count).padStart(5)} ${String(bucket.tokens).padStart(11)}   ${percent(
				bucket.tokens,
				totalTokens,
			)}`,
		);
	}
	console.log("");
	console.log(
		"提示：真实压缩比请用 scripts/bash-digest-measure.ts（本脚本只算哪些结果进入摘要路径）。",
	);
}

await main();
