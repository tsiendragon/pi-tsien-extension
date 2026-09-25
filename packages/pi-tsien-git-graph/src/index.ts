import { basename } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";

const DEFAULT_LIMIT = 300;
const MAX_LIMIT = 2_000;
const VIEWPORT_ROWS = 16;
const COLLAPSE_MINIMUM = 2;
const RECORD_SEPARATOR = "\x1e";
const FIELD_SEPARATOR = "\x1f";

type GitResult = {
	stdout: string;
	stderr: string;
	code: number | null;
};

interface CommitGroup {
	hash: string;
	parents: string[];
	refs: string[];
	date: string;
	subject: string;
	graphPrefix: string;
	connectors: string[];
}

type GraphRow =
	| { type: "commit"; commit: CommitGroup }
	| { type: "connector"; prefix: string }
	| { type: "collapsed"; prefix: string; count: number }
	| { type: "message"; text: string };

interface GraphData {
	repository: string;
	branch: string;
	dirty: boolean;
	rows: GraphRow[];
	limit: number;
	sourceCommitCount: number;
	totalCommitCount: number;
	keyCommitCount: number;
	collapsedCommitCount: number;
	remoteNames: Set<string>;
}

function parseLimit(args: string): number | null {
	const value = args.trim();
	if (value === "") return DEFAULT_LIMIT;
	if (!/^\d+$/.test(value)) return null;

	const limit = Number(value);
	return limit >= 1 && limit <= MAX_LIMIT ? limit : null;
}

function gitError(result: GitResult): string {
	return result.stderr.trim() || result.stdout.trim() || "git 命令执行失败";
}

function parseCommitGroups(output: string): CommitGroup[] {
	const groups: CommitGroup[] = [];
	let current: CommitGroup | undefined;

	for (const line of output.split("\n")) {
		const recordIndex = line.indexOf(RECORD_SEPARATOR);
		if (recordIndex === -1) {
			if (current && line.trim() !== "") current.connectors.push(line);
			continue;
		}

		const fields = line.slice(recordIndex + 1).split(FIELD_SEPARATOR);
		if (fields.length < 5 || !fields[0]) continue;

		current = {
			hash: fields[0],
			parents: fields[1] ? fields[1].split(" ").filter(Boolean) : [],
			refs: fields[2] ? fields[2].split(",").map((ref) => ref.trim()).filter(Boolean) : [],
			date: fields[3],
			subject: fields.slice(4).join(FIELD_SEPARATOR),
			graphPrefix: line.slice(0, recordIndex),
			connectors: [],
		};
		groups.push(current);
	}

	return groups;
}

function buildOverview(groups: CommitGroup[]): {
	rows: GraphRow[];
	keyCommitCount: number;
	collapsedCommitCount: number;
} {
	if (groups.length === 0) {
		return {
			rows: [{ type: "message", text: "（仓库尚无提交）" }],
			keyCommitCount: 0,
			collapsedCommitCount: 0,
		};
	}

	const childCounts = new Map<string, number>();
	for (const group of groups) {
		for (const parent of group.parents) {
			childCounts.set(parent, (childCounts.get(parent) ?? 0) + 1);
		}
	}

	const keyHashes = new Set<string>();
	for (const group of groups) {
		if (
			group.refs.length > 0 ||
			group.parents.length > 1 ||
			(childCounts.get(group.hash) ?? 0) > 1
		) {
			keyHashes.add(group.hash);
		}
	}
	keyHashes.add(groups[0]!.hash);
	keyHashes.add(groups[groups.length - 1]!.hash);

	const rows: GraphRow[] = [];
	let collapsedCommitCount = 0;

	const addCommit = (group: CommitGroup) => {
		rows.push({ type: "commit", commit: group });
		for (const prefix of group.connectors) rows.push({ type: "connector", prefix });
	};

	for (let index = 0; index < groups.length;) {
		const group = groups[index]!;
		if (keyHashes.has(group.hash)) {
			addCommit(group);
			index++;
			continue;
		}

		let end = index;
		while (end < groups.length && !keyHashes.has(groups[end]!.hash)) end++;
		const count = end - index;

		if (count >= COLLAPSE_MINIMUM) {
			rows.push({ type: "collapsed", prefix: group.graphPrefix, count });
			collapsedCommitCount += count;
		} else {
			for (let cursor = index; cursor < end; cursor++) addCommit(groups[cursor]!);
		}
		index = end;
	}

	return { rows, keyCommitCount: keyHashes.size, collapsedCommitCount };
}

class GitGraphOverlay implements Component {
	private offset = 0;

	constructor(
		private readonly data: GraphData,
		private readonly theme: Theme,
		private readonly requestRender: () => void,
		private readonly close: () => void,
	) {}

