import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { calculateCost, clampThinkingLevel } from "@earendil-works/pi-ai";
import type {
	AssistantMessage,
	Context as LlmContext,
	Message,
	Model,
	ProviderEnv,
	ProviderHeaders,
	ThinkingLevel,
	Usage,
} from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/**
 * Cache Heartbeat — 会话空闲时用一次极低成本请求给 prompt 缓存"续命"。
 *
 * 长会话等待（等子代理、等长实验）时 prompt 缓存会过期；过期后下一次真实请求要按
 * 全价重建整份前缀缓存。心跳的做法：空闲时重放"主会话最近一次请求的前缀"，只在其后
 * 追加一个 "Reply with exactly: ok" 的临时 user 消息，让 provider 重新计时并把缓存
 * 写回。实测每次约 $0.003（几乎全是缓存重读费）。
 *
 * 三个必须同时成立的正确性条件（缺一个就白花钱）：
 *
 * 1. sessionId 必须等于主会话 sessionId。
 *    pi-ai 里 prompt_cache_key = clampOpenAIPromptCacheKey(options.sessionId)
 *    （api/openai-completions.js、openai-responses.js、azure-openai-responses.js、
 *    openai-codex-responses.js 都是这一条），传错等于另开一份缓存。
 *
 * 2. 前缀必须与主会话最近一次请求一致：systemPrompt + messages + tools。
 *    这里的取法是"抄真实请求"，而不是"重新拼一遍"：
 *      - systemPrompt ← before_agent_start 的 event.systemPrompt（该 turn 真正用的那份）
 *      - messages     ← context 事件的 messages（走完所有扩展 transform、即将交给
 *                       convertToLlm 的那份 AgentMessage[]），再 convertToLlm
 *      - tools        ← before_provider_request 抓到的 payload.tools（已序列化，含
 *                       strict schema / cache_control），心跳时用 onPayload 原样放回。
 *                       tools 在 payload 里位于 messages 之前，用原始序列化结果才保证
 *                       这一段逐字节一致。
 *    因此本扩展要注册在 extensions 列表**最后一项**：context 事件 handler 按注册顺序
 *    执行，排最后才能看到前面扩展（例如 context-slim）transform 完的结果。
 *
 * 3. 不写会话历史。心跳走 pi-ai 的 completeSimple 直接发独立请求，不经过 pi 的 agent
 *    loop/turn，也不调用 pi.sendMessage / pi.appendEntry，所以心跳的 user/assistant
 *    消息不会进 session 文件，也不会出现在下一轮上下文里。
 *
 * 其它约束：有 turn 在跑（isIdle()!==true 或有排队消息）时跳过；子代理会话不发
 * （判据与 packages/pi-tsien-context-slim 一致）；失败指数退避，绝不重试。
 *
 * 4. 间隔按模型缓存 TTL 自适应（不是固定周期）。
 *    最优心跳间隔 = 0.8 × TTL：早于这个时间发，缓存本来就没过期，纯浪费；
 *    晚于 TTL 发，缓存已经过期，续命失败。所以
 *      - 发送闸门 refreshAfter = 0.8 × TTL（距上次活动满这么久才发一次）；
 *      - 定时器只是低频"看一眼"（cadence，几十秒到几分钟，不花钱），
 *        不是发送周期。这样每 TTL 窗口只发一次心跳，而不是每个 tick 发一次。
 *    TTL 查表见 MODEL_TTL_SEC / PROVIDER_TTL_SEC / MODEL_TTL_PREFIX_SEC。
 *
 * 环境变量：
 *   PI_HEARTBEAT=1                启用（默认关闭）
 *   PI_HEARTBEAT_INTERVAL=240     显式覆盖：改成"空闲每 N 秒发一次"的固定节奏
 *                                 （优先于自适应，便于实验/手动调优）
 *   PI_HEARTBEAT_TTL=2700         显式指定某模型 TTL（秒），覆盖内置 TTL 表；
 *                                 自适应间隔随之变成 0.8 × 该值
 *   PI_HEARTBEAT_MIN_IDLE=120     安全下限：距上次真实活动至少多少秒才允许发
 *                                 （自适应模式下远小于 0.8×TTL，实际不起作用）
 *   PI_HEARTBEAT_MAX_TOKENS=16    心跳回复上限
 *   PI_HEARTBEAT_TIMEOUT_MS=120000
 *   PI_HEARTBEAT_DRY_RUN=1        只写日志不发请求（联调零成本）
 *   PI_HEARTBEAT_VERBOSE=1        跳过原因也写日志
 *   PI_HEARTBEAT_LOG=<path>       默认 ~/.pi/agent/heartbeat.log（JSONL）
 */

