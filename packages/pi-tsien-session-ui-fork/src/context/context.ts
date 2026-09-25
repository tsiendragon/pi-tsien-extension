import {
	type ExtensionAPI,
	type ExtensionCommandContext,
	estimateTokens,
} from "@earendil-works/pi-coding-agent";
import { adjustGuidelinesSection, readDefaultSystemPrompt, replaceSystemPromptIntro } from "pi-tsien-default-system-prompt/src/index.ts";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
	showTextPreview,
	normalizePreviewText,
	parseSgrMousePacket,
	mouseBaseButton,
	escCloseHitbox,
} from "../shared/text-preview.ts";

export type ContextPart = {
	label: string;
	tokens: number;
	color: "accent" | "success" | "warning" | "muted" | "dim";
};

type PreviewKey = "systemPrompt" | "tools" | "contextFiles" | "skills";

type ContextPreview = {
	key: PreviewKey;
	label: string;
	title: string;
	content: string;
};

const tokenEstimate = (value: unknown): number => {
	if (!value) return 0;
	const text = typeof value === "string" ? value : JSON.stringify(value);
	return Math.max(0, Math.ceil(text.length / 4));
};

type ToolPreviewInfo = {
	name: string;
	description?: string;
	promptGuidelines?: string[];
};

export function scaleParts(parts: ContextPart[], target: number): ContextPart[] {
	const estimated = parts.reduce((sum, part) => sum + part.tokens, 0);
	if (estimated === 0 || target <= 0) return parts;
	const scaled = parts.map((part) => ({
		...part,
		tokens: Math.round((part.tokens / estimated) * target),
	}));
	const delta = target - scaled.reduce((sum, part) => sum + part.tokens, 0);
	const largest = scaled.reduce(
		(best, part, index) => (part.tokens > scaled[best]!.tokens ? index : best),
		0,
	);
	scaled[largest]!.tokens += delta;
	return scaled;
}

export function formatTokens(tokens: number): string {
	return Math.round(tokens).toLocaleString("en-US");
}

type SystemPromptOptions = {
	contextFiles?: Array<{ path: string; content: string }>;
	skills?: Array<{
		name: string;
		description?: string;
		filePath?: string;
		disableModelInvocation?: boolean;
	}>;
	selectedTools?: string[];
	toolSnippets?: Record<string, string>;
	promptGuidelines?: string[];
};

type ContextBreakdown = {
	parts: ContextPart[];
	options: SystemPromptOptions;
	systemPrompt: string;
};

/**
 * Single pass over prompt options + session entries. Returns options/systemPrompt
 * so the /context UI does not re-fetch or re-stringify the same sources.
 */
async function collectContextBreakdown(ctx: ExtensionCommandContext): Promise<ContextBreakdown> {
	const options = (ctx.getSystemPromptOptions?.() ?? {}) as SystemPromptOptions;
	const baseSystemPrompt = typeof ctx.getSystemPrompt === "function" ? ctx.getSystemPrompt() : "";
	let systemPrompt = baseSystemPrompt;
	try {
		const customIntro = await readDefaultSystemPrompt();
		systemPrompt = adjustGuidelinesSection(
			replaceSystemPromptIntro(baseSystemPrompt, customIntro) ?? baseSystemPrompt,
		);
	} catch {
		// Match the runtime extension: a missing or unreadable custom file leaves Pi's prompt unchanged.
	}

	const contextFileTokens = (options.contextFiles ?? []).reduce(
		(sum, file) => sum + tokenEstimate(file.content),
		0,
	);
	// Prefer field-level estimates over JSON.stringify(whole skill).
	const skillTokens = (options.skills ?? []).reduce((sum, skill) => {
		if (!skill || typeof skill !== "object") return sum + tokenEstimate(skill);
		return (
			sum +
			tokenEstimate(skill.name) +
			tokenEstimate(skill.description) +
			tokenEstimate(skill.filePath)
		);
	}, 0);
	const tools = options.selectedTools ?? [];
	const snippets = options.toolSnippets;
	let toolTokens = tokenEstimate(options.promptGuidelines);
	for (const name of tools) {
		toolTokens += tokenEstimate(name) + tokenEstimate(snippets?.[name]);
	}

	let user = 0;
	let assistant = 0;
	let toolResults = 0;
	let summaries = 0;
	for (const entry of ctx.sessionManager.buildContextEntries()) {
		if (entry.type === "message") {
			const tokens = estimateTokens(entry.message);
			if (entry.message.role === "user") user += tokens;
			else if (entry.message.role === "assistant") assistant += tokens;
			else toolResults += tokens;
		} else if (entry.type === "compaction" || entry.type === "branch_summary") {
			summaries += tokenEstimate(entry);
		}
	}

	const systemTotal = tokenEstimate(systemPrompt);
	const baseSystem = Math.max(0, systemTotal - contextFileTokens - skillTokens - toolTokens);
	const parts: ContextPart[] = [
		{ label: "System prompt", tokens: baseSystem, color: "accent" },
		{ label: "Tools", tokens: toolTokens, color: "success" },
		{ label: "Context files", tokens: contextFileTokens, color: "warning" },
		{ label: "Skills", tokens: skillTokens, color: "warning" },
		{ label: "User messages", tokens: user, color: "muted" },
		{ label: "Assistant messages", tokens: assistant, color: "accent" },
		{ label: "Tool results", tokens: toolResults, color: "dim" },
		{ label: "Compaction summaries", tokens: summaries, color: "success" },
	];
	return {
		parts: parts.filter((part) => part.tokens > 0),
		options,
		systemPrompt,
	};
}

