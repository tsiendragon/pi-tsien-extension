/**
 * Measures the real token cost of an observation-pack placeholder, so the
 * eviction thresholds in docs/session-context-token-plan.md §6 are grounded in
 * the actual renderer instead of an estimate.
 *
 * Usage: npx tsx scripts/observation-pack-placeholder-size.ts
 */
import { placeholderFor, type Observation } from "pi-tsien-observation-pack/src/core.ts";

const tok = (value: string): number => Math.ceil(value.length / 4);

function makeObservation(bytes: number, tokens: number): Observation {
	const lines = 200;
	const text = Array.from({ length: lines }, (_, i) => {
		const body = "x".repeat(Math.max(1, Math.floor(bytes / lines) - 8));
		return `line ${String(i).padStart(3, "0")} ${body}`;
	}).join("\n");
	return {
		id: "obs_0123456789abcdef",
		contentHash: "deadbeef",
		filePath: "/tmp/archiv/sess/observation-pack/objects/obs_0123456789abcdef.txt",
		toolName: "bash",
		text,
		bytes,
		lines,
		tokens,
	};
}

console.log("excerptBytes   boilerplate   excerpt   total   total% of a 4000-tok result");
for (const excerptBytes of [0, 250, 320, 512, 1024]) {
	const observation = makeObservation(14000, 4000);
	const full = placeholderFor(observation, excerptBytes, 2);
	const bare = placeholderFor(observation, 0, 2);
	const boilerplate = tok(bare);
	const total = tok(full);
	console.log(
		`${String(excerptBytes).padStart(12)} ${String(boilerplate).padStart(13)} ${String(total - boilerplate).padStart(
			9,
		)} ${String(total).padStart(7)}   ${((total / 4000) * 100).toFixed(1)}%`,
	);
}

console.log("\n小结果的绝对开销（阈值降到 1200B 后必须付的成本下限）：");
for (const [bytes, tokens] of [
	[1200, 300],
	[2000, 500],
	[4000, 1000],
] as [number, number][]) {
	const observation = makeObservation(bytes, tokens);
	const total = tok(placeholderFor(observation, 250, 2));
	console.log(`  原文 ${String(tokens).padStart(5)} tok (${bytes}B)  ->  占位符 ${String(total).padStart(4)} tok  省 ${String(tokens - total).padStart(5)} tok (${(((tokens - total) / tokens) * 100).toFixed(0)}%)`);
}