/** 心跳附带的临时 user 消息（只存在于这一次请求里，不进会话历史）。 */
export const HEARTBEAT_PROMPT = "Reply with exactly: ok";

/** 心跳间隔 = TTL × 该系数：太早发浪费，太晚发缓存已过期。 */
export const HEARTBEAT_TTL_FRACTION = 0.8;

/**
 * 未知模型（查表查不到、也没设 PI_HEARTBEAT_TTL）的保守默认 TTL。
 * 取 30min：多数 provider 的 prompt cache 在 5–60min 量级，30min 既不会
 * 早到离谱，也不至于晚到必然过期。true TTL 更长时只是略偏密，反之略偏疏。
 */
export const DEFAULT_TTL_SEC = 1800;

/** 检查定时器周期的下限/上限（秒）。cadence 不花钱，只影响发送时刻的精度。 */
export const MIN_CADENCE_SEC = 60;
export const MAX_CADENCE_SEC = 300;

const DEFAULT_MIN_IDLE_SEC = 120;
const DEFAULT_MAX_TOKENS = 16;
const DEFAULT_TIMEOUT_MS = 120_000;

type EnvLike = Record<string, string | undefined>;

// ---------------------------------------------------------------------------
// 模型 TTL 表
// ---------------------------------------------------------------------------

/**
 * deepseek-v4.1-flash 实测（2025-11，dashscope）：
 *   空闲 30min → 命中 99.7%；60min → 96%；120min → 30.7%（大幅过期）。
 * 拟合出的 TTL ≈ 45min。0.8 × 45min = 36min = 2160s 即推荐心跳间隔。
 * 同一实验里用固定 4min 间隔 → 每条消息 10 次心跳，成本放大 10 倍，不划算。
 */
export const TTL_DEEPSEEK_SEC = 2700;

/** 占位值 —— 待实测确认（openai-codex/gpt-6.2-sol）。 */
export const TTL_SOL_PLACEHOLDER_SEC = 1800;

/** 占位值 —— 待实测确认（dashscope/kimi-k3.1-pro）。 */
export const TTL_KIMI_PLACEHOLDER_SEC = 3600;

/**
 * 精确匹配：`<provider>/<modelId>`（小写）。优先级最高。
 * 新增实测数据时改这里，并同步 README 的 TTL 表。
 */
export const MODEL_TTL_SEC: Record<string, { ttlSec: number; note?: string }> = {
	"dashscope/deepseek-v4.1-flash": {
		ttlSec: TTL_DEEPSEEK_SEC,
		note: "实测：30min 命中 99.7% / 60min 96% / 120min 30.7%，估计 TTL≈45min",
	},
	"openai-codex/gpt-6.2-sol": {
		ttlSec: TTL_SOL_PLACEHOLDER_SEC,
		note: "占位值，待实测确认",
	},
	"dashscope/kimi-k3.1-pro": {
		ttlSec: TTL_KIMI_PLACEHOLDER_SEC,
		note: "占位值，待实测确认",
	},
};

/** provider 名包含该子串即命中（用于一家 provider 全是同一 TTL 的情况）。 */
export const PROVIDER_TTL_SEC: Array<{ match: string; ttlSec: number }> = [
	{ match: "deepseek", ttlSec: TTL_DEEPSEEK_SEC },
];

/** 模型 id 前缀命中：dashscope 下 deepseek 系列都走同一条实测结论。 */
export const MODEL_TTL_PREFIX_SEC: Array<{ prefix: string; ttlSec: number }> = [
	{ prefix: "deepseek", ttlSec: TTL_DEEPSEEK_SEC },
];

export type TtlSource = "env" | "table" | "provider" | "prefix" | "default";

export interface TtlResolution {
	ttlSec: number;
	source: TtlSource;
	/** 命中的表项 / env 名 / 默认值说明，写日志用。 */
	matched: string;
}

function readPositiveSec(env: EnvLike, name: string): number | undefined {
	const raw = env[name];
	if (raw === undefined || raw.trim() === "") return undefined;
	const v = Number(raw);
	return Number.isFinite(v) && v > 0 ? v : undefined;
}

