import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getSettingsListTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import {
	installCompactStyle,
	type CompactStyleHooks,
	type CompactStyleMode,
} from "./compact-style.ts";
import type { CompactThinkingConfig, CompactThinkingController } from "./compact-thinking.ts";
import {
	installToolGrouping,
	type ToolGroupingHooks,
} from "./tool-grouping.ts";
import { TOOL_LOADING_INTERVAL_MS, toolLoadingIcon } from "./tool-loading-icon.ts";
import { sanitizeToolResultText } from "./tool-result-sanitize.ts";
import {
	DEFAULT_TOOL_DISPLAY_CONFIG,
	installWriteOverride,
	renderRichToolResult,
	WriteExecutionMetadataStore,
	type DiffIndicatorMode,
	type DiffViewMode,
	type ToolDisplayConfig,
} from "./tool-diff/index.ts";
import {
	SettingsList,
	Text,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";

/**
 * Claude Code Style for pi.
 *
 * This is the package's only entry point. Compact transcript rendering lives in
 * the internal compact-style module and is routed by the mode below.
 */

export type Config = {
	mode: CompactStyleMode;
	excludeRenderers: string[];
	diffViewMode: DiffViewMode;
	diffIndicatorMode: DiffIndicatorMode;
	diffSplitMinWidth: number;
	diffCollapsedLines: number;
	diffWordWrap: boolean;
	expandedPreviewMaxLines: number;
	useSummaryTitlesAsThinkingTitle: boolean;
	previewLines: number;
	animationIntervalMs: number;
};

const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const CONFIG_PATH = join(AGENT_DIR, "claude-code-style.json");

const DIFF_VIEW_MODES: DiffViewMode[] = ["auto", "split", "unified"];
const DIFF_INDICATOR_MODES: DiffIndicatorMode[] = ["bars", "classic", "none"];
const DIFF_SPLIT_MIN_WIDTH_VALUES = ["80", "100", "120", "140", "160", "180"];
const DIFF_COLLAPSED_LINES_VALUES = ["12", "24", "36", "48", "80", "120"];
/** Presets for expanded body height — keep low options first so cycling stays TUI-friendly. */
const EXPANDED_PREVIEW_MAX_LINES_VALUES = ["40", "60", "80", "120", "200", "500", "2000"];
const THINKING_PREVIEW_LINES_VALUES = ["0", "1", "3", "5", "10"];
const THINKING_ANIMATION_INTERVAL_VALUES = ["40", "60", "90", "120", "180"];
/** Tools commonly toggled in excludeRenderers via the settings panel. */
const EXCLUDE_RENDERER_CANDIDATES = [
	"bash",
	"read",
	"edit",
	"write",
	"grep",
	"find",
	"ls",
	"webfetch",
	"wait",
];

export const DEFAULT_CONFIG: Config = {
	mode: "on",
	excludeRenderers: [],
	diffViewMode: DEFAULT_TOOL_DISPLAY_CONFIG.diffViewMode,
	diffIndicatorMode: DEFAULT_TOOL_DISPLAY_CONFIG.diffIndicatorMode,
	diffSplitMinWidth: DEFAULT_TOOL_DISPLAY_CONFIG.diffSplitMinWidth,
	diffCollapsedLines: DEFAULT_TOOL_DISPLAY_CONFIG.diffCollapsedLines,
	diffWordWrap: DEFAULT_TOOL_DISPLAY_CONFIG.diffWordWrap,
	expandedPreviewMaxLines: DEFAULT_TOOL_DISPLAY_CONFIG.expandedPreviewMaxLines,
	useSummaryTitlesAsThinkingTitle: true,
	previewLines: 3,
	animationIntervalMs: 90,
};

function pickEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
	return typeof value === "string" && (allowed as readonly string[]).includes(value)
		? (value as T)
		: fallback;
}

function pickPositiveInt(value: unknown, fallback: number, min = 1, max = 100_000): number {
	const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
	if (!Number.isFinite(n)) return fallback;
	return Math.min(max, Math.max(min, Math.floor(n)));
}

function pickPositiveNumber(value: unknown, fallback: number, min = 1): number {
	const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
	return Number.isFinite(n) ? Math.max(min, n) : fallback;
}

function nearestPreset(value: number, presets: readonly string[]): string {
	const numeric = presets.map((p) => Number(p));
	let best = presets[0] ?? String(value);
	let bestDist = Number.POSITIVE_INFINITY;
	for (let i = 0; i < numeric.length; i++) {
		const dist = Math.abs((numeric[i] ?? 0) - value);
		if (dist < bestDist) {
			bestDist = dist;
			best = presets[i] ?? best;
		}
	}
	// Prefer exact match when value is already a preset.
	const exact = presets.find((p) => Number(p) === value);
	return exact ?? best;
}

export function normalizeConfig(input: unknown): Config {
	const source = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
	const mode = source.mode;
	const migratedMode: CompactStyleMode =
		mode === "on" || mode === "off" || mode === "compact"
			? mode
			: typeof source.enabled === "boolean"
				? source.enabled
					? "on"
					: "off"
				: "on";
	const excludeRenderers = Array.isArray(source.excludeRenderers)
		? [
				...new Set(
					source.excludeRenderers.filter(
						(name): name is string => typeof name === "string" && name.length > 0,
					),
				),
			]
		: [];
	return {
		mode: migratedMode,
		excludeRenderers,
		diffViewMode: pickEnum(source.diffViewMode, DIFF_VIEW_MODES, DEFAULT_CONFIG.diffViewMode),
		diffIndicatorMode: pickEnum(
			source.diffIndicatorMode,
			DIFF_INDICATOR_MODES,
			DEFAULT_CONFIG.diffIndicatorMode,
		),
		diffSplitMinWidth: pickPositiveInt(
			source.diffSplitMinWidth,
			DEFAULT_CONFIG.diffSplitMinWidth,
			40,
			300,
		),
		diffCollapsedLines: pickPositiveInt(
			source.diffCollapsedLines,
			DEFAULT_CONFIG.diffCollapsedLines,
			1,
			500,
		),
		diffWordWrap: source.diffWordWrap !== false,
		expandedPreviewMaxLines: pickPositiveInt(
			source.expandedPreviewMaxLines,
			DEFAULT_CONFIG.expandedPreviewMaxLines,
			10,
			50_000,
		),
		useSummaryTitlesAsThinkingTitle: source.useSummaryTitlesAsThinkingTitle !== false,
		previewLines: pickPositiveInt(
			source.previewLines,
			DEFAULT_CONFIG.previewLines,
			0,
			Number.MAX_SAFE_INTEGER,
		),
		animationIntervalMs: pickPositiveNumber(
			source.animationIntervalMs,
			DEFAULT_CONFIG.animationIntervalMs,
		),
	};
}

export function getCompactThinkingConfig(source: Config = config): CompactThinkingConfig {
	return {
		useSummaryTitlesAsThinkingTitle: source.useSummaryTitlesAsThinkingTitle,
		previewLines: source.previewLines,
		animationIntervalMs: source.animationIntervalMs,
	};
}

export function getToolDisplayConfig(source: Config = config): ToolDisplayConfig {
	return {
		diffViewMode: source.diffViewMode,
		diffIndicatorMode: source.diffIndicatorMode,
		diffSplitMinWidth: source.diffSplitMinWidth,
		diffCollapsedLines: source.diffCollapsedLines,
		diffWordWrap: source.diffWordWrap,
		expandedPreviewMaxLines: source.expandedPreviewMaxLines,
	};
}

function formatExcludeRenderers(names: readonly string[]): string {
	return names.length === 0 ? "none" : names.join(", ");
}

export function formatConfigStatus(source: Config = config): string {
	return [
		`mode=${source.mode}`,
		`exclude=[${source.excludeRenderers.join(", ") || "none"}]`,
		`diffView=${source.diffViewMode}`,
		`diffIndicator=${source.diffIndicatorMode}`,
		`diffSplitMin=${source.diffSplitMinWidth}`,
		`diffCollapsed=${source.diffCollapsedLines}`,
		`diffWordWrap=${source.diffWordWrap ? "on" : "off"}`,
		`expandedMax=${source.expandedPreviewMaxLines}`,
		`thinkingTitle=${source.useSummaryTitlesAsThinkingTitle ? "summary" : "default"}`,
		`thinkingPreview=${source.previewLines}`,
		`thinkingAnimation=${source.animationIntervalMs}ms`,
	].join(" · ");
}

let config: Config = loadConfig();

function loadConfig(): Config {
	try {
		const source = existsSync(CONFIG_PATH)
			? (JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Record<string, unknown>)
			: {};
		const normalized = normalizeConfig(source);
		if (
			typeof source.enabled === "boolean" &&
			source.mode !== "on" &&
			source.mode !== "off" &&
			source.mode !== "compact"
		) {
			try {
				writeFileSync(CONFIG_PATH, JSON.stringify(normalized, null, 2));
			} catch {
				// A read-only config still uses the migrated in-memory value.
			}
		}
		return normalized;
	} catch {
		// Ignore bad config and fall back to defaults.
	}
	return { ...DEFAULT_CONFIG };
}