	handleInput(input: string): void {
		const maxOffset = Math.max(0, this.data.rows.length - VIEWPORT_ROWS);

		if (
			matchesKey(input, "escape") ||
			matchesKey(input, "return") ||
			input.toLowerCase() === "q"
		) {
			this.close();
			return;
		}

		if (matchesKey(input, "up")) {
			this.offset = Math.max(0, this.offset - 1);
		} else if (matchesKey(input, "down")) {
			this.offset = Math.min(maxOffset, this.offset + 1);
		} else if (matchesKey(input, "pageUp")) {
			this.offset = Math.max(0, this.offset - VIEWPORT_ROWS);
		} else if (matchesKey(input, "pageDown")) {
			this.offset = Math.min(maxOffset, this.offset + VIEWPORT_ROWS);
		} else if (matchesKey(input, "home")) {
			this.offset = 0;
		} else if (matchesKey(input, "end")) {
			this.offset = maxOffset;
		} else {
			return;
		}

		this.requestRender();
	}

	private renderGraphPrefix(prefix: string, node: "commit" | "merge" | "collapsed" | "connector"): string {
		let rendered = "";
		for (const character of prefix) {
			if (character === "*") {
				const symbol = node === "merge" ? "◆" : node === "collapsed" ? "╎" : "●";
				const color = node === "merge" ? "warning" : node === "collapsed" ? "dim" : "accent";
				rendered += this.theme.fg(color, symbol);
			} else if (character === "|") {
				rendered += this.theme.fg("borderMuted", "│");
			} else if (character === "/") {
				rendered += this.theme.fg("borderMuted", "╱");
			} else if (character === "\\") {
				rendered += this.theme.fg("borderMuted", "╲");
			} else {
				rendered += character;
			}
		}
		return rendered;
	}

	private renderRefs(refs: string[]): string {
		const classify = (ref: string) => {
			if (ref.startsWith("HEAD ->")) return 0;
			if (ref.startsWith("tag: ")) return 3;
			const target = ref.includes(" -> ") ? ref.split(" -> ").at(-1)! : ref;
			return this.data.remoteNames.has(target.split("/")[0]!) ? 2 : 1;
		};

		return [...refs]
			.sort((left, right) => classify(left) - classify(right))
			.map((ref) => {
				const target = ref.includes(" -> ") ? ref.split(" -> ").at(-1)! : ref;
				const isRemote = this.data.remoteNames.has(target.split("/")[0]!);
				const label = ref.replace("HEAD -> ", "HEAD→").replace(" -> ", "→").replace("tag: ", "#");
				const color = ref.startsWith("HEAD ->")
					? "accent"
					: ref.startsWith("tag: ")
						? "warning"
						: isRemote
							? "muted"
							: "success";
				return this.theme.fg(color, `[${label}]`);
			})
			.join(" ");
	}

	private renderGraphRow(row: GraphRow): string {
		if (row.type === "message") return this.theme.fg("muted", ` ${row.text}`);
		if (row.type === "connector") return this.renderGraphPrefix(row.prefix, "connector");
		if (row.type === "collapsed") {
			return (
				this.renderGraphPrefix(row.prefix, "collapsed") +
				this.theme.fg("dim", ` ⋯ ${row.count} 个普通提交已折叠`)
			);
		}

		const { commit } = row;
		const node = commit.parents.length > 1 ? "merge" : "commit";
		const refs = this.renderRefs(commit.refs);
		const hash = this.theme.fg("dim", commit.hash.slice(0, 7));
		const title = this.theme.fg("text", commit.subject || "（无提交说明）");
		const date = commit.date ? this.theme.fg("dim", ` ${commit.date}`) : "";
		return `${this.renderGraphPrefix(commit.graphPrefix, node)}${hash} ${refs ? `${refs} ` : ""}${title}${date}`;
	}