/** 查表（不含 env 覆盖）：精确 provider/model → provider 子串 → model id 前缀。 */
export function lookupTtlSec(model: Model<any> | undefined): { ttlSec: number; source: TtlSource; matched: string } | undefined {
	if (!model) return undefined;
	const provider = String(model.provider ?? "").toLowerCase();
	const id = String(model.id ?? "").toLowerCase();
	if (!id && !provider) return undefined;

	const key = `${provider}/${id}`;
	const exact = MODEL_TTL_SEC[key];
	if (exact) return { ttlSec: exact.ttlSec, source: "table", matched: key };

	for (const entry of PROVIDER_TTL_SEC) {
		if (provider.includes(entry.match)) {
			return { ttlSec: entry.ttlSec, source: "provider", matched: `provider~${entry.match}` };
		}
	}
	for (const entry of MODEL_TTL_PREFIX_SEC) {
		if (id.startsWith(entry.prefix)) {
			return { ttlSec: entry.ttlSec, source: "prefix", matched: `id~${entry.prefix}*` };
		}
	}
	return undefined;
}

/**
 * 该模型的有效 TTL：`PI_HEARTBEAT_TTL` 显式覆盖 > 查表 > 保守默认 1800s。
 * 未知模型不会静默用 0（那会让心跳永不停发），也不会用超大值（形同关闭）。
 */
export function resolveTtlSec(model: Model<any> | undefined, env: EnvLike): TtlResolution {
	const envTtl = readPositiveSec(env, "PI_HEARTBEAT_TTL");
	if (envTtl !== undefined) return { ttlSec: envTtl, source: "env", matched: "PI_HEARTBEAT_TTL" };
	const hit = lookupTtlSec(model);
	if (hit) return hit;
	return { ttlSec: DEFAULT_TTL_SEC, source: "default", matched: "default(fallback)" };
}

export interface HeartbeatTiming {
	/** adaptive = 发送闸门由 TTL 推出；fixed-interval = PI_HEARTBEAT_INTERVAL 显式指定。 */
	mode: "adaptive" | "fixed-interval";
	ttlSec: number;
	ttlSource: TtlSource;
	ttlMatched: string;
	/** 距上次真实活动满多少毫秒才允许发一次（真正的发送闸门）。 */
	refreshAfterMs: number;
	/** 检查定时器周期（毫秒）。只是"来看一眼"，不发请求。 */
	cadenceMs: number;
}

/**
 * 由模型 TTL 推出节流参数。
 *
 * 为什么"闸门"而不是"固定周期"：
 *   固定周期会在 TTL 内重复发（4min 周期 / 45min TTL = 每个窗口 11 次），
 *   每次都要重读整份前缀，成本随周期数线性放大。改成"距上次活动 ≥ 0.8×TTL
 *   才发一次"后每个 TTL 窗口最多 1 次，并且因为我们一发心跳就会刷新缓存、
 *   同时把 lastActivityAt 推到当下，下一次自然又是 0.8×TTL 之后。
 *   定时器周期（cadence）只需足够小于闸门，保证"闸门到 → 下一次检查就发"的延迟
 *   吃掉的那部分 TTL 余量仍有余。取 cadence = clamp(0.1×TTL, ≤300s, ≥60s)，
 *   于是最晚在 0.9×TTL 发出，仍留 10% 余量。cadence 只是本地计时，不发请求。
 */
export function resolveTiming(model: Model<any> | undefined, env: EnvLike): HeartbeatTiming {
	const ttl = resolveTtlSec(model, env);
	const explicitIntervalSec = readPositiveSec(env, "PI_HEARTBEAT_INTERVAL");
	if (explicitIntervalSec !== undefined) {
		const ms = explicitIntervalSec * 1000;
		return {
			mode: "fixed-interval",
			ttlSec: ttl.ttlSec,
			ttlSource: ttl.source,
			ttlMatched: ttl.matched,
			refreshAfterMs: ms,
			cadenceMs: ms,
		};
	}
	const refreshAfterMs = Math.round(ttl.ttlSec * HEARTBEAT_TTL_FRACTION) * 1000;
	// cadence 决定发送时刻的精度：下一次检查可能晚于闸门最多一个 cadence。
	// 留 0.1×TTL 的余量（闸门 0.8 + cadence ⩽ 0.1 → 最晚 0.9×TTL 发出），
	// 所以 cadence 不能超过它。一个 TTL 窗口仍只发 1 次，检查本身不花钱。
	const safeWindowSec = Math.max(1, Math.floor(ttl.ttlSec * 0.1));
	// 下限 60s 只在安全窗口容得下时才用：PI_HEARTBEAT_TTL 被设得很小时宁可查得密一点，
	// 也不能让 cadence 把发送时刻推到 TTL 之后（那就白发一次全价请求）。
	const minCadenceSec = Math.max(1, Math.min(MIN_CADENCE_SEC, safeWindowSec));
	const cadenceSec = Math.min(
		MAX_CADENCE_SEC,
		safeWindowSec,
		Math.max(minCadenceSec, Math.round((ttl.ttlSec * HEARTBEAT_TTL_FRACTION) / 4)),
	);
	return {
		mode: "adaptive",
		ttlSec: ttl.ttlSec,
		ttlSource: ttl.source,
		ttlMatched: ttl.matched,
		refreshAfterMs,
		cadenceMs: cadenceSec * 1000,
	};
}

