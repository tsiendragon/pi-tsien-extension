export type DiffViewMode = "auto" | "split" | "unified";
export type DiffIndicatorMode = "bars" | "classic" | "none";

export interface ToolDisplayConfig {
	diffViewMode: DiffViewMode;
	diffIndicatorMode: DiffIndicatorMode;
	diffSplitMinWidth: number;
	diffCollapsedLines: number;
	diffWordWrap: boolean;
	expandedPreviewMaxLines: number;
}

export const DEFAULT_TOOL_DISPLAY_CONFIG: ToolDisplayConfig = {
	diffViewMode: "auto",
	diffIndicatorMode: "bars",
	diffSplitMinWidth: 120,
	/** Collapsed tool/diff body: ~half a typical terminal after chrome. */
	diffCollapsedLines: 24,
	diffWordWrap: true,
	/**
	 * Expanded tool/diff body cap. 40 ≈ one screen of content after title,
	 * Input section, editor, and status — keeps the TUI compact.
	 * Raise via /ccstyle → Diff → Expanded max lines when reviewing large dumps.
	 */
	expandedPreviewMaxLines: 40,
};
