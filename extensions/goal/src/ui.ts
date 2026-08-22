import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { getOpenBlockers, getWorkItems, goalWorkOverview } from "./goal-graph.ts";
import type { GoalBlockerDisposition, GoalState, GoalStatus } from "./types.ts";

export const GOAL_USAGE = [
	"Usage:",
	"  /goal <objective>          Start a long-running goal; interactive UI can edit before start",
	"  /goal status               Show expanded goal status",
	"  /goal start                Queue one explicit handoff for the active goal",
	"  /goal import <path> [--yes] Import a PRD/docs file or folder",
	"  /goal edit                 Edit the objective (interactive UI only)",
	"  /goal pause|resume         Pause or resume the active goal",
	"  /goal clear [--yes]        Clear the current goal",
	"  /goal complete [--yes]     Mark the current goal complete",
	"  /goal blockers [--markdown] View report; --markdown prints text; export <path> writes file",
	"",
	"Interactive mode: review, edit, or cancel the drafted objective and acceptance criteria before starting.",
	"Non-interactive mode: use --yes for destructive/import confirmations and --replace to replace goals.",
].join("\n");

export interface GoalUiContext {
	mode?: "tui" | "rpc" | "json" | "print";
	hasUI?: boolean;
	ui?: {
		setStatus?: (key: string, value: string | undefined) => void;
		setWidget?: unknown;
		custom?: <T>(
			factory: (
				tui: { requestRender(): void; terminal?: { rows: number; columns: number } },
				theme: GoalWidgetTheme,
				keybindings: unknown,
				done: (value: T) => void,
			) => GoalOverlayComponent,
			options?: {
				overlay?: boolean;
				overlayOptions?: {
					anchor?: "center";
					width?: number | string;
					minWidth?: number;
					maxHeight?: string;
					margin?: number;
				};
			},
		) => Promise<T>;
	};
}

export type GoalWidgetContent = string[] | GoalWidgetFactory;
export type GoalWidgetFactory = (tui: unknown, theme: GoalWidgetTheme) => GoalWidgetComponent;

export interface GoalWidgetComponent {
	render(width: number): string[];
	invalidate(): void;
}

export interface GoalOverlayComponent extends GoalWidgetComponent {
	handleInput(data: string): void;
}

export interface GoalWidgetTheme {
	fg?: (token: GoalThemeToken, text: string) => string;
	bold?: (text: string) => string;
}

export type GoalThemeToken =
	| "success"
	| "warning"
	| "accent"
	| "muted"
	| "dim"
	| "border"
	| "borderMuted"
	| "customMessageText"
	| "customMessageLabel";

export interface GoalSymbols {
	separator: string;
	ellipsis: string;
	completion: string;
}

export interface GoalSymbolOptions {
	ascii?: boolean;
	highContrast?: boolean;
}

export const GOAL_SYMBOLS: { unicode: GoalSymbols; ascii: GoalSymbols } = {
	unicode: { separator: "·", ellipsis: "…", completion: "✓" },
	ascii: { separator: "-", ellipsis: "...", completion: "[x]" },
};

export interface GoalWidgetPresentation {
	status: GoalStatus;
	label: string;
	objective: string;
	acceptanceCount: number;
	doneCount: number;
	totalCount: number;
	readyCount: number;
	openBlockerCount: number;
	blockedCount: number;
	current?: string;
	completedCount: number;
}

interface GoalWidgetRenderOptions {
	symbols?: GoalSymbols;
	theme?: GoalWidgetTheme;
	width?: number;
}

export function renderGoalSummary(goal: GoalState): string {
	const lines = [
		`Goal: ${goal.objective}`,
		`Status: ${goal.status}`,
		`Progress: ${goal.progress.lastSummary || "No progress recorded yet."}`,
	];

	if (goal.progress.current) lines.push(`Current: ${goal.progress.current}`);
	if (goal.progress.blocked.length > 0) lines.push(`Blocked: ${goal.progress.blocked.length} item(s)`);
	if (goal.acceptanceCriteria.length > 0) lines.push(`Acceptance: ${goal.acceptanceCriteria.length} item(s)`);
	if (goal.sourceDocs.length > 0)
		lines.push(`Source docs: ${goal.sourceDocs.map((doc) => doc.path).join(", ")}`);
	lines.push(`Next actions: ${nextActionsForStatus(goal)}`);

	return lines.join("\n");
}