function saveConfig() {
	writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

const TOOL_VIEWPORT_WIDTH_RATIO = 0.8;

function toolViewportWidth(width: number): number {
	return Math.max(1, Math.floor(width * TOOL_VIEWPORT_WIDTH_RATIO));
}

function oneLine(value: unknown, max = 72): string {
	const text = String(value ?? "")
		.replace(/\s+/g, " ")
		.trim();
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function rawTextFromResult(result: any): string {
	return Array.isArray(result?.content)
		? result.content
				.filter((item: any) => item?.type === "text")
				.map((item: any) => String(item.text ?? ""))
				.join("\n")
		: "";
}

function detailsFromResult(result: any): string {
	if (result?.details === undefined) return "";
	const details =
		typeof result.details === "string"
			? result.details
			: inspect(result.details, { depth: 8, breakLength: 100, compact: false });
	return sanitizeToolResultText(details, 16_384);
}

function textFromResult(result: any, expanded = false): string {
	// Compact previews only need short text; bound sanitize work.
	const content = sanitizeToolResultText(rawTextFromResult(result), 16_384);
	const details = detailsFromResult(result);
	if (!content) return details;
	if (!expanded || !details || details === content) return content;
	return `${content}\nDetails:\n${details}`;
}

export function outputLineCount(result: any): number {
	const text = rawTextFromResult(result).replace(/\r\n?/g, "\n").replace(/\n+$/, "");
	return text ? text.split("\n").length : 0;
}

function countLines(text: string): number {
	return text
		.trim()
		.split("\n")
		.filter((line) => line.trim().length > 0).length;
}

function hasExpandableResult(text: string): boolean {
	return countLines(text) > 1;
}

function toolIcon(_name: string): string {
	return "●";
}

const activeAnimationContexts = new Set<any>();
let sharedAnimationTimer: ReturnType<typeof setTimeout> | null = null;

function clearAnimation(context: any) {
	if (!context?.state?.ccstyleAnimationScheduled) return;
	context.state.ccstyleAnimationScheduled = false;
	activeAnimationContexts.delete(context);
	if (activeAnimationContexts.size === 0 && sharedAnimationTimer) {
		clearTimeout(sharedAnimationTimer);
		sharedAnimationTimer = null;
	}
}

function clearAllAnimations() {
	for (const ctx of activeAnimationContexts) {
		ctx.state.ccstyleAnimationScheduled = false;
	}
	activeAnimationContexts.clear();
	if (sharedAnimationTimer) {
		clearTimeout(sharedAnimationTimer);
		sharedAnimationTimer = null;
	}
}

function scheduleAnimation(context: any, intervalMs = TOOL_LOADING_INTERVAL_MS) {
	const state = (context.state ??= {});
	if (state.ccstyleAnimationScheduled) return;
	state.ccstyleAnimationScheduled = true;
	activeAnimationContexts.add(context);
	if (!sharedAnimationTimer) {
		sharedAnimationTimer = setTimeout(() => {
			sharedAnimationTimer = null;
			const contexts = Array.from(activeAnimationContexts);
			activeAnimationContexts.clear();
			for (const ctx of contexts) {
				ctx.state.ccstyleAnimationScheduled = false;
				ctx.invalidate?.();
			}
		}, intervalMs);
	}
}

function pendingIcon(_name: string): string {
	return toolLoadingIcon();
}

type ToolVisualState = "pending" | "success" | "error";

function settledIcon(name: string, state: ToolVisualState | undefined): string {
	if (state === "success") return "✓";
	if (state === "error") return "✗";
	return toolIcon(name);
}

function setToolVisualState(context: any, visualState: ToolVisualState) {
	const state = (context.state ??= {});
	if (visualState !== "pending") clearAnimation(context);
	if (state.ccstyleToolVisualState === visualState) return;
	state.ccstyleToolVisualState = visualState;
	// Do not invalidate synchronously from renderResult. Pi is already rendering
	// this tool row; recursively scheduling another render here can retain both
	// the finalized result component and its previous secondary/partial component,
	// which displays the result summary twice. The current render pass also
	// refreshes renderCall, so the settled icon still updates immediately.
}

function getToolVisualState(context: any): ToolVisualState | undefined {
	return context?.state?.ccstyleToolVisualState as ToolVisualState | undefined;
}

function resolveToolVisualState(context: any): ToolVisualState | undefined {
	const visualState = getToolVisualState(context);
	if (visualState || context?.isPartial !== false) return visualState;
	const settledState: ToolVisualState = context?.isError ? "error" : "success";
	setToolVisualState(context, settledState);
	return settledState;
}

function toolIconColor(context: any): "accent" | "error" | "success" | "muted" {
	const visualState = getToolVisualState(context);
	if (context?.isError || visualState === "error") return "error";
	if (visualState === "success") return "success";
	if (context?.isPartial || context?.executionStarted || visualState === "pending") return "accent";
	return "muted";
}

function isToolExpanded(options: any, context: any): boolean {
	const local = context?.state?.ccstyleToolExpanded;
	return typeof local === "boolean" ? local : Boolean(options?.expanded ?? context?.expanded);
}

/** Keep the guide aligned when long result lines wrap at the viewport edge. */
export class ExpandedToolResultText {
	private text: string;
	private prefix: string;
	private normalizedText: string;
	private cachedWidth: number | undefined;
	private cachedLines: string[] | undefined;

	constructor(text: string, prefix: string) {
		this.text = text;
		this.prefix = prefix;
		this.normalizedText = text.replace(/\t/g, "   ").replace(/\n+$/, "");
	}

	setText(text: string): void {
		if (this.text === text) return;
		this.text = text;
		this.normalizedText = text.replace(/\t/g, "   ").replace(/\n+$/, "");
		this.invalidate();
	}

	setPrefix(prefix: string): void {
		if (this.prefix === prefix) return;
		this.prefix = prefix;
		this.invalidate();
	}

	render(width: number): string[] {
		if (this.cachedLines !== undefined && this.cachedWidth === width) return this.cachedLines;

		const prefixWidth = visibleWidth(this.prefix);
		const contentWidth = Math.max(1, width - prefixWidth);
		const lines = wrapTextWithAnsi(this.normalizedText, contentWidth).map((line) =>
			truncateToWidth(this.prefix + line, width, ""),
		);
		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

/** Affordance next to truncated Input/Output headers — click opens full preview. */
export const SHOW_MORE_LABEL = "[show more]";

export type ToolIoSection = "input" | "output";

// Module-local token: /reload creates a fresh token, so stale view instances are
// replaced instead of retaining their old render implementation.
const EXPANDED_TOOL_IO_VIEW_GENERATION = Symbol("ccstyle-expanded-tool-io-view");

/**
 * Expanded tool body with clear Input / Output sections (Grok Build–style).
 *
 * Visual frame:
 *   ├ Input  [show more]
 *   │ path: src/a.ts
 *   │
 *   └ Output  [show more]
 *     result line…
 *
 * Reused across re-renders via context.lastComponent when possible.
 */
export class ExpandedToolIoView {
	readonly [EXPANDED_TOOL_IO_VIEW_GENERATION] = true;
	private inputBody: string;
	private outputBody: string;
	private isError: boolean;
	private theme: any;
	private maxOutputLines: number;
	private maxInputLines: number;
	private cachedWidth: number | undefined;
	private cachedLines: string[] | undefined;
	private hoveredSection: ToolIoSection | null = null;
	/** Which sections currently show the [show more] affordance (after last render). */
	private truncated: { input: boolean; output: boolean } = { input: false, output: false };
	/** 0-based header line indexes that carry [show more] after last render. */
	private showMoreHeaderRows: { input?: number; output?: number } = {};

	constructor(
		theme: any,
		inputBody: string,
		outputBody: string,
		isError: boolean,
		maxOutputLines = config.expandedPreviewMaxLines,
		maxInputLines = config.expandedPreviewMaxLines,
	) {
		this.theme = theme;
		this.inputBody = inputBody;
		this.outputBody = outputBody;
		this.isError = isError;
		this.maxOutputLines = Math.max(1, maxOutputLines);
		this.maxInputLines = Math.max(1, maxInputLines);
	}

	setContent(
		inputBody: string,
		outputBody: string,
		isError: boolean,
		maxOutputLines?: number,
		maxInputLines?: number,
	): void {
		const nextOut =
			maxOutputLines !== undefined ? Math.max(1, maxOutputLines) : this.maxOutputLines;
		const nextIn = maxInputLines !== undefined ? Math.max(1, maxInputLines) : this.maxInputLines;
		if (
			this.inputBody === inputBody &&
			this.outputBody === outputBody &&
			this.isError === isError &&
			this.maxOutputLines === nextOut &&
			this.maxInputLines === nextIn
		) {
			return;
		}
		this.inputBody = inputBody;
		this.outputBody = outputBody;
		this.isError = isError;
		this.maxOutputLines = nextOut;
		this.maxInputLines = nextIn;
		this.invalidate();
	}

	getInputBody(): string {
		return this.inputBody;
	}

	getOutputBody(): string {
		return this.outputBody.trim() ? this.outputBody : "Done";
	}

	setHoveredSection(section: ToolIoSection | null): void {
		if (this.hoveredSection === section) return;
		this.hoveredSection = section;
		this.invalidate();
	}

	/** True when the plain header line is a truncated section with [show more]. */
	matchShowMoreLine(plainLine: string): ToolIoSection | null {
		const line = plainLine.replace(/\x1b\[[0-9;]*m/g, "");
		if (!line.includes(SHOW_MORE_LABEL)) return null;
		if (/\bInput\b/.test(line) && this.truncated.input) return "input";
		if (/\bOutput\b/.test(line) && this.truncated.output) return "output";
		return null;
	}

	/** Precise header rows marked for show-more hit testing (last render). */
	showMoreHeaderLineIndexes(): ReadonlyArray<{ section: ToolIoSection; line: number }> {
		const out: Array<{ section: ToolIoSection; line: number }> = [];
		if (this.showMoreHeaderRows.input !== undefined) {
			out.push({ section: "input", line: this.showMoreHeaderRows.input });
		}
		if (this.showMoreHeaderRows.output !== undefined) {
			out.push({ section: "output", line: this.showMoreHeaderRows.output });
		}
		return out;
	}

	/** Column range (1-based, visible cells) of [show more] on a rendered header, if present. */
	showMoreHitbox(plainLine: string): { startCol: number; endCol: number } | null {
		const line = plainLine.replace(/\x1b\[[0-9;]*m/g, "");
		const idx = line.indexOf(SHOW_MORE_LABEL);
		if (idx < 0) return null;
		const before = line.slice(0, idx);
		const startCol = visibleWidth(before) + 1;
		const endCol = startCol + visibleWidth(SHOW_MORE_LABEL) - 1;
		return { startCol, endCol };
	}

	render(width: number): string[] {
		if (this.cachedLines !== undefined && this.cachedWidth === width) {
			return this.cachedLines;
		}

		const theme = this.theme;
		const safeWidth = Math.max(1, Math.floor(width));
		const rail = " │ ";
		const railWidth = visibleWidth(rail);
		const bodyWidth = toolViewportWidth(safeWidth);
		const contentWidth = Math.max(1, bodyWidth - railWidth);
		const bodyColor = this.isError ? "error" : "toolOutput";
		const lines: string[] = [];
		this.truncated = { input: false, output: false };
		this.showMoreHeaderRows = {};

		const pushHeader = (
			corner: "├" | "└",
			label: string,
			section: ToolIoSection,
			showMore: boolean,
		) => {
			const mark = theme.fg("dim", ` ${corner} `);
			const title = theme.fg(
				"accent",
				typeof theme.bold === "function" ? theme.bold(label) : label,
			);
			const more = showMore
				? theme.fg(this.hoveredSection === section ? "text" : "dim", ` ${SHOW_MORE_LABEL}`)
				: "";
			if (showMore) this.showMoreHeaderRows[section] = lines.length;
			lines.push(truncateToWidth(mark + title + more, safeWidth, ""));
		};

		const pushRailLine = (styledContent: string, continued = true) => {
			const prefix = continued ? rail : "   ";
			lines.push(truncateToWidth(theme.fg("dim", prefix) + styledContent, safeWidth, ""));
		};

		const pushBlankRail = () => {
			lines.push(truncateToWidth(theme.fg("dim", " │"), safeWidth, ""));
		};

		/** Style `key: value` input rows — dim keys, readable values. */
		const styleInputLine = (rawLine: string): string => {
			const match = rawLine.match(/^([A-Za-z_][\w.-]*)(:\s*)(.*)$/);
			if (!match) return theme.fg("muted", rawLine);
			const [, key, sep, rest] = match;
			return theme.fg("dim", key + sep) + theme.fg("muted", rest ?? "");
		};

		const pushBody = (
			body: string,
			opts: { input?: boolean; limit: number; continued?: boolean },
		): boolean /* truncated */ => {
			const raw = body.replace(/\t/g, "   ").replace(/\n+$/, "");
			if (!raw.trim()) {
				pushRailLine(theme.fg("dim", "(empty)"), opts.continued);
				return false;
			}
			const sourceLines = raw.split("\n");
			const wrapped: string[] = [];
			for (const source of sourceLines) {
				const styled = opts.input ? styleInputLine(source) : theme.fg(bodyColor, source);
				const parts = wrapTextWithAnsi(styled, contentWidth);
				if (parts.length === 0) wrapped.push(styled);
				else wrapped.push(...parts);
			}
			// Prefer source-line count so plain multi-line dumps always cap, even when
			// theme/wrap measurements disagree slightly.
			const truncated = wrapped.length > opts.limit || sourceLines.length > opts.limit;
			const visible = truncated ? wrapped.slice(0, Math.min(opts.limit, wrapped.length)) : wrapped;
			for (const line of visible) pushRailLine(line, opts.continued);
			if (truncated) {
				const hidden = Math.max(0, wrapped.length - visible.length);
				if (hidden > 0) {
					pushRailLine(theme.fg("dim", `… +${hidden} more lines`), opts.continued);
				}
			}
			return truncated;
		};

		const hasInput = this.inputBody.trim().length > 0;
		const outputText = this.getOutputBody();

		// Decide [show more] from the same truncation rules as pushBody.
		const inputWouldTruncate =
			hasInput &&
			bodyExceedsLineLimit(this.inputBody, this.maxInputLines, contentWidth, true, theme);
		const outputWouldTruncate = bodyExceedsLineLimit(
			outputText,
			this.maxOutputLines,
			contentWidth,
			false,
			theme,
			bodyColor,
		);

		if (hasInput) {
			this.truncated.input = inputWouldTruncate;
			pushHeader("├", "Input", "input", inputWouldTruncate);
			pushBody(this.inputBody, {
				input: true,
				limit: this.maxInputLines,
				continued: true,
			});
			pushBlankRail();
			this.truncated.output = outputWouldTruncate;
			pushHeader("└", "Output", "output", outputWouldTruncate);
			pushBody(outputText, { limit: this.maxOutputLines, continued: false });
		} else {
			this.truncated.output = outputWouldTruncate;
			pushHeader("└", "Output", "output", outputWouldTruncate);
			pushBody(outputText, { limit: this.maxOutputLines, continued: false });
		}

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

function isExpandedToolIoView(value: unknown): value is ExpandedToolIoView {
	return Boolean(
		value &&
			typeof value === "object" &&
			(value as ExpandedToolIoView)[EXPANDED_TOOL_IO_VIEW_GENERATION] === true &&
			typeof (value as ExpandedToolIoView).getInputBody === "function" &&
			typeof (value as ExpandedToolIoView).getOutputBody === "function" &&
			typeof (value as ExpandedToolIoView).setHoveredSection === "function" &&
			typeof (value as ExpandedToolIoView).render === "function",
	);
}

/** True when body needs truncation at the given line limit (source lines or wrapped rows). */
function bodyExceedsLineLimit(
	body: string,
	limit: number,
	contentWidth: number,
	asInput: boolean,
	theme: any,
	bodyColor = "toolOutput",
): boolean {
	const raw = body.replace(/\t/g, "   ").replace(/\n+$/, "");
	if (!raw.trim()) return false;
	const sourceLines = raw.split("\n");
	if (sourceLines.length > limit) return true;
	let total = 0;
	for (const source of sourceLines) {
		let styled: string;
		if (asInput) {
			const match = source.match(/^([A-Za-z_][\w.-]*)(:\s*)(.*)$/);
			styled = match
				? theme.fg("dim", match[1] + match[2]) + theme.fg("muted", match[3] ?? "")
				: theme.fg("muted", source);
		} else {
			styled = theme.fg(bodyColor, source);
		}
		const parts = wrapTextWithAnsi(styled, contentWidth);
		total += Math.max(1, parts.length);
		if (total > limit) return true;
	}
	return false;
}

export function renderCollapsedToolResult(body: string, collapsedHint = ""): string {
	return `   ↳ ${body}${collapsedHint}`;
}

export function renderCollapsedToolResultToWidth(
	body: string,
	collapsedHint: string,
	width: number,
	prefix = "   ↳ ",
): string {
	const previewWidth = toolViewportWidth(width);
	const bodyWidth = Math.max(1, previewWidth - visibleWidth(prefix) - visibleWidth(collapsedHint));
	return truncateToWidth(
		prefix + middleTruncateToWidth(body, bodyWidth) + collapsedHint,
		previewWidth,
		"",
	);
}

/** Pretty-print tool call args for the expanded Input section. */
export function formatToolInputArgs(args: unknown, maxChars = 8_000): string {
	if (args === undefined || args === null) return "";
	if (typeof args !== "object") {
		const text = String(args);
		return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
	}
	if (Array.isArray(args)) {
		try {
			const json = JSON.stringify(args, null, 2);
			return json.length > maxChars ? `${json.slice(0, maxChars)}…` : json;
		} catch {
			return String(args);
		}
	}

	const entries = Object.entries(args as Record<string, unknown>).filter(
		([, value]) => value !== undefined,
	);
	if (entries.length === 0) return "";

	// Stable, human-first field order for common tools.
	const preferred = [
		"path",
		"file_path",
		"command",
		"query",
		"pattern",
		"url",
		"name",
		"message",
		"content",
		"old_string",
		"new_string",
	];
	entries.sort(([left], [right]) => {
		const li = preferred.indexOf(left);
		const ri = preferred.indexOf(right);
		if (li === -1 && ri === -1) return left.localeCompare(right);
		if (li === -1) return 1;
		if (ri === -1) return -1;
		return li - ri;
	});

	const lines: string[] = [];
	for (const [key, value] of entries) {
		if (typeof value === "string") {
			if (value.includes("\n")) {
				lines.push(`${key}:`);
				for (const line of value.replace(/\t/g, "   ").split("\n")) {
					lines.push(`  ${line}`);
				}
			} else {
				lines.push(`${key}: ${value}`);
			}
			continue;
		}
		if (typeof value === "number" || typeof value === "boolean" || value === null) {
			lines.push(`${key}: ${String(value)}`);
			continue;
		}
		try {
			const json = JSON.stringify(value, null, 2);
			if (json.includes("\n")) {
				lines.push(`${key}:`);
				for (const line of json.split("\n")) lines.push(`  ${line}`);
			} else {
				lines.push(`${key}: ${json}`);
			}
		} catch {
			lines.push(`${key}: [unserializable]`);
		}
	}
	const text = lines.join("\n");
	return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

function hasExpandableDetail(outputText: string, args: unknown): boolean {
	if (hasExpandableResult(outputText)) return true;
	return formatToolInputArgs(args).trim().length > 0;
}

function renderExpandedToolResult(
	body: string,
	theme: any,
	isError: boolean,
	lastComponent?: unknown,
	args?: unknown,
	context?: any,
): ExpandedToolIoView | ExpandedToolResultText | Text {
	const inputBody = formatToolInputArgs(args);
	const outputBody = body;
	const maxLines = config.expandedPreviewMaxLines;

	// Prefer structured Input/Output when we have args or non-empty output.
	if (inputBody.trim() || outputBody.trim()) {
		let view: ExpandedToolIoView;
		if (isExpandedToolIoView(lastComponent)) {
			lastComponent.setContent(inputBody, outputBody, isError, maxLines, maxLines);
			view = lastComponent;
		} else {
			view = new ExpandedToolIoView(theme, inputBody, outputBody, isError, maxLines, maxLines);
		}
		return view;
	}

	if (context?.state) context.state.ccstyleIoView = undefined;
	const color = isError ? "error" : "muted";
	return new Text(theme.fg(color, renderCollapsedToolResult("Done")), 0, 0);
}

export function formatExpandHint(lineCount: number): string {
	return ` (${lineCount} more line${lineCount === 1 ? "" : "s"} / click)`;
}

// Bright green for success icon (truecolor ANSI escape)
const BRIGHT_GREEN = "\x1b[38;2;80;220;100m";
const ANSI_FG_RESET = "\x1b[39m";

function refreshCurrentTranscript(
	compactStyle: CompactStyleHooks,
	ctx?: any,
	toolGrouping?: ToolGroupingHooks,
): void {
	toolGrouping?.refresh();
	compactStyle.refresh();
	ctx?.ui?.requestRender?.(true);
}

function applyStyleMode(
	mode: CompactStyleMode,
	ctx: any,
	compactStyle: CompactStyleHooks,
	toolGrouping?: ToolGroupingHooks,
): void {
	config.mode = mode;
	saveConfig();
	refreshCurrentTranscript(compactStyle, ctx, toolGrouping);
	ctx.ui.notify(`Claude Code style: ${mode}`, "info");
}

function modeSettingDescription(mode: CompactStyleMode): string {
	if (mode === "compact") {
		return "Compact transcript summaries. Fixed editor and diff options below still apply independently.";
	}
	if (mode === "off") {
		return "Pi native tool rendering. Fixed editor and diff options below still apply independently.";
	}
	return "Claude Code style with rich edit/write diffs. Tune diff options below.";
}

function excludeRenderersDescription(names: readonly string[]): string {
	return names.length === 0
		? "No tools excluded. Agent always keeps its dedicated renderer. Enter to toggle common tools."
		: `Native renderer for: ${names.join(", ")}. Agent is always native. Enter to toggle.`;
}

function diffViewModeDescription(mode: DiffViewMode): string {
	if (mode === "split") return "Force side-by-side diff when width allows; otherwise unified.";
	if (mode === "unified") return "Always render a single unified diff column.";
	return "Auto: split when terminal is wide enough, otherwise unified.";
}

function diffIndicatorDescription(mode: DiffIndicatorMode): string {
	if (mode === "classic") return "Classic +/- gutters on changed lines.";
	if (mode === "none") return "No change indicators; rely on color alone.";
	return "Vertical bar indicators on changed lines (default).";
}

function buildExcludeRenderersSubmenu(
	onClose: () => void,
	onLiveChange: () => void,
): {
	render: (width: number) => string[];
	invalidate: () => void;
	handleInput: (data: string) => void;
} {
	const candidates = [
		...new Set([...EXCLUDE_RENDERER_CANDIDATES, ...config.excludeRenderers]),
	].sort((a, b) => a.localeCompare(b));
	const items = candidates.map((name) => ({
		id: name,
		label: name,
		description:
			name === "Agent"
				? "Agent always uses its dedicated renderer and cannot be forced through ccstyle."
				: `Use Pi native renderer for ${name} instead of Claude Code / compact styling.`,
		currentValue: config.excludeRenderers.includes(name) ? "exclude" : "style",
		values: ["style", "exclude"],
	}));
	const list = new SettingsList(
		items,
		Math.min(8, Math.max(4, items.length)),
		getSettingsListTheme(),
		(id: string, value: string) => {
			const excluded = new Set(config.excludeRenderers);
			if (value === "exclude") excluded.add(id);
			else excluded.delete(id);
			config.excludeRenderers = [...excluded].sort((a, b) => a.localeCompare(b));
			saveConfig();
			onLiveChange();
		},
		() => onClose(),
		{ enableSearch: candidates.length > 8 },
	);
	return {
		render: (width: number) => [
			...list.render(width),
			"",
			// Extra hint: Esc returns to the Style section list.
			truncateToWidth("  Esc back to Style settings", width),
		],
		invalidate: () => list.invalidate(),
		handleInput: (data: string) => list.handleInput(data),
	};
}

/** Section tabs for /ccstyle — matches Zentui-style "A / B / C" headers. */
type CcstyleSection = {
	id: "style" | "editor" | "diff" | "thinking";
	label: string;
	items: any[];
};

function isForwardTabKey(data: string): boolean {
	return data === "\t" || matchesKey(data, "tab");
}

function isBackTabKey(data: string): boolean {
	// CSI Z is the common terminal encoding for Shift+Tab.
	return data === "\x1b[Z" || matchesKey(data, "shift+tab");
}

function renderPanelRule(theme: any, width: number): string {
	return theme.fg("dim", "─".repeat(Math.max(0, width)));
}

function renderSectionTabBar(
	theme: any,
	sections: readonly { label: string }[],
	activeIndex: number,
	width: number,
): string {
	const pieces: string[] = [];
	for (let i = 0; i < sections.length; i++) {
		if (i > 0) pieces.push(theme.fg("dim", " / "));
		const label = sections[i]?.label ?? "";
		pieces.push(
			i === activeIndex
				? theme.fg("text", typeof theme.bold === "function" ? theme.bold(label) : label)
				: theme.fg("dim", label),
		);
	}
	return truncateToWidth(pieces.join(""), Math.max(0, width));
}

async function showCcstylePanel(
	ctx: any,
	compactStyle: CompactStyleHooks,
	toolGrouping?: ToolGroupingHooks,
	compactThinking?: CompactThinkingController,
): Promise<void> {
	if (ctx?.mode !== "tui" || !ctx?.hasUI || typeof ctx.ui?.custom !== "function") {
		ctx.ui?.notify?.("/ccstyle requires TUI mode", "warning");
		return;
	}

	await ctx.ui.custom((tui: any, theme: any, _keybindings: any, done: () => void) => {
		const modeSetting = {
			id: "mode",
			label: "Mode",
			description: modeSettingDescription(config.mode),
			currentValue: config.mode,
			values: ["on", "off", "compact"],
		};
		// Tracks whether the Exclude-tools submenu is open so Tab switches sections
		// only at the top level (mirrors Zentui settings: Tab = switch sections).
		let excludeSubmenuOpen = false;
		const excludeSetting = {
			id: "excludeRenderers",
			label: "Exclude tools",
			description: excludeRenderersDescription(config.excludeRenderers),
			currentValue: formatExcludeRenderers(config.excludeRenderers),
			submenu: (_current: string, closeSubmenu: (selected?: string) => void) => {
				excludeSubmenuOpen = true;
				return buildExcludeRenderersSubmenu(
					() => {
						excludeSubmenuOpen = false;
						excludeSetting.currentValue = formatExcludeRenderers(config.excludeRenderers);
						excludeSetting.description = excludeRenderersDescription(config.excludeRenderers);
						closeSubmenu();
					},
					() => {
						excludeSetting.currentValue = formatExcludeRenderers(config.excludeRenderers);
						excludeSetting.description = excludeRenderersDescription(config.excludeRenderers);
						refreshCurrentTranscript(compactStyle, ctx);
					},
				);
			},
		};
		const diffViewSetting = {
			id: "diffViewMode",
			label: "Diff layout",
			description: diffViewModeDescription(config.diffViewMode),
			currentValue: config.diffViewMode,
			values: [...DIFF_VIEW_MODES],
		};
		const diffIndicatorSetting = {
			id: "diffIndicatorMode",
			label: "Diff indicator",
			description: diffIndicatorDescription(config.diffIndicatorMode),
			currentValue: config.diffIndicatorMode,
			values: [...DIFF_INDICATOR_MODES],
		};
		const diffSplitSetting = {
			id: "diffSplitMinWidth",
			label: "Split min width",
			description: "Minimum terminal width before auto/split layout uses side-by-side columns.",
			currentValue: nearestPreset(config.diffSplitMinWidth, DIFF_SPLIT_MIN_WIDTH_VALUES),
			values: [...DIFF_SPLIT_MIN_WIDTH_VALUES],
		};
		const diffCollapsedSetting = {
			id: "diffCollapsedLines",
			label: "Collapsed lines",
			description: "How many diff body lines to show before the expand hint (Ctrl+O / click).",
			currentValue: nearestPreset(config.diffCollapsedLines, DIFF_COLLAPSED_LINES_VALUES),
			values: [...DIFF_COLLAPSED_LINES_VALUES],
		};
		const diffWordWrapSetting = {
			id: "diffWordWrap",
			label: "Diff word wrap",
			description: config.diffWordWrap
				? "Long diff lines wrap within the panel width."
				: "Long diff lines are truncated to the panel width.",
			currentValue: config.diffWordWrap ? "on" : "off",
			values: ["on", "off"],
		};
		const expandedMaxSetting = {
			id: "expandedPreviewMaxLines",
			label: "Expanded max lines",
			description:
				"Max Output/diff body lines when expanded. Default 40 keeps the TUI compact; raise for large dumps.",
			currentValue: nearestPreset(
				config.expandedPreviewMaxLines,
				EXPANDED_PREVIEW_MAX_LINES_VALUES,
			),
			values: [...EXPANDED_PREVIEW_MAX_LINES_VALUES],
		};
		const thinkingTitleSetting = {
			id: "useSummaryTitlesAsThinkingTitle",
			label: "Summary title",
			description: "Use the latest provider summary as the active thinking title.",
			currentValue: config.useSummaryTitlesAsThinkingTitle ? "on" : "off",
			values: ["on", "off"],
		};
		const thinkingPreviewSetting = {
			id: "previewLines",
			label: "Preview lines",
			description: "Thinking preview lines; 0 hides the preview body.",
			currentValue: nearestPreset(config.previewLines, THINKING_PREVIEW_LINES_VALUES),
			values: [...THINKING_PREVIEW_LINES_VALUES],
		};
		const thinkingAnimationSetting = {
			id: "animationIntervalMs",
			label: "Animation interval ms",
			description: "Thinking title animation interval for the next thinking run.",
			currentValue: nearestPreset(config.animationIntervalMs, THINKING_ANIMATION_INTERVAL_VALUES),
			values: [...THINKING_ANIMATION_INTERVAL_VALUES],
		};

		const onSettingChange = (id: string, value: string) => {
			switch (id) {
				case "mode":
					modeSetting.description = modeSettingDescription(value as CompactStyleMode);
					applyStyleMode(value as CompactStyleMode, ctx, compactStyle, toolGrouping);
					return;
				case "excludeRenderers":
					excludeSetting.currentValue = formatExcludeRenderers(config.excludeRenderers);
					excludeSetting.description = excludeRenderersDescription(config.excludeRenderers);
					return;
				case "diffViewMode":
					config.diffViewMode = value as DiffViewMode;
					diffViewSetting.description = diffViewModeDescription(config.diffViewMode);
					break;
				case "diffIndicatorMode":
					config.diffIndicatorMode = value as DiffIndicatorMode;
					diffIndicatorSetting.description = diffIndicatorDescription(config.diffIndicatorMode);
					break;
				case "diffSplitMinWidth":
					config.diffSplitMinWidth = pickPositiveInt(
						value,
						DEFAULT_CONFIG.diffSplitMinWidth,
						40,
						300,
					);
					break;
				case "diffCollapsedLines":
					config.diffCollapsedLines = pickPositiveInt(
						value,
						DEFAULT_CONFIG.diffCollapsedLines,
						1,
						500,
					);
					break;
				case "diffWordWrap":
					config.diffWordWrap = value === "on";
					diffWordWrapSetting.description = config.diffWordWrap
						? "Long diff lines wrap within the panel width."
						: "Long diff lines are truncated to the panel width.";
					break;
				case "expandedPreviewMaxLines":
					config.expandedPreviewMaxLines = pickPositiveInt(
						value,
						DEFAULT_CONFIG.expandedPreviewMaxLines,
						10,
						50_000,
					);
					break;
				case "useSummaryTitlesAsThinkingTitle":
					config.useSummaryTitlesAsThinkingTitle = value === "on";
					break;
				case "previewLines":
					config.previewLines = pickPositiveInt(value, DEFAULT_CONFIG.previewLines, 0);
					break;
				case "animationIntervalMs":
					config.animationIntervalMs = pickPositiveNumber(
						value,
						DEFAULT_CONFIG.animationIntervalMs,
					);
					break;
				default:
					return;
			}
			saveConfig();
			compactThinking?.updateConfig(getCompactThinkingConfig());
			refreshCurrentTranscript(compactStyle, ctx);
			ctx.ui.notify(`Updated ${id}: ${value}`, "info");
		};

		const sections: CcstyleSection[] = [
			{
				id: "style",
				label: "Style",
				items: [modeSetting, excludeSetting],
			},
			{
				id: "diff",
				label: "Diff",
				items: [
					diffViewSetting,
					diffIndicatorSetting,
					diffSplitSetting,
					diffCollapsedSetting,
					diffWordWrapSetting,
					expandedMaxSetting,
				],
			},
			{
				id: "thinking",
				label: "Thinking",
				items: [thinkingTitleSetting, thinkingPreviewSetting, thinkingAnimationSetting],
			},
		];

		let activeSection = 0;
		const settingsTheme = getSettingsListTheme();
		const lists = sections.map(
			(section) =>
				new SettingsList(
					section.items,
					Math.min(8, Math.max(section.items.length, 1)),
					settingsTheme,
					onSettingChange,
					() => done(),
					{ enableSearch: false },
				),
		);

		const activeList = () => lists[activeSection]!;

		const switchSection = (delta: number) => {
			if (excludeSubmenuOpen) return;
			activeSection = (activeSection + delta + sections.length) % sections.length;
		};

		return {
			render(width: number): string[] {
				const safeWidth = Math.max(0, Math.floor(width));
				const rule = renderPanelRule(theme, safeWidth);
				const body = activeList().render(safeWidth);
				// Drop SettingsList's built-in hint — the panel footer below is the single source.
				while (body.length > 0 && body[body.length - 1] === "") body.pop();
				const listHintIndex = body.findIndex(
					(line) =>
						typeof line === "string" &&
						(line.includes("Enter/Space to change") || line.includes("Esc to cancel")),
				);
				const listBody = listHintIndex >= 0 ? body.slice(0, listHintIndex) : body;
				while (listBody.length > 0 && listBody[listBody.length - 1] === "") listBody.pop();

				// Frame: top rule · tabs · mid rule · settings · mid rule · footer · bottom rule
				return [
					rule,
					renderSectionTabBar(theme, sections, activeSection, safeWidth),
					rule,
					...listBody,
					rule,
					truncateToWidth(
						theme.fg(
							"dim",
							"  Enter/Space to change · Tab/Shift+Tab to switch sections · Esc to close",
						),
						safeWidth,
					),
					rule,
				];
			},
			invalidate() {
				for (const list of lists) list.invalidate();
			},
			handleInput(data: string) {
				if (!excludeSubmenuOpen && isForwardTabKey(data)) {
					switchSection(1);
					tui.requestRender();
					return;
				}
				if (!excludeSubmenuOpen && isBackTabKey(data)) {
					switchSection(-1);
					tui.requestRender();
					return;
				}
				activeList().handleInput?.(data);
				tui.requestRender();
			},
		};
	});
}

function renderDefault(tool: any, slot: "renderCall" | "renderResult", args: any[], fallback = "") {
	try {
		if (typeof tool?.[slot] === "function") return tool[slot](...args);
	} catch {
		// Fall through to raw fallback.
	}
	return new Text(fallback, 0, 0);
}

function insetComponent(component: any): any {
	return {
		render: (width: number) =>
			component.render(Math.max(1, width - 1)).map((line: string) => {
				const nestedMarker = line.replace(/^((?:\x1b\[[0-?]*[ -/]*[@-~])*)↳/, "$1  ↳");
				return ` ${nestedMarker}`;
			}),
		invalidate: () => component.invalidate?.(),
	};
}

function humanizeToolLabel(label: string): string {
	return label
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/[_-]+/g, " ")
		.replace(/\b\w/g, (char) => char.toUpperCase());
}

function singleToolCallSummary(
	toolName: string,
	label: string,
	args: any,
): { main: string; detail: string } {
	const title = label === toolName ? humanizeToolLabel(label) : label;
	if (!args || typeof args !== "object") return { main: title, detail: "" };
	const name = toolName.toLowerCase();
	const value = (fallback: string, ...keys: string[]) => {
		const found = keys.map((key) => args[key]).find((item) => typeof item === "string" && item);
		return `${title} ${oneLine(found || fallback, Infinity)}`;
	};
	if (AGENT_FAMILY_TOOL_NAMES.has(toolName) && args.agent_id) {
		return { main: `${title} ${oneLine(args.agent_id, Infinity)}`, detail: "" };
	}
	// Agents still uses the ccstyle wrapper; Agent keeps its dedicated renderer.
	if (name === "agents") {
		return {
			main: value("launch agents", "description", "prompt"),
			detail: "",
		};
	}
	if (name === "skill") return { main: value("run skill", "name"), detail: "" };
	if (name === "enterplanmode" || name === "enter_plan_mode") {
		return { main: `${title} enable read-only planning`, detail: "" };
	}
	if (name === "exitplanmode" || name === "exit_plan_mode") {
		return { main: `${title} present plan`, detail: "" };
	}
	if (name === "taskcreate") return { main: value("create task", "subject"), detail: "" };
	if (name === "tasklist") return { main: `${title} task list`, detail: "" };
	if (name === "taskget" || name === "taskupdate") {
		return { main: value("task", "taskId", "task_id"), detail: "" };
	}
	if (name === "taskoutput" || name === "taskstop") {
		return { main: value("background task", "task_id", "taskId"), detail: "" };
	}
	if (name === "taskexecute") {
		const ids = Array.isArray(args.task_ids)
			? args.task_ids
			: Array.isArray(args.taskIds)
				? args.taskIds
				: [];
		const summary = ids.length
			? `${ids[0]}${ids.length > 1 ? ` (+${ids.length - 1} tasks)` : ""}`
			: "start tasks";
		return { main: `${title} ${summary}`, detail: "" };
	}
	if (toolName === "read") {
		const details = [
			args.offset !== undefined ? `offset=${args.offset}` : "",
			args.limit !== undefined ? `limit=${args.limit}` : "",
		].filter(Boolean);
		return {
			main: `${title}${args.path ? ` ${oneLine(args.path, Infinity)}` : ""}`,
			detail: details.length ? ` (${details.join(", ")})` : "",
		};
	}
	const preferred =
		args.path ??
		args.file_path ??
		args.command ??
		args.query ??
		args.question ??
		args.pattern ??
		args.url ??
		args.name ??
		args.tool_use_id ??
		args.toolCallId ??
		args.id ??
		args.message;
	return {
		main:
			preferred !== undefined && preferred !== null && typeof preferred !== "object"
				? `${title} ${oneLine(preferred, Infinity)}`
				: title,
		detail: "",
	};
}

export function middleTruncateToWidth(text: string, width: number): string {
	if (visibleWidth(text) <= width) return text;
	if (width <= 1) return "…";
	const chars = Array.from(text);
	const leftWidth = Math.ceil((width - 1) / 2);
	let left = "";
	let right = "";
	for (const char of chars) {
		if (visibleWidth(left + char) > leftWidth) break;
		left += char;
	}
	for (const char of chars.reverse()) {
		if (visibleWidth(left + "…" + char + right) > width) break;
		right = char + right;
	}
	return `${left}…${right}`;
}

export function shouldRenderRichDiff(
	mode: CompactStyleMode,
	toolName: string,
	isError: boolean,
): boolean {
	return mode === "on" && !isError && (toolName === "edit" || toolName === "write");
}

type ParsedTask = { id: string; status: string; subject: string };

function parseTaskList(text: string): ParsedTask[] {
	return text
		.split("\n")
		.map((line) => line.match(/^#(\d+) \[([^\]]+)] (.+)$/))
		.filter((match): match is RegExpMatchArray => Boolean(match))
		.map((match) => ({ id: match[1]!, status: match[2]!, subject: match[3]! }));
}

function taskListSummary(tasks: ParsedTask[]): string {
	const counts = { pending: 0, in_progress: 0, completed: 0 };
	for (const task of tasks) {
		if (task.status in counts) counts[task.status as keyof typeof counts]++;
	}
	return [
		`${tasks.length} tasks`,
		counts.in_progress ? `${counts.in_progress} in progress` : "",
		counts.pending ? `${counts.pending} pending` : "",
		counts.completed ? `${counts.completed} completed` : "",
	]
		.filter(Boolean)
		.join(" • ");
}

function renderExpandedTaskResult(
	toolName: string,
	text: string,
	theme: any,
	isError: boolean,
): any | undefined {
	if (isError) return undefined;
	if (toolName === "TaskList") {
		const tasks = parseTaskList(text);
		if (!tasks.length) return undefined;
		const limit = Math.max(1, config.expandedPreviewMaxLines);
		const rows = tasks.slice(0, limit).map((task) => {
			const color =
				task.status === "completed"
					? "success"
					: task.status === "in_progress"
						? "warning"
						: "muted";
			return `   ${theme.fg("accent", `#${task.id}`)} ${theme.fg(color, task.status)} ${theme.fg("dim", task.subject)}`;
		});
		if (tasks.length > rows.length)
			rows.push(theme.fg("muted", `   … ${tasks.length - rows.length} more tasks`));
		return new Text(` ↳ ${theme.fg("muted", taskListSummary(tasks))}\n${rows.join("\n")}`, 0, 0);
	}
	const line = text.trim();
	if (!line || line.includes("\n")) return undefined;
	let formatted: string | undefined;
	let match: RegExpMatchArray | null;
	if (
		toolName === "TaskCreate" &&
		(match = line.match(/^Task #(\d+) created successfully: (.+)$/))
	) {
		formatted = `${theme.fg("success", "Created task")} ${theme.fg("accent", `#${match[1]}`)} ${theme.fg("muted", match[2])}`;
	} else if (toolName === "TaskUpdate" && (match = line.match(/^Updated task #(\d+) (.+)$/))) {
		formatted = `${theme.fg("success", "Updated task")} ${theme.fg("accent", `#${match[1]}`)} ${theme.fg("muted", match[2])}`;
	} else if (toolName === "TaskExecute") {
		formatted = `${theme.fg("success", "Started")} ${theme.fg("muted", line)}`;
	} else if (toolName === "TaskStop") {
		formatted = `${theme.fg("success", "Stopped")} ${theme.fg("muted", line)}`;
	}
	return formatted ? new Text(` ↳ ${formatted}`, 0, 0) : undefined;
}

/** Wrap an arbitrary tool definition with ccstyle call/result rendering. */
function createCcstyleTool(
	originalTool: any,
	writeExecutionMetadata: WriteExecutionMetadataStore,
): any {
	const toolName = originalTool.name;
	const label = isMcpToolDefinition(originalTool, toolName)
		? humanizeMcpToolName(toolName)
		: originalTool.label || toolName;

	return {
		...originalTool,
		renderShell: "self",
		renderCall(args: any, theme: any, context: any) {
			if (config.mode !== "on") {
				return renderDefault(originalTool, "renderCall", [args, theme, context], String(toolName));
			}

			const visualState = resolveToolVisualState(context);
			const isPending =
				visualState === "pending" ||
				(!visualState && (context?.isPartial || context?.executionStarted));
			if (isPending) scheduleAnimation(context);
			const rawIcon = isPending ? pendingIcon(toolName) : settledIcon(toolName, visualState);
			const icon =
				visualState === "success"
					? `${BRIGHT_GREEN}${rawIcon}${ANSI_FG_RESET}`
					: theme.fg(toolIconColor(context), rawIcon);
			const summary = singleToolCallSummary(toolName, label, args);
			let cachedWidth: number | undefined;
			let cachedLine: string | undefined;
			return {
				render(width: number) {
					if (cachedLine !== undefined && cachedWidth === width) return [cachedLine];
					const viewportWidth = toolViewportWidth(width);
					const callWidth = Math.max(0, viewportWidth - visibleWidth(icon) - 2);
					const mainWidth = Math.max(0, callWidth - visibleWidth(summary.detail));
					cachedWidth = width;
					cachedLine = ` ${icon} ${theme.fg("toolTitle", middleTruncateToWidth(summary.main, mainWidth))}${theme.fg("muted", summary.detail)}`;
					return [truncateToWidth(cachedLine, viewportWidth, "")];
				},
				invalidate() {},
			};
		},
		renderResult(result: any, options: any, theme: any, context: any) {
			if (config.mode !== "on") {
				return renderDefault(
					originalTool,
					"renderResult",
					[result, options, theme, context],
					textFromResult(result),
				);
			}

			if (options?.isPartial) {
				return new Text(theme.fg("muted", "   ↳ Pending…"), 0, 0);
			}

			const isError = options?.isError || context?.isError;
			setToolVisualState(context, isError ? "error" : "success");
			const expanded = isToolExpanded(options, context);
			if (shouldRenderRichDiff(config.mode, toolName, Boolean(isError))) {
				// Pass getter so Diff indicator / wrap / limits update on the next paint
				// without recreating the tool result component.
				const richResult = renderRichToolResult(
					toolName,
					result,
					{
						...options,
						expanded,
					},
					theme,
					context,
					writeExecutionMetadata,
					getToolDisplayConfig,
				);
				if (richResult) return insetComponent(richResult);
			}

			const text = textFromResult(result, expanded);
			const args = context?.args;
			if (expanded) {
				const taskResult = renderExpandedTaskResult(toolName, text, theme, Boolean(isError));
				if (taskResult) return taskResult;
			}
			const tasks = !isError && toolName === "TaskList" ? parseTaskList(text) : [];
			const outputLines = outputLineCount(result) || countLines(text);
			const lineWord = outputLines === 1 ? "line" : "lines";
			const action = toolName === "read" ? "loaded" : "returned";
			const rendered = tasks.length
				? taskListSummary(tasks)
				: isError
					? text
						? oneLine(text)
						: "Failed"
					: outputLines
						? `${outputLines} ${lineWord} ${action}`
						: "Done";
			const expandable = !expanded && (tasks.length > 0 || hasExpandableDetail(text, args));
			const hint = expandable ? theme.fg("muted", " • press ctrl-o to expand") : "";
			if (expanded) {
				return renderExpandedToolResult(
					text || "",
					theme,
					Boolean(isError),
					context?.lastComponent,
					args,
					context,
				);
			}
			if (context?.state) context.state.ccstyleIoView = undefined;
			let cachedWidth: number | undefined;
			let cachedLine: string | undefined;
			return {
				render(width: number) {
					if (cachedLine === undefined || cachedWidth !== width) {
						cachedWidth = width;
						cachedLine = theme.fg(
							isError ? "error" : "muted",
							renderCollapsedToolResultToWidth(rendered, hint, width),
						);
					}
					return [cachedLine!];
				},
				invalidate() {},
			};
		},
	};
}

/**
 * Apart from the write override used to capture pre-write content, renderers are
 * applied through ToolExecutionComponent. Patch its lookup once so tools use the
 * same compact fallback shell by default. Tools named in excludeRenderers keep
 * their original renderer.
 */
const GLOBAL_TOOL_RENDER_PATCH = Symbol.for("pi.ccstyle.global-tool-render-patch");
const COMPONENT_TOOL_RENDER_MODE = Symbol.for("pi.ccstyle.component-tool-render-mode");
const COMPONENT_TOOL_SELF_SHELL_MODE = Symbol.for("pi.ccstyle.component-tool-self-shell-mode");
const AGENT_FAMILY_TOOL_NAMES = new Set([
	"Agent",
	"Agents",
	"get_subagent_result",
	"steer_subagent",
]);
// Extensions like pi-subagents provide dedicated renderers for the Agent tool (displayName / run stats); ccstyle preserves them without wrapping.
const DEDICATED_RENDERER_TOOLS = new Set(["Agent"]);

type ToolRenderMethods = {
	hasRendererDefinition: (...args: any[]) => boolean;
	getRenderShell: (...args: any[]) => "default" | "self";
	getCallRenderer: (...args: any[]) => any;
	getResultRenderer: (...args: any[]) => any;
};

type GlobalToolRenderPatch = {
	version: 2;
	prototype: any;
	owner: object;
	active: boolean;
	enabled: () => boolean;
	mode: () => CompactStyleMode;
	wrap: (tool: any) => any;
	byDefinition: WeakMap<object, any>;
	byName: Map<string, any>;
	downstream: ToolRenderMethods;
	installed: ToolRenderMethods;
	// Keep the legacy aliases so an older extension build can read this Symbol.
	originalHasRendererDefinition: ToolRenderMethods["hasRendererDefinition"];
	originalGetRenderShell: ToolRenderMethods["getRenderShell"];
	originalGetCallRenderer: ToolRenderMethods["getCallRenderer"];
	originalGetResultRenderer: ToolRenderMethods["getResultRenderer"];
};

export function isMcpToolDefinition(definition: any, toolName: string): boolean {
	const label = typeof definition?.label === "string" ? definition.label.trim() : "";
	if (/^MCP(?::|$)/i.test(label)) return true;
	if (toolName === "mcp" || /^mcp[_:-]|[_:-]mcp[_:-]/i.test(toolName)) return true;
	if (label) return false;
	const description = typeof definition?.description === "string" ? definition.description : "";
	return /\bModel Context Protocol\b/i.test(description);
}

export function humanizeMcpToolName(toolName: string): string {
	const words = toolName
		.replace(/^mcp(?:[_:-]+)+/i, "")
		.split(/[_:-]+/)
		.filter(Boolean);
	return words.length
		? words.map((word) => word[0]!.toUpperCase() + word.slice(1)).join(" ")
		: "MCP";
}

/** Return true when this tool must keep its original renderer. */
export function preservesOriginalRenderer(
	extensionDefinition: any,
	toolName: string,
	builtInToolDefinition?: any,
	excludeRenderers: readonly string[] = config.excludeRenderers,
): boolean {
	if (!excludeRenderers.includes(toolName)) return false;
	return [extensionDefinition, builtInToolDefinition].some(
		(definition) =>
			definition?.renderShell === "self" ||
			typeof definition?.renderCall === "function" ||
			typeof definition?.renderResult === "function",
	);
}

function syncToolShell(component: any, shell: "default" | "self"): void {
	const target = shell === "self" ? component.selfRenderContainer : component.contentBox;
	if (!target || !Array.isArray(component.children)) return;
	const candidates = new Set(
		[component.contentText, component.contentBox, component.selfRenderContainer].filter(Boolean),
	);
	const indexes = component.children
		.map((child: any, index: number) => (candidates.has(child) ? index : -1))
		.filter((index: number) => index >= 0);
	const targetIndex = indexes[0];
	// During construction getRenderShell() runs immediately before Pi mounts the
	// selected shell. Do not mount it here or the constructor will add it twice.
	if (targetIndex === undefined) return;
	component.children[targetIndex] = target;
	for (const index of indexes.sort((left: number, right: number) => right - left)) {
		if (index !== targetIndex) component.children.splice(index, 1);
	}
}

function shouldGloballyStyleTool(component: any, patch: GlobalToolRenderPatch): boolean {
	const extensionDefinition = component.toolDefinition;
	const builtInDefinition = component.builtInToolDefinition;
	const definition = extensionDefinition ?? builtInDefinition;
	const toolName = String(component.toolName || definition?.name || "");
	const useCcstyle =
		patch.mode() === "on" &&
		!DEDICATED_RENDERER_TOOLS.has(toolName) &&
		!preservesOriginalRenderer(extensionDefinition, toolName, builtInDefinition);
	component[COMPONENT_TOOL_RENDER_MODE] = useCcstyle;
	return useCcstyle;
}

function shouldUseSelfShell(component: any, _patch: GlobalToolRenderPatch): boolean {
	component[COMPONENT_TOOL_SELF_SHELL_MODE] = false;
	return false;
}

function getGloballyStyledTool(component: any, patch: GlobalToolRenderPatch): any {
	const definition = component.toolDefinition ?? component.builtInToolDefinition;
	if (definition && typeof definition === "object") {
		let wrapped = patch.byDefinition.get(definition);
		if (!wrapped) {
			wrapped = patch.wrap(definition);
			patch.byDefinition.set(definition, wrapped);
		}
		return wrapped;
	}

	const name = String(component.toolName || "tool");
	let wrapped = patch.byName.get(name);
	if (!wrapped) {
		wrapped = patch.wrap({ name, label: name });
		patch.byName.set(name, wrapped);
	}
	return wrapped;
}

function prototypeToolRenderMethods(prototype: any): ToolRenderMethods {
	return {
		hasRendererDefinition: prototype.hasRendererDefinition,
		getRenderShell: prototype.getRenderShell,
		getCallRenderer: prototype.getCallRenderer,
		getResultRenderer: prototype.getResultRenderer,
	};
}

function isOwnershipAwarePatch(value: any): value is GlobalToolRenderPatch {
	if (!value || value.version !== 2 || !value.installed || !value.downstream) return false;
	return ["hasRendererDefinition", "getRenderShell", "getCallRenderer", "getResultRenderer"].every(
		(name) =>
			typeof value.installed[name] === "function" && typeof value.downstream[name] === "function",
	);
}

function isLegacyInstalledWrapper(method: unknown, downstreamField: string): boolean {
	if (typeof method !== "function") return false;
	try {
		const source = Function.prototype.toString.call(method);
		return (
			source.includes(downstreamField) &&
			(source.includes("shouldGloballyStyleTool") ||
				source.includes("shouldUseSelfShell") ||
				source.includes("getGloballyStyledTool"))
		);
	} catch {
		return false;
	}
}

function downstreamForGlobalToolInstall(prototype: any, previous: any): ToolRenderMethods {
	const current = prototypeToolRenderMethods(prototype);
	if (!previous || previous.prototype !== prototype) return current;
	if (isOwnershipAwarePatch(previous)) {
		return {
			hasRendererDefinition:
				current.hasRendererDefinition === previous.installed.hasRendererDefinition
					? previous.downstream.hasRendererDefinition
					: current.hasRendererDefinition,
			getRenderShell:
				current.getRenderShell === previous.installed.getRenderShell
					? previous.downstream.getRenderShell
					: current.getRenderShell,
			getCallRenderer:
				current.getCallRenderer === previous.installed.getCallRenderer
					? previous.downstream.getCallRenderer
					: current.getCallRenderer,
			getResultRenderer:
				current.getResultRenderer === previous.installed.getResultRenderer
					? previous.downstream.getResultRenderer
					: current.getResultRenderer,
		};
	}

	// Pre-v2 Symbol state did not retain wrapper references. Recognize its known
	// wrappers when possible; otherwise preserve the current method as external.
	const legacyDownstream = (method: Function, field: string): Function => {
		const saved = previous[field];
		return typeof saved === "function" && isLegacyInstalledWrapper(method, field) ? saved : method;
	};
	return {
		hasRendererDefinition: legacyDownstream(
			current.hasRendererDefinition,
			"originalHasRendererDefinition",
		) as ToolRenderMethods["hasRendererDefinition"],
		getRenderShell: legacyDownstream(
			current.getRenderShell,
			"originalGetRenderShell",
		) as ToolRenderMethods["getRenderShell"],
		getCallRenderer: legacyDownstream(
			current.getCallRenderer,
			"originalGetCallRenderer",
		) as ToolRenderMethods["getCallRenderer"],
		getResultRenderer: legacyDownstream(
			current.getResultRenderer,
			"originalGetResultRenderer",
		) as ToolRenderMethods["getResultRenderer"],
	};
}

function disconnectGlobalToolRenderPatch(patch: any): void {
	if (!patch || typeof patch !== "object") return;
	patch.active = false;
	patch.enabled = () => false;
	patch.mode = () => "off";
	patch.wrap = (tool: any) => tool;
	patch.byDefinition = new WeakMap();
	if (patch.byName && typeof patch.byName.clear === "function") patch.byName.clear();
	else patch.byName = new Map();
}

function installGlobalToolRendering(
	writeExecutionMetadata: WriteExecutionMetadataStore,
): GlobalToolRenderPatch {
	const prototype = (ToolExecutionComponent as any).prototype;
	const host = globalThis as any;
	const previous = host[GLOBAL_TOOL_RENDER_PATCH];
	const downstream = downstreamForGlobalToolInstall(prototype, previous);
	// Any wrapper retained by an external owner must become a callback-free
	// pass-through before the new installation is linked above it.
	disconnectGlobalToolRenderPatch(previous);

	const patch: GlobalToolRenderPatch = {
		version: 2,
		prototype,
		owner: {},
		active: true,
		enabled: () => config.mode === "on",
		mode: () => config.mode,
		wrap: (tool: any) => createCcstyleTool(tool, writeExecutionMetadata),
		byDefinition: new WeakMap(),
		byName: new Map(),
		downstream,
		installed: undefined as any,
		originalHasRendererDefinition: downstream.hasRendererDefinition,
		originalGetRenderShell: downstream.getRenderShell,
		originalGetCallRenderer: downstream.getCallRenderer,
		originalGetResultRenderer: downstream.getResultRenderer,
	};

	patch.installed = {
		hasRendererDefinition: function (this: any, ...args: any[]) {
			if (patch.active && shouldGloballyStyleTool(this, patch)) return true;
			return patch.downstream.hasRendererDefinition.apply(this, args);
		},
		getRenderShell: function (this: any, ...args: any[]) {
			if (!patch.active) return patch.downstream.getRenderShell.apply(this, args);
			const useSelfShell = shouldUseSelfShell(this, patch);
			const useCcstyle = shouldGloballyStyleTool(this, patch);
			const shell =
				useSelfShell || (useCcstyle && !this.expanded)
					? "self"
					: useCcstyle
						? "default"
						: patch.downstream.getRenderShell.apply(this, args);
			syncToolShell(this, shell);
			return shell;
		},
		getCallRenderer: function (this: any, ...args: any[]) {
			if (patch.active && shouldGloballyStyleTool(this, patch)) {
				return getGloballyStyledTool(this, patch).renderCall;
			}
			return patch.downstream.getCallRenderer.apply(this, args);
		},
		getResultRenderer: function (this: any, ...args: any[]) {
			if (patch.active && shouldGloballyStyleTool(this, patch)) {
				return getGloballyStyledTool(this, patch).renderResult;
			}
			return patch.downstream.getResultRenderer.apply(this, args);
		},
	};

	prototype.hasRendererDefinition = patch.installed.hasRendererDefinition;
	prototype.getRenderShell = patch.installed.getRenderShell;
	prototype.getCallRenderer = patch.installed.getCallRenderer;
	prototype.getResultRenderer = patch.installed.getResultRenderer;
	host[GLOBAL_TOOL_RENDER_PATCH] = patch;
	return patch;
}

function deactivateGlobalToolRendering(patch: GlobalToolRenderPatch): void {
	if (!patch.active) return;
	disconnectGlobalToolRenderPatch(patch);
	const prototype = patch.prototype;
	if (prototype.hasRendererDefinition === patch.installed.hasRendererDefinition) {
		prototype.hasRendererDefinition = patch.downstream.hasRendererDefinition;
	}
	if (prototype.getRenderShell === patch.installed.getRenderShell) {
		prototype.getRenderShell = patch.downstream.getRenderShell;
	}
	if (prototype.getCallRenderer === patch.installed.getCallRenderer) {
		prototype.getCallRenderer = patch.downstream.getCallRenderer;
	}
	if (prototype.getResultRenderer === patch.installed.getResultRenderer) {
		prototype.getResultRenderer = patch.downstream.getResultRenderer;
	}
}

const GLOBAL_COMPACTION_RENDER_PATCH = Symbol.for("pi.ccstyle.compaction-render-patch");

type LegacyCompactionRenderPatch = {
	enabled?: () => boolean;
};

/** Disable the pre-native compaction monkey patch left alive by /reload. */
function deactivateLegacyCompactionRendering() {
	const patch = (globalThis as any)[GLOBAL_COMPACTION_RENDER_PATCH] as
		| LegacyCompactionRenderPatch
		| undefined;
	if (patch) patch.enabled = () => false;
}

export default function (
	pi: ExtensionAPI,
	configOverride?: Partial<Config>,
	compactThinking?: CompactThinkingController,
) {
	// The optional override keeps integration tests independent from the user's global config.
	if (configOverride) config = normalizeConfig({ ...config, ...configOverride });
	const writeExecutionMetadata = installWriteOverride(pi, new WriteExecutionMetadataStore());
	let installation:
		| {
				globalToolRendering: GlobalToolRenderPatch;
				toolGrouping: ToolGroupingHooks;
				compactStyle: CompactStyleHooks;
		  }
		| undefined;
	const ensureTuiInstallation = (ctx: any) => {
		if (ctx?.mode !== "tui" || !ctx?.hasUI) return undefined;
		if (installation) return installation;
		const globalToolRendering = installGlobalToolRendering(writeExecutionMetadata);
		const toolGrouping = installToolGrouping(() => config.mode === "on");
		deactivateLegacyCompactionRendering();
		const compactStyle = installCompactStyle(pi, {
			getMode: () => config.mode,
			getExcludeRenderers: () => config.excludeRenderers,
		});
		installation = { globalToolRendering, toolGrouping, compactStyle };
		return installation;
	};

	pi.registerCommand("ccstyle", {
		description: "Configure Claude Code style, fixed editor, and rich diff options",
		getArgumentCompletions: (prefix) => {
			const topLevel = [
				{ value: "on", label: "on", description: "Enable Claude Code style" },
				{ value: "off", label: "off", description: "Use Pi's native renderer" },
				{ value: "compact", label: "compact", description: "Use compact transcript rendering" },
				{ value: "status", label: "status", description: "Show full configuration" },
				{ value: "panel", label: "panel", description: "Open interactive settings panel" },
			];
			return topLevel.filter((item) => item.value.startsWith(prefix));
		},
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			if (!arg || arg === "panel") {
				const hooks = ensureTuiInstallation(ctx);
				if (hooks)
					await showCcstylePanel(
						ctx,
						hooks.compactStyle,
						hooks.toolGrouping,
						compactThinking,
					);
				else ctx.ui?.notify?.("/ccstyle requires TUI mode", "warning");
				return;
			}
			if (arg === "on" || arg === "off" || arg === "compact") {
				const hooks = ensureTuiInstallation(ctx);
				if (hooks) applyStyleMode(arg, ctx, hooks.compactStyle, hooks.toolGrouping);
				else ctx.ui?.notify?.("/ccstyle requires TUI mode", "warning");
				return;
			}
			if (arg === "status") {
				ctx.ui.notify(`Claude Code style: ${formatConfigStatus(config)}`, "info");
				return;
			}
			ctx.ui.notify("Usage: /ccstyle [on|off|compact|status|panel]", "warning");
		},
	});

	pi.on("session_start", async (event, ctx) => {
		const hooks = ensureTuiInstallation(ctx);
		if (!hooks) return;
		hooks.toolGrouping.setTheme(ctx.ui.theme);
		hooks.compactStyle.onSessionStart(event, ctx);
		ctx.ui.setStatus("ccstyle", undefined);
	});

	pi.on("session_compact", async (event, ctx) => {
		const hooks = ensureTuiInstallation(ctx);
		if (!hooks) return;
		hooks.toolGrouping.setTheme(ctx.ui.theme);
		hooks.compactStyle.onSessionCompact(event, ctx);
	});

	pi.on("message_update", async (event, ctx) => {
		installation?.compactStyle.onMessageUpdate(event, ctx);
	});

	pi.on("agent_start", async (event, ctx) => {
		installation?.compactStyle.onAgentStart(event, ctx);
	});

	pi.on("agent_end", async (event, ctx) => {
		installation?.compactStyle.onAgentEnd(event, ctx);
	});

	pi.on("turn_start", async (event, ctx) => {
		installation?.compactStyle.onTurnStart(event, ctx);
	});

	pi.on("tool_execution_start", async (event, ctx) => {
		installation?.toolGrouping.setTheme(ctx.ui.theme);
		installation?.compactStyle.onToolExecutionStart(event, ctx);
	});

	pi.on("tool_execution_update", async (event, ctx) => {
		installation?.compactStyle.onToolExecutionUpdate(event, ctx);
	});

	pi.on("tool_execution_end", async (event, ctx) => {
		installation?.compactStyle.onToolExecutionEnd(event, ctx);
	});

	pi.on("session_shutdown", async (event, ctx) => {
		writeExecutionMetadata.clear();
		const current = installation;
		if (
			!current ||
			(globalThis as any)[GLOBAL_TOOL_RENDER_PATCH] !== current.globalToolRendering ||
			!current.globalToolRendering.active
		)
			return;
		current.compactStyle.onSessionShutdown(event, ctx);
		deactivateGlobalToolRendering(current.globalToolRendering);
		current.toolGrouping.shutdown();
		deactivateLegacyCompactionRendering();
		clearAllAnimations();
		installation = undefined;
	});
}
