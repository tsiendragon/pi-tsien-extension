/**
 * Shared session-history scanner for the bash-digest scripts.
 *
 * Reads `~/.pi/agent/sessions/**\/*.jsonl` and yields the bash tool results an
 * agent actually received (i.e. after RTK filtering, as stored in the session).
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface BashResult {
	readonly text: string;
	readonly command?: string;
	readonly at: number;
}

export interface ScanOptions {
	readonly days: number;
	readonly root?: string;
}

export const DEFAULT_SESSIONS_ROOT =
	process.env.PI_SESSIONS_DIR ?? join(homedir(), ".pi/agent/sessions");

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

function extractBashResults(line: string, commands: Map<string, string>): BashResult[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return [];
	}
	if (typeof parsed !== "object" || parsed === null) return [];
	const record = parsed as Record<string, unknown>;
	if (record.type !== "message") return [];
	const message = record.message;
	if (typeof message !== "object" || message === null) return [];
	const m = message as Record<string, unknown>;

	// Assistant tool calls carry the command; tool results carry the output and
	// are linked to them by id, in a later line.
	if (m.role === "assistant" && Array.isArray(m.content)) {
		for (const block of m.content as { type?: unknown; id?: unknown; name?: unknown; arguments?: unknown }[]) {
			if (block.type !== "toolCall" || typeof block.id !== "string") continue;
			const args = block.arguments;
			if (typeof args !== "object" || args === null) continue;
			const command = (args as Record<string, unknown>).command;
			if (typeof command === "string") commands.set(block.id, command);
		}
		return [];
	}

	if (m.role !== "toolResult" || m.toolName !== "bash") return [];
	if (!Array.isArray(m.content)) return [];
	const blocks = m.content as { type?: unknown; text?: unknown }[];
	if (!blocks.every((block) => block.type === "text")) return [];
	const text = blocks.map((block) => (typeof block.text === "string" ? block.text : "")).join("\n");
	const at = typeof m.timestamp === "number" ? m.timestamp : 0;
	const toolCallId = typeof m.toolCallId === "string" ? m.toolCallId : undefined;
	return [{ text, at, command: toolCallId ? commands.get(toolCallId) : undefined }];
}

export interface ScanResult {
	readonly results: BashResult[];
	readonly sessions: number;
}

/** Collect every bash result from sessions touched within the window. */
export async function collectBashResults(options: ScanOptions): Promise<ScanResult> {
	const root = options.root ?? DEFAULT_SESSIONS_ROOT;
	const since = Date.now() - options.days * 24 * 3600 * 1000;
	const files = await findSessionFiles(root);
	const results: BashResult[] = [];
	let sessions = 0;

	for (const file of files) {
		let info;
		try {
			info = await stat(file);
		} catch {
			continue;
		}
		if (info.mtimeMs < since) continue;
		let content: string;
		try {
			content = await readFile(file, "utf8");
		} catch {
			continue;
		}
		let used = false;
		const commands = new Map<string, string>();
		for (const line of content.split("\n")) {
			if (line.trim() === "") continue;
			for (const result of extractBashResults(line, commands)) {
				if (result.at !== 0 && result.at < since) continue;
				results.push(result);
				used = true;
			}
		}
		if (used) sessions += 1;
	}

	return { results, sessions };
}

/**
 * Evenly spread `limit` samples across an ascending-by-size list, so the sample
 * covers the whole size range instead of only the biggest outputs.
 */
export function stratifiedSample<T>(items: readonly T[], limit: number): T[] {
	if (items.length <= limit) return [...items];
	const picked: T[] = [];
	for (let i = 0; i < limit; i += 1) {
		const index = Math.floor((i * (items.length - 1)) / (limit - 1));
		picked.push(items[index]!);
	}
	return picked;
}
