import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Context Slim — 工具输出只让主 agent 读"需要的那部分"。
 *
 * 一个入口、一个目录、一个小模型：
 *   工具输出 → 全文按内容 hash 落盘 → 小模型提炼主 agent 需要的信息 →
 *   上下文里只留「摘要 + 全文路径」。
 *
 * 两个钩子共用同一份摘要：
 *   - tool_result：处理新产生的输出；
 *   - context：处理历史消息（重启恢复的旧会话也能压缩），并剥离历史思考。
 *
 * 缓存友好的关键：摘要按内容 hash 缓存在 <hash>.summary.txt。
 * 同一内容永远复用第一次生成的摘要，绝不每轮重新总结——否则前缀缓存会失效。
 * 小模型调用失败时退回程序截取（尾部优先 + 错误关键字行），同样写入缓存。
 *
 * 环境变量：
 *   PI_SLIM_TOOL_OUTPUT=0      关闭外包（全部）
 *   PI_SLIM_HISTORY=0          只关闭对历史消息的外包
 *   PI_SLIM_STRIP_REASONING=0  关闭历史思考剥离
 *   PI_SLIM_LLM_SUMMARY=0      关闭小模型摘要（只用程序截取）
 *   PI_SLIM_THRESHOLD=3000     外包阈值（字符）
 *   PI_SLIM_SUMMARY_MODEL      默认 deepseek-v4.1-flash
 *   PI_SLIM_SUMMARY_BASE_URL   默认 dashscope 兼容端点
 *   PI_SLIM_OUT_DIR            覆盖保存目录（调试用）
 *   DASHSCOPE_API_KEY          小模型摘要所需；缺失时自动退回程序截取
 */

const DEFAULT_THRESHOLD = 3000;
const DEFAULT_EXCLUDE = new Set(["read", "edit", "write", "rtk_configure", "compact_context"]);
const MARK = "[输出已外包]";

function numEnv(name: string, fallback: number): number {
	const v = Number(process.env[name]);
	return Number.isFinite(v) && v >= 0 ? v : fallback; // 允许 0：POLL_INTERVAL=0 关节流、THRESHOLD=0 全外包
}

function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR?.trim()
		? resolve(process.env.PI_CODING_AGENT_DIR)
		: join(homedir(), ".pi", "agent");
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((b) => (b && typeof b === "object" && typeof (b as { text?: unknown }).text === "string"
				? (b as { text: string }).text
				: ""))
			.join("\n");
	}
	return content == null ? "" : String(content);
}

function clip(text: string, n: number): string {
	return text.length > n ? `${text.slice(0, n)}…` : text;
}

const KEY_LINE = /(traceback|exception|assertionerror|\berror\b|\bfailed\b|\bfailure\b|\bwarning\b|\bpanic\b|\bfatal\b|错误|失败|警告)/i;

/** 小模型不可用时的兜底：尾部优先 + 错误关键字行（纯程序，零成本）。 */
function fallbackSummary(full: string, isError: boolean): string {
	const head = isError ? 400 : 200;
	const tail = isError ? 1600 : 800;
	const headText = clip(full, head);
	const tailText = clip(full.slice(Math.max(0, full.length - tail)), tail);
	const keys: string[] = [];
	for (const line of full.split("\n")) {
		if (!line.trim() || !KEY_LINE.test(line)) continue;
		const t = clip(line, 300);
		if (headText.includes(t) || tailText.includes(t) || keys.includes(t)) continue;
		keys.push(t);
		if (keys.length >= (isError ? 12 : 8)) break;
	}
	return [
		`--- 开头 ---\n${headText}`,
		...(keys.length ? [`--- 含错误/警告的行 ---\n${keys.join("\n")}`] : []),
		`--- 结尾（通常包含最终结果） ---\n${tailText}`,
	].join("\n\n");
}

const SUMMARY_PROMPT = `你在为一个正在工作的主 agent 压缩工具输出。只保留主 agent 继续工作所必需的信息，用不超过 200 字的中文列出要点：
- 最终结论/状态（成功、失败、退出码）
- 关键数值及其含义（不要罗列全部数据）
- 错误与异常：错误类型、关键堆栈行、出错位置
- 产物文件路径、可复现命令
- 若输出是数值表/搜索结果：给出极值、异常项及其位置，不要逐行复述
不要写"该输出包含…"这类描述，不要遗漏任何报错。若没有重要信息，直接回答"无关键信息"。`;

async function llmSummary(full: string, toolName: string, signal?: AbortSignal): Promise<string | undefined> {
	const apiKey = process.env.DASHSCOPE_API_KEY;
	if (!apiKey) return undefined;
	const base = (process.env.PI_SLIM_SUMMARY_BASE_URL || "https://dashscope-intl.aliyuncs.com/compatible-mode/v1").replace(/\/$/, "");
	const model = process.env.PI_SLIM_SUMMARY_MODEL || "deepseek-v4.1-flash";
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 40000);
	signal?.addEventListener("abort", () => controller.abort(), { once: true });
	try {
		const resp = await fetch(`${base}/chat/completions`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
			body: JSON.stringify({
				model,
				max_tokens: 900,
				temperature: 0,
				enable_thinking: false,
				messages: [
					{ role: "system", content: SUMMARY_PROMPT },
					{ role: "user", content: `工具 ${toolName} 的输出：\n\n${full.length <= 24000 ? full : `${full.slice(0, 12000)}\n…[中间省略]…\n${full.slice(-12000)}`}` },
				],
			}),
			signal: controller.signal,
		});
		if (!resp.ok) return undefined;
		const data = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> };
		const text = data.choices?.[0]?.message?.content?.trim();
		return text && text.length > 0 ? text : undefined;
	} catch {
		return undefined;
	} finally {
		clearTimeout(timer);
	}
}

/** 主 agent 不写代码/测试：代码文件的创建与大改动必须委派，文档与小修放行。 */
const CODE_EXT = /\.(?:py|ts|tsx|js|jsx|mjs|cjs|lean|sh|bash|c|h|cpp|hpp|java|rs|go|rb|sql|v|sv|sage|m)$/i;

function isCodePath(path: unknown): boolean {
	return typeof path === "string" && CODE_EXT.test(path);
}

/** 主会话不许直接检索/读文献：这些结果体积大，应由子代理消化后只回结论。 */
const WEB_TOOLS = new Set(["WebFetch", "WebSearch", "arxiv_search", "openreview_search"]);

function isSubagentProcess(ctx: { sessionManager: unknown }): boolean {
	if (process.env.PI_SUBAGENT_WORKBENCH_CHILD === "1") return true;
	const raw = process.env.PI_TRACE_CONTEXT;
	if (raw) {
		try {
			const t = JSON.parse(raw) as Record<string, unknown>;
			if (t.parentSessionId || t.parentToolCallId || t.parentWorkId || t.parentWorkflowId) return true;
		} catch { /* 不是 JSON 就忽略 */ }
	}
	const file = (ctx.sessionManager as { getSessionFile?: () => string }).getSessionFile?.() || "";
	return file.includes("subagent-sessions");
}

function codeDelegateReason(tool: string, path: string): string {
	return [
		`主 agent 不直接写代码/测试（${tool} ${path} 被拦截）。`,
		`请改用 subagent_start(role: "code", tier: "light") 委派，任务里给出：`,
		`1) 思路：要实现什么、为什么这么做（这是主 agent 的职责）；`,
		`2) 验收标准：什么算完成（命令、期望输出、测试通过条件）；`,
		`3) 相关文件绝对路径与约束（不许动哪些文件）。`,
		`细节、环境、路径选择、测试编写与复用脚本由子代理自己搞定；`,
		`要求子代理只回 ≤200 字结论 + 产物路径 + 可复现命令。`,
		`确需主 agent 亲自改时设 PI_SLIM_BLOCK_CODE=0。`,
	].join("\n");
}

/** 子代理进度轮询节流：status 查询不产生进展，却每次都触发一次全价模型请求。 */
const pollSeen = new Map<string, number>();

export default function contextSlimExtension(pi: ExtensionAPI): void {
	const pollIntervalMs = numEnv("PI_SLIM_POLL_INTERVAL", 90) * 1000;
	const blockWeb = process.env.PI_SLIM_BLOCK_WEB !== "0";
	const blockRunCode = process.env.PI_SLIM_BLOCK_RUN_CODE !== "0";
	const blockCode = process.env.PI_SLIM_BLOCK_CODE !== "0";
	const codeEditMin = numEnv("PI_SLIM_CODE_EDIT_MIN", 400);
	const runCodeMin = numEnv("PI_SLIM_RUN_CODE_MIN", 500);
	const threshold = numEnv("PI_SLIM_THRESHOLD", DEFAULT_THRESHOLD);
	const toolOutputEnabled = process.env.PI_SLIM_TOOL_OUTPUT !== "0";
	const historyEnabled = process.env.PI_SLIM_HISTORY !== "0";
	const stripReasoning = process.env.PI_SLIM_STRIP_REASONING !== "0";
	const llmEnabled = process.env.PI_SLIM_LLM_SUMMARY !== "0";
	const exclude = new Set(DEFAULT_EXCLUDE);
	for (const t of (process.env.PI_SLIM_EXCLUDE || "").split(",")) if (t.trim()) exclude.add(t.trim());
	for (const t of (process.env.PI_SLIM_INCLUDE || "").split(",")) if (t.trim()) exclude.delete(t.trim());

	const outDir = (sessionId: string) => process.env.PI_SLIM_OUT_DIR?.trim()
		? resolve(process.env.PI_SLIM_OUT_DIR)
		: join(agentDir(), "tool-output", sessionId.replace(/[^\w-]/g, "_"));

	/** 全文 + 摘要都按内容 hash 存放；摘要只生成一次，之后永远读缓存。 */
	async function buildSummary(
		toolName: string,
		callId: string,
		full: string,
		isError: boolean,
		dir: string,
		signal?: AbortSignal,
	): Promise<string> {
		const hash = createHash("sha256").update(full).digest("hex").slice(0, 16);
		mkdirSync(dir, { recursive: true });
		const fullPath = join(dir, `${hash}.log`);
		const summaryPath = join(dir, `${hash}.summary.txt`);
		if (!existsSync(fullPath)) {
			writeFileSync(fullPath, `tool: ${toolName}\ntoolCallId: ${callId}\nchars: ${full.length}\nisError: ${Boolean(isError)}\n\n${full}`, "utf8");
		}
		let core: string | undefined;
		if (existsSync(summaryPath)) {
			core = readFileSync(summaryPath, "utf8").trim();
		} else {
			if (llmEnabled) core = await llmSummary(full, toolName, signal);
			if (!core) core = fallbackSummary(full, isError);
			try {
				writeFileSync(summaryPath, core, "utf8");
			} catch { /* 缓存写失败不影响本次返回 */ }
		}
		return [
			`${MARK} ${toolName} 返回 ${full.length} 字符 / ${full.split("\n").length} 行，全文在 ${fullPath}`,
			`需要细节时用 read 读取该文件（可用 offset/limit），不要凭摘要猜测数值或错误原因。`,
			``,
			core,
		].join("\n");
	}

	pi.on("tool_call", async (event, ctx) => {
		if (isSubagentProcess(ctx)) return; // 子代理本来就是被委派来做这些的
		// 长脚本必须委派：主会话自己写/改/跑长代码会产生多轮全价开销
		if (blockRunCode && event.toolName === "run_code") {
			const input = (event.input || {}) as { code?: unknown };
			const code = typeof input.code === "string" ? input.code : "";
			if (code.length >= runCodeMin) {
				return {
					block: true,
					reason: [
						`这段代码 ${code.length} 字符，超过主会话直接执行的上限 ${runCodeMin}。`,
						`请改用 subagent_start(role: "code", tier: "light") 委派：写清目标、输入文件绝对路径、验收标准，`,
						`让子代理编写并运行脚本，只回 ≤200 字结论 + 产物/日志路径。`,
						`先查 ~/repos/agent-scripts/INDEX.md 是否已有可复用脚本，能直接 bash 调用就不必新写。`,
						`确需主会话自行执行时设 PI_SLIM_BLOCK_RUN_CODE=0。`,
					].join("\n"),
				};
			}
		}
		// 代码文件的创建与大改动必须委派给 code 子代理
		if (blockCode) {
			const input = (event.input || {}) as { path?: unknown; content?: unknown; edits?: Array<{ newText?: unknown }> };
			if (event.toolName === "write" && isCodePath(input.path) && String(input.content || "").length >= 200) {
				return { block: true, reason: codeDelegateReason("write", String(input.path)) };
			}
			if (event.toolName === "edit" && isCodePath(input.path)) {
				const size = (input.edits || []).reduce((n, e) => n + String(e.newText || "").length, 0);
				if (size >= codeEditMin) return { block: true, reason: codeDelegateReason("edit", String(input.path)) };
			}
		}
		// 子代理轮询节流：同一 workId 短时间内重复 status 查询则拦截，引导改用 wait
		if (event.toolName === "subagent_results" && pollIntervalMs > 0) {
			const input = (event.input || {}) as { mode?: string; waitFor?: string; workIds?: string[] };
			const isWait = input.mode === "wait" || input.waitFor === "any" || input.waitFor === "all";
			const ids = Array.isArray(input.workIds) ? input.workIds : [];
			if (!isWait && ids.length > 0) {
				const now = Date.now();
				const recent = ids.filter((id) => now - (pollSeen.get(id) || 0) < pollIntervalMs);
				// 只在放行时记录时间：被 block 也刷新窗口会让主 agent 每隔 <90s 重试时永远被 block
				if (recent.length === 0) for (const id of ids) pollSeen.set(id, now);
				if (recent.length > 0) {
					return {
						block: true,
						reason: [
							`你在 ${Math.round(pollIntervalMs / 1000)} 秒内重复查询子代理 ${recent.join(", ")} 的进度。`,
							`轮询不产生进展，而且每次都是一次全价模型请求。`,
							`请改用 subagent_results({ workIds, mode: "wait", waitFor: "all", timeoutMs: 30000 }) 等待完成，`,
							`或先处理其他任务、等子代理完成通知。确需频繁查看时设 PI_SLIM_POLL_INTERVAL=0。`,
						].join("\n"),
					};
				}
			}
		}
		if (!blockWeb || !WEB_TOOLS.has(event.toolName)) return;
		return {
			block: true,
			reason: [
				`主会话不要直接调用 ${event.toolName}：检索结果/文献全文会把上万字符灌进主上下文。`,
				`请改用 subagent_start 委派（纯检索用 role: "research"，需要落盘文献卡片用 role: "code"，tier: "light"），`,
				`任务里写清要回答的具体问题和需要的字段，要求子代理只回 ≤300 字结论 + 引用信息（标题/作者/arXiv id/定理号）。`,
				`主 agent 只负责复核“这篇文献是否足以支撑当前引理”，不要亲自通读全文。`,
				`确需主会话自行检索时设 PI_SLIM_BLOCK_WEB=0。`,
			].join("\n"),
		};
	});

	pi.on("tool_result", async (event, ctx) => {
		if (!toolOutputEnabled || exclude.has(event.toolName)) return;
		// 子代理精读的文献资料（论文全文/检索结果）必须保留原文，不能换成摘要
		if (isSubagentProcess(ctx) && WEB_TOOLS.has(event.toolName)) return;
		try {
			const full = textOf(event.content);
			if (full.length <= threshold || full.includes(MARK)) return;
			const dir = outDir(ctx.sessionManager.getSessionId());
			const summary = await buildSummary(
				event.toolName,
				String(event.toolCallId || "unknown"),
				full,
				Boolean(event.isError),
				dir,
				ctx.signal,
			);
			if (summary.length >= full.length * 0.8) return undefined;
			return {
				content: [{ type: "text" as const, text: summary }],
				details: { outsourcedTo: dir, originalChars: full.length },
			};
		} catch {
			return undefined; // 任何失败都退回原始结果
		}
	});

	pi.on("context", async (event, ctx) => {
		const dir = outDir(ctx.sessionManager.getSessionId());
		const isAnthropic = ctx.model?.provider === "anthropic";

		const slimOne = async (m: (typeof event.messages)[number]): Promise<(typeof event.messages)[number]> => {
			const rec = m as unknown as Record<string, unknown>;
			const copy: Record<string, unknown> = { ...rec };
			let touched = false;

			// --- 历史工具结果外包：重启恢复的旧会话也能被压缩 ---
			if (toolOutputEnabled && historyEnabled && rec.role === "toolResult") {
				const toolName = String(rec.toolName || "");
				const full = textOf(rec.content);
				if (!exclude.has(toolName) && full.length > threshold && !full.includes(MARK)) {
					try {
						const summary = await buildSummary(
							toolName,
							String(rec.toolCallId || "unknown"),
							full,
							Boolean(rec.isError),
							dir,
							ctx.signal,
						);
						if (summary.length < full.length * 0.8) {
							copy.content = [{ type: "text", text: summary }];
							touched = true;
						}
					} catch { /* 保留原样 */ }
				}
			}

			// --- 历史思考剥离 ---
			if (stripReasoning && !isAnthropic && rec.role === "assistant") {
				for (const key of ["reasoning_content", "reasoning"]) {
					if (typeof copy[key] === "string" && (copy[key] as string).length > 0) {
						delete copy[key];
						touched = true;
					}
				}
				if (Array.isArray(copy.content)) {
					const content = copy.content as Array<Record<string, unknown>>;
					const filtered = content.filter((b) => {
						const t = b && typeof b === "object" ? b.type : undefined;
						return t !== "thinking" && t !== "reasoning";
					});
					if (filtered.length !== content.length) touched = true;
					copy.content = filtered;
				}
			}

			return touched ? (copy as unknown as typeof m) : m;
		};

		// 限制并发：恢复旧会话时可能有几十条历史输出要首次摘要，避免打满小模型配额
		const queue = [...event.messages.entries()];
		const messages: typeof event.messages = [...event.messages];
		let cursor = 0;
		const workers = Array.from({ length: Math.min(4, queue.length) }, async () => {
			while (cursor < queue.length) {
				const [index, message] = queue[cursor++];
				messages[index] = await slimOne(message);
			}
		});
		await Promise.all(workers);
		const changed = messages.some((m, i) => m !== event.messages[i]);
		return changed ? { messages } : undefined;
	});
}
