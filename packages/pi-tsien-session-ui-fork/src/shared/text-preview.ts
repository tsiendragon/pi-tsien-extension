/**
 * shared/text-preview.ts
 *
 * Generic text-preview dialog (showTextPreview) plus its text/mouse helpers.
 * Shared by context (/context content preview) and ccstyle (tool Input/Output [show more]).
 */
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Key, Markdown, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export function normalizePreviewText(text: string): string {
	return text
		.replace(/\r\n?/g, "\n")
		.replace(/\t/g, "  ")
		.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}

export type DialogBounds = { left: number; top: number; width: number };

/** 1-based terminal hitbox of the [esc] close button on the dialog title row (row 2 of the box). */
export function escCloseHitbox(bounds: DialogBounds): {
	row: number;
	startCol: number;
	endCol: number;
} {
	return {
		row: bounds.top + 2,
		startCol: bounds.left + bounds.width - 5,
		endCol: bounds.left + bounds.width - 1,
	};
}

type SgrMousePacket = {
	code: number;
	col: number;
	row: number;
	final: "M" | "m";
};

export function parseSgrMousePacket(data: string): SgrMousePacket | null {
	const match = data.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/);
	if (!match) return null;
	return {
		code: Number(match[1]),
		col: Number(match[2]),
		row: Number(match[3]),
		final: match[4] as "M" | "m",
	};
}

export function mouseBaseButton(code: number): number {
	return code & ~(4 | 8 | 16 | 32);
}

export async function showTextPreview(
	ctx: Pick<ExtensionCommandContext, "ui">,
	title: string,
	rawContent: string,
): Promise<void> {
	const content = normalizePreviewText(rawContent);
	await ctx.ui.custom(
		(tui, theme, _keybindings, done) => {
			let scrollOffset = 0;
			let pageSize = 1;
			let totalLines = 1;
			let escHitbox: { row: number; startCol: number; endCol: number } | undefined;
			const markdownView = new Markdown(content, 0, 0, getMarkdownTheme());

			const scrollTo = (nextOffset: number): void => {
				scrollOffset = Math.max(0, Math.min(nextOffset, Math.max(0, totalLines - pageSize)));
				tui.requestRender();
			};

			return {
				invalidate() {
					markdownView.invalidate();
				},
				handleInput(data: string) {
					if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
						done(undefined);
						return;
					}
					if (matchesKey(data, Key.up)) scrollTo(scrollOffset - 1);
					else if (matchesKey(data, Key.down)) scrollTo(scrollOffset + 1);
					else if (matchesKey(data, "pageUp")) scrollTo(scrollOffset - pageSize);
					else if (matchesKey(data, "pageDown")) scrollTo(scrollOffset + pageSize);
					else if (matchesKey(data, Key.home)) scrollTo(0);
					else if (matchesKey(data, Key.end)) scrollTo(totalLines - pageSize);
					else {
						const mouse = parseSgrMousePacket(data);
						if (mouse?.final !== "M") return;
						const button = mouseBaseButton(mouse.code);
						if (button === 0 && (mouse.code & 32) === 0) {
							if (
								escHitbox &&
								mouse.row === escHitbox.row &&
								mouse.col >= escHitbox.startCol &&
								mouse.col <= escHitbox.endCol
							) {
								done(undefined);
								return;
							}
						}
						if (button === 64) scrollTo(scrollOffset - 3);
						else if (button === 65) scrollTo(scrollOffset + 3);
					}
				},
				render(width: number) {
					const inner = Math.max(1, width - 2);
					const escWidth = visibleWidth("[esc]");
					const bodyInner = Math.max(1, inner - 1);
					const bodyWidth = Math.max(1, bodyInner - 1);
					const terminalHeight = Math.max(1, tui.terminal.rows);
					const availableHeight = Math.max(1, terminalHeight - 4);
					const viewportHeight = Math.min(
						30,
						Math.max(1, Math.floor(terminalHeight * 0.8)),
						availableHeight,
					);
					pageSize = Math.max(1, viewportHeight - 6);
					const wrapped = markdownView.render(bodyWidth);
					totalLines = wrapped.length;
					scrollOffset = Math.min(scrollOffset, Math.max(0, totalLines - pageSize));
					// Centered overlay with margin 2: mirror TUI resolveOverlayLayout for anchor "center".
					const overlayTop = 2 + Math.floor((availableHeight - viewportHeight) / 2);
					const overlayLeft = Math.floor((Math.max(1, tui.terminal.columns) - width) / 2);
					escHitbox = escCloseHitbox({ left: overlayLeft, top: overlayTop, width });
					const visible = wrapped.slice(scrollOffset, scrollOffset + pageSize);
					const border = (text: string) => theme.fg("border", text);
					const padLine = (text: string, lineWidth = inner): string => {
						const truncated = truncateToWidth(text, lineWidth, "…");
						return truncated + " ".repeat(Math.max(0, lineWidth - visibleWidth(truncated)));
					};
					const scrollable = totalLines > pageSize;
					const thumbSize = scrollable
						? Math.max(1, Math.floor((pageSize * pageSize) / totalLines))
						: 0;
					const maxScrollOffset = Math.max(0, totalLines - pageSize);
					const thumbStart =
						scrollable && maxScrollOffset > 0
							? Math.round((scrollOffset / maxScrollOffset) * (pageSize - thumbSize))
							: 0;
					const scrollbar = (row: number): string => {
						if (!scrollable) return " ";
						const inThumb = row >= thumbStart && row < thumbStart + thumbSize;
						return theme.fg(inThumb ? "accent" : "borderMuted", inThumb ? "█" : "│");
					};
					const bodyRows = Array.from({ length: pageSize }, (_, row) => {
						const line = visible[row] ?? "";
						return `${border("│")}${padLine(` ${line}`, bodyInner)}${scrollbar(row)}${border("│")}`;
					});
					const start = totalLines === 0 ? 0 : scrollOffset + 1;
					const end = Math.min(totalLines, scrollOffset + pageSize);
					const status = `${start}-${end} / ${totalLines} lines · ↑↓ PgUp/PgDn Home/End · [esc] close`;

					return [
						border(`╭${"─".repeat(inner)}╮`),
						`${border("│")}${padLine(` ${theme.bold(theme.fg("accent", title))}`, inner - escWidth)}${theme.fg("muted", "[esc]")}${border("│")}`,
						`${border("├")}${border("─".repeat(inner))}${border("┤")}`,
						...bodyRows,
						`${border("├")}${border("─".repeat(inner))}${border("┤")}`,
						`${border("│")}${padLine(theme.fg("dim", ` ${status}`))}${border("│")}`,
						border(`╰${"─".repeat(inner)}╯`),
					];
				},
			};
		},
		{
			overlay: true,
			overlayOptions: { anchor: "center", width: "85%", minWidth: 50, maxHeight: "80%", margin: 2 },
		},
	);
}
