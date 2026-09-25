/**
 * ObservationPack core helpers.
 *
 * Pure/IO helpers for archiving large tool results by a stable observation id and
 * paging them back with `obs_recall`. Design: docs/efficiency-mechanisms-design.md
 */

import { createHash } from "node:crypto";
import { constants, readFileSync } from "node:fs";
import { appendFile, lstat, mkdir, open, readdir, rename, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Message shape (structural; avoids importing pi-agent-core directly)
// ---------------------------------------------------------------------------

export interface TextBlock {
	readonly type: "text";
	readonly text: string;
}

export interface ToolResultLike {
	readonly role: "toolResult";
	readonly toolCallId: string;
	readonly toolName: string;
	readonly isError: boolean;
	readonly content: readonly { readonly type: string }[];
}

export function isPureTextResult(message: unknown): message is ToolResultLike {
	if (typeof message !== "object" || message === null) return false;
	const candidate = message as Record<string, unknown>;
	if (candidate.role !== "toolResult" || candidate.isError === true) return false;
	const content = candidate.content;
	if (!Array.isArray(content) || content.length === 0) return false;
	return content.every(
		(block) =>
			typeof block === "object" &&
			block !== null &&
			(block as { type?: unknown }).type === "text",
	);
}

function textFromResult(message: ToolResultLike): string {
	return (message.content as readonly TextBlock[]).map((block) => block.text).join("\n");
}

// ---------------------------------------------------------------------------
// Observation identity, sizing, placeholder
// ---------------------------------------------------------------------------

/** Only tool results larger than this participate. */
export const DEFAULT_THRESHOLD_BYTES = 10 * 1024;
/** Provider requests that still carry the full payload before the placeholder takes over. */
export const DEFAULT_FULL_SENDS = 2;
/** Placeholder excerpt budget, split evenly between head and tail, whole lines only. */
export const DEFAULT_PLACEHOLDER_EXCERPT_BYTES = 1024;

const CHARS_PER_TOKEN = 4;
export const OBSERVATION_ID_PATTERN = /^obs_[a-f0-9]{24}$/;

/**
 * Receipts from an evidence-preserving reducer are already a reduction of a long
 * log; packing them again would replace verified evidence with an excerpt.
 */
const EVIDENCE_REDUCER_RECEIPT_PREFIX = "sol_pi_evidence_receipt_v1";

const READ_OBJECT_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW;
const CREATE_OBJECT_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;

export interface Observation {
	readonly id: string;
	readonly contentHash: string;
	readonly filePath: string;
	readonly toolName: string;
	readonly text: string;
	readonly bytes: number;
	readonly lines: number;
	readonly tokens: number;
}

export function hash(value: string | Buffer): string {
	return createHash("sha256").update(value).digest("hex");
}

export function estimateTokens(text: string): number {
	return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function countLines(text: string): number {
	if (text.length === 0) return 0;
	let lines = text.endsWith("\n") ? 0 : 1;
	for (const character of text) {
		if (character === "\n") lines += 1;
	}
	return lines;
}

function countBufferLines(buffer: Buffer): number {
	if (buffer.length === 0) return 0;
	let lines = buffer[buffer.length - 1] === 0x0a ? 0 : 1;
	for (const byte of buffer) {
		if (byte === 0x0a) lines += 1;
	}
	return lines;
}

function containsReducerReceipt(text: string): boolean {
	return text.split("\n").some((line) => line === EVIDENCE_REDUCER_RECEIPT_PREFIX);
}

export function observationPath(sessionRoot: string, id: string): string {
	return join(sessionRoot, "objects", `${id}.txt`);
}

export function isObservationId(id: string): boolean {
	return OBSERVATION_ID_PATTERN.test(id);
}

export interface CreateObservationOptions {
	readonly thresholdBytes?: number;
	readonly sessionRoot: string;
}

/**
 * Derive a stable, call-scoped observation id and its archive path.
 * Returns undefined when the result is too small or already a reducer receipt.
 */
export function createObservation(
	message: ToolResultLike,
	options: CreateObservationOptions,
): Observation | undefined {
	const text = textFromResult(message);
	if (containsReducerReceipt(text)) return undefined;
	const bytes = Buffer.byteLength(text, "utf8");
	if (bytes <= (options.thresholdBytes ?? DEFAULT_THRESHOLD_BYTES)) return undefined;
	const contentHash = hash(text);
	const id = `obs_${hash(`${message.toolName}\0${message.toolCallId}\0${contentHash}`).slice(0, 24)}`;
	return {
		id,
		contentHash,
		filePath: observationPath(options.sessionRoot, id),
		toolName: message.toolName,
		text,
		bytes,
		lines: countLines(text),
		tokens: estimateTokens(text),
	};
}

/**
 * Persist the payload at its observation path, refusing symlinks and verifying an
 * existing object byte for byte before reusing it.
 */
export async function ensureStored(observation: Observation): Promise<void> {
	const directoryPath = dirname(observation.filePath);
	await mkdir(directoryPath, { recursive: true, mode: 0o700 });
	const directoryStats = await lstat(directoryPath);
	if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) {
		throw new Error(`Observation directory is not a regular directory for ${observation.id}`);
	}
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		handle = await open(observation.filePath, CREATE_OBJECT_FLAGS, 0o600);
		await handle.writeFile(observation.text, { encoding: "utf8" });
	} catch (error) {
		if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
		const existingHandle = await open(observation.filePath, READ_OBJECT_FLAGS);
		try {
			const existing = await existingHandle.stat();
			if (!existing.isFile()) {
				throw new Error(`Observation is not a regular file for ${observation.id}`);
			}
			if (existing.size !== observation.bytes) {
				throw new Error(`Observation size mismatch for ${observation.id}`);
			}
			const existingContent = await existingHandle.readFile();
			if (hash(existingContent) !== observation.contentHash) {
				throw new Error(`Observation hash mismatch for ${observation.id}`);
			}
		} finally {
			await existingHandle.close();
		}
	} finally {
		await handle?.close();
	}
}

