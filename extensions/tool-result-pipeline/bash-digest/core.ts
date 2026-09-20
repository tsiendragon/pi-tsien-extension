/**
 * Pure helpers for the bash digest extension.
 *
 * A large bash result is replaced, before it enters the context, by a short
 * digest produced by a cheap non-thinking model. The raw text is archived with
 * the observation-pack layout so `obs_recall` can still page it back: the digest
 * is an index, never the only copy.
 *
 * Design and measured numbers: docs/session-context-token-plan.md
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { agentDir, estimateTokens } from "../../observation-pack/core.ts";

export { estimateTokens };

export const CONFIG_FILE_NAME = "bash-digest.json";

export const DEFAULT_THRESHOLD_BYTES = 1200;
export const DEFAULT_TARGET_TOKENS = 40;
export const DEFAULT_MAX_TOKENS = 128;
export const DEFAULT_TIMEOUT_MS = 6000;
export const DEFAULT_MAX_CONCURRENT = 2;
export const DEFAULT_DIGEST_MODEL = "dashscope/qwen3.8-flash";
export const DEFAULT_CODE_DUMP_RATIO = 0.3;
/**
 * Commands whose output is a list of items the caller asked for. A digest can
 * only shrink such a list by dropping rows, and a dropped row is a lost fact, so
 * these are left untouched.
 */
export const DEFAULT_EXCLUDE_PATTERNS: readonly string[] = [
	"^(ls|find|tree|du|df|grep|rg|ag|ack|wc|head|tail|cat|sed|awk|cut|sort|uniq|jq)\\b",
	"^git\\s+(log|show|status|diff|shortlog|blame)\\b",
	"^pip\\s+(list|show)\\b",
];
/** Reject a digest that is not at least this much smaller than the original. */
export const DEFAULT_MAX_DIGEST_RATIO = 0.6;
/** Reply the model sends when the output cannot be compressed without losing facts. */
export const KEEP_SIGNAL = "KEEP";


export interface BashDigestConfig {
	enabled: boolean;
	thresholdBytes: number;
	targetTokens: number;
	maxTokens: number;
	timeoutMs: number;
	maxConcurrent: number;
	digestModel: string;
	codeDumpRatio: number;
	maxDigestRatio: number;
	excludePatterns: string[];
}

export const DEFAULT_BASH_DIGEST_CONFIG: BashDigestConfig = {
	enabled: false,
	thresholdBytes: DEFAULT_THRESHOLD_BYTES,
	targetTokens: DEFAULT_TARGET_TOKENS,
	maxTokens: DEFAULT_MAX_TOKENS,
	timeoutMs: DEFAULT_TIMEOUT_MS,
	maxConcurrent: DEFAULT_MAX_CONCURRENT,
	digestModel: DEFAULT_DIGEST_MODEL,
	codeDumpRatio: DEFAULT_CODE_DUMP_RATIO,
	maxDigestRatio: DEFAULT_MAX_DIGEST_RATIO,
	excludePatterns: [...DEFAULT_EXCLUDE_PATTERNS],
};