	render(width: number): string[] {
		if (width < 12) return [truncateToWidth("Git overview: terminal too narrow", width)];

		const panelWidth = Math.min(width, 130);
		const innerWidth = panelWidth - 2;
		const maxOffset = Math.max(0, this.data.rows.length - VIEWPORT_ROWS);
		const visibleRows = this.data.rows.slice(this.offset, this.offset + VIEWPORT_ROWS);
		const dirty = this.data.dirty
			? this.theme.fg("warning", " ● 有未提交改动")
			: this.theme.fg("success", " ● 工作区干净");
		const scanned = this.data.totalCommitCount > this.data.sourceCommitCount
			? `读取 ${this.data.sourceCommitCount}/${this.data.totalCommitCount}`
			: `共 ${this.data.sourceCommitCount} 个提交`;
		const summary = `关键节点 ${this.data.keyCommitCount} · 已折叠 ${this.data.collapsedCommitCount} · ${scanned}`;
		const position = this.data.rows.length > VIEWPORT_ROWS
			? ` ${this.offset + 1}-${Math.min(this.offset + VIEWPORT_ROWS, this.data.rows.length)}/${this.data.rows.length}`
			: " 概览";

		const pad = (content: string) => {
			const clipped = truncateToWidth(content, innerWidth);
			return clipped + " ".repeat(Math.max(0, innerWidth - visibleWidth(clipped)));
		};
		const frame = (content: string) =>
			this.theme.fg("border", "│") + pad(content) + this.theme.fg("border", "│");

		const lines = [
			this.theme.fg("border", `╭${"─".repeat(innerWidth)}╮`),
			frame(
				` ${this.theme.fg("accent", this.theme.bold("Git 概览"))}` +
					this.theme.fg("muted", ` · ${this.data.repository} · ${this.data.branch}`) +
					dirty,
			),
			frame(this.theme.fg("dim", ` ${summary}${position}`)),
			frame(this.theme.fg("dim", " 本地与远端引用均保留；普通线性提交自动折叠")),
			frame(this.theme.fg("borderMuted", "─".repeat(innerWidth))),
		];

		for (const graphRow of visibleRows) lines.push(frame(this.renderGraphRow(graphRow)));
		for (let index = visibleRows.length; index < VIEWPORT_ROWS; index++) lines.push(frame(""));

		const moreAbove = this.offset > 0 ? "↑ " : "  ";
		const moreBelow = this.offset < maxOffset ? " ↓" : "  ";
		lines.push(frame(this.theme.fg("dim", `${moreAbove}↑↓ 浏览 · PgUp/PgDn 翻页 · Home/End · Esc/q/Enter 关闭${moreBelow}`)));
		lines.push(this.theme.fg("border", `╰${"─".repeat(innerWidth)}╯`));
		return lines;
	}

	invalidate(): void {}
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("git-graph", {
		description: "打开当前仓库的 Git 概览图（本地与远端引用，普通提交自动折叠）",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
		const limit = parseLimit(args);
		if (limit === null) {
				ctx.ui.notify("用法：/git-graph [1-2000]", "warning");
				return;
			}
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/git-graph 仅可在 Pi 的交互式终端中打开。", "warning");
				return;
			}

			const prefix = ["-C", ctx.cwd];
			const root = (await pi.exec("git", [...prefix, "rev-parse", "--show-toplevel"], {
				timeout: 5_000,
			})) as GitResult;
			if (root.code !== 0) {
				ctx.ui.notify(`当前目录不是 Git 仓库：${gitError(root)}`, "warning");
				return;
			}

			const [graph, branch, status, total, remotes] = (await Promise.all([
				pi.exec(
					"git",
					[
						...prefix,
						"log",
						"--all",
						"--graph",
						"--topo-order",
						"--decorate=short",
						"--color=never",
						"--date=short",
						`--format=${RECORD_SEPARATOR}%H${FIELD_SEPARATOR}%P${FIELD_SEPARATOR}%D${FIELD_SEPARATOR}%ad${FIELD_SEPARATOR}%s`,
						"-n",
						String(limit),
					],
					{ timeout: 15_000 },
				),
				pi.exec("git", [...prefix, "branch", "--show-current"], { timeout: 5_000 }),
				pi.exec("git", [...prefix, "status", "--porcelain"], { timeout: 5_000 }),
				pi.exec("git", [...prefix, "rev-list", "--all", "--count"], { timeout: 10_000 }),
				pi.exec("git", [...prefix, "remote"], { timeout: 5_000 }),
			])) as [GitResult, GitResult, GitResult, GitResult, GitResult];

			if (graph.code !== 0) {
				ctx.ui.notify(`无法读取 Git 图谱：${gitError(graph)}`, "error");
				return;
			}

			const groups = parseCommitGroups(graph.stdout);
			const overview = buildOverview(groups);
			const graphData: GraphData = {
				repository: basename(root.stdout.trim()),
				branch: branch.code === 0 && branch.stdout.trim() ? branch.stdout.trim() : "detached HEAD",
				dirty: status.code === 0 && status.stdout.trim() !== "",
				rows: overview.rows,
				limit,
				sourceCommitCount: groups.length,
				totalCommitCount: total.code === 0 ? Number(total.stdout.trim()) || groups.length : groups.length,
				keyCommitCount: overview.keyCommitCount,
				collapsedCommitCount: overview.collapsedCommitCount,
				remoteNames: new Set(remotes.code === 0 ? remotes.stdout.split("\n").filter(Boolean) : []),
			};

			await ctx.ui.custom<void>(
				(tui, theme, _keybindings, done) =>
					new GitGraphOverlay(graphData, theme, () => tui.requestRender(), () => done(undefined)),
				{
					overlay: true,
					overlayOptions: {
						anchor: "center",
						width: "96%",
						minWidth: 52,
						maxHeight: "80%",
					},
				},
			);
		},
	});
}
