/**
 * Capability call ledger.
 *
 * One JSONL line per run. Kept outside the repository so running a capability
 * never dirties a checkout. Feeds the failure-driven loop: a bad entry becomes a
 * regression case, not a silent regression.
 */

import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface LedgerEntry {
	readonly ts: string;
	readonly capability: string;
	readonly impl: "code" | "text";
	readonly ok: boolean;
	readonly durationMs: number;
	readonly llmCalls: number;
	readonly cacheHits: number;
	readonly tokens: { readonly input: number; readonly output: number };
	readonly costUsd: number;
	readonly error?: string;
	readonly sessionId?: string;
}

export function ledgerDir(): string {
	const agentDir = process.env.PI_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	return join(agentDir, "capability", "ledger");
}

export async function appendLedger(entry: LedgerEntry): Promise<void> {
	const dir = ledgerDir();
	await mkdir(dir, { recursive: true });
	const day = entry.ts.slice(0, 10) || "unknown";
	await appendFile(join(dir, `${day}.jsonl`), `${JSON.stringify(entry)}\n`, "utf8");
}