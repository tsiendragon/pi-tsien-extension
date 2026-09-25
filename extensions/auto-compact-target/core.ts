/**
 * Pure helpers for the auto-compact target extension.
 *
 * The extension compacts proactively once the context reaches an *absolute*
 * token target, so the same policy applies to every model instead of a fixed
 * percentage of a 1M window. Small windows converge proportionally:
 *
 *   target = min(targetTokens, floor(windowRatio * contextWindow))
 *
 * 1,048,576-token models hit 270K; a 128K-window model hits 96K.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Absolute context target for large-window models. */
export const DEFAULT_TARGET_TOKENS = 270_000;
/** Upper bound for models whose window cannot hold the absolute target. */
export const DEFAULT_WINDOW_RATIO = 0.75;
export const CONFIG_FILE_NAME = "auto-compact-target.json";

export interface ModelTargetOverride {
	targetTokens?: number;
}

export interface AutoCompactTargetConfig {
	enabled: boolean;
	targetTokens: number;
	windowRatio: number;
	modelOverrides: Record<string, ModelTargetOverride>;
}

export const DEFAULT_AUTO_COMPACT_TARGET_CONFIG: AutoCompactTargetConfig = {
	enabled: true,
	targetTokens: DEFAULT_TARGET_TOKENS,
	windowRatio: DEFAULT_WINDOW_RATIO,
	modelOverrides: {},
};

export function agentDir(env: NodeJS.ProcessEnv = process.env): string {
	return env.PI_CODING_AGENT_DIR ? resolve(env.PI_CODING_AGENT_DIR) : join(homedir(), ".pi", "agent");
}

export interface ResolveTargetOptions {
	targetTokens?: number;
	windowRatio?: number;
	/** Per-model override; wins over `targetTokens` but is still window-clamped. */
	overrideTargetTokens?: number;
}

/**
 * Resolve the context-token count that should trigger compaction.
 *
 * Returns a positive integer. Unknown/zero windows fall back to the absolute
 * target so a missing model window never disables compaction entirely.
 */
export function resolveTargetTokens(
	contextWindow: number | undefined | null,
	options: ResolveTargetOptions = {},
): number {
	const target = Math.floor(
		options.overrideTargetTokens ?? options.targetTokens ?? DEFAULT_TARGET_TOKENS,
	);
	const absolute = Number.isFinite(target) && target > 0 ? target : DEFAULT_TARGET_TOKENS;
	if (typeof contextWindow !== "number" || !Number.isFinite(contextWindow) || contextWindow <= 0) {
		return absolute;
	}
	const ratio = options.windowRatio ?? DEFAULT_WINDOW_RATIO;
	const cap = Math.floor(ratio * contextWindow);
	if (!Number.isFinite(cap) || cap <= 0) return absolute;
	return Math.max(1, Math.min(absolute, cap));
}

/**
 * One policy that can trigger compaction, with the token count at which it fires.
 *
 * `auto-compact-target` = this extension compacts at the absolute target;
 * `pi-reserve-tokens` = pi core's own guard
 * (`shouldCompact(tokens, window, { reserveTokens })`), which still runs as the
 * last-resort trigger for long autonomous runs that never settle.
 */
export interface CompactionTriggerCandidate {
	readonly source: "auto-compact-target" | "pi-reserve-tokens";
	readonly tokens: number;
}

/** pi core compaction policy (`SettingsManager.getCompactionSettings(model)`). */
export interface PiCompactionPolicy {
	readonly enabled: boolean;
	readonly reserveTokens: number;
}

export interface ResolveCompactionTriggerOptions {
	/** Omitted/`null`/non-finite = window unknown; pi's candidate is then unknowable. */
	readonly contextWindow?: number | undefined | null;
	/** Omitted = the model key carries no `modelOverrides` entry. */
	readonly model?: { readonly provider: string; readonly id: string } | undefined;
	/** Undefined = pi settings unreadable, treat as "no pi policy". */
	readonly piPolicy?: PiCompactionPolicy | undefined;
	/** Undefined = use the shared process-wide policy snapshot ({@link autoCompactTargetConfig}). */
	readonly config?: AutoCompactTargetConfig | undefined;
}

export interface CompactionTrigger {
	readonly enabled: boolean;
	/** Earliest token count at which compaction fires; `0` when disabled. */
	readonly triggerTokens: number;
	/** Every enabled candidate, so a UI can explain which policy binds. */
	readonly candidates: readonly CompactionTriggerCandidate[];
}