function completeLineExcerpt(text: string, budgetBytes: number, fromEnd: boolean): string {
	const lines = text.split(/(?<=\n)/);
	const selected: string[] = [];
	let selectedBytes = 0;
	let index = fromEnd ? lines.length - 1 : 0;
	while (index >= 0 && index < lines.length) {
		const line = lines[index];
		if (line === undefined) break;
		const lineBytes = Buffer.byteLength(line, "utf8");
		if (selectedBytes + lineBytes > budgetBytes) break;
		if (fromEnd) selected.unshift(line);
		else selected.push(line);
		selectedBytes += lineBytes;
		index += fromEnd ? -1 : 1;
	}
	return selected.join("");
}

export function placeholderFor(
	observation: Observation,
	excerptBytes: number = DEFAULT_PLACEHOLDER_EXCERPT_BYTES,
	fullSends: number = DEFAULT_FULL_SENDS,
): string {
	const headBudget = Math.floor(excerptBytes / 2);
	const tailBudget = excerptBytes - headBudget;
	const head = completeLineExcerpt(observation.text, headBudget, false);
	const tail = completeLineExcerpt(observation.text, tailBudget, true);
	return [
		`[large tool result replaced after its first ${fullSends} provider requests]`,
		`id: ${observation.id}`,
		`tool: ${observation.toolName}`,
		`archived_bytes: ${observation.bytes}`,
		`archived_lines: ${observation.lines}`,
		`estimated_tokens: ${observation.tokens}`,
		`retrieve: call obs_recall with {"id":"${observation.id}","offset":0}; continue with returned next_offset`,
		`[first complete lines, up to ${headBudget} bytes]`,
		head,
		`[middle omitted; last complete lines, up to ${tailBudget} bytes]`,
		tail,
		`[${observation.bytes} archived bytes omitted]`,
	].join("\n");
}

// ---------------------------------------------------------------------------
// Paged recall
// ---------------------------------------------------------------------------

export interface RecallLimits {
	readonly maxBytes: number;
	readonly maxLines: number;
}

/**
 * Room the `obs_recall` tool must leave for its own header.
 *
 * The tool prefixes two lines and the emitted text is then measured with
 * `text.split("\n").length`, which counts one extra element for the trailing
 * newline. Reserving only two lines made a full-size chunk fail that check —
 * i.e. recall failed for exactly the dense, many-short-line observations
 * (bash listings, large `read` results) it exists to serve.
 */
export const RECALL_HEADER_LINES = 2;
export const RECALL_HEADER_BYTES = 512;