export default function contextUsageExtension(pi: ExtensionAPI) {
	pi.registerCommand("context", {
		description: "Show the current context-window distribution",
		handler: async (_args, ctx) => {
			const usage = ctx.getContextUsage();
			const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
			const breakdown = await collectContextBreakdown(ctx);
			const used = usage?.tokens ?? breakdown.parts.reduce((sum, part) => sum + part.tokens, 0);
			const parts = scaleParts(breakdown.parts, used);
			const free = Math.max(0, contextWindow - used);
			const allParts = [...parts, { label: "Free space", tokens: free, color: "dim" as const }];

			if (ctx.mode !== "tui") {
				const lines = allParts.map((part) => `${part.label}: ${formatTokens(part.tokens)} tokens`);
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}

			const options = breakdown.options;
			const toolByName = new Map<string, ToolPreviewInfo>(
				(pi.getAllTools() as ToolPreviewInfo[]).map((tool) => [tool.name, tool] as const),
			);
			const toolContent = (options.selectedTools ?? []).map((name) => {
				const tool = toolByName.get(name);
				const lines = [`## ${name}`];
				if (tool?.description) lines.push(tool.description);
				if (options.toolSnippets?.[name]) lines.push(`Prompt: ${options.toolSnippets[name]}`);
				if (tool?.promptGuidelines?.length) {
					lines.push("Guidelines:", ...tool.promptGuidelines.map((guideline) => `- ${guideline}`));
				}
				return lines.join("\n");
			});
			if (options.promptGuidelines?.length) {
				toolContent.push(
					`## Shared prompt guidelines\n${options.promptGuidelines.map((guideline) => `- ${guideline}`).join("\n")}`,
				);
			}
			const contextFilesContent = (options.contextFiles ?? [])
				.map((file) => `===== ${file.path} =====\n${file.content}`)
				.join("\n\n");
			const skillsContent = (options.skills ?? [])
				.map((skill) =>
					[
						`## ${skill.name}`,
						skill.description,
						`Path: ${skill.filePath}`,
						`Model invocation: ${skill.disableModelInvocation ? "disabled" : "enabled"}`,
					]
						.filter(Boolean)
						.join("\n"),
				)
				.join("\n\n");
			const rawPreviews: ContextPreview[] = [
				{
					key: "systemPrompt",
					label: "System prompt",
					title: "System Prompt",
					content: breakdown.systemPrompt,
				},
				{
					key: "tools",
					label: "Tools",
					title: "Tools",
					content: toolContent.join("\n\n") || "No active tools.",
				},
				{
					key: "contextFiles",
					label: "Context files",
					title: "Context Files",
					content: contextFilesContent || "No context files loaded.",
				},
				{
					key: "skills",
					label: "Skills",
					title: "Skills",
					content: skillsContent || "No skills loaded.",
				},
			];
			const previews = rawPreviews.map((preview) => ({
				...preview,
				content: normalizePreviewText(preview.content),
			}));
			const previewByKey = new Map(previews.map((preview) => [preview.key, preview]));
			const visiblePreviews = previews.filter((preview) =>
				allParts.some((part) => part.label === preview.label),
			);
			let selectedPreviewIndex = 0;

			while (true) {
				const action = await ctx.ui.custom(
					(tui, theme, _keybindings, done) => {
						let previewHitboxes: Array<{
							key: PreviewKey;
							row: number;
							startCol: number;
							endCol: number;
						}> = [];
						let escHitbox: { row: number; startCol: number; endCol: number } | undefined;

						const padLine = (text: string, width: number): string => {
							const truncated = truncateToWidth(text, width, "…");
							return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
						};

						return {
							invalidate() {},
							handleInput(data: string) {
								if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
									done(undefined);
									return;
								}
								if (matchesKey(data, Key.up) && visiblePreviews.length > 0) {
									selectedPreviewIndex =
										(selectedPreviewIndex - 1 + visiblePreviews.length) % visiblePreviews.length;
									tui.requestRender();
									return;
								}
								if (matchesKey(data, Key.down) && visiblePreviews.length > 0) {
									selectedPreviewIndex = (selectedPreviewIndex + 1) % visiblePreviews.length;
									tui.requestRender();
									return;
								}
								if (matchesKey(data, Key.enter)) {
									done(visiblePreviews[selectedPreviewIndex]?.key);
									return;
								}

								const mouse = parseSgrMousePacket(data);
								if (
									mouse?.final !== "M" ||
									mouseBaseButton(mouse.code) !== 0 ||
									(mouse.code & 32) !== 0
								)
									return;
								if (
									escHitbox &&
									mouse.row === escHitbox.row &&
									mouse.col >= escHitbox.startCol &&
									mouse.col <= escHitbox.endCol
								) {
									done(undefined);
									return;
								}
								const hitbox = previewHitboxes.find(
									(candidate) =>
										mouse.row === candidate.row &&
										mouse.col >= candidate.startCol &&
										mouse.col <= candidate.endCol,
								);
								if (hitbox) {
									selectedPreviewIndex = Math.max(
										0,
										visiblePreviews.findIndex((preview) => preview.key === hitbox.key),
									);
									done(hitbox.key);
								}
							},
							render(width: number) {
								const inner = Math.max(1, width - 2);
								const escWidth = visibleWidth("[esc]");
								const percent = contextWindow > 0 ? (used / contextWindow) * 100 : 0;
								const title = theme.bold(theme.fg("accent", "Context Usage"));
								const subtitle = `${formatTokens(used)} / ${formatTokens(contextWindow)} tokens (${percent.toFixed(1)}%)`;
								const barWidth = Math.max(1, Math.min(60, inner - 2));
								let remaining = barWidth;
								const segments = allParts
									.map((part, index) => {
										const cells =
											index === allParts.length - 1
												? remaining
												: Math.min(
														remaining,
														Math.round((part.tokens / Math.max(1, contextWindow)) * barWidth),
													);
										remaining -= cells;
										return theme.fg(part.color, "█".repeat(Math.max(0, cells)));
									})
									.join("");
								const labelWidth = Math.min(
									24,
									Math.max(...allParts.map((part) => part.label.length)),
								);
								const selectedLabel = visiblePreviews[selectedPreviewIndex]?.label;
								const partRows = allParts.map((part) => {
									const pct = contextWindow > 0 ? (part.tokens / contextWindow) * 100 : 0;
									const swatch = theme.fg(part.color, "■");
									const label = part.label.padEnd(labelWidth);
									const amount = `${formatTokens(part.tokens).padStart(7)}  ${pct.toFixed(1).padStart(5)}%`;
									const selected = part.label === selectedLabel;
									const prefix = selected ? "› " : "  ";
									const row = padLine(`${prefix}${swatch} ${label} ${amount}`, inner);
									return selected ? theme.bg("selectedBg", row) : row;
								});
								const border = (text: string) => theme.fg("border", text);
								const lines = [
									border(`╭${"─".repeat(inner)}╮`),
									`${border("│")}${padLine(` ${title}  ${theme.fg("muted", subtitle)}`, inner - escWidth)}${theme.fg("muted", "[esc]")}${border("│")}`,
									`${border("├")}${border("─".repeat(inner))}${border("┤")}`,
									`${border("│")}${padLine(` ${segments}`, inner)}${border("│")}`,
									`${border("│")}${" ".repeat(inner)}${border("│")}`,
									...partRows.map((row) => `${border("│")}${row}${border("│")}`),
									`${border("├")}${border("─".repeat(inner))}${border("┤")}`,
									`${border("│")}${padLine(theme.fg("dim", " ↑↓ select · Click / Enter to preview · [esc] close"), inner)}${border("│")}`,
									border(`╰${"─".repeat(inner)}╯`),
								];

								const terminalHeight = Math.max(1, tui.terminal.rows);
								const maxHeight = Math.min(
									Math.max(1, Math.floor(terminalHeight * 0.9)),
									Math.max(1, terminalHeight - 2),
								);
								const visibleHeight = Math.min(lines.length, maxHeight);
								const overlayTop =
									1 + Math.floor((Math.max(1, terminalHeight - 2) - visibleHeight) / 2);
								const overlayLeft = Math.floor((Math.max(1, tui.terminal.columns) - width) / 2);
								escHitbox = escCloseHitbox({ left: overlayLeft, top: overlayTop, width });
								previewHitboxes = visiblePreviews.flatMap((preview) => {
									const partIndex = allParts.findIndex((part) => part.label === preview.label);
									const line = 5 + partIndex;
									return partIndex >= 0 && line < visibleHeight
										? [
												{
													key: preview.key,
													row: overlayTop + line + 1,
													startCol: overlayLeft + 1,
													endCol: overlayLeft + width,
												},
											]
										: [];
								});

								return lines;
							},
						};
					},
					{
						overlay: true,
						overlayOptions: {
							anchor: "center",
							width: 64,
							minWidth: 44,
							maxHeight: "90%",
							margin: 1,
						},
					},
				);

				if (!action) break;
				const preview = previewByKey.get(action as PreviewKey);
				if (!preview) continue;

				await showTextPreview(ctx, preview.title, preview.content);
			}
		},
	});
}
