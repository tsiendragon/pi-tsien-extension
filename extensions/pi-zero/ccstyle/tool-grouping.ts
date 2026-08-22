import { AssistantMessageComponent, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { TOOL_LOADING_INTERVAL_MS, toolLoadingIcon } from "./tool-loading-icon.ts";
import { sanitizeToolResultText } from "./tool-result-sanitize.ts";

const PATCH_KEY = Symbol.for("pi.ccstyle.tool-grouping-patch");
const PARENT_KEY = Symbol.for("pi.ccstyle.tool-grouping-parent");
const GENERATION_KEY = Symbol.for("pi.ccstyle.tool-grouping-generation");
const NON_GROUPABLE = new Set(["edit", "write", "apply_patch"]);

type Patch = {
	owner: object;
	active: boolean;
	prototype: any;
	original: { addChild: Function; removeChild: Function; clear: Function };
	installed: { addChild: Function; removeChild: Function; clear: Function };
	groups: Set<ToolGroupComponent>;
	enabled: () => boolean;
	generation: number;
	lastEnabled: boolean;
	theme?: any;
	animationTimer: ReturnType<typeof setTimeout> | null;
};

function toolName(tool: any): string {
	return String(tool?.toolName ?? tool?.toolDefinition?.name ?? "tool");
}

function isGroupable(value: unknown): value is any {
	return value instanceof ToolExecutionComponent && !NON_GROUPABLE.has(toolName(value));
}

function isIgnorable(value: unknown): boolean {
	if (value instanceof Spacer) return true;
	if (!(value instanceof AssistantMessageComponent)) return false;
	const children = (value as any).contentContainer?.children;
	return Array.isArray(children) && children.length === 0;
}

function previousSibling(
	children: any[],
	start: number,
): { child: any; index: number } | undefined {
	let skipped = 0;
	for (let index = start; index >= 0; index--) {
		const child = children[index];
		if (isIgnorable(child) && skipped < 3) {
			skipped++;
			continue;
		}
		return { child, index };
	}
	return undefined;
}

type ToolStatus = "pending" | "success" | "error";

function status(tool: any): ToolStatus {
	if (tool?.result?.isError) return "error";
	if (tool?.isPartial === true || (tool?.executionStarted && !tool?.result)) return "pending";
	return tool?.result ? "success" : "pending";
}

function statusIcon(value: ToolStatus): string {
	if (value === "success") return "✓";
	if (value === "error") return "✗";
	return toolLoadingIcon();
}

function scheduleGroupAnimation(patch: Patch): void {
	if (patch.animationTimer || !patch.active) return;
	patch.animationTimer = setTimeout(() => {
		patch.animationTimer = null;
		if (!patch.active) return;
		for (const group of patch.groups) {
			if (group.children.some((tool) => status(tool) === "pending")) group.invalidate();
		}
	}, TOOL_LOADING_INTERVAL_MS);
	patch.animationTimer.unref?.();
}

function stripAnsi(line: string): string {
	return line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

function visibleLines(lines: string[]): string[] {
	return lines.filter((line) => stripAnsi(line).trim());
}

function stripLeadingStatusIcon(line: string): string {
	return line.replace(
		/^((?:\x1b\[[0-9;]*m|[ \t]|[├└│─])*)(?:\x1b\[[0-9;]*m)*(?:[✓✗●○■⬤•·])(?:\x1b\[[0-9;]*m)*\s+/,
		"$1",
	);
}

function stripBackgroundAnsi(line: string): string {
	return line.replace(/\x1b\[(?:4[0-9]|10[0-7]|48(?:(?:;|:)[0-9]+)+|49)m/g, "");
}

function stripLeadingSpaces(line: string, count: number): string {
	let offset = 0;
	let removed = 0;
	let ansi = "";
	while (offset < line.length) {
		const control = line.slice(offset).match(/^\x1b\[[0-?]*[ -/]*[@-~]/)?.[0];
		if (control) {
			ansi += control;
			offset += control.length;
			continue;
		}
		if (removed < count && line[offset] === " ") {
			removed++;
			offset++;
			continue;
		}
		break;
	}
	return ansi + line.slice(offset);
}

function paddedBackgroundRow(theme: any, slot: string, content: string, width: number): string {
	const innerWidth = Math.max(0, width - 2);
	const clipped = truncateToWidth(stripBackgroundAnsi(content), innerWidth, "");
	const row = ` ${clipped}${" ".repeat(Math.max(0, innerWidth - visibleWidth(clipped)))} `;
	if (typeof theme?.bg !== "function") return row;
	const bgAnsi =
		theme.getBgAnsi?.(slot) ?? theme.bg(slot, "").match(/^\x1b\[[0-?]*[ -/]*[@-~]/)?.[0] ?? "";
	const stable = bgAnsi ? row.replace(/\x1b\[(?:0)?m/g, (reset) => reset + bgAnsi) : row;
	return theme.bg(slot, stable);
}

function oneLine(value: unknown, max = 96): string {
	const text = sanitizeToolResultText(String(value ?? ""), 4096)
		.replace(/\s+/g, " ")
		.trim();
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function humanizeToolName(name: string): string {
	return name
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/[_-]+/g, " ")
		.replace(/\b\w/g, (char) => char.toUpperCase());
}

function toolSummary(tool: any): { main: string; detail: string } {
	const name = toolName(tool);
	const lowerName = name.toLowerCase();
	const args = tool?.args ?? {};
	const titled = humanizeToolName(name);
	const value = (fallback: string, ...keys: string[]) => {
		const found = keys.map((key) => args[key]).find((item) => typeof item === "string" && item);
		return `${titled} ${oneLine(found || fallback)}`;
	};
	if (lowerName === "agent" || lowerName === "agents") {
		const displayName = args.subagent_type ?? args.agent_type ?? args.agent;
		if (typeof displayName === "string" && displayName) {
			return { main: `${titled} ${displayName}`, detail: "" };
		}
		return {
			main: value(
				lowerName === "agent" ? "launch agent" : "launch agents",
				"description",
				"prompt",
			),
			detail: "",
		};
	}
	if (lowerName === "get_subagent_result" || lowerName === "steer_subagent") {
		return {
			main: value(lowerName === "get_subagent_result" ? "agent result" : "steer agent", "agent_id"),
			detail: "",
		};
	}
	if (lowerName === "skill") return { main: value("run skill", "name"), detail: "" };
	if (lowerName === "enterplanmode" || lowerName === "enter_plan_mode") {
		return { main: `${titled} enable read-only planning`, detail: "" };
	}
	if (lowerName === "exitplanmode" || lowerName === "exit_plan_mode") {
		return { main: `${titled} present plan`, detail: "" };
	}
	if (lowerName === "taskcreate") return { main: value("create task", "subject"), detail: "" };
	if (lowerName === "tasklist") return { main: `${titled} task list`, detail: "" };
	if (lowerName === "taskget" || lowerName === "taskupdate") {
		return { main: value("task", "taskId", "task_id"), detail: "" };
	}
	if (lowerName === "taskoutput" || lowerName === "taskstop") {
		return { main: value("background task", "task_id", "taskId"), detail: "" };
	}
	if (lowerName === "taskexecute") {
		const ids = Array.isArray(args.task_ids)
			? args.task_ids
			: Array.isArray(args.taskIds)
				? args.taskIds
				: [];
		return {
			main: `${titled} ${ids.length ? `${ids[0]}${ids.length > 1 ? ` (+${ids.length - 1} tasks)` : ""}` : "start tasks"}`,
			detail: "",
		};
	}
	if (name === "read") {
		const details = [
			args.offset !== undefined ? `offset=${args.offset}` : "",
			args.limit !== undefined ? `limit=${args.limit}` : "",
		].filter(Boolean);
		return {
			main: `Read ${oneLine(args.path || "...")}`,
			detail: details.length ? ` (${details.join(", ")})` : "",
		};
	}
	if (name === "bash") return { main: `Bash ${oneLine(args.command || "...")}`, detail: "" };
	if (name === "grep") {
		const pattern = oneLine(args.pattern || "...");
		return {
			main: `Grep ${JSON.stringify(pattern)}${args.path ? ` in ${oneLine(args.path)}` : ""}`,
			detail: "",
		};
	}
	if (name === "find") {
		const pattern = oneLine(args.pattern || "...");
		return {
			main: `Find ${JSON.stringify(pattern)}${args.path ? ` in ${oneLine(args.path)}` : ""}`,
			detail: "",
		};
	}
	const preferred =
		args.agent_id ??
		args.path ??
		args.file_path ??
		args.url ??
		args.description ??
		args.query ??
		args.name ??
		args.prompt;
	return {
		main: `${humanizeToolName(name)}${preferred === undefined ? "" : ` ${oneLine(preferred)}`}`,
		detail: "",
	};
}

function toolNameList(tools: any[]): string {
	const counts = new Map<string, number>();
	for (const tool of tools) counts.set(toolName(tool), (counts.get(toolName(tool)) ?? 0) + 1);
	return [...counts].map(([name, count]) => `${name}${count > 1 ? `×${count}` : ""}`).join(", ");
}

let nextGroupId = 1;

export class ToolGroupComponent extends Container {
	readonly toolCallId = `ccstyle-tool-group-${nextGroupId++}`;
	readonly toolName = "Tool group";
	private expanded = false;
	private hintHovered = false;
	private readonly patch: Patch;

	constructor(patch: Patch) {
		super();
		this.patch = patch;
		patch.groups.add(this);
	}

	addTool(tool: any): void {
		this.children.push(tool);
		tool[PARENT_KEY] = this;
	}

	releaseTools(): any[] {
		const tools = [...this.children];
		this.children.length = 0;
		this.patch.groups.delete(this);
		return tools;
	}

	removeTool(tool: any): void {
		const index = this.children.indexOf(tool);
		if (index >= 0) this.children.splice(index, 1);
		if (tool?.[PARENT_KEY] === this) delete tool[PARENT_KEY];
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		for (const tool of this.children) {
			(tool as { setExpanded?: (expanded: boolean) => void }).setExpanded?.(expanded);
		}
	}

	setHintHovered(hovered: boolean): void {
		this.hintHovered = hovered;
	}

	invalidate(): void {
		for (const tool of this.children) tool.invalidate?.();
	}

	render(width: number): string[] {
		const theme = this.patch.theme;
		const fg = (color: string, text: string) => theme?.fg?.(color, text) ?? text;
		const counts = { pending: 0, success: 0, error: 0 };
		for (const tool of this.children) counts[status(tool)]++;
		const countText = (["pending", "success", "error"] as const)
			.filter((key) => counts[key])
			.map((key) => {
				const label = key === "pending" ? "running" : key === "success" ? "done" : "failed";
				const color = key === "pending" ? "accent" : key;
				return `${fg(color, String(counts[key]))} ${label}`;
			})
			.join(` ${fg("dim", "•")} `);
		const names = new Set(this.children.map(toolName));
		const label =
			names.size === 1 ? humanizeToolName(toolName(this.children[0])) : "Multiple Tools";
		const overall: ToolStatus = counts.error ? "error" : counts.pending ? "pending" : "success";
		if (overall === "pending") scheduleGroupAnimation(this.patch);
		const overallColor = overall === "pending" ? "accent" : overall;
		const nameList = names.size > 1 ? ` ${fg("dim", `• ${toolNameList(this.children)}`)}` : "";
		const hint = fg(this.hintHovered ? "text" : "dim", "• press ctrl-o to expand");
		const lines = [
			"",
			truncateToWidth(
				` ${fg(overallColor, "●")} ${label}: ${countText}${nameList} ${hint}`,
				width,
				"…",
			),
		];
		const total = this.children.length;
		const expandedLines: string[] = [];
		for (let index = 0; index < total; index++) {
			const tool = this.children[index];
			const toolStatus = status(tool);
			const color = toolStatus === "pending" ? "accent" : toolStatus;
			const branch = index === total - 1 ? "└" : "├";
			const continuation = index === total - 1 ? "  " : "│ ";
			if (!this.expanded) {
				const summary = toolSummary(tool);
				lines.push(
					truncateToWidth(
						` ${fg("dim", branch)} ${fg(color, statusIcon(toolStatus))} ${fg("toolTitle", summary.main)}${fg("dim", summary.detail)}`,
						width,
						"…",
					),
				);
				continue;
			}
			const rendered = visibleLines(tool.render(Math.max(1, width - 2)));
			if (rendered.length) {
				rendered[0] = stripLeadingStatusIcon(rendered[0])
					.replace(/^ +/, "")
					.replace(/^((?:\x1b\[[0-?]*[ -/]*[@-~])*) +/, "$1");
			}
			const childLines = rendered.length ? rendered : [toolSummary(tool).main];
			for (let lineIndex = 0; lineIndex < childLines.length; lineIndex++) {
				const content =
					lineIndex === 0 ? childLines[lineIndex] : stripLeadingSpaces(childLines[lineIndex], 2);
				const prefix =
					lineIndex === 0
						? `${fg("dim", branch)} ${fg(color, statusIcon(toolStatus))} `
						: fg("dim", continuation);
				expandedLines.push(prefix + content);
			}
		}
		if (this.expanded) {
			const backgroundSlot =
				overall === "error"
					? "toolErrorBg"
					: overall === "pending"
						? "toolPendingBg"
						: "toolSuccessBg";
			for (const line of expandedLines) {
				lines.push(paddedBackgroundRow(theme, backgroundSlot, line, width));
			}
			lines.push(paddedBackgroundRow(theme, backgroundSlot, "", width));
		}
		return lines;
	}
}

function ungroup(patch: Patch): void {
	for (const group of [...patch.groups]) {
		const parent = (group as any)[PARENT_KEY];
		const children = parent?.children;
		if (!Array.isArray(children)) {
			patch.groups.delete(group);
			continue;
		}
		const index = children.indexOf(group);
		if (index < 0) {
			patch.groups.delete(group);
			continue;
		}
		const tools = group.releaseTools();
		for (const tool of tools) tool[PARENT_KEY] = parent;
		children.splice(index, 1, ...tools);
	}
}

function normalizeGroup(patch: Patch, group: ToolGroupComponent): void {
	if (group.children.length > 1) return;
	const parent = (group as any)[PARENT_KEY];
	const index = parent?.children?.indexOf(group) ?? -1;
	const tools = group.releaseTools();
	delete (group as any)[PARENT_KEY];
	if (index < 0) {
		for (const tool of tools) delete tool[PARENT_KEY];
		return;
	}
	if (tools.length === 1) {
		tools[0][PARENT_KEY] = parent;
		parent.children.splice(index, 1, tools[0]);
	} else {
		parent.children.splice(index, 1);
	}
}

function maybeGroup(patch: Patch, parent: any, component: any): void {
	if (
		!patch.active ||
		!patch.enabled() ||
		parent instanceof ToolGroupComponent ||
		!isGroupable(component)
	)
		return;
	component[GENERATION_KEY] = patch.generation;
	const children = parent?.children;
	if (!Array.isArray(children)) return;
	const index = children.indexOf(component);
	const prior = previousSibling(children, index - 1);
	if (!prior) return;
	if (prior.child instanceof ToolGroupComponent && (prior.child as any).patch === patch) {
		children.splice(index, 1);
		prior.child.addTool(component);
		return;
	}
	if (!isGroupable(prior.child) || prior.child[GENERATION_KEY] !== patch.generation) return;
	const group = new ToolGroupComponent(patch);
	group.addTool(prior.child);
	group.addTool(component);
	(group as any)[PARENT_KEY] = parent;
	children[prior.index] = group;
	children.splice(index, 1);
}

export type ToolGroupingHooks = {
	setTheme(theme: any): void;
	refresh(): void;
	shutdown(): void;
};

export function installToolGrouping(getEnabled: () => boolean): ToolGroupingHooks {
	const prototype = Container.prototype as any;
	const host = globalThis as any;
	const previous = host[PATCH_KEY] as Patch | undefined;
	if (previous) {
		previous.active = false;
		previous.enabled = () => false;
		if (previous.animationTimer) clearTimeout(previous.animationTimer);
		previous.animationTimer = null;
		ungroup(previous);
	}
	const original = {
		addChild:
			previous && prototype.addChild === previous.installed.addChild
				? previous.original.addChild
				: prototype.addChild,
		removeChild:
			previous && prototype.removeChild === previous.installed.removeChild
				? previous.original.removeChild
				: prototype.removeChild,
		clear:
			previous && prototype.clear === previous.installed.clear
				? previous.original.clear
				: prototype.clear,
	};
	const patch: Patch = {
		owner: {},
		active: true,
		prototype,
		original,
		installed: undefined as any,
		groups: new Set(),
		enabled: getEnabled,
		generation: 0,
		lastEnabled: getEnabled(),
		animationTimer: null,
	};
	patch.installed = {
		addChild: function (this: any, component: any) {
			const result = patch.original.addChild.call(this, component);
			if (component && typeof component === "object") component[PARENT_KEY] = this;
			maybeGroup(patch, this, component);
			return result;
		},
		removeChild: function (this: any, component: any) {
			const group = component?.[PARENT_KEY];
			if (group instanceof ToolGroupComponent && (group as any)[PARENT_KEY] === this) {
				group.removeTool(component);
				normalizeGroup(patch, group);
				return;
			}
			const result = patch.original.removeChild.call(this, component);
			if (component?.[PARENT_KEY] === this) delete component[PARENT_KEY];
			if (this instanceof ToolGroupComponent) normalizeGroup(patch, this);
			if (component instanceof ToolGroupComponent) {
				for (const tool of component.releaseTools()) delete tool[PARENT_KEY];
			}
			return result;
		},
		clear: function (this: any) {
			for (const child of [...(this.children ?? [])]) {
				if (child instanceof ToolGroupComponent) {
					for (const tool of child.releaseTools()) delete tool[PARENT_KEY];
				}
				if (child?.[PARENT_KEY] === this) delete child[PARENT_KEY];
			}
			if (this instanceof ToolGroupComponent) patch.groups.delete(this);
			return patch.original.clear.call(this);
		},
	};
	prototype.addChild = patch.installed.addChild;
	prototype.removeChild = patch.installed.removeChild;
	prototype.clear = patch.installed.clear;
	host[PATCH_KEY] = patch;
	return {
		setTheme(theme: any) {
			patch.theme = theme;
		},
		refresh() {
			const enabled = patch.enabled();
			if (enabled !== patch.lastEnabled) {
				patch.lastEnabled = enabled;
				if (enabled) patch.generation++;
			}
			if (!enabled) ungroup(patch);
		},
		shutdown() {
			if (!patch.active) return;
			patch.active = false;
			if (patch.animationTimer) clearTimeout(patch.animationTimer);
			patch.animationTimer = null;
			patch.enabled = () => false;
			ungroup(patch);
			if (prototype.addChild === patch.installed.addChild)
				prototype.addChild = patch.original.addChild;
			if (prototype.removeChild === patch.installed.removeChild)
				prototype.removeChild = patch.original.removeChild;
			if (prototype.clear === patch.installed.clear) prototype.clear = patch.original.clear;
		},
	};
}