/** Chunk limits that a header-carrying recall response is guaranteed to satisfy. */
export function recallChunkLimits(maxBytes: number, maxLines: number): RecallLimits {
	return {
		maxBytes: Math.max(1, maxBytes - RECALL_HEADER_BYTES),
		maxLines: Math.max(1, maxLines - RECALL_HEADER_LINES - 2),
	};
}

export interface RecallChunk {
	readonly text: string;
	readonly bytes: number;
	readonly lines: number;
	/** Byte offset actually used (aligned forward to a UTF-8 character boundary). */
	readonly actualOffset: number;
	readonly nextOffset: number;
	readonly eof: boolean;
}

function trimUtf8End(buffer: Buffer, limit: number): number {
	let end = limit;
	while (end > 0 && end < buffer.length && ((buffer[end] ?? 0) & 0xc0) === 0x80) end -= 1;
	return end;
}

export async function readRecallChunk(
	path: string,
	offset: number,
	limits: RecallLimits,
): Promise<RecallChunk> {
	const handle = await open(path, READ_OBJECT_FLAGS);
	try {
		const fileStats = await handle.stat();
		if (!fileStats.isFile()) throw new Error("Stored observation is not a regular file");
		if (offset < 0 || offset > fileStats.size) {
			throw new Error(`Offset ${offset} exceeds observation size ${fileStats.size}`);
		}
		const available = Math.max(0, fileStats.size - offset);
		const buffer = Buffer.alloc(Math.min(available, limits.maxBytes + 8));
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
		const raw = buffer.subarray(0, bytesRead);

		// Align the start forward to the next UTF-8 character boundary.
		let start = 0;
		while (start < raw.length && ((raw[start] ?? 0) & 0xc0) === 0x80) start += 1;

		let end = Math.min(raw.length, start + limits.maxBytes);
		let newlineCount = 0;
		for (let index = start; index < end; index += 1) {
			if (raw[index] !== 0x0a) continue;
			newlineCount += 1;
			if (newlineCount === limits.maxLines) {
				end = index + 1;
				break;
			}
		}
		end = trimUtf8End(raw, end);
		if (end < start) end = start;

		const chunk = raw.subarray(start, end);
		const actualOffset = offset + start;
		const nextOffset = actualOffset + chunk.length;
		return {
			text: chunk.toString("utf8"),
			bytes: chunk.length,
			lines: countBufferLines(chunk),
			actualOffset,
			nextOffset,
			eof: nextOffset >= fileStats.size,
		};
	} finally {
		await handle.close();
	}
}

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

