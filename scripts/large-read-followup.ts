/**
 * How often is a large `read` result followed by another read of the same file?
 *
 * This decides whether `large-read-pack` pays off. The stage caps a large `read`
 * at a head + tail and hides the middle behind an observation id. That is only a
 * win when the middle is never needed again: `obs_recall` (or a second `read`)
 * brings bytes back as *new* full-price input, while the tokens it replaced were
 * sitting in the context at cache price — a 1:10 difference.
 *
 * A/B evidence: on a needle-in-the-middle task (the omitted line is the answer),
 * the packed arm cost +47% and used 3 extra requests. This script measures how
 * common that shape is in real sessions, so the decision uses a rate instead of
 * a single hand-picked task.
 *
 * Usage: npx tsx scripts/large-read-followup.ts [days]
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Session jsonl files under `root`, walked iteratively (sessions nest by cwd). */
function findSessionFiles(root: string): string[] {
	const found: string[] = [];
	const queue = [root];
	while (queue.length > 0) {
		const dir = queue.pop()!;
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			continue;
		}
		for (const entry of entries) {
			const path = join(dir, entry);
			let isDirectory = false;
			try {
				isDirectory = statSync(path).isDirectory();
			} catch {
				continue;
			}
			if (isDirectory) queue.push(path);
			else if (entry.endsWith(".jsonl")) found.push(path);
		}
	}
	return found;
}

interface LargeRead {
	path: string;
	bytes: number;
	followUps: number;
	followUpBytes: number;
}

function byteLength(value: unknown): number {
	if (typeof value === "string") return Buffer.byteLength(value, "utf8");
	if (Array.isArray(value)) return value.reduce((sum, item) => sum + byteLength(item), 0);
	if (typeof value === "object" && value !== null) {
		const record = value as Record<string, unknown>;
		if (typeof record.text === "string") return Buffer.byteLength(record.text, "utf8");
	}
	return 0;
}

function main(): void {
	const since = Number(process.argv[2] ?? 0) || 0;
	const files = findSessionFiles(
		process.env.PI_SESSION_ROOT ?? join(process.env.HOME ?? "", ".pi", "agent", "sessions"),
	);
	{
		{
			const reads: LargeRead[] = [];
			let sessions = 0;
			let sessionsWithFollowUp = 0;

			for (const file of files) {
				let raw: string;
				try {
					raw = readFileSync(file, "utf8");
				} catch {
					continue;
				}
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
					const head = records.find((record) => record.type === "session");
					const at = Date.parse(String(head?.timestamp ?? ""));
					if (Number.isFinite(at) && at < since) continue;
				}

				const byId = new Map<string, Record<string, unknown>>();
				for (const record of records) {
					if (typeof record.id === "string") byId.set(record.id, record);
				}
				let leaf: string | undefined;
				for (const record of records) {
					if (record.type === "message" && typeof record.id === "string") leaf = record.id;
				}
				if (!leaf) continue;
				const chain: Record<string, unknown>[] = [];
				const seen = new Set<string>();
				let cursor: string | undefined = leaf;
				while (cursor && byId.has(cursor) && !seen.has(cursor)) {
					seen.add(cursor);
					chain.push(byId.get(cursor)!);
					cursor = byId.get(cursor)!.parentId as string | undefined;
				}
				chain.reverse();

				// Later read calls, keyed by path: a follow-up means the agent needed
				// more of the file than one read gave it.
				// The tool result message has no `input`; the path lives on the
				// assistant's toolCall, so map ids to paths as we walk forward.
				const pathByCallId = new Map<string, string>();
				const large: LargeRead[] = [];
				let touched = false;

				for (const record of chain) {
					if (record.type !== "message") continue;
					const message = record.message as Record<string, unknown> | undefined;
					if (typeof message !== "object" || message === null) continue;
					const content = message.content;
					if (!Array.isArray(content)) continue;

					if (message.role === "assistant") {
						for (const block of content as Record<string, unknown>[]) {
							if (block.type !== "toolCall" || block.name !== "read") continue;
							const args = block.arguments as Record<string, unknown> | undefined;
							const path = typeof args?.path === "string" ? args.path : undefined;
							if (!path) continue;
							if (typeof block.id === "string") pathByCallId.set(block.id, path);
							for (const read of large) {
								if (read.path !== path) continue;
								read.followUps += 1;
							}
						}
						continue;
					}

					if (message.role !== "toolResult" || message.toolName !== "read") continue;
					const bytes = byteLength(content);
					if (bytes <= 8192) continue;
					const path =
						typeof message.toolCallId === "string"
							? (pathByCallId.get(message.toolCallId) ?? "")
							: "";
					touched = true;
					large.push({ path, bytes, followUps: 0, followUpBytes: 0 });
				}

				if (!touched) continue;
				sessions += 1;
				let sessionHasFollowUp = false;
				for (const read of large) {
					if (read.followUps > 0) sessionHasFollowUp = true;
					reads.push(read);
				}
				if (sessionHasFollowUp) sessionsWithFollowUp += 1;
			}

			const total = reads.length;
			const withFollowUp = reads.filter((read) => read.followUps > 0);
			const sumBytes = reads.reduce((sum, read) => sum + read.bytes, 0);
			const sumFollowedBytes = withFollowUp.reduce((sum, read) => sum + read.bytes, 0);
			const pct = (value: number): string => `${(value * 100).toFixed(1)}%`;

			console.log(`window            : ${since > 0 ? `since ${process.argv[2]}` : "all history"} (${files.length} files)`);
			console.log(`sessions with >8KB reads : ${sessions}`);
			console.log(`large reads              : ${total}  (${sumBytes} bytes)`);
			console.log(
				`  followed by another read of the same path : ${withFollowUp.length} (${pct(withFollowUp.length / Math.max(1, total))} of reads, ${pct(sumFollowedBytes / Math.max(1, sumBytes))} of bytes)`,
			);
			console.log(
				`  sessions with any such follow-up          : ${sessionsWithFollowUp} (${pct(sessionsWithFollowUp / Math.max(1, sessions))})`,
			);
			const followUpTotal = withFollowUp.reduce((sum, read) => sum + read.followUps, 0);
			console.log(
				`  follow-up reads per affected large read   : ${(followUpTotal / Math.max(1, withFollowUp.length)).toFixed(2)}`,
			);
		}
	}
}

main();