export function numEnv(env: EnvLike, name: string, fallback: number): number {
	const raw = env[name];
	if (raw === undefined || raw.trim() === "") return fallback;
	const v = Number(raw);
	return Number.isFinite(v) && v >= 0 ? v : fallback;
}

function agentDir(env: EnvLike): string {
	const dir = env.PI_CODING_AGENT_DIR?.trim();
	return dir ? resolve(dir) : join(homedir(), ".pi", "agent");
}

/**
 * 子代理会话不发心跳：子代理是短命会话、缓存独立，心跳只会白花钱。
 * 判据与 packages/pi-tsien-context-slim/src/index.ts 的 isSubagentProcess 一致。
 */
export function isSubagentProcess(
	ctx: { sessionManager?: { getSessionFile?: () => string | undefined } },
	env: EnvLike,
): boolean {
	if (env.PI_SUBAGENT_WORKBENCH_CHILD === "1") return true;
	const raw = env.PI_TRACE_CONTEXT;
	if (raw) {
		try {
			const t = JSON.parse(raw) as Record<string, unknown>;
			if (t.parentSessionId || t.parentToolCallId || t.parentWorkId || t.parentWorkflowId) return true;
		} catch {
			/* 不是 JSON 就忽略 */
		}
	}
	const file = ctx.sessionManager?.getSessionFile?.() || "";
	return file.includes("subagent-sessions");
}

/**
 * 心跳使用的 thinking 档位。
 *
 * effort 型 provider（OpenAI responses / codex / completions、Anthropic adaptive
 * thinking）把 "minimal" 映射成一个 effort 字符串，不会放大 max_tokens，所以照用。
 * budget 型 provider（老 Anthropic 模型、Bedrock Anthropic）会把 reasoning 翻成
 * thinkingBudgetTokens，pi 会把 max_tokens 抬到 maxTokens + 1024 起（见
 * api/anthropic-messages.js streamSimple），一次心跳就多烧一千多个 thinking token。
 * 这种情况下宁可关掉 thinking：心跳只要触发缓存重读，不需要模型思考。
 */
export function resolveHeartbeatReasoning(model: Model<any>): ThinkingLevel | undefined {
	if (!model.reasoning) return undefined;
	const api = String(model.api);
	const effortBased = api === "openai-responses" ||
		api === "azure-openai-responses" ||
		api === "openai-codex-responses" ||
		api === "openai-completions" ||
		api === "google-generative-ai" ||
		api === "google-vertex" ||
		// Anthropic 只有在 adaptive thinking 下才是 effort 型；旧模型走 budget，会抬高 max_tokens。
		(model.compat as { forceAdaptiveThinking?: boolean } | undefined)?.forceAdaptiveThinking === true;
	if (!effortBased) return undefined; // budget 型：thinking 关掉更便宜
	const clamped = clampThinkingLevel(model, "minimal");
	return clamped === "off" ? undefined : clamped;
}

/** 心跳请求的上下文：真实前缀 + 末尾一个临时 user 消息。纯函数，便于单测。 */
export function buildHeartbeatContext(input: {
	systemPrompt: string;
	agentMessages: readonly unknown[];
	timestamp: number;
	prompt?: string;
}): LlmContext {
	const prefix = convertToLlm(input.agentMessages as never) as Message[];
	const tempUser: Message = {
		role: "user",
		content: [{ type: "text", text: input.prompt ?? HEARTBEAT_PROMPT }],
		timestamp: input.timestamp,
	};
	return {
		systemPrompt: input.systemPrompt,
		messages: [...prefix, tempUser],
	};
}