export async function appendLedger(
	ledgerPath: string,
	entry: Record<string, unknown>,
): Promise<void> {
	await mkdir(dirname(ledgerPath), { recursive: true, mode: 0o700 });
	await appendFile(ledgerPath, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, {
		mode: 0o600,
	});
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/**
 * Portable data root: `<PI_CODING_AGENT_DIR | ~/.pi/agent>/archiv`.
 * Override with the `PI_OBSERVATION_DIR` env var or `archiveDir` in the config file.
 */
export const DEFAULT_ARCHIVE_DIR = join(agentDir(), "archiv");
export const CONFIG_FILE_NAME = "observation-pack.json";

export interface ObservationPackConfig {
	enabled: boolean;
	archiveDir: string;
	thresholdBytes: number;
	fullSends: number;
	placeholderExcerptBytes: number;
	recallMaxBytes: number;
	recallMaxLines: number;
	cleanupEnabled: boolean;
	retentionDays: number;
}

export const DEFAULT_OBSERVATION_PACK_CONFIG: ObservationPackConfig = {
	enabled: false,
	archiveDir: DEFAULT_ARCHIVE_DIR,
	thresholdBytes: DEFAULT_THRESHOLD_BYTES,
	fullSends: DEFAULT_FULL_SENDS,
	placeholderExcerptBytes: DEFAULT_PLACEHOLDER_EXCERPT_BYTES,
	recallMaxBytes: 16 * 1024,
	recallMaxLines: 400,
	cleanupEnabled: false,
	retentionDays: 30,
};

export function agentDir(env: NodeJS.ProcessEnv = process.env): string {
	return env.PI_CODING_AGENT_DIR ? resolve(env.PI_CODING_AGENT_DIR) : join(homedir(), ".pi", "agent");
}

function asBoolean(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function asPositiveNumber(value: unknown, fallback: number, integer = false): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback;
	return integer ? Math.floor(value) : value;
}

export function loadObservationPackConfig(
	env: NodeJS.ProcessEnv = process.env,
): ObservationPackConfig {
	let section: Record<string, unknown> = {};
	try {
		const parsed: unknown = JSON.parse(readFileSync(join(agentDir(env), CONFIG_FILE_NAME), "utf8"));
		if (typeof parsed === "object" && parsed !== null && "observationPack" in parsed) {
			const value = (parsed as { observationPack?: unknown }).observationPack;
			if (typeof value === "object" && value !== null) section = value as Record<string, unknown>;
		}
	} catch {
		// Missing or malformed config: keep defaults.
	}

	const config: ObservationPackConfig = {
		enabled: asBoolean(section.enabled, DEFAULT_OBSERVATION_PACK_CONFIG.enabled),
		archiveDir:
			typeof section.archiveDir === "string" && section.archiveDir.trim() !== ""
				? section.archiveDir
				: DEFAULT_OBSERVATION_PACK_CONFIG.archiveDir,
		thresholdBytes: asPositiveNumber(section.thresholdBytes, DEFAULT_OBSERVATION_PACK_CONFIG.thresholdBytes, true),
		fullSends: asPositiveNumber(section.fullSends, DEFAULT_OBSERVATION_PACK_CONFIG.fullSends, true),
		placeholderExcerptBytes: asPositiveNumber(
			section.placeholderExcerptBytes,
			DEFAULT_OBSERVATION_PACK_CONFIG.placeholderExcerptBytes,
			true,
		),
		recallMaxBytes: asPositiveNumber(section.recallMaxBytes, DEFAULT_OBSERVATION_PACK_CONFIG.recallMaxBytes, true),
		recallMaxLines: asPositiveNumber(section.recallMaxLines, DEFAULT_OBSERVATION_PACK_CONFIG.recallMaxLines, true),
		cleanupEnabled: asBoolean(section.cleanupEnabled, DEFAULT_OBSERVATION_PACK_CONFIG.cleanupEnabled),
		retentionDays: asPositiveNumber(section.retentionDays, DEFAULT_OBSERVATION_PACK_CONFIG.retentionDays, true),
	};

	const envArchiveDir = env.PI_OBSERVATION_DIR;
	if (typeof envArchiveDir === "string" && envArchiveDir.trim() !== "") {
		config.archiveDir = envArchiveDir;
	}
	return config;
}

// ---------------------------------------------------------------------------
// Session root + manual prune
// ---------------------------------------------------------------------------

export const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Resolve `<archiveRoot>/<sessionId>/observation-pack`, rejecting unsafe session ids. */
export function resolveSessionRoot(archiveRoot: string, sessionId: string): string | undefined {
	if (!SESSION_ID_PATTERN.test(sessionId)) return undefined;
	const root = resolve(archiveRoot);
	const target = resolve(root, sessionId, "observation-pack");
	const rel = relative(root, target);
	if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return undefined;
	return target;
}

export interface PruneCandidate {
	readonly sessionId: string;
	/** Session directory to move to trash. */
	readonly path: string;
	readonly mtimeMs: number;
}

export interface PruneOptions {
	readonly excludeSessionId?: string;
	readonly retentionDays: number;
	readonly now?: number;
}

export async function selectPruneCandidates(
	archiveRoot: string,
	options: PruneOptions,
): Promise<PruneCandidate[]> {
	const root = resolve(archiveRoot);
	const entries = await readdir(root, { withFileTypes: true }).catch(() => [] as never[]);
	const cutoff = (options.now ?? Date.now()) - options.retentionDays * 24 * 60 * 60 * 1000;
	const candidates: PruneCandidate[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
		if (entry.name === options.excludeSessionId) continue;
		const sessionPath = join(root, entry.name);
		const packPath = join(sessionPath, "observation-pack");
		try {
			const stats = await stat(packPath);
			if (stats.mtimeMs < cutoff) {
				candidates.push({ sessionId: entry.name, path: sessionPath, mtimeMs: stats.mtimeMs });
			}
		} catch {
			// No pack directory: not an ObservationPack session.
		}
	}
	return candidates;
}

export async function moveToTrash(archiveRoot: string, candidate: PruneCandidate): Promise<string> {
	const trashDir = join(resolve(archiveRoot), ".trash");
	await mkdir(trashDir, { recursive: true, mode: 0o700 });
	const destination = join(trashDir, `${candidate.sessionId}-${Date.now()}`);
	await rename(candidate.path, destination);
	return destination;
}