/** CSI/OSC/other ANSI escape sequences plus carriage-return overwrites. */
const ANSI_PATTERN =
	// eslint-disable-next-line no-control-regex
	/[\u001b\u009b][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;
const CR_OVERWRITE_SPLIT = /\r(?!\n)/;

/**
 * Keep only what a terminal would actually show for each line: text after the
 * last carriage return. A trailing CR from a CRLF ending is dropped first.
 */
function collapseCarriageReturns(text: string): string {
	return text
		.split("\n")
		.map((line) => {
			const clean = line.endsWith("\r") ? line.slice(0, -1) : line;
			if (!CR_OVERWRITE_SPLIT.test(clean)) return clean;
			const parts = clean.split("\r");
			return parts[parts.length - 1] ?? "";
		})
		.join("\n");
}

export function stripAnsi(text: string): string {
	return collapseCarriageReturns(text.replace(ANSI_PATTERN, ""));
}

/** Normalize noise that carries no information before measuring or digesting. */
export function preclean(text: string): string {
	return stripAnsi(text)
		.split("\n")
		.map((line) => line.replace(/[ \t]+$/, ""))
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

const CODE_LINE_PATTERNS: readonly RegExp[] = [
	/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\b/,
	/^\s*(?:export\s+)?(?:abstract\s+)?class\s+[A-Za-z_$]/,
	/^\s*(?:export\s+)?(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*[:=]/,
	/^\s*(?:export\s+)?(?:interface|type|enum|namespace)\s+[A-Za-z_$]/,
	/^\s*(?:import|from)\s/,
	/^\s*(?:def|class)\s+[A-Za-z_]/,
	/^\s*(?:if|elif|else|for|while|switch|case|return|try|catch|finally|except|with)\b/,
	/^\s*[}{()[\],;]\s*$/,
	/^\s*(?:\/\/|\/\*|\*)/,
	/^\s*@[A-Za-z_]\w*/,
	/=>\s*\{?\s*$/,
];

/**
 * Share of non-empty lines that look like source code.
 *
 * Measured on three days of real bash output: source-style output is only ~16%
 * of the tokens above the digest threshold, so rejecting it costs little and
 * avoids replacing code the agent will have to re-read with a file list.
 */
export function codeLineRatio(text: string): number {
	const lines = text.split("\n").filter((line) => line.trim() !== "");
	if (lines.length === 0) return 0;
	let code = 0;
	for (const line of lines) {
		if (CODE_LINE_PATTERNS.some((pattern) => pattern.test(line))) code += 1;
	}
	return code / lines.length;
}

export function looksLikeCodeDump(text: string, ratio = DEFAULT_CODE_DUMP_RATIO): boolean {
	return codeLineRatio(text) > ratio;
}


const COMMAND_PREFIXES = ["sudo", "time", "nohup", "command", "env", "xargs", "then", "do"];

function stripCommandPrefixes(segment: string): string {
	const tokens = segment.trim().split(/\s+/);
	let index = 0;
	while (index < tokens.length) {
		const token = tokens[index]!;
		if (/^[A-Za-z_]\w*=/.test(token)) {
			index += 1;
			continue;
		}
		if (COMMAND_PREFIXES.includes(token)) {
			index += 1;
			// Wrapper commands can carry a flag and its value, e.g. `sudo -u root`.
			if (index < tokens.length && tokens[index]!.startsWith("-")) {
				index += 1;
				if (index < tokens.length && !tokens[index]!.startsWith("-")) index += 1;
			}
			continue;
		}
		break;
	}
	return tokens.slice(index).join(" ");
}

/**
 * The commands whose stdout ends up in the captured output.
 *
 * A compound command like `cd x && ls | head` is split per chain element, and
 * for each pipeline only the last stage is kept, because earlier stages feed it
 * rather than print. This keeps command-based exclusions precise: a `grep` used
 * as a filter should not exclude the output of the command it filters.
 */
export function outputProducerCommands(command: string): string[] {
	return command
		.split(/\s*(?:&&|\|\||;|\n)\s*/)
		.map((chain) => chain.split(/\s*\|\s*/).pop() ?? "")
		.map(stripCommandPrefixes)
		.filter((segment) => segment !== "");
}

/** True when any command that produced the output matches an exclude pattern. */
export function matchesExcludePattern(
	command: string,
	patterns: readonly string[],
): boolean {
	const producers = outputProducerCommands(command);
	if (producers.length === 0) return false;
	return patterns.some((pattern) => {
		let regex: RegExp;
		try {
			regex = new RegExp(pattern);
		} catch {
			return false;
		}
		return producers.some((segment) => regex.test(segment));
	});
}

export interface DigestDecision {
	digest: boolean;
	/** Machine-readable reason, for tests and logging. */
	reason:
		| "digest"
		| "empty"
		| "is-error"
		| "below-threshold"
		| "code-dump"
		| "excluded";
	/** Pre-cleaned text (the text that would be digested or kept as-is). */
	text: string;
	bytes: number;
	tokens: number;
}

export interface DigestDecisionInput {
	readonly text: string;
	readonly isError: boolean;
	readonly config: BashDigestConfig;
	readonly command?: string;
}

export function decideDigest(input: DigestDecisionInput): DigestDecision {
	const { config } = input;
	const text = preclean(input.text);
	const bytes = Buffer.byteLength(text, "utf8");
	const tokens = estimateTokens(text);
	const base = { text, bytes, tokens };

	if (input.isError) return { digest: false, reason: "is-error", ...base };
	if (text.trim() === "") return { digest: false, reason: "empty", ...base };
	if (input.command !== undefined) {
		if (matchesExcludePattern(input.command, config.excludePatterns)) {
			return { digest: false, reason: "excluded", ...base };
		}
	}
	if (bytes <= config.thresholdBytes) return { digest: false, reason: "below-threshold", ...base };
	if (looksLikeCodeDump(text, config.codeDumpRatio)) {
		return { digest: false, reason: "code-dump", ...base };
	}
	return { digest: true, reason: "digest", ...base };
}

export function buildDigestPrompt(input: {
	readonly output: string;
	readonly command?: string;
	readonly targetTokens: number;
	readonly maxDigestRatio?: number;
}): string {
	const command = input.command?.trim();
	return [
		"Shell output compressor for a coding agent. Output a MINIMAL digest " +
			`(target ${input.targetTokens} tokens).`,
		"Most shell output is verbose: keep the facts, drop the verbosity.",
		"",
		"ALWAYS KEEP: errors, warnings, file paths, line numbers, numbers, counts, versions, ids, hashes, and the names of files, tables, functions and columns.",
		"NEVER LOSE A ROW: when the output is mostly a list of ids, hashes, names or counts, keep every entry in the original order and shorten each entry instead of dropping entries. Never replace a list with a subset or with 'and more':",
		"- file/directory listings: keep every name, mark directories with a trailing '/'; drop permissions, owner, group and timestamps.",
		"- commit/log/search rows: keep every id, hash and count; drop subjects, messages and surrounding prose.",
		"ALWAYS DROP: banners, separators, progress, blank lines, repeated prefixes, boilerplate, and prose that just restates the command.",
		"`== label ==` sections: keep the label plus only the decisive lines.",
		"If the output is just a success confirmation, reply with one short line.",
		"Never invent. Never explain. No markdown fences. Plain text only.",
		"",
		command !== undefined && command !== "" ? `<cmd>${command.slice(0, 1200)}</cmd>` : "",
		`<out>${input.output}</out>`,
	]
		.filter((part) => part !== "")
		.join("\n");
}

/** True when the model declined to compress (defensive; the prompt does not ask for it). */
export function isKeepSignal(digest: string): boolean {
	return (
		digest
			.replace(/[`*"']/g, "")
			.trim()
			.replace(/[.\s]+$/g, "")
			.toUpperCase() === KEEP_SIGNAL
	);
}

/**
 * Output budget for the digest model.
 *
 * A row-preserving digest of a long id/hash list needs more than a fixed 128
 * tokens, and truncating it would silently drop rows. The budget therefore
 * scales with the input, floored at the configured value and capped so a huge
 * output cannot turn into a huge summary.
 */
export function resolveMaxTokens(originalTokens: number, config: BashDigestConfig): number {
	return Math.max(config.maxTokens, Math.min(Math.round(originalTokens * config.maxDigestRatio), 256));
}

export interface RenderDigestInput {
	readonly digest: string;
	readonly originalTokens: number;
	readonly digestTokens: number;
	readonly observationId?: string;
}

export function renderDigest(input: RenderDigestInput): string {
	const header =
		input.observationId !== undefined
			? `[digest ${input.originalTokens} tok -> ${input.digestTokens} tok | raw: ${input.observationId}]`
			: `[digest ${input.originalTokens} tok -> ${input.digestTokens} tok | raw not archived]`;
	return `${header}\n${input.digest.trim()}`;
}

/** Extract the digest text from a model response, tolerating stray fences. */
export function normalizeDigest(raw: string): string {
	return raw
		.trim()
		.replace(/^```[a-zA-Z]*\n?/, "")
		.replace(/\n?```$/, "")
		.trim();
}

function asBoolean(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function asPositiveInt(value: unknown, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback;
	return Math.floor(value);
}

function asRatio(value: unknown, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) return fallback;
	return value;
}

export function loadBashDigestConfig(env: NodeJS.ProcessEnv = process.env): BashDigestConfig {
	let section: Record<string, unknown> = {};
	try {
		const parsed: unknown = JSON.parse(
			readFileSync(join(agentDir(env), CONFIG_FILE_NAME), "utf8"),
		);
		if (typeof parsed === "object" && parsed !== null) {
			const value =
				"bashDigest" in parsed ? (parsed as { bashDigest?: unknown }).bashDigest : parsed;
			if (typeof value === "object" && value !== null) section = value as Record<string, unknown>;
		}
	} catch {
		// Missing or malformed config falls back to defaults (disabled).
	}

	const model = section.digestModel;
	return {
		enabled: asBoolean(section.enabled, DEFAULT_BASH_DIGEST_CONFIG.enabled),
		thresholdBytes: asPositiveInt(
			section.thresholdBytes,
			DEFAULT_BASH_DIGEST_CONFIG.thresholdBytes,
		),
		targetTokens: asPositiveInt(section.targetTokens, DEFAULT_BASH_DIGEST_CONFIG.targetTokens),
		maxTokens: asPositiveInt(section.maxTokens, DEFAULT_BASH_DIGEST_CONFIG.maxTokens),
		timeoutMs: asPositiveInt(section.timeoutMs, DEFAULT_BASH_DIGEST_CONFIG.timeoutMs),
		maxConcurrent: asPositiveInt(section.maxConcurrent, DEFAULT_BASH_DIGEST_CONFIG.maxConcurrent),
		digestModel:
			typeof model === "string" && model.trim() !== ""
				? model
				: DEFAULT_BASH_DIGEST_CONFIG.digestModel,
		codeDumpRatio: asRatio(section.codeDumpRatio, DEFAULT_BASH_DIGEST_CONFIG.codeDumpRatio),
		maxDigestRatio: asRatio(section.maxDigestRatio, DEFAULT_BASH_DIGEST_CONFIG.maxDigestRatio),
		excludePatterns: Array.isArray(section.excludePatterns)
			? section.excludePatterns.filter((entry): entry is string => typeof entry === "string")
			: [...DEFAULT_EXCLUDE_PATTERNS],
	};
}

/** Split `provider/model` into parts. Returns undefined when malformed. */
export function parseModelKey(key: string): { provider: string; modelId: string } | undefined {
	const index = key.indexOf("/");
	if (index <= 0 || index === key.length - 1) return undefined;
	return { provider: key.slice(0, index), modelId: key.slice(index + 1) };
}