/** 观测到的主会话状态（全部来自"抄真实请求"，不重新拼）。 */
interface Observed {
	systemPrompt: string;
	/** 最近一次真实请求的 AgentMessage[]（context 事件里 transform 之后的那份）。 */
	agentMessages: unknown[] | undefined;
	/** 最近一次真实请求 payload 里序列化好的 tools（ground truth）。 */
	toolPayload: unknown[] | undefined;
	/** toolPayload 是在哪个模型下抓到的（换模型后格式可能不同，不再复用）。 */
	toolPayloadModel: string | undefined;
	sessionId: string | undefined;
	/** 上次真实活动时间（任何 turn/message 事件都会更新）。 */
	lastActivityAt: number;
}

export type HeartbeatComplete = (
	model: Model<any>,
	context: LlmContext,
	options: Record<string, unknown>,
) => Promise<AssistantMessage>;

export interface HeartbeatExtensionOptions {
	/** 可注入的时钟（测试用）。 */
	now?: () => number;
	/** 可注入的 complete（测试用 mock）。 */
	complete?: HeartbeatComplete;
	setInterval?: (fn: () => void, ms: number) => unknown;
	clearInterval?: (handle: unknown) => void;
	/** 日志落盘（测试可接管）。 */
	appendLog?: (path: string, line: string) => void;
	env?: EnvLike;
	/** 覆盖日志路径（默认 ~/.pi/agent/heartbeat.log）。 */
	logPath?: string;
}

/** 供测试/调试检查的内部句柄。 */
export interface HeartbeatHandle {
	observed: Observed;
	tick: () => Promise<void>;
	stop: () => void;
	config: {
		enabled: boolean;
		/** 发送门限（距上次活动满这么久才发一次）；= 0.8×TTL 或 PI_HEARTBEAT_INTERVAL。 */
		intervalMs: number;
		minIdleMs: number;
		maxTokens: number;
		dryRun: boolean;
		logPath: string;
		mode: HeartbeatTiming["mode"];
		ttlSec: number;
		ttlSource: TtlSource;
		cadenceMs: number;
	};
	/** 按当前模型实时算一次节流参数（测试/调试用）。 */
	timing: () => HeartbeatTiming;
}

/**
 * 生成扩展工厂。默认导出用真实依赖；测试用 createHeartbeatExtension 注入
 * clock / complete / setInterval / appendLog，完全不碰网络与磁盘。
 */