/**
 * Where compaction actually fires first.
 *
 * The single answer to "when does this session compact?", shared by the actor
 * (`auto-compact-target`, which calls `ctx.compact()`) and by every display that
 * draws that trigger (the TUI status bar, the dashboard's status line). Two
 * policies can both be live, and pi's guard can be the earlier one on small
 * windows, so the effective trigger is the earliest enabled candidate — not
 * whichever policy happens to be asked first.
 */
export function resolveCompactionTrigger(
	options: ResolveCompactionTriggerOptions,
): CompactionTrigger {
	const candidates: CompactionTriggerCandidate[] = [];
	// Default to the shared snapshot rather than "no policy": a caller that forgets
	// it would otherwise silently drop the extension's trigger and report a
	// compaction point the actor never uses — the very divergence this fixes.
	const config = options.config ?? autoCompactTargetConfig();
	if (config?.enabled) {
		const keys = options.model ? [`${options.model.provider}/${options.model.id}`] : [];
		const override = keys
			.map((key) => config.modelOverrides[key]?.targetTokens)
			.find((value) => value !== undefined);
		candidates.push({
			source: "auto-compact-target",
			tokens: resolveTargetTokens(options.contextWindow, {
				targetTokens: config.targetTokens,
				windowRatio: config.windowRatio,
				overrideTargetTokens: override,
			}),
		});
	}
	const policy = options.piPolicy;
	const window = options.contextWindow;
	if (policy?.enabled && typeof window === "number" && Number.isFinite(window) && window > 0) {
		// pi compacts when `contextTokens > contextWindow - reserveTokens`.
		candidates.push({
			source: "pi-reserve-tokens",
			tokens: Math.max(0, Math.floor(window - policy.reserveTokens)),
		});
	}
	if (candidates.length === 0) return { enabled: false, triggerTokens: 0, candidates: [] };
	return {
		enabled: true,
		triggerTokens: candidates.reduce(
			(earliest, candidate) => Math.min(earliest, candidate.tokens),
			Number.POSITIVE_INFINITY,
		),
		candidates,
	};
}

/**
 * Process-wide policy snapshot.
 *
 * The actor and every display must read the SAME policy, so the config file is
 * loaded once per process instead of once per reader (a reader that loaded its
 * own copy could draw a trigger the actor does not use).
 */
export function autoCompactTargetConfig(): AutoCompactTargetConfig {
	return sharedConfig ??= loadAutoCompactTargetConfig();
}

let sharedConfig: AutoCompactTargetConfig | undefined;

/** Whether `tokens` has reached `target`. */
export function shouldCompact(tokens: number | null | undefined, target: number): boolean {
	if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens <= 0) return false;
	return tokens >= target;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function asPositiveNumber(value: unknown, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback;
	return Math.floor(value);
}

function asOverrides(value: unknown): Record<string, ModelTargetOverride> {
	const out: Record<string, ModelTargetOverride> = {};
	if (typeof value !== "object" || value === null) return out;
	for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
		if (typeof raw !== "object" || raw === null) continue;
		const tokens = asPositiveNumber((raw as { targetTokens?: unknown }).targetTokens, 0);
		if (tokens > 0) out[key] = { targetTokens: tokens };
	}
	return out;
}

export function loadAutoCompactTargetConfig(
	env: NodeJS.ProcessEnv = process.env,
): AutoCompactTargetConfig {
	let section: Record<string, unknown> = {};
	try {
		const parsed: unknown = JSON.parse(
			readFileSync(join(agentDir(env), CONFIG_FILE_NAME), "utf8"),
		);
		if (typeof parsed === "object" && parsed !== null) {
			const value =
				"autoCompactTarget" in parsed
					? (parsed as { autoCompactTarget?: unknown }).autoCompactTarget
					: parsed;
			if (typeof value === "object" && value !== null) section = value as Record<string, unknown>;
		}
	} catch {
		// Missing or malformed config falls back to defaults.
	}

	return {
		enabled: asBoolean(section.enabled, DEFAULT_AUTO_COMPACT_TARGET_CONFIG.enabled),
		targetTokens: asPositiveNumber(
			section.targetTokens,
			DEFAULT_AUTO_COMPACT_TARGET_CONFIG.targetTokens,
		),
		windowRatio: (() => {
			const ratio = section.windowRatio;
			return typeof ratio === "number" && Number.isFinite(ratio) && ratio > 0 && ratio <= 1
				? ratio
				: DEFAULT_AUTO_COMPACT_TARGET_CONFIG.windowRatio;
		})(),
		modelOverrides: asOverrides(section.modelOverrides),
	};
}
