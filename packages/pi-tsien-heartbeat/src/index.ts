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
import { appendFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
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
 * 5. 先判"这个 provider 的缓存类型"，再谈间隔（三模型实测的结论）。
 *    心跳只在缓存是**固定 TTL**（写入后按寿命过期、续期有效）时才有意义：
 *      - fixed-ttl      deepseek-v4.1-flash：TTL≈45min，0.8×TTL≈36min 续期有效。
 *      - long-retention kimi-k3.1-pro：TTL>2h（120min 等待后仍 91.8%），一般无需心跳。
 *      - probabilistic  sol (openai-codex)：命中率由 LRU/容量/路由决定，与"写入多久"
 *                       弱相关且非单调（5/10min 0%、15min 53.6%）；对照组实测心跳组与
 *                       纯等待组命中率完全相同 → 心跳无效。默认**不发**，只有用户用
 *                       PI_HEARTBEAT_TTL / PI_HEARTBEAT_INTERVAL 显式指定才强制开。
 *
 * 环境变量：
 *   PI_HEARTBEAT=1                启用（默认关闭；probabilistic 缓存模型仍不发，见上）
 *   PI_HEARTBEAT_INTERVAL=240     显式覆盖：改成"空闲每 N 秒发一次"的固定节奏
 *                                 （优先于自适应，便于实验/手动调优）
 *   PI_HEARTBEAT_TTL=2700         显式指定某模型 TTL（秒），覆盖内置 TTL 表；
 *                                 自适应间隔随之变成 0.8 × 该值
 *   PI_HEARTBEAT_MIN_IDLE=120     安全下限：距上次真实活动至少多少秒才允许发
 *                                 （自适应模式下远小于 0.8×TTL，实际不起作用）
 *   PI_HEARTBEAT_MAX_IDLE=3600    空闲上限（秒）：距上次真实活动超过这么久就停心跳。
 *                                 不设时按模型刊例价自动算盈亏平衡点
 *                                 （= 心跳间隔 × (输入价/缓存读价 − 1)），
 *                                 上限受 PI_HEARTBEAT_MAX_IDLE_CEILING 约束。
 *   PI_HEARTBEAT_MAX_IDLE_CEILING=14400  自动算出的上限的天花板（秒，默认 4h）
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
 * 缓存类型 —— 比 TTL 数值更根本：决定"心跳对这个 provider 到底有没有用"。
 *
 * - `fixed-ttl`      缓存从写入/命中起按固定寿命过期，续期有效。心跳的正常工作对象。
 * - `long-retention` 寿命很长（实测 ≥2h），会话里的等待通常等不到过期 → 心跳基本不需要；
 *                    自适应间隔 0.8×TTL 本身就已经很长，等于"默认几乎不发"。
 * - `probabilistic`  命中与否由 provider 侧 LRU/容量/路由决定，与"上次写入多久"弱相关
 *                    （实测甚至非单调）。心跳既不能保证命中、又自己产生费用，默认**不发**
 *                    并写一条日志说明原因；只有用户显式指定 PI_HEARTBEAT_TTL /
 *                    PI_HEARTBEAT_INTERVAL 才视为"我知道自己在干什么"而强制开。
 */
export type CacheKind = "fixed-ttl" | "long-retention" | "probabilistic";

/**
 * 未知模型（查表查不到、也没设 PI_HEARTBEAT_TTL）的保守默认 TTL。
 * 取 30min：多数 provider 的 prompt cache 在 5–60min 量级，30min 既不会
 * 早到离谱，也不至于晚到必然过期。true TTL 更长时只是略偏密，反之略偏疏。
 */
export const DEFAULT_TTL_SEC = 1800;

/**
 * 空闲上限：距上次真实活动超过这么久就**停止**心跳（毫秒）。
 *
 * 为什么需要：心跳省下的钱来自「下次回来用的时候缓存还热着」。
 * 盈亏平衡点 = 心跳间隔 × (输入价/缓存读价 − 1)：超过这个时长即使续着命，
 * 也已经比一次冷启动更贵。没有上限时，被弃置的会话会一直按节奏发请求。
 * 所以上限直接取盈亏平衡点（按模型自身刊例价算），不手工维护表。
 */
export const DEFAULT_MAX_IDLE_SEC = 3600;
/** 盈亏平衡算出来再大，也不让它超过这个上限（防止价格元数据异常时永不停）。 */
export const MAX_IDLE_CEILING_SEC = 24 * 3600;

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
 * deepseek-v4.1-flash 实测（dashscope，三模型对照实验）：
 *   纯等待 30min → 命中 99.7%；60min → 96%；120min → 30.7%（大幅过期）→ 拟合 TTL ≈ 45min。
 *   同一实验的**心跳组**（0.8×TTL≈36min 续期一次）120min 后仍保持 99.4% 命中 → 续期有效。
 * 0.8 × 45min = 36min = 2160s 即推荐心跳间隔。
 * 同一实验里用固定 4min 间隔 → 每条消息 10 次心跳，成本放大 10 倍，不划算。
 */
export const TTL_DEEPSEEK_SEC = 2700;

/**
 * kimi-k3.1-pro 实测（dashscope）：等待 120min 后命中率仍 91.8%、没有掉崖 → TTL > 2h。
 * 表里取 7200s 作为"下界估计"（真实值只会更长）；0.8×TTL = 5760s ≈ 96min 才发一次，
 * 会话里几乎等不到，所以缓存类型标 `long-retention`：基本无需心跳。
 */
export const TTL_KIMI_SEC = 2700;

/**
 * Claude 系实测（任意提供方走 Anthropic 语义）：**滑动 5 分钟窗口**。
 * 2026-11-28 探测：间隔 5min 仍命中，间隔 10min 失效；
 * 同一前缀在 2/5/10min 连续命中也说明每次命中都会顺延窗口。
 * 0.8 × 5min = 4min 即有效心跳间隔。
 */
export const TTL_CLAUDE_SEC = 300;

/**
 * sol（openai-codex/gpt-6.2-sol）实测：**不是固定 TTL**，是概率性/不稳定缓存
 * （疑似 LRU、容量或路由驱动）。证据：
 *   - 纯等待命中率 5min → 0%、10min → 0%、15min → 53.6%（非单调，5min 比 15min 还差）；
 *   - 心跳对照：15min 时心跳组与纯等待组命中率完全相同（53.6%）；
 *   - 心跳请求自身 4 次里只有 1 次命中。
 * 结论：心跳对 sol 无效，默认不启用。这个数值只是"若用户强制开启"的标称 TTL。
 */
export const TTL_SOL_SEC = 1800;

/** TTL 表项：数值 + 缓存类型 + 实测依据（note 是数据来源，写 README/评论时照抄）。 */
export interface TtlTableEntry {
	ttlSec: number;
	cacheKind: CacheKind;
	note?: string;
}

/**
 * 精确匹配：`<provider>/<modelId>`（小写）。优先级最高。
 * 新增实测数据时改这里，并同步 README 的三模型对照表。
 */
export const MODEL_TTL_SEC: Record<string, TtlTableEntry> = {
	"dashscope/deepseek-v4.1-flash": {
		ttlSec: TTL_DEEPSEEK_SEC,
		cacheKind: "fixed-ttl",
		note: "实测：固定 TTL≈45min（等待 30min 99.7% / 60min 96% / 120min 30.7%）；" +
			"0.8×TTL≈36min 续期有效（心跳组 120min 仍 99.4%）",
	},
	"dashscope/kimi-k3.1-pro": {
		ttlSec: TTL_KIMI_SEC,
		cacheKind: "fixed-ttl",
		note: "2026-11-28 复测：小前缀静置 90min 仍命中、120min 失效；但真实会话（20–40 万前缀）" +
			"在间隔 40–80min 命中率塌到 5%（大前缀单元易被驱逐）→ 按大前缀取 45min，0.8×≈36min 心跳",
	},
	"dashscope/qwen4-max": {
		ttlSec: 2700,
		cacheKind: "fixed-ttl",
		note: "2026-11-28 实测：独立前缀 60min 仍命中、75min 失效，另一组 45min 即失效（抖动）→ 保守取 45min（该模型缓存读极便宜，密集心跳成本可忽略）",
	},
	"openai-codex/gpt-6.2-sol": {
		ttlSec: TTL_SOL_SEC,
		cacheKind: "probabilistic",
		note: "实测：概率性/不稳定缓存，非固定 TTL（等待 5/10min 0%、15min 53.6% 非单调；" +
			"15min 心跳组与等待组命中率相同 = 53.6%；心跳自身 4 次仅 1 次命中）→ 心跳无效，默认不启用",
	},
};

/**
 * provider 名包含该子串即命中（一家 provider 全是同一种缓存行为时用）。
 * 顺序有意义：`openai-codex` 必须排在 `openai` 前。
 */
export const PROVIDER_TTL_SEC: Array<{ match: string } & TtlTableEntry> = [
	{
		match: "deepseek",
		ttlSec: TTL_DEEPSEEK_SEC,
		cacheKind: "fixed-ttl",
		note: "按 deepseek-v4.1-flash 实测结论外推同系列",
	},
	{
		match: "kimi",
		ttlSec: TTL_KIMI_SEC,
		cacheKind: "fixed-ttl",
		note: "按 kimi-k3.1-pro 2026-11-28 复测：小前缀可活 90min，大前缀 40–80min 即被驱逐 → 取 60min",
	},
	{
		match: "openai-codex",
		ttlSec: TTL_SOL_SEC,
		cacheKind: "probabilistic",
		note: "codex 后端实测概率性缓存（sol），心跳无效",
	},
	{
		match: "openai",
		ttlSec: TTL_SOL_SEC,
		cacheKind: "probabilistic",
		note: "官方 openai 直连缓存由 provider 侧管理（短命/自动），未实测出固定 TTL；" +
			"与 sol 同按保守策略默认不跳，需实测可用 PI_HEARTBEAT_TTL 强制",
	},
];

/** 模型 id 前缀命中（跨 provider 的模型系列，例如同一模型走代理）。 */
export const MODEL_TTL_PREFIX_SEC: Array<{ prefix: string } & TtlTableEntry> = [
	{ prefix: "deepseek", ttlSec: TTL_DEEPSEEK_SEC, cacheKind: "fixed-ttl" },
	{ prefix: "kimi", ttlSec: TTL_KIMI_SEC, cacheKind: "fixed-ttl", note: "2026-11-28 复测：小前缀 90min 仍活，大前缀 40–80min 被驱逐 → 保守 45min" },
	{ prefix: "claude", ttlSec: TTL_CLAUDE_SEC, cacheKind: "fixed-ttl", note: "Anthropic 语义：5min 滑动窗口" },
	{ prefix: "qwen4", ttlSec: 2700, cacheKind: "fixed-ttl", note: "2026-11-28 实测：两组数据在 45–60min 间矛盾（抖动）→ 保守取 45min；该模型缓存读取极便宜，密集心跳成本可忽略" },
	{
		prefix: "gpt-6.2-sol",
		ttlSec: TTL_SOL_SEC,
		cacheKind: "probabilistic",
		note: "sol 实测概率性缓存，心跳无效",
	},
	{ prefix: "gpt-6.2", ttlSec: TTL_SOL_SEC, cacheKind: "probabilistic" },
];

export type TtlSource = "env" | "override" | "table" | "provider" | "prefix" | "default";

export interface TtlResolution {
	ttlSec: number;
	source: TtlSource;
	/** 命中的表项 / env 名 / 默认值说明，写日志用。 */
	matched: string;
	/** 该模型的缓存类型（查不到表项时按 fixed-ttl 处理，即"保守地当作可用"）。 */
	cacheKind: CacheKind;
	/** probabilistic 且用户没有显式强制 → 不发心跳。 */
	suppressed: boolean;
	/** suppressed 的原因码，未抑制时为 undefined。 */
	suppressedReason?: string;
	/** 让 probabilistic 模型强制发心跳的 env 名（PI_HEARTBEAT_TTL / PI_HEARTBEAT_INTERVAL）。 */
	forcedBy?: string;
}

function readPositiveSec(env: EnvLike, name: string): number | undefined {
	const raw = env[name];
	if (raw === undefined || raw.trim() === "") return undefined;
	const v = Number(raw);
	return Number.isFinite(v) && v > 0 ? v : undefined;
}

/** 查表（不含 env 覆盖）：精确 provider/model → provider 子串 → model id 前缀。 */
/**
 * 机器本地 TTL 覆盖表（**不进仓库**）。
 *
 * 同一模型走不同通道时缓存行为可能不同（例如某代理把 60 分钟寿命压成 5 分钟），
 * 这类差异属于部署细节，不适合写进开源表里。所以允许在
 * `PI_HEARTBEAT_TTL_FILE`（默认 `<agent dir>/heartbeat-ttl.json`）里按
 * `"<provider>/<model>"` 覆盖，优先级最高：
 *
 * ```json
 * { "version": 1, "models": { "<provider>/<model>": { "ttlSec": 300, "cacheKind": "fixed-ttl", "note": "..." } } }
 * ```
 */
let overrideCache: { path: string; mtimeMs: number; models: Record<string, TtlTableEntry> } | undefined;

function overrideTable(): Record<string, TtlTableEntry> {
	const file = process.env.PI_HEARTBEAT_TTL_FILE?.trim() || join(homedir(), ".pi", "agent", "heartbeat-ttl.json");
	try {
		const stat = statSync(file);
		if (overrideCache && overrideCache.path === file && overrideCache.mtimeMs === stat.mtimeMs) return overrideCache.models;
		const parsed = JSON.parse(readFileSync(file, "utf8")) as { models?: Record<string, Partial<TtlTableEntry>> };
		const models: Record<string, TtlTableEntry> = {};
		for (const [key, value] of Object.entries(parsed.models ?? {})) {
			if (!value || typeof value.ttlSec !== "number" || !(value.ttlSec > 0)) continue;
			const kind: CacheKind =
				value.cacheKind === "long-retention" || value.cacheKind === "probabilistic" ? value.cacheKind : "fixed-ttl";
			models[key.toLowerCase()] = { ttlSec: value.ttlSec, cacheKind: kind, ...(value.note ? { note: value.note } : {}) };
		}
		overrideCache = { path: file, mtimeMs: stat.mtimeMs, models };
		return models;
	} catch {
		overrideCache = undefined;
		return {};
	}
}

export function lookupTtlSec(
	model: Model<any> | undefined,
): { ttlSec: number; cacheKind: CacheKind; source: TtlSource; matched: string; note?: string } | undefined {
	if (!model) return undefined;
	const provider = String(model.provider ?? "").toLowerCase();
	const id = String(model.id ?? "").toLowerCase();
	if (!id && !provider) return undefined;

	const key = `${provider}/${id}`;
	const override = overrideTable()[key];
	if (override) return { ...override, source: "override", matched: key };
	const exact = MODEL_TTL_SEC[key];
	if (exact) return { ttlSec: exact.ttlSec, cacheKind: exact.cacheKind, source: "table", matched: key, note: exact.note };

	for (const entry of PROVIDER_TTL_SEC) {
		if (provider.includes(entry.match)) {
			return {
				ttlSec: entry.ttlSec,
				cacheKind: entry.cacheKind,
				source: "provider",
				matched: `provider~${entry.match}`,
				note: entry.note,
			};
		}
	}
	for (const entry of MODEL_TTL_PREFIX_SEC) {
		if (id.startsWith(entry.prefix)) {
			return {
				ttlSec: entry.ttlSec,
				cacheKind: entry.cacheKind,
				source: "prefix",
				matched: `id~${entry.prefix}*`,
				note: entry.note,
			};
		}
	}
	return undefined;
}

/** 用户显式指定了间隔/TTL 吗？这是"我自己承担后果"的强制信号（对 probabilistic 模型生效）。 */
function forceEnvName(env: EnvLike): string | undefined {
	if (readPositiveSec(env, "PI_HEARTBEAT_TTL") !== undefined) return "PI_HEARTBEAT_TTL";
	if (readPositiveSec(env, "PI_HEARTBEAT_INTERVAL") !== undefined) return "PI_HEARTBEAT_INTERVAL";
	return undefined;
}

/**
 * 该模型的有效 TTL：`PI_HEARTBEAT_TTL` 显式覆盖 > 查表 > 保守默认 1800s；
 * 同时给出缓存类型与"是否该抑制心跳"。
 * 未知模型不会静默用 0（那会让心跳永不停发），也不会用超大值（形同关闭）。
 * 注意 cacheKind 始终取**查表结果**（即使 TTL 被 env 覆盖），这样日志不会因为用户
 * 设了 PI_HEARTBEAT_TTL 就把 sol 谎报成 fixed-ttl。
 */
export function resolveTtlSec(model: Model<any> | undefined, env: EnvLike): TtlResolution {
	const hit = lookupTtlSec(model);
	const forcedBy = forceEnvName(env);
	const cacheKind: CacheKind = hit?.cacheKind ?? "fixed-ttl";
	const suppressed = cacheKind === "probabilistic" && forcedBy === undefined;

	const build = (ttlSec: number, source: TtlSource, matched: string): TtlResolution => ({
		ttlSec,
		source,
		matched,
		cacheKind,
		suppressed,
		suppressedReason: suppressed ? "probabilistic-cache" : undefined,
		forcedBy,
	});

	const envTtl = readPositiveSec(env, "PI_HEARTBEAT_TTL");
	if (envTtl !== undefined) return build(envTtl, "env", "PI_HEARTBEAT_TTL");
	if (hit) return build(hit.ttlSec, hit.source, hit.matched);
	return build(DEFAULT_TTL_SEC, "default", "default(fallback)");
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
	/** 缓存类型：fixed-ttl 正常心跳；long-retention 间隔自然很长；probabilistic 默认不发。 */
	cacheKind: CacheKind;
	/** probabilistic 且未显式强制 → 一律不发（skipReason = "probabilistic-cache"）。 */
	suppressed: boolean;
	suppressedReason?: string;
	/** 用户用哪个 env 强制开了心跳（probabilistic 模型才有意义）。 */
	forcedBy?: string;
	/** 空闲超过这么久就停止心跳（毫秒）；0 = 不设上限。 */
	maxIdleMs: number;
	/** 上限来源：env / price（按刊例价算盈亏平衡）/ default。 */
	maxIdleSource: "env" | "price" | "default";
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
/**
 * 盈亏平衡点（毫秒）：心跳间隔 × (输入价/缓存读价 − 1)。
 *
 * 推导：冷轮花一次输入价；心跳花「心跳间隔内每 T 一次读价」。
 * 两种花法相等时 (1 + 空隔/T) × 读价 = 输入价 → 空隔 = T × (输入价/读价 − 1)。
 * 超过这个空隔，续命已经比直接冷启动贵，所以用它做停止心跳的阀值。
 */
function priceBreakEvenMs(model: Model<any> | undefined, refreshAfterMs: number): number | undefined {
	const cost = (model as { cost?: { input?: number; cacheRead?: number } } | undefined)?.cost;
	const input = cost?.input;
	const cacheRead = cost?.cacheRead;
	if (typeof input !== "number" || typeof cacheRead !== "number") return undefined;
	if (!(input > 0) || !(cacheRead > 0)) return undefined;
	const ratio = input / cacheRead;
	if (!(ratio > 1)) return undefined;
	return refreshAfterMs * (ratio - 1);
}

/** 空闲上限：env 显式指定 > 按模型刊例价算盈亏平衡 > 保守默认；三者都受天花板约束。 */
function resolveMaxIdle(
	model: Model<any> | undefined,
	env: EnvLike,
	refreshAfterMs: number,
): Pick<HeartbeatTiming, "maxIdleMs" | "maxIdleSource"> {
	const ceilingSec = readPositiveSec(env, "PI_HEARTBEAT_MAX_IDLE_CEILING") ?? MAX_IDLE_CEILING_SEC;
	const ceilingMs = ceilingSec * 1000;
	const explicit = readPositiveSec(env, "PI_HEARTBEAT_MAX_IDLE");
	if (explicit !== undefined) return { maxIdleMs: Math.min(explicit * 1000, ceilingMs), maxIdleSource: "env" };
	const breakEven = priceBreakEvenMs(model, refreshAfterMs);
	if (breakEven !== undefined) return { maxIdleMs: Math.min(breakEven, ceilingMs), maxIdleSource: "price" };
	return { maxIdleMs: Math.min(DEFAULT_MAX_IDLE_SEC * 1000, ceilingMs), maxIdleSource: "default" };
}

export function resolveTiming(model: Model<any> | undefined, env: EnvLike): HeartbeatTiming {
	const ttl = resolveTtlSec(model, env);
	const policy = {
		cacheKind: ttl.cacheKind,
		suppressed: ttl.suppressed,
		suppressedReason: ttl.suppressedReason,
		forcedBy: ttl.forcedBy,
	};
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
			...resolveMaxIdle(model, env, ms),
			...policy,
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
		...resolveMaxIdle(model, env, refreshAfterMs),
		...policy,
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
		/** 模型缓存类型 / 是否因 probabilistic 被抑制（加载时未知模型 → fixed-ttl, false）。 */
		cacheKind: CacheKind;
		suppressed: boolean;
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
			const timing = currentTiming();
			/**
			 * 缓存类型判据放在所有成本判断之前：sol 这类概率性缓存的命中与"上次写入多久"
			 * 无关（实测非单调），发心跳既不能续命又要付费（15min 对照组命中率完全相同），
			 * 所以默认一律不发，只在用户显式 PI_HEARTBEAT_TTL / PI_HEARTBEAT_INTERVAL 时放行。
			 */
			if (timing.suppressed) return timing.suppressedReason ?? "probabilistic-cache";
			const ts = now();
			/**
			 * 空闲上限：超过盈亏平衡点就停。此后续命已经比下次冷启动贵，
			 * 继续发只是给“已经不会再回来用”的会话白烧钱。
			 */
			if (timing.maxIdleMs > 0 && ts - observed.lastActivityAt >= timing.maxIdleMs) return "max-idle";
			if (ts - observed.lastActivityAt < refreshThresholdMs(timing)) return "recent-activity";
			if (ts < nextAllowedAt) return "backoff";
			return undefined;
		}

		/** probabilistic 抑制只记一次：用户需要知道"为什么没有心跳"，但不能每个 tick 刷屏。 */
		let muteNotedFor: string | undefined;

		async function tick(): Promise<void> {
			const reason = skipReason();
			if (reason !== undefined) {
				const timing = currentTiming();
				const modelLabel = formatModelLabel(safeModel(ctxRef));
				/** probabilistic 静音是默认策略，不算"调试细节"，所以不看 verbose，一次会话记一次。 */
				const logMute = reason === "probabilistic-cache" && muteNotedFor !== modelLabel;
				if (logMute) muteNotedFor = modelLabel;
				if (logMute || (verbose && reason !== "disabled" && reason !== "subagent")) {
					writeLog({
						ts: new Date(now()).toISOString(),
						event: "skip",
						reason,
						model: modelLabel,
						cacheKind: timing.cacheKind,
						...(logMute
							? {
								note:
									"概率性缓存（sol 等）：命中由 provider 侧 LRU/容量/路由决定，实测心跳无效" +
									"（15min 对照组命中率与纯等待组相同）且自己要付整份前缀钱，默认不发；" +
									"确需实验请显式设 PI_HEARTBEAT_TTL=<秒>",
							}
							: {}),
					});
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
						cacheKind: timing.cacheKind,
						...(timing.forcedBy ? { forcedBy: timing.forcedBy } : {}),
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
				cacheKind: initialTiming.cacheKind,
				suppressed: initialTiming.suppressed,
			},
			timing: currentTiming,
		};
		(pi as unknown as { __heartbeat?: HeartbeatHandle }).__heartbeat = handle;

		startTimer();
	};
}

/** `provider/modelId` 标签（日志用）；无模型时 undefined。 */
function formatModelLabel(model: Model<any> | undefined): string | undefined {
	return model ? `${model.provider}/${model.id}` : undefined;
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