export function createHeartbeatExtension(options: HeartbeatExtensionOptions = {}) {
	return function heartbeatExtension(pi: ExtensionAPI): void {
		const env = options.env ?? process.env;
		const now = options.now ?? (() => Date.now());
		const setIntervalFn = options.setInterval ?? ((fn: () => void, ms: number) => setInterval(fn, ms));
		const clearIntervalFn = options.clearInterval ?? ((h: unknown) => clearInterval(h as NodeJS.Timeout));
		const completeFn: HeartbeatComplete = options.complete ??
			((model, context, requestOptions) => completeSimple(model, context, requestOptions as never));
		const logPath = options.logPath ?? join(agentDir(env), "heartbeat.log");
		const appendLog = options.appendLog ?? appendLine;

		const enabled = env.PI_HEARTBEAT === "1" || env.PI_HEARTBEAT === "true";
		/** 加载时模型未知 → 只能靠 env 覆盖 / 保守默认算一份初始值，运行时按真实模型重算。 */
		const initialTiming = resolveTiming(undefined, env);
		const intervalMs = initialTiming.refreshAfterMs;
		const minIdleMs = numEnv(env, "PI_HEARTBEAT_MIN_IDLE", DEFAULT_MIN_IDLE_SEC) * 1000;
		const maxTokens = numEnv(env, "PI_HEARTBEAT_MAX_TOKENS", DEFAULT_MAX_TOKENS);
		const timeoutMs = numEnv(env, "PI_HEARTBEAT_TIMEOUT_MS", DEFAULT_TIMEOUT_MS);
		const dryRun = env.PI_HEARTBEAT_DRY_RUN === "1";
		const verbose = env.PI_HEARTBEAT_VERBOSE === "1";

		// 进程级判据（PI_SUBAGENT_WORKBENCH_CHILD / PI_TRACE_CONTEXT）加载时就能定。
		const subagentAtLoad = isSubagentProcess({}, env);

		const observed: Observed = {
			systemPrompt: "",
			agentMessages: undefined,
			toolPayload: undefined,
			toolPayloadModel: undefined,
			sessionId: undefined,
			lastActivityAt: now(),
		};

		let ctxRef: ExtensionContext | undefined;
		let inFlight = false;
		let nextAllowedAt = 0;
		let failureStreak = 0;
		let timer: unknown;
		let timerCadenceMs = 0;
		let counter = 0;

		/** 当前模型的有效节流参数（每次判断重算，所以换模型立即生效）。 */
		function currentTiming(): HeartbeatTiming {
			return resolveTiming(safeModel(ctxRef), env);
		}

		/**
		 * 发送门限：距上次真实活动满 refreshAfterMs（自适应 = 0.8×TTL）才允许发一次。
		 * PI_HEARTBEAT_MIN_IDLE 作为安全下限并入（自适应时几乎总被覆盖）。
		 */
		function refreshThresholdMs(timing: HeartbeatTiming): number {
			return Math.max(timing.refreshAfterMs, minIdleMs);
		}

		function writeLog(record: Record<string, unknown>): void {
			try {
				appendLog(logPath, JSON.stringify(record));
			} catch {
				/* 日志写失败绝不能影响主会话 */
			}
		}

		function markActivity(): void {
			observed.lastActivityAt = now();
		}

		function currentSessionId(): string | undefined {
			return safeSessionId(ctxRef);
		}

		function noteSession(sessionId: string | undefined): void {
			if (!sessionId) return;
			if (observed.sessionId && observed.sessionId !== sessionId) {
				// 会话切换：旧快照属于别的会话（也属于别的 cache key），丢弃重来。
				observed.agentMessages = undefined;
				observed.toolPayload = undefined;
				observed.toolPayloadModel = undefined;
			}
			observed.sessionId = sessionId;
		}

		function isSubagent(): boolean {
			if (subagentAtLoad) return true;
			return ctxRef ? isSubagentProcess(ctxRef, env) : false;
		}

		function rememberSystemPrompt(fallbackToCtx: boolean): void {
			const system = fallbackToCtx ? safeSystemPrompt(ctxRef) : undefined;
			if (system) observed.systemPrompt = system;
		}

		pi.on("session_start", async (_event, ctx) => {
			ctxRef = ctx;
			markActivity();
			noteSession(safeSessionId(ctx));
			rememberSystemPrompt(true);
			startTimer();
		});

		pi.on("before_agent_start", async (event, ctx) => {
			ctxRef = ctx;
			markActivity();
			noteSession(safeSessionId(ctx));
			// 这是本 turn 真正使用的 system prompt（扩展链可能已替换过）。
			const fromEvent = typeof event.systemPrompt === "string" ? event.systemPrompt : "";
			if (fromEvent.length > 0) observed.systemPrompt = fromEvent;
			else rememberSystemPrompt(true);
		});

		pi.on("turn_start", async (_event, ctx) => {
			ctxRef = ctx;
			markActivity();
		});

		pi.on("turn_end", async (_event, ctx) => {
			ctxRef = ctx;
			markActivity();
			noteSession(safeSessionId(ctx));
			rememberSystemPrompt(true);
		});

		pi.on("message_start", async (_event, ctx) => {
			ctxRef = ctx;
			markActivity();
		});

		pi.on("context", async (event, ctx) => {
			ctxRef = ctx;
			markActivity();
			noteSession(safeSessionId(ctx));
			// 深拷贝：之后 pi 还会继续改动这个数组，心跳必须拿到"请求发出那一刻"的形态。
			try {
				observed.agentMessages = structuredClone(event.messages) as unknown[];
			} catch {
				observed.agentMessages = (event.messages as unknown[]).slice();
			}
			return undefined; // 只观测，绝不改上下文
		});

		pi.on("before_provider_request", async (event) => {
			// ground truth：provider 序列化后的 tools（含 strict schema / cache_control）。
			const payload = event.payload as { tools?: unknown } | undefined;
			if (payload && Array.isArray(payload.tools)) {
				const model = safeModel(ctxRef);
				try {
					observed.toolPayload = structuredClone(payload.tools) as unknown[];
				} catch {
					observed.toolPayload = (payload.tools as unknown[]).slice();
				}
				observed.toolPayloadModel = model ? `${model.provider}/${model.id}` : undefined;
			}
			return undefined;
		});

		pi.on("session_shutdown", async () => {
			stopTimer();
		});

		function startTimer(): void {
			if (!enabled || subagentAtLoad) return;
			const cadence = currentTiming().cadenceMs;
			if (!(cadence > 0)) return;
			// cadence 变了（换了模型/TTL 覆盖生效）才重建定时器。
			if (timer !== undefined && cadence === timerCadenceMs) return;
			stopTimer();
			const handle = setIntervalFn(() => {
				void tick();
			}, cadence);
			// 心跳定时器不应拖住进程退出。
			(handle as { unref?: () => void }).unref?.();
			timer = handle;
			timerCadenceMs = cadence;
		}

		function stopTimer(): void {
			if (timer === undefined) return;
			try {
				clearIntervalFn(timer);
			} catch {
				/* ignore */
			}
			timer = undefined;
			timerCadenceMs = 0;
		}

		/** 该不该发；返回跳过原因（undefined = 可以发）。 */
		function skipReason(): string | undefined {
			if (!enabled) return "disabled";
			if (isSubagent()) return "subagent";
			const ctx = ctxRef;
			if (!ctx) return "no-context";
			if (inFlight) return "in-flight";
			let idle: boolean;
			try {
				idle = ctx.isIdle() === true;
			} catch {
				return "stale-context";
			}
			if (!idle) return "busy";
			try {
				if (ctx.hasPendingMessages?.()) return "pending-messages";
			} catch {
				/* 老版本没有该方法 */
			}
			if (!observed.agentMessages || observed.agentMessages.length === 0) return "no-snapshot";
			const ts = now();
			if (ts - observed.lastActivityAt < refreshThresholdMs(currentTiming())) return "recent-activity";
			if (ts < nextAllowedAt) return "backoff";
			return undefined;
		}

		async function tick(): Promise<void> {
			const reason = skipReason();
			if (reason !== undefined) {
				if (verbose && reason !== "disabled" && reason !== "subagent") {
					writeLog({ ts: new Date(now()).toISOString(), event: "skip", reason });
				}
				return;
			}
			await beat(ctxRef as ExtensionContext);
		}

		async function beat(ctx: ExtensionContext): Promise<void> {
			inFlight = true;
			const startedAt = now();
			const base = { ts: new Date(startedAt).toISOString(), event: "heartbeat", seq: ++counter };
			let modelLabel: string | undefined;
			try {
				const model = ctx.model;
				if (!model) throw new Error("no model");
				modelLabel = `${model.provider}/${model.id}`;
				const sessionId = safeSessionId(ctx);
				if (!sessionId) throw new Error("no sessionId");
				// 前缀必须来自同一会话，否则 cache key 与前缀都对不上。
				if (observed.sessionId && observed.sessionId !== sessionId) {
					throw new Error("session switched before heartbeat");
				}

				const context = buildHeartbeatContext({
					systemPrompt: observed.systemPrompt,
					agentMessages: observed.agentMessages as unknown[],
					timestamp: startedAt,
				});

				// 最低档 thinking（按 model 能力钳制；budget 型模型直接关掉，见注释）。
				const reasoning = resolveHeartbeatReasoning(model);

				const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
				const requestModel: Model<any> = auth.ok && auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model;

				const requestOptions: Record<string, unknown> = {
					sessionId, // ← 与主会话一致，才是同一个 prompt_cache_key
					maxTokens,
					timeoutMs,
					maxRetries: 0, // 心跳失败无所谓（下一轮再来），不重试、不重复付费
				};
				if (reasoning) requestOptions.reasoning = reasoning;
				if (auth.ok) {
					if (auth.apiKey) requestOptions.apiKey = auth.apiKey;
					if (auth.headers) requestOptions.headers = auth.headers as ProviderHeaders;
					if (auth.env) requestOptions.env = auth.env as ProviderEnv;
				}

				const toolPayload = selectToolPayload(model);
				if (toolPayload) {
					// tools 段用真实 payload 原样放回：避免 strict schema 重算导致前缀不一致。
					requestOptions.onPayload = (payload: unknown) =>
						payload && typeof payload === "object" ? { ...(payload as object), tools: toolPayload } : undefined;
				}

				const timing = resolveTiming(model, env);
				const logBase = {
					...base,
					sessionId,
					model: modelLabel,
					systemPromptChars: (context.systemPrompt ?? "").length,
					messageCount: context.messages.length,
					toolsInjected: Boolean(toolPayload),
					reasoning: reasoning ?? "off",
					maxTokens,
					// 记录"这一发是用哪套 TTL 判定的"，方便事后校核自适应是否生效。
					timing: {
						mode: timing.mode,
						ttlSec: timing.ttlSec,
						ttlSource: timing.ttlSource,
						ttlMatched: timing.ttlMatched,
						refreshAfterSec: Math.round(timing.refreshAfterMs / 1000),
						idleSec: Math.round((startedAt - observed.lastActivityAt) / 1000),
					},
				};

				if (dryRun) {
					writeLog({ ...logBase, mode: "dry-run" });
					return;
				}

				const response = await completeFn(requestModel, context, requestOptions);
				const usage = response?.usage;
				// 按刊例重算成本，不只信任响应里的 cost（心跳里 cost 字段常常是全 0）。
				const cost = usage
					? calculateCost(model, { ...usage, cost: { ...usage.cost } } as Usage)
					: undefined;
				const error = response?.stopReason === "error"
					? response.errorMessage || "unknown error"
					: undefined;

				writeLog({
					...logBase,
					mode: "sent",
					usage: usage
						? {
							input: usage.input,
							cacheRead: usage.cacheRead,
							cacheWrite: usage.cacheWrite,
							output: usage.output,
						}
						: undefined,
					cost: cost
						? {
							input: round6(cost.input),
							cacheRead: round6(cost.cacheRead),
							cacheWrite: round6(cost.cacheWrite),
							output: round6(cost.output),
							total: round6(cost.total),
						}
						: undefined,
					hit: Boolean(usage && usage.cacheRead > 0),
					stopReason: response?.stopReason,
					durationMs: now() - startedAt,
					error,
				});

				if (error) noteFailure();
				else {
					failureStreak = 0;
					nextAllowedAt = 0;
				}
			} catch (error) {
				noteFailure();
				writeLog({
					...base,
					mode: "error",
					sessionId: observed.sessionId,
					model: modelLabel,
					durationMs: now() - startedAt,
					error: error instanceof Error ? formatError(error) : String(error),
				});
			} finally {
				inFlight = false;
				markActivity(); // 心跳本身算活动，避免连发
			}
		}

		/** 只复用同一模型下抓到的 tools 序列化结果。 */
		function selectToolPayload(model: Model<any>): unknown[] | undefined {
			if (!observed.toolPayload || observed.toolPayload.length === 0) return undefined;
			const label = `${model.provider}/${model.id}`;
			if (observed.toolPayloadModel && observed.toolPayloadModel !== label) return undefined;
			return observed.toolPayload;
		}

		/** 失败后指数退避。基数是检查 cadence 而不是发送间隔：避免退避期间被定时器
		 * 反复唤醒、也避免把一个小时级的 TTL 当重试频率。 */
		function noteFailure(): void {
			failureStreak = Math.min(failureStreak + 1, 4);
			nextAllowedAt = now() + currentTiming().cadenceMs * failureStreak;
		}

		const handle: HeartbeatHandle = {
			observed,
			tick,
			stop: stopTimer,
			config: {
				enabled,
				intervalMs,
				minIdleMs,
				maxTokens,
				dryRun,
				logPath,
				mode: initialTiming.mode,
				ttlSec: initialTiming.ttlSec,
				ttlSource: initialTiming.ttlSource,
				cadenceMs: initialTiming.cadenceMs,
			},
			timing: currentTiming,
		};
		(pi as unknown as { __heartbeat?: HeartbeatHandle }).__heartbeat = handle;

		startTimer();
	};
}

function safeModel(ctx: ExtensionContext | undefined): Model<any> | undefined {
	try {
		return ctx?.model;
	} catch {
		return undefined;
	}
}

function safeSessionId(ctx: ExtensionContext | undefined): string | undefined {
	try {
		return ctx?.sessionManager?.getSessionId?.();
	} catch {
		return undefined;
	}
}

function safeSystemPrompt(ctx: ExtensionContext | undefined): string | undefined {
	try {
		return ctx?.getSystemPrompt?.();
	} catch {
		return undefined;
	}
}

function formatError(err: Error): string {
	const name = err.name && err.name !== "Error" ? `${err.name}: ` : "";
	return `${name}${err.message}`;
}

function round6(n: number): number {
	return Math.round(n * 1e6) / 1e6;
}

function appendLine(path: string, line: string): void {
	mkdirSync(dirname(path), { recursive: true });
	appendFileSync(path, `${line}\n`, "utf8");
}

export default createHeartbeatExtension();