export function renderGoalStatus(goal: GoalState, symbols = getGoalSymbols()): string {
	return [
		renderGoalSummary(goal),
		"",
		"Acceptance criteria:",
		...formatAcceptanceCriteriaList(goal.acceptanceCriteria),
		"",
		"Constraints:",
		...formatList(goal.constraints),
		"",
		"Progress done:",
		...formatCompletedList(goal.progress.done, symbols),
		"",
		"Current work:",
		`- ${goal.progress.current || "none"}`,
		"",
		"Blocked:",
		...formatList(goal.progress.blocked),
		"",
		"Work items:",
		...formatList(getWorkItems(goal).map((item) => `[${item.state}] ${item.title}`)),
		"",
		"Structured blockers:",
		...formatList(
			getOpenBlockers(goal).map((blocker) => `[${blocker.disposition}] ${blocker.title}: ${blocker.reason}`),
		),
		"",
		"Source docs:",
		...formatList(goal.sourceDocs.map((doc) => `${doc.path} (${doc.kind}): ${doc.brief}`)),
		"",
		"Commands:",
		`- ${nextActionsForStatus(goal)}`,
	].join("\n");
}

export function createGoalWidgetPresentation(goal: GoalState): GoalWidgetPresentation | undefined {
	if (goal.status !== "active") return undefined;
	const overview = goalWorkOverview(goal);
	return {
		status: goal.status,
		label: "Goal",
		objective: goal.objective,
		acceptanceCount: goal.acceptanceCriteria.length,
		doneCount: overview.done,
		totalCount: overview.total,
		readyCount: overview.ready.length,
		openBlockerCount: overview.openBlockers,
		blockedCount: goal.progress.blocked.length,
		current: goal.progress.current || undefined,
		completedCount: goal.progress.done.length,
	};
}

export function renderGoalWidget(goal: GoalState, symbols = getGoalSymbols()): string[] | undefined {
	const presentation = createGoalWidgetPresentation(goal);
	return presentation ? renderGoalWidgetPresentation(presentation, { symbols }) : undefined;
}

export function renderGoalWidgetPresentation(
	presentation: GoalWidgetPresentation,
	options: GoalWidgetRenderOptions = {},
): string[] {
	const symbols = options.symbols ?? getGoalSymbols();
	const separator = ` ${symbols.separator} `;
	const status = styleWidgetPart(presentation.status, statusLabel(presentation.status), options.theme);
	const progressParts = [`🎯 ${presentation.doneCount}/${presentation.totalCount}`];
	if (presentation.openBlockerCount > 0) {
		progressParts.push(`${presentation.readyCount === 0 ? "⛔" : "⚠"}${presentation.openBlockerCount}`);
	}
	progressParts.push(`▶${presentation.readyCount}`);
	const progress = progressParts.join(separator);
	const metadata = [
		styleWidgetPart("label", presentation.label, options.theme),
		status,
		styleWidgetPart("acceptance", `AC: ${presentation.acceptanceCount}`, options.theme),
		styleWidgetPart("progress", progress, options.theme),
	];
	if (presentation.blockedCount > 0) {
		metadata.push(styleWidgetPart("blocked", `Blocked: ${presentation.blockedCount}`, options.theme));
	}
	if (presentation.completedCount > 0) {
		metadata.push(
			styleWidgetPart("completed", `${symbols.completion} ${presentation.completedCount}`, options.theme),
		);
	}

	const objective = truncatePlain(presentation.objective, 80, symbols.ellipsis);
	const lines = [
		`${metadata.join(separator)}${separator}${styleWidgetPart("objective", objective, options.theme)}`,
	];
	if (presentation.current) {
		const current = truncatePlain(presentation.current, 80, symbols.ellipsis);
		lines.push(
			`${styleWidgetPart("current", "Now", options.theme)}${separator}${styleWidgetPart("current", current, options.theme)}`,
		);
	}
	return options.width === undefined
		? lines
		: lines.map((line) => truncateToWidth(line, options.width ?? 0, symbols.ellipsis));
}

export function createGoalWidgetFactory(presentation: GoalWidgetPresentation): GoalWidgetFactory {
	return (_tui, theme) => ({
		render(width: number) {
			return renderGoalWidgetPresentation(presentation, { theme, width });
		},
		invalidate() {
			// Stateless render: theme colors are computed fresh in render(), so invalidation only satisfies Pi's component contract.
		},
	});
}

export function getGoalSymbols(options: GoalSymbolOptions = {}): GoalSymbols {
	return options.ascii || options.highContrast ? GOAL_SYMBOLS.ascii : GOAL_SYMBOLS.unicode;
}

export function renderContinuationStatus(kind: "queued" | "running"): string {
	return kind === "queued" ? "goal: continuation queued" : "goal: continuation running";
}

export function applyGoalUi(ctx: GoalUiContext, goal: GoalState | null): void {
	ctx.ui?.setStatus?.("goal", undefined);
	ctx.ui?.setStatus?.("goal-progress", undefined);
	const presentation = goal ? createGoalWidgetPresentation(goal) : undefined;
	if (!presentation || !goal) {
		setGoalWidget(ctx, undefined);
		return;
	}
	const content =
		ctx.mode === "tui" ? createGoalWidgetFactory(presentation) : renderGoalWidgetPresentation(presentation);
	setGoalWidget(ctx, content);
}

export async function showGoalBlockers(ctx: GoalUiContext, goal: GoalState): Promise<boolean> {
	if (ctx.mode !== "tui" || !ctx.ui?.custom) return false;
	await ctx.ui.custom<void>(
		(tui, theme, _keybindings, done) => {
			let disposition: GoalBlockerDisposition | "all" = "all";
			let scrollOffset = 0;
			let pageSize = 1;
			let totalLines = 1;
			const cycle = (): void => {
				disposition =
					disposition === "all"
						? "needs_user"
						: disposition === "needs_user"
							? "agent_can_try"
							: disposition === "agent_can_try"
								? "external_wait"
								: "all";
			};
			const scrollTo = (nextOffset: number): void => {
				scrollOffset = Math.max(0, Math.min(nextOffset, Math.max(0, totalLines - pageSize)));
				tui.requestRender();
			};
			return {
				render(width) {
					const inner = Math.max(1, width - 2);
					const bodyInner = Math.max(1, inner - 1);
					const openBlockers = (goal.blockers ?? []).filter((blocker) => blocker.state === "open");
					const blockers = openBlockers.filter(
						(blocker) => disposition === "all" || blocker.disposition === disposition,
					);
					const style = (token: GoalThemeToken, text: string): string => theme.fg?.(token, text) ?? text;
					const border = (text: string): string => style("border", text);
					const padLine = (text: string, lineWidth = inner): string => {
						const truncated = truncateToWidth(text, lineWidth);
						return truncated + " ".repeat(Math.max(0, lineWidth - visibleWidth(truncated)));
					};
					const summary = [
						style("warning", `Needs you ${countBlockers(openBlockers, "needs_user")}`),
						style("accent", `Agent can try ${countBlockers(openBlockers, "agent_can_try")}`),
						style("muted", `Waiting ${countBlockers(openBlockers, "external_wait")}`),
					].join(" · ");
					const barWidth = Math.max(1, Math.min(48, inner - 2));
					let remaining = barWidth;
					const distribution: Array<[GoalBlockerDisposition, GoalThemeToken]> = [
						["needs_user", "warning"],
						["agent_can_try", "accent"],
						["external_wait", "muted"],
					];
					const bar =
						openBlockers.length === 0
							? style("muted", "░".repeat(barWidth))
							: distribution
									.map(([kind, token], index) => {
										const count = countBlockers(openBlockers, kind);
										const cells =
											index === distribution.length - 1
												? remaining
												: Math.min(remaining, Math.round((count / openBlockers.length) * barWidth));
										remaining -= cells;
										return style(token, "█".repeat(Math.max(0, cells)));
									})
									.join("");
					const bodyLines =
						blockers.length > 0
							? blockers.flatMap((blocker, index) => {
									const impact =
										blocker.workItemIds.length === 0
											? "all work items"
											: `${blocker.workItemIds.length} work item${blocker.workItemIds.length === 1 ? "" : "s"}`;
									return [
										...(index > 0 ? [style("borderMuted", "─".repeat(bodyInner))] : []),
										style("customMessageLabel", `● ${blocker.title}`),
										`  ${style(blockerDispositionToken(blocker.disposition), blockerDispositionLabel(blocker.disposition))} · ${blocker.kind.replaceAll("_", " ")} · ${impact}`,
										`  ${style("muted", "Why:")} ${blocker.reason}`,
										`  ${style("muted", "Next:")} ${blocker.proposedResolution ?? blockerDispositionNextStep(blocker.disposition)}`,
									];
								})
							: [style("muted", `No ${blockerDispositionLabel(disposition).toLowerCase()} blockers.`)];
					const terminalHeight = Math.max(1, tui.terminal?.rows ?? 24);
					const viewportHeight = Math.min(30, Math.max(9, Math.floor(terminalHeight * 0.8)), terminalHeight);
					pageSize = Math.max(1, viewportHeight - 8);
					totalLines = bodyLines.length;
					scrollOffset = Math.min(scrollOffset, Math.max(0, totalLines - pageSize));
					const visible = bodyLines.slice(scrollOffset, scrollOffset + pageSize);
					const scrollable = totalLines > pageSize;
					const thumbSize = scrollable ? Math.max(1, Math.floor((pageSize * pageSize) / totalLines)) : 0;
					const maxScrollOffset = Math.max(0, totalLines - pageSize);
					const thumbStart =
						scrollable && maxScrollOffset > 0
							? Math.round((scrollOffset / maxScrollOffset) * (pageSize - thumbSize))
							: 0;
					const scrollbar = (row: number): string => {
						if (!scrollable) return " ";
						const inThumb = row >= thumbStart && row < thumbStart + thumbSize;
						return style(inThumb ? "accent" : "borderMuted", inThumb ? "█" : "│");
					};
					const bodyRows = Array.from({ length: pageSize }, (_, row) => {
						const line = visible[row] ?? "";
						return `${border("│")}${padLine(` ${line}`, bodyInner)}${scrollbar(row)}${border("│")}`;
					});
					const start = totalLines === 0 ? 0 : scrollOffset + 1;
					const end = Math.min(totalLines, scrollOffset + pageSize);
					const title = theme.bold?.(style("accent", "Goal blockers")) ?? style("accent", "Goal blockers");
					const esc = style("muted", "[esc]");
					const status = `${start}-${end} / ${totalLines} rows · ${blockers.length} blockers · ↑↓ PgUp/PgDn Home/End · Tab filter · [esc] close`;
					return [
						border(`╭${"─".repeat(inner)}╮`),
						`${border("│")}${padLine(` ${title}  ${style("muted", `Open ${openBlockers.length}`)}`, inner - visibleWidth(esc))}${esc}${border("│")}`,
						`${border("├")}${border("─".repeat(inner))}${border("┤")}`,
						`${border("│")}${padLine(` ${bar}`, inner)}${border("│")}`,
						`${border("│")}${padLine(` ${summary} · Filter: ${blockerDispositionLabel(disposition)}`, inner)}${border("│")}`,
						`${border("├")}${border("─".repeat(inner))}${border("┤")}`,
						...bodyRows,
						`${border("├")}${border("─".repeat(inner))}${border("┤")}`,
						`${border("│")}${padLine(style("dim", ` ${status}`), inner)}${border("│")}`,
						border(`╰${"─".repeat(inner)}╯`),
					];
				},
				invalidate() {},
				handleInput(data) {
					if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
						done(undefined);
						return;
					}
					if (matchesKey(data, Key.tab)) {
						cycle();
						scrollOffset = 0;
						tui.requestRender();
						return;
					}
					if (matchesKey(data, Key.up)) scrollTo(scrollOffset - 1);
					else if (matchesKey(data, Key.down)) scrollTo(scrollOffset + 1);
					else if (matchesKey(data, "pageUp")) scrollTo(scrollOffset - pageSize);
					else if (matchesKey(data, "pageDown")) scrollTo(scrollOffset + pageSize);
					else if (matchesKey(data, Key.home)) scrollTo(0);
					else if (matchesKey(data, Key.end)) scrollTo(totalLines - pageSize);
				},
			};
		},
		{
			overlay: true,
			overlayOptions: { anchor: "center", width: "85%", minWidth: 50, maxHeight: "80%", margin: 2 },
		},
	);
	return true;
}

function countBlockers(blockers: GoalState["blockers"], disposition: GoalBlockerDisposition): number {
	return blockers?.filter((blocker) => blocker.disposition === disposition).length ?? 0;
}

function blockerDispositionLabel(disposition: GoalBlockerDisposition | "all"): string {
	if (disposition === "needs_user") return "Needs you";
	if (disposition === "agent_can_try") return "Agent can try";
	if (disposition === "external_wait") return "Waiting externally";
	return "All blockers";
}

function blockerDispositionToken(disposition: GoalBlockerDisposition): GoalThemeToken {
	if (disposition === "needs_user") return "warning";
	if (disposition === "agent_can_try") return "accent";
	return "muted";
}

function blockerDispositionNextStep(disposition: GoalBlockerDisposition): string {
	if (disposition === "needs_user") return "Provide the required decision or approval.";
	if (disposition === "agent_can_try") return "Try the recorded safe next step within budget.";
	return "Wait for the external dependency, then reassess.";
}

export function noGoalMessage(action: string): string {
	return `No goal exists to ${action}. Start one with /goal <objective> or import docs with /goal import <path>.`;
}

export function nonInteractiveConfirmationMessage(command: string): string {
	return `${command} requires --yes in non-interactive mode. Re-run with --yes after reviewing the action.`;
}

function setGoalWidget(ctx: GoalUiContext, content: GoalWidgetContent | undefined): void {
	if (typeof ctx.ui?.setWidget !== "function") return;
	(ctx.ui.setWidget as (key: string, value: GoalWidgetContent | undefined) => void)("goal", content);
}

function styleWidgetPart(
	part:
		| "label"
		| "active"
		| "paused"
		| "complete"
		| "acceptance"
		| "progress"
		| "blocked"
		| "completed"
		| "current"
		| "objective",
	text: string,
	theme?: GoalWidgetTheme,
): string {
	switch (part) {
		case "active":
			return theme?.fg?.("success", text) ?? text;
		case "paused":
			return theme?.fg?.("dim", text) ?? text;
		case "complete":
		case "completed":
			return theme?.fg?.("success", text) ?? text;
		case "acceptance":
		case "progress":
			return theme?.fg?.("muted", text) ?? text;
		case "blocked":
			return theme?.fg?.("warning", text) ?? text;
		case "current":
			return theme?.fg?.("accent", text) ?? text;
		case "label": {
			const label = theme?.bold?.(text) ?? text;
			return theme?.fg?.("customMessageLabel", label) ?? label;
		}
		case "objective":
			return theme?.fg?.("customMessageText", text) ?? text;
	}
}

function statusLabel(status: GoalStatus): string {
	if (status === "active") return "Active";
	if (status === "paused") return "Paused";
	return "Complete";
}

function nextActionsForStatus(goal: GoalState): string {
	if (goal.status === "active") return "/goal status, /goal pause, /goal complete, /goal clear";
	if (goal.status === "paused") return "/goal resume, /goal status, /goal clear";
	return "/goal status, /goal clear, or /goal <objective> --replace";
}

function formatList(items: string[]): string[] {
	return items.length === 0 ? ["- none"] : items.map((item) => `- ${item}`);
}

function formatCompletedList(items: string[], symbols: GoalSymbols): string[] {
	return items.length === 0 ? ["- none"] : items.map((item) => `${symbols.completion} ${item}`);
}

function formatAcceptanceCriteriaList(items: string[]): string[] {
	return items.length === 0
		? ["- No acceptance criteria were specified for this goal; use the objective as the source of truth."]
		: formatList(items);
}

function truncatePlain(value: string, maxLength: number, ellipsis: string): string {
	return value.length <= maxLength
		? value
		: `${value.slice(0, Math.max(0, maxLength - ellipsis.length))}${ellipsis}`;
}
