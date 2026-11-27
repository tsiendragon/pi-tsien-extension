import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, Context as LlmContext, Message, Model } from "@earendil-works/pi-ai";
import { clampOpenAIPromptCacheKey } from "@earendil-works/pi-ai/api/openai-prompt-cache";
import {
	createHeartbeatExtension,
	DEFAULT_TTL_SEC,
	HEARTBEAT_PROMPT,
	HEARTBEAT_TTL_FRACTION,
	isSubagentProcess,
	lookupTtlSec,
	resolveHeartbeatReasoning,
	resolveTtlSec,
	resolveTiming,
	TTL_DEEPSEEK_SEC,
	TTL_KIMI_SEC,
	TTL_SOL_SEC,
	type HeartbeatHandle,
} from "pi-tsien-heartbeat/src/index.ts";

// ---------------------------------------------------------------------------
// 测试替身
// ---------------------------------------------------------------------------

/** effort 型模型（OpenAI responses / codex 这一路）：minimal 映射成 effort 字符串。 */
const EFFORT_MODEL = {
	provider: "openai-codex",
	id: "gpt-6-luna",
	api: "openai-codex-responses",
	reasoning: true,
	thinkingLevelMap: { off: "none", minimal: "low", low: "low", medium: "medium", high: "high" },
	cost: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
	contextWindow: 272000,
	maxTokens: 128000,
	baseUrl: "https://example.invalid",
} as unknown as Model<any>;

/** budget 型模型（老 Anthropic 这类）：reasoning 会抬高 max_tokens，心跳应关掉 thinking。 */
const BUDGET_MODEL = {
	provider: "anthropic",
	id: "claude-sonnet-4-5",
	api: "anthropic-messages",
	reasoning: true,
	cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
	contextWindow: 200000,
	maxTokens: 64000,
	baseUrl: "https://example.invalid",
} as unknown as Model<any>;

const SESSION_ID = "01JHEARTBEATSESSIONID0000000000";
const SYSTEM_PROMPT = "You are a careful assistant.\n\n<project_context>repo rules</project_context>";
const START = 1_000_000;

/** 主会话真实的 AgentMessage[]（含 toolResult 与 custom 消息，用来验证 convertToLlm 路径）。 */
function agentMessages(): any[] {
	return [
		{ role: "user", content: "please refactor the parser", timestamp: 1 },
		{
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "think..." },
				{ type: "text", text: "I'll look at the file." },
				{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "/repo/parser.ts" } },
			],
			api: "openai-codex-responses",
			provider: "openai-codex",
			model: "gpt-6-luna",
			usage: {
				input: 10,
				output: 5,
				cacheRead: 100,
				cacheWrite: 0,
				totalTokens: 115,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: 2,
		},
		{
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "read",
			content: [{ type: "text", text: "export const parse = () => {}" }],
			isError: false,
			timestamp: 3,
		},
		{ role: "custom", customType: "note", content: [{ type: "text", text: "extra context" }], timestamp: 4 },
		{ role: "user", content: "now run the tests", timestamp: 5 },
	];
}

const TOOL_PAYLOAD = [
	{
		type: "function",
		function: {
			name: "read",
			description: "Read a file",
			parameters: {
				type: "object",
				properties: { path: { type: "string" } },
				required: ["path"],
				additionalProperties: false,
			},
			strict: true,
		},
	},
];

const OK_USAGE = {
	input: 12,
	cacheRead: 40_000,
	cacheWrite: 0,
	output: 2,
	totalTokens: 40_014,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

interface HarnessOptions {
	env: Record<string, string | undefined>;
	model?: Model<any>;
	idle?: () => boolean;
	pending?: () => boolean;
	usage?: unknown;
	response?: () => Partial<AssistantMessage>;
	complete?: (model: Model<any>, context: LlmContext, opts: Record<string, unknown>) => Promise<AssistantMessage>;
}

interface Call {
	model: Model<any>;
	context: LlmContext;
	options: Record<string, unknown>;
}

interface Harness {
	handle: HeartbeatHandle;
	ctx: ExtensionContext;
	calls: Call[];
	logs: string[];
	/** 扩展有没有试图往会话里写东西（sendMessage / appendEntry / sendUserMessage …）。 */
	writes: string[];
	/** 把时钟往前推（模拟"空闲了 n 秒"）。 */
	advance: (ms: number) => void;
	/** 用真实事件把主会话状态喂给扩展（模拟一次完整 turn）。 */
	prime: (opts?: { systemPrompt?: string }) => Promise<void>;
	emit: (name: string, event: unknown) => Promise<void>;
	/** 取某个事件的首个 handler 返回值（用来断言"不改写上下文"）。 */
	handlerResult: (name: string, event: unknown) => Promise<unknown>;
}

function makeHarness(options: HarnessOptions): Harness {
	const handlers = new Map<string, Array<(event: any, ctx: ExtensionContext) => any>>();
	const writes: string[] = [];
	const logs: string[] = [];
	const calls: Call[] = [];

	let clock = START;
	const now = () => clock;
	const model = options.model ?? EFFORT_MODEL;
	let effectivePrompt = SYSTEM_PROMPT;

	const pi = {
		on(name: string, handler: (event: any, ctx: ExtensionContext) => any) {
			const list = handlers.get(name) || [];
			list.push(handler);
			handlers.set(name, list);
		},
		// 任何"写入会话"的 API 都记录下来：心跳一个都不许调用。
		sendMessage: () => writes.push("sendMessage"),
		sendUserMessage: () => writes.push("sendUserMessage"),
		appendEntry: () => writes.push("appendEntry"),
		setSessionName: () => writes.push("setSessionName"),
		registerTool: () => writes.push("registerTool"),
		registerCommand: () => writes.push("registerCommand"),
		getActiveTools: () => ["read"],
		getAllTools: () => [{ name: "read", description: "Read a file", parameters: { type: "object" }, sourceInfo: {} }],
		respondExtensionUi: () => true,
	} as unknown as ExtensionAPI;

	const ctx = {
		mode: "tui",
		cwd: "/repo",
		model,
		sessionManager: {
			getSessionId: () => SESSION_ID,
			getSessionFile: () => `/home/user/.pi/agent/sessions/--repo--/${SESSION_ID}.jsonl`,
			getSessionName: () => "main",
			getCwd: () => "/repo",
			getBranch: () => [],
			buildContextEntries: () => [],
		},
		modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key" }) },
		isIdle: options.idle ?? (() => true),
		hasPendingMessages: options.pending ?? (() => false),
		// 与 pi 一致：before_agent_start 返回的 systemPrompt 会写回 state.systemPrompt，
		// 因此 turn_end 的 getSystemPrompt() 看到的是生效后的那一份。
		getSystemPrompt: () => effectivePrompt,
		getContextUsage: () => ({ tokens: 100, contextWindow: 1000, percent: 10 }),
		ui: { notify() {} },
	} as unknown as ExtensionContext;

	const complete =
		options.complete ??
		(async (m: Model<any>, context: LlmContext, opts: Record<string, unknown>) => {
			calls.push({ model: m, context, options: opts });
			return {
				role: "assistant",
				content: [{ type: "text", text: "ok" }],
				api: "openai-codex-responses",
				provider: m.provider,
				model: m.id,
				stopReason: "stop",
				timestamp: now(),
				usage: options.usage ?? OK_USAGE,
				...(options.response?.() ?? {}),
			} as unknown as AssistantMessage;
		});

	const factory = createHeartbeatExtension({
		env: options.env,
		now,
		appendLog: (_path, line) => logs.push(line),
		setInterval: () => ({ unref() {} }),
		clearInterval: () => {},
		complete,
	});
	factory(pi);
	const handle = (pi as unknown as { __heartbeat: HeartbeatHandle }).__heartbeat;

	async function emit(name: string, event: unknown): Promise<void> {
		for (const handler of handlers.get(name) || []) await handler(event, ctx);
	}

	return {
		handle,
		ctx,
		calls,
		logs,
		writes,
		handlerResult: async (name: string, event: unknown) => {
			let result: unknown;
			for (const handler of handlers.get(name) || []) result = await handler(event, ctx);
			return result;
		},
		advance: (ms: number) => {
			clock += ms;
		},
		emit,
		prime: async (opts) => {
			await emit("session_start", { type: "session_start", reason: "startup" });
			const prompt = opts?.systemPrompt ?? SYSTEM_PROMPT;
			effectivePrompt = prompt;
			await emit("before_agent_start", { type: "before_agent_start", prompt: "hi", systemPrompt: prompt });
			await emit("context", { type: "context", messages: agentMessages() });
			await emit("before_provider_request", {
				type: "before_provider_request",
				payload: { tools: TOOL_PAYLOAD },
			});
			await emit("turn_end", { type: "turn_end", turnIndex: 1, message: {}, toolResults: [] });
		},
	};
}

/**
 * 内容类断言用"固定间隔"模式：PI_HEARTBEAT_INTERVAL 显式设置会覆盖自适应，
 * 所以 advance(121s) 就能跨过发送闸门，不必每次等 0.8×TTL。
 * 自适应路径本身在最后几组 TTL 用例里单独测。
 */
const ENABLED_ENV = {
	PI_HEARTBEAT: "1",
	PI_HEARTBEAT_INTERVAL: "60",
	PI_HEARTBEAT_MIN_IDLE: "120",
};

/** 自适应模式：不设 INTERVAL，发送闸门完全由模型 TTL 推出。 */
const ADAPTIVE_ENV = { PI_HEARTBEAT: "1" };

/** 喂完一遍 turn，再让时钟走过发送闸门（MIN_IDLE + 固定间隔）。 */
async function primedIdleHarness(options: HarnessOptions): Promise<Harness> {
	/**
	 * 内容类用例（前缀/cache key/thinking/不写历史）跟缓存类型无关，默认钉在查表 miss 的
	 * 未知模型上（→ 保守 fixed-ttl），否则用 EFFORT_MODEL 的 openai-codex provider 会被
	 * probabilistic 策略静音，测的就不是它们要测的东西了。
	 */
	const h = makeHarness({ model: UNKNOWN_MODEL, ...options });
	await h.prime();
	h.advance(121_000);
	return h;
}

// ---------------------------------------------------------------------------
// ① 前缀一致 + 末尾临时 ok 消息
// ---------------------------------------------------------------------------

test("heartbeat request replays the main-session prefix and appends one temp user message", async () => {
	const h = await primedIdleHarness({ env: { ...ENABLED_ENV } });
	await h.handle.tick();

	assert.equal(h.calls.length, 1, "one heartbeat request");
	const { context } = h.calls[0];

	assert.equal(context.systemPrompt, SYSTEM_PROMPT, "system prompt is the one the turn actually used");
	assert.ok(Array.isArray(context.messages));

	// 末尾就是那条临时消息，并且只要求回 ok。
	const last = context.messages[context.messages.length - 1] as any;
	assert.equal(last.role, "user");
	assert.equal(last.content[0].text, HEARTBEAT_PROMPT);
	assert.match(HEARTBEAT_PROMPT, /ok/i);

	// 前缀 = 主会话 messages 经 convertToLlm 的结果（custom → user，toolResult 保留）。
	const prefix = context.messages.slice(0, -1) as any[];
	assert.deepEqual(prefix, convertToLlm(agentMessages() as never) as Message[]);
	assert.deepEqual(prefix.map((m) => m.role), ["user", "assistant", "toolResult", "user", "user"]);
	assert.equal(prefix[0].content, "please refactor the parser");
	assert.equal((prefix[2] as any).toolName, "read");
	assert.equal((prefix[3].content as any)[0].text, "extra context");
	assert.equal(prefix[4].content, "now run the tests");
});

test("heartbeat uses the turn's own system prompt even when it differs from ctx.getSystemPrompt()", async () => {
	const h = makeHarness({ env: { ...ENABLED_ENV } });
	const overridden = "REPLACED-BY-ANOTHER-EXTENSION";
	await h.prime({ systemPrompt: overridden });
	h.advance(121_000);
	await h.handle.tick();

	assert.equal(h.calls.length, 1);
	assert.equal(h.calls[0].context.systemPrompt, overridden, "must replay what the turn really sent");
});

// ---------------------------------------------------------------------------
// ② sessionId 一致 → 同一个 prompt_cache_key
// ---------------------------------------------------------------------------

test("heartbeat passes the main sessionId, so the provider cache key is identical", async () => {
	const h = await primedIdleHarness({ env: { ...ENABLED_ENV } });
	await h.handle.tick();

	assert.equal(h.calls.length, 1);
	assert.equal(h.calls[0].options.sessionId, SESSION_ID);

	// 这才是"命中并刷新同一份缓存"的充要条件。
	assert.equal(
		clampOpenAIPromptCacheKey(h.calls[0].options.sessionId as string),
		clampOpenAIPromptCacheKey(SESSION_ID),
	);

	// 心跳不重试（重试 = 重复付费），也不覆盖缓存保留策略。
	assert.equal(h.calls[0].options.maxRetries, 0);
	assert.equal(h.calls[0].options.cacheRetention, undefined);
});

// ---------------------------------------------------------------------------
// ③ 最低档 thinking
// ---------------------------------------------------------------------------

test("heartbeat uses the lowest thinking level the model supports", async () => {
	
	const h = await primedIdleHarness({ env: { ...ENABLED_ENV }, model: EFFORT_MODEL });
	await h.handle.tick();

	assert.equal(h.calls.length, 1);
	assert.equal(h.calls[0].options.reasoning, "minimal");

	// effort 型模型：minimal 直接可用。
	assert.equal(resolveHeartbeatReasoning(EFFORT_MODEL), "minimal");
	// budget 型模型：thinking 会抬高 max_tokens，心跳宁可不思考。
	assert.equal(resolveHeartbeatReasoning(BUDGET_MODEL), undefined);
	// 不支持 reasoning 的模型：不带 thinking 参数。
	assert.equal(resolveHeartbeatReasoning({ ...EFFORT_MODEL, reasoning: false } as Model<any>), undefined);
});

test("a budget-thinking model gets no reasoning option at all (keeps maxTokens small)", async () => {
	const h = makeHarness({ env: { ...ENABLED_ENV } });
	await h.prime();
	// 换到 budget 型模型：tools 序列化与 thinking 策略都是按模型决定的。
	(h.ctx as { model: Model<any> }).model = BUDGET_MODEL;
	h.advance(121_000);
	await h.handle.tick();

	assert.equal(h.calls.length, 1);
	assert.equal(h.calls[0].options.reasoning, undefined);
	assert.equal(h.calls[0].options.maxTokens, 16);
	assert.equal(h.calls[0].options.onPayload, undefined, "tools payload is per-model and must not be reused");
});

// ---------------------------------------------------------------------------
// ④ 不写历史
// ---------------------------------------------------------------------------

test("heartbeat does not mutate the observed snapshot nor call any session-writing API", async () => {
	const h = await primedIdleHarness({ env: { ...ENABLED_ENV } });
	const before = JSON.stringify(h.handle.observed.agentMessages);
	const beforeCount = h.handle.observed.agentMessages!.length;
	assert.equal(h.writes.length, 0);

	await h.handle.tick();

	// 快照逐字节没变、长度也没增加 → 心跳消息没混进主会话上下文。
	assert.equal(JSON.stringify(h.handle.observed.agentMessages), before);
	assert.equal(h.handle.observed.agentMessages!.length, beforeCount);
	assert.deepEqual(h.writes, [], "no sendMessage / appendEntry / registerTool");

	// 连发第二次：临时消息不会累积（每次都是前缀 + 1 条）。
	h.advance(121_000);
	await h.handle.tick();
	assert.equal(h.calls.length, 2);
	const second = h.calls[1].context.messages;
	assert.equal(second.length, beforeCount + 1);
	assert.equal((second[second.length - 1] as any).content[0].text, HEARTBEAT_PROMPT);
	assert.equal(JSON.stringify(h.handle.observed.agentMessages), before);
});

test("the context / provider hooks never rewrite the main session's messages", async () => {
	const h = makeHarness({ env: { ...ENABLED_ENV } });
	await h.emit("session_start", { type: "session_start", reason: "startup" });

	// 返回 messages 就等于改写主会话上下文（context 事件是 transform 钩子）。
	assert.equal(await h.handlerResult("context", { type: "context", messages: agentMessages() }), undefined);
	// 返回 payload 就等于改写真实请求。
	assert.equal(
		await h.handlerResult("before_provider_request", {
			type: "before_provider_request",
			payload: { tools: TOOL_PAYLOAD },
		}),
		undefined,
	);
	assert.ok(h.handle.observed.agentMessages, "but it does record the snapshot");
});

// ---------------------------------------------------------------------------
// ⑤ 开关与空闲判断
// ---------------------------------------------------------------------------

test("heartbeat is off unless PI_HEARTBEAT=1", async () => {
	const h = makeHarness({ env: { PI_HEARTBEAT_INTERVAL: "240", PI_HEARTBEAT_MIN_IDLE: "120" }, model: UNKNOWN_MODEL });
	await h.prime();
	h.advance(600_000);
	await h.handle.tick();

	assert.equal(h.handle.config.enabled, false);
	assert.equal(h.calls.length, 0, "no request when disabled");
});

test("heartbeat is skipped while a turn is running or messages are queued", async () => {
	let idle = false;
	let pending = false;
	const h = await primedIdleHarness({ env: { ...ENABLED_ENV }, idle: () => idle, pending: () => pending });

	await h.handle.tick();
	assert.equal(h.calls.length, 0, "busy → skip");

	idle = true;
	pending = true;
	await h.handle.tick();
	assert.equal(h.calls.length, 0, "queued messages → skip");

	pending = false;
	await h.handle.tick();
	assert.equal(h.calls.length, 1, "idle and empty queue → send");
});

test("heartbeat waits for MIN_IDLE after the last real activity", async () => {
	// TTL 300s → 自适应闸门 = 240s；MIN_IDLE 120s 在这里被闸门覆盖。
	const h = makeHarness({ env: { ...ADAPTIVE_ENV, PI_HEARTBEAT_TTL: "300" } });
	await h.prime();

	h.advance(60_000); // 距上次活动 60s，远小于闸门
	await h.handle.tick();
	assert.equal(h.calls.length, 0, "too soon after activity");

	h.advance(181_000); // 累计 241s ≥ 240s = 0.8×TTL
	await h.handle.tick();
	assert.equal(h.calls.length, 1, "idle past 0.8×TTL");

	// 心跳本身把 lastActivityAt 推到当下 → 不会连发。
	await h.handle.tick();
	assert.equal(h.calls.length, 1, "no back-to-back heartbeats");

	h.advance(241_000);
	await h.handle.tick();
	assert.equal(h.calls.length, 2, "next heartbeat only after another 0.8×TTL of idleness");
});

test("PI_HEARTBEAT_INTERVAL explicitly overrides the adaptive 0.8×TTL gate", async () => {
	const h = makeHarness({
		env: { PI_HEARTBEAT: "1", PI_HEARTBEAT_INTERVAL: "600", PI_HEARTBEAT_MIN_IDLE: "120" },
		model: UNKNOWN_MODEL,
	});
	await h.prime();
	h.advance(599_000);
	await h.handle.tick();
	assert.equal(h.calls.length, 0, "explicit interval wins over the adaptive gate");

	h.advance(2_000);
	await h.handle.tick();
	assert.equal(h.calls.length, 1);
	assert.equal(h.handle.config.intervalMs, 600_000);
	assert.equal(h.handle.timing().mode, "fixed-interval");
});

test("heartbeat does nothing before any turn produced a snapshot", async () => {
	const h = makeHarness({ env: { ...ENABLED_ENV }, model: UNKNOWN_MODEL });
	await h.emit("session_start", { type: "session_start", reason: "startup" });
	h.advance(600_000);
	await h.handle.tick();
	assert.equal(h.calls.length, 0, "no messages observed yet");
});

test("subagent sessions never send heartbeats", async () => {
	assert.equal(isSubagentProcess({}, { PI_SUBAGENT_WORKBENCH_CHILD: "1" }), true);
	assert.equal(
		isSubagentProcess({}, { PI_TRACE_CONTEXT: JSON.stringify({ parentSessionId: "p", workId: "w" }) }),
		true,
	);
	assert.equal(
		isSubagentProcess({ sessionManager: { getSessionFile: () => "/a/subagent-sessions/x.jsonl" } }, {}),
		true,
	);
	assert.equal(
		isSubagentProcess({ sessionManager: { getSessionFile: () => "/a/sessions/main.jsonl" } }, {}),
		false,
	);

	const h = await primedIdleHarness({ env: { ...ENABLED_ENV, PI_SUBAGENT_WORKBENCH_CHILD: "1" } });
	await h.handle.tick();
	assert.equal(h.calls.length, 0, "subagent process → no heartbeat");
});

// ---------------------------------------------------------------------------
// 成本与容错
// ---------------------------------------------------------------------------

test("heartbeat replays the captured provider tool payload verbatim", async () => {
	const h = await primedIdleHarness({ env: { ...ENABLED_ENV } });
	await h.handle.tick();

	const onPayload = h.calls[0].options.onPayload as (p: unknown) => unknown;
	const outgoing = onPayload({ model: "gpt-6-luna", input: [], tools: [{ __stale: true }] }) as { tools: unknown };
	assert.deepEqual(outgoing.tools, TOOL_PAYLOAD, "tools segment is identical to the real request");
});

test("heartbeat logs usage, cost and the cache-hit flag", async () => {
	const h = await primedIdleHarness({ env: { ...ENABLED_ENV } });
	await h.handle.tick();

	assert.equal(h.logs.length, 1);
	const record = JSON.parse(h.logs[0]);
	assert.equal(record.event, "heartbeat");
	assert.equal(record.mode, "sent");
	assert.equal(record.sessionId, SESSION_ID);
	assert.equal(record.model, "somewhere/mystery-1", "内容类用例钉在未知模型上（查表 miss → 保守 fixed-ttl）");
	assert.equal(record.usage.input, 12);
	assert.equal(record.usage.cacheRead, 40_000);
	assert.equal(record.usage.output, 2);
	assert.equal(record.hit, true, "cacheRead > 0 → cache hit");
	assert.equal(record.toolsInjected, true);
	// 40k cacheRead @ $0.01/M + 12 input @ $0.1/M + 2 output @ $0.5/M ≈ 0.000402
	assert.ok(record.cost.total > 0 && record.cost.total < 0.01, `cost ${record.cost.total}`);
});

test("a missed cache is visible in the log (hit=false when cacheRead is 0)", async () => {
	const h = await primedIdleHarness({
		env: { ...ENABLED_ENV },
		usage: { ...OK_USAGE, cacheRead: 0, input: 40_012 },
	});
	await h.handle.tick();

	const record = JSON.parse(h.logs[0]);
	assert.equal(record.hit, false);
	assert.equal(record.usage.cacheRead, 0);
});

test("a failing heartbeat is swallowed and logged, and the main session keeps working", async () => {
	const h = await primedIdleHarness({
		env: { ...ENABLED_ENV },
		complete: async () => {
			throw new Error("network blew up");
		},
	});

	await h.handle.tick(); // 不抛异常就算通过

	assert.equal(h.logs.length, 1);
	const record = JSON.parse(h.logs[0]);
	assert.equal(record.mode, "error");
	assert.match(record.error, /network blew up/);

	// 失败后退避：立刻再 tick 不会打第二次请求。
	await h.handle.tick();
	assert.equal(h.logs.length, 1, "backoff after failure");

	// 退避到期后仍然可以继续工作。
	h.advance(240_000 * 2);
	await h.handle.tick();
	assert.equal(h.logs.length, 2, "recovers after backoff");
});

test("an error stopReason is reported as an error, not as a success", async () => {
	const h = await primedIdleHarness({
		env: { ...ENABLED_ENV },
		response: () => ({
			stopReason: "error",
			errorMessage: "insufficient quota",
			usage: { ...OK_USAGE, input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
		}),
	});
	await h.handle.tick();

	const record = JSON.parse(h.logs[0]);
	assert.equal(record.error, "insufficient quota");
	assert.equal(record.hit, false);
});

test("dry run logs the plan without spending anything", async () => {
	const h = await primedIdleHarness({ env: { ...ENABLED_ENV, PI_HEARTBEAT_DRY_RUN: "1" } });
	await h.handle.tick();

	assert.equal(h.calls.length, 0, "no request in dry run");
	const record = JSON.parse(h.logs[0]);
	assert.equal(record.mode, "dry-run");
	assert.equal(record.sessionId, SESSION_ID);
	assert.equal(record.toolsInjected, true);
	assert.ok(record.messageCount > 0);
});

test("a session switch drops the stale snapshot instead of replaying another session's prefix", async () => {
	const h = makeHarness({ env: { ...ENABLED_ENV } });
	await h.prime();
	h.advance(121_000);
	// 模拟会话切换：sessionId 变了，但还没有新的 turn 产生新快照。
	(h.ctx.sessionManager as any).getSessionId = () => "ANOTHER-SESSION";
	await h.emit("session_start", { type: "session_start", reason: "resume" });
	assert.equal(h.handle.observed.agentMessages, undefined, "snapshot cleared on switch");

	h.advance(600_000);
	await h.handle.tick();
	assert.equal(h.calls.length, 0, "no heartbeat with a stale prefix");
});
// ---------------------------------------------------------------------------
// ⑥ TTL 查表 + 0.8×TTL 自适应 + 覆盖优先级 + 未知模型回退
// ---------------------------------------------------------------------------

/** 真实配置里的模型 id（只取 TTL 查表需要的字段）。 */
const DEEPSEEK_MODEL = {
	provider: "dashscope",
	id: "deepseek-v4.1-flash",
	api: "openai-completions",
	cost: { input: 0.07, output: 0.28, cacheRead: 0.014, cacheWrite: 0.07 },
	contextWindow: 128000,
	maxTokens: 8192,
	baseUrl: "https://example.invalid",
} as unknown as Model<any>;

const SOL_MODEL = { ...EFFORT_MODEL, provider: "openai-codex", id: "gpt-6.2-sol" } as unknown as Model<any>;
const KIMI_MODEL = { ...DEEPSEEK_MODEL, id: "kimi-k3.1-pro" } as unknown as Model<any>;
/** 查表 miss → 保守默认。anthropic 也不在表里，内容类用例靠它避开 probabilistic 抑制。 */
const UNKNOWN_MODEL = { ...DEEPSEEK_MODEL, provider: "somewhere", id: "mystery-1" } as unknown as Model<any>;

test("TTL table: deepseek fixed-ttl 45min / kimi long-retention >2h / sol probabilistic", () => {
	assert.equal(lookupTtlSec(DEEPSEEK_MODEL)?.ttlSec, TTL_DEEPSEEK_SEC);
	assert.equal(TTL_DEEPSEEK_SEC, 2700, "实测 TTL≈45min（等待 30min 99.7% / 60min 96% / 120min 30.7%）");
	assert.equal(lookupTtlSec(DEEPSEEK_MODEL)?.cacheKind, "fixed-ttl");

	
	assert.equal(lookupTtlSec({ ...DEEPSEEK_MODEL, id: "deepseek-v4-pro" } as Model<any>)?.ttlSec, 2700);
	assert.equal(lookupTtlSec({ ...DEEPSEEK_MODEL, id: "deepseek-v5.0-flash" } as Model<any>)?.ttlSec, 2700);

	
	assert.equal(lookupTtlSec(KIMI_MODEL)?.ttlSec, TTL_KIMI_SEC);
	assert.equal(TTL_KIMI_SEC, 7200, "实测 TTL>2h（120min 等待后仍 91.8%），表里取下界估计");
	assert.equal(lookupTtlSec(KIMI_MODEL)?.cacheKind, "long-retention", "长保留：基本无需心跳");

	
	assert.equal(lookupTtlSec(SOL_MODEL)?.ttlSec, TTL_SOL_SEC);
	assert.equal(lookupTtlSec(SOL_MODEL)?.cacheKind, "probabilistic", "sol 是概率性缓存，不是固定 TTL");
	assert.ok((lookupTtlSec(SOL_MODEL)?.note ?? "").includes("心跳无效"));

	
	assert.equal(lookupTtlSec({ ...EFFORT_MODEL, id: "gpt-6-luna" } as Model<any>)?.cacheKind, "probabilistic");
	assert.equal(lookupTtlSec({ ...EFFORT_MODEL, provider: "openai", id: "gpt-6.1" } as Model<any>)?.cacheKind, "probabilistic");

	
	assert.equal(lookupTtlSec(UNKNOWN_MODEL), undefined);
	assert.equal(lookupTtlSec(undefined), undefined);
});

test("unknown models stay conservative: default TTL, fixed-ttl, not suppressed", () => {
	const unknown = resolveTtlSec(UNKNOWN_MODEL, {});
	assert.equal(unknown.cacheKind, "fixed-ttl", "未知模型不能因为判不准就被永久静音");
	assert.equal(unknown.suppressed, false);
	assert.equal(resolveTtlSec(BUDGET_MODEL, {}).suppressed, false, "anthropic 不在表里 → 保守默认");
});

test("unknown model falls back to the documented default TTL", () => {
	const ttl = resolveTtlSec(UNKNOWN_MODEL, {});
	assert.equal(ttl.ttlSec, DEFAULT_TTL_SEC);
	assert.equal(ttl.source, "default");
	assert.equal(DEFAULT_TTL_SEC, 1800, "documented conservative default = 30min");

	// 无模型（扩展加载时）同样走默认，不会崩。
	assert.equal(resolveTtlSec(undefined, {}).ttlSec, DEFAULT_TTL_SEC);
});

test("adaptive interval = 0.8 × TTL", () => {
	assert.equal(HEARTBEAT_TTL_FRACTION, 0.8);

	const deepseek = resolveTiming(DEEPSEEK_MODEL, {});
	assert.equal(deepseek.mode, "adaptive");
	assert.equal(deepseek.ttlSec, 2700);
	assert.equal(deepseek.refreshAfterMs, 2160 * 1000, "0.8 × 45min = 36min");
	assert.equal(deepseek.ttlSource, "table");

	// cadence 只是检查周期，必须远小于闸门（否则会晚于 TTL 才醒）。
	assert.ok(deepseek.cadenceMs > 0);
	assert.ok(deepseek.cadenceMs <= deepseek.refreshAfterMs / 2, "cadence ≪ gate");
	assert.ok(deepseek.cadenceMs <= 300_000, "cadence stays cheap");

	// 未知模型 → 0.8 × 1800 = 1440s。
	assert.equal(resolveTiming(UNKNOWN_MODEL, {}).refreshAfterMs, 1440 * 1000);
	// 闸门 + 一个 cadence 仍落在 TTL 内（留 10% 余量），极小 TTL 也不例外：
	// 此时 cadence 下限被压到 0.1×TTL 以下，宁可查得密，也不能晚于 TTL 才发。
	for (const ttl of [DEFAULT_TTL_SEC, 300, 2700, TTL_KIMI_SEC, TTL_SOL_SEC, 10, 100]) {
		const t = resolveTiming(undefined, { PI_HEARTBEAT_TTL: String(ttl) });
		assert.ok(t.refreshAfterMs + t.cadenceMs <= ttl * 1000, `gate+cadence within TTL (ttl=${ttl})`);
		assert.ok(t.cadenceMs > 0, `cadence stays positive (ttl=${ttl})`);
	}
});

test("PI_HEARTBEAT_TTL overrides the table, and PI_HEARTBEAT_INTERVAL overrides everything", () => {
	// TTL 覆盖：改变闸门。
	const ttlOverride = resolveTiming(DEEPSEEK_MODEL, { PI_HEARTBEAT_TTL: "600" });
	assert.equal(ttlOverride.ttlSec, 600);
	assert.equal(ttlOverride.ttlSource, "env");
	assert.equal(ttlOverride.refreshAfterMs, 480 * 1000, "0.8 × 600s");
	assert.equal(ttlOverride.mode, "adaptive");

	// 非法值忽略，回落到查表。
	for (const bad of ["0", "-5", "abc", ""]) {
		assert.equal(resolveTiming(DEEPSEEK_MODEL, { PI_HEARTBEAT_TTL: bad }).ttlSec, 2700, `bad=${bad}`);
	}

	// INTERVAL 优先级最高：改成固定节奏，TTL 只用于日志。
	const both = resolveTiming(DEEPSEEK_MODEL, { PI_HEARTBEAT_TTL: "600", PI_HEARTBEAT_INTERVAL: "120" });
	assert.equal(both.mode, "fixed-interval");
	assert.equal(both.refreshAfterMs, 120_000);
	assert.equal(both.cadenceMs, 120_000);
	assert.equal(both.ttlSec, 600, "TTL 仍被解析出来（写日志用），但不再决定闸门");
});

test("deepseek heartbeat actually fires at 0.8×TTL, not before", async () => {
	const h = makeHarness({ env: { ...ADAPTIVE_ENV } });
	(h.ctx as { model: Model<any> }).model = DEEPSEEK_MODEL;
	await h.prime();

	// 30min（实测命中 99.7% 的时刻）还不到闸门 → 不发，避免早发浪费。
	h.advance(30 * 60_000);
	await h.handle.tick();
	assert.equal(h.calls.length, 0, "no heartbeat at 30min: well before 0.8×TTL");

	h.advance(6 * 60_000 + 1_000); // 累计 36min+1s ≥ 0.8 × 45min
	await h.handle.tick();
	assert.equal(h.calls.length, 1, "heartbeat at ~36min = 0.8 × TTL");

	const record = JSON.parse(h.logs[0]);
	assert.equal(record.timing.ttlSec, 2700);
	assert.equal(record.timing.ttlSource, "table");
	assert.equal(record.timing.mode, "adaptive");
	assert.equal(record.timing.refreshAfterSec, 2160);
	assert.ok(record.timing.idleSec >= 2160, `idleSec=${record.timing.idleSec}`);

	// 一次心跳只花一次钱：TTL 窗口内不重复发。
	h.advance(10 * 60_000);
	await h.handle.tick();
	assert.equal(h.calls.length, 1, "exactly one heartbeat per TTL window");
});

test("a switched model immediately gets its own TTL gate", async () => {
	const h = makeHarness({ env: { ...ADAPTIVE_ENV } });
	(h.ctx as { model: Model<any> }).model = DEEPSEEK_MODEL;
	await h.prime();
	assert.equal(h.handle.timing().refreshAfterMs, 2160 * 1000);

	// 换成未知模型：闸门变成 0.8 × 1800 = 24min。
	(h.ctx as { model: Model<any> }).model = UNKNOWN_MODEL;
	assert.equal(h.handle.timing().refreshAfterMs, 1440 * 1000);
	assert.equal(h.handle.timing().ttlSource, "default");

	// 换成 sol 占位 TTL：0.8 × 1800 = 24min，来源是表。
	(h.ctx as { model: Model<any> }).model = SOL_MODEL;
	assert.equal(h.handle.timing().ttlSource, "table");
	assert.equal(h.handle.timing().refreshAfterMs, TTL_SOL_SEC * 0.8 * 1000);
});

test("the timer cadence is derived from the TTL, not a fixed 4 minutes", async () => {
	const cadences: number[] = [];
	const factory = createHeartbeatExtension({
		env: { ...ADAPTIVE_ENV },
		now: () => START,
		appendLog: () => {},
		setInterval: (_fn: () => void, ms: number) => {
			cadences.push(ms);
			return { unref() {} };
		},
		clearInterval: () => {},
		complete: async () => {
			throw new Error("must not send");
		},
	});
	const pi = { on() {}, sendMessage() {}, appendEntry() {}, registerTool() {} } as unknown as ExtensionAPI;
	factory(pi);

	assert.equal(cadences.length, 1, "one timer at load time");
	// 加载时模型未知 → 默认 TTL 1800s → cadence = clamp(0.1×TTL = 180s) = 180s，
	// 不是旧的固定 240s（那是发送周期而非检查周期）。
	assert.equal(cadences[0], 180_000);
	assert.ok(cadences[0] < DEFAULT_TTL_SEC * HEARTBEAT_TTL_FRACTION * 1000, "cadence ≪ gate");
});

/* ───────────────────────── 缓存类型：概率性缓存默认不心跳 ───────────────────────── */

test("probabilistic cache (sol) never sends a heartbeat even with PI_HEARTBEAT=1", async () => {
	const h = makeHarness({ env: { ...ADAPTIVE_ENV, PI_HEARTBEAT_VERBOSE: "1" }, model: SOL_MODEL });
	await h.prime();

	
	h.advance(6 * 60 * 60_000);
	await h.handle.tick();
	assert.equal(h.calls.length, 0, "sol: 实测心跳无效（15min 对照组命中率完全相同），默认不发");

	
	h.advance(6 * 60 * 60_000);
	await h.handle.tick();
	assert.equal(h.calls.length, 0, "still nothing after another 6h");

	assert.equal(h.handle.timing().cacheKind, "probabilistic");
	assert.equal(h.handle.timing().suppressed, true);
	assert.equal(h.handle.config.cacheKind, "fixed-ttl", "加载时模型未知 → config 只能给保守值（按模型实时判的是 timing()）");

	
	const skip = h.logs.map((l) => JSON.parse(l)).find((r) => r.event === "skip");
	assert.ok(skip, "verbose 下要能查到为什么没发");
	assert.equal(skip.reason, "probabilistic-cache");
	assert.equal(skip.model, "openai-codex/gpt-6.2-sol");
	assert.match(skip.note, /PI_HEARTBEAT_TTL/);
});

test("openai / openai-codex providers are all treated as probabilistic", async () => {
	const h = makeHarness({ env: { ...ADAPTIVE_ENV }, model: { ...EFFORT_MODEL, id: "gpt-6-luna" } as Model<any> });
	await h.prime();
	h.advance(3 * 60 * 60_000);
	await h.handle.tick();
	assert.equal(h.calls.length, 0);
	assert.equal(h.handle.timing().suppressed, true);
});

test("PI_HEARTBEAT_TTL force-enables a probabilistic model, and the log says who forced it", async () => {
	const h = makeHarness({
		env: { ...ADAPTIVE_ENV, PI_HEARTBEAT_TTL: "600" },
		model: SOL_MODEL,
	});
	await h.prime();

	const timing = h.handle.timing();
	assert.equal(timing.suppressed, false, "显式 TTL = 用户自己承担后果");
	assert.equal(timing.forcedBy, "PI_HEARTBEAT_TTL");
	assert.equal(timing.cacheKind, "probabilistic", "cacheKind 仍是真实的，不被 env 覆盖改写成 fixed-ttl");
	assert.equal(timing.ttlSec, 600);
	assert.equal(timing.refreshAfterMs, 480_000);

	h.advance(481_000);
	await h.handle.tick();
	assert.equal(h.calls.length, 1, "forced → 真的发出去");

	const record = JSON.parse(h.logs[0]);
	assert.equal(record.event, "heartbeat");
	assert.equal(record.timing.cacheKind, "probabilistic");
	assert.equal(record.timing.forcedBy, "PI_HEARTBEAT_TTL");
});

test("PI_HEARTBEAT_INTERVAL also force-enables a probabilistic model", async () => {
	const h = makeHarness({
		env: { PI_HEARTBEAT: "1", PI_HEARTBEAT_INTERVAL: "60", PI_HEARTBEAT_MIN_IDLE: "120" },
		model: SOL_MODEL,
	});
	await h.prime();
	const timing = h.handle.timing();
	assert.equal(timing.suppressed, false);
	assert.equal(timing.forcedBy, "PI_HEARTBEAT_INTERVAL");

	h.advance(121_000);
	await h.handle.tick();
	assert.equal(h.calls.length, 1);
});

test("fixed-ttl (deepseek) heartbeats normally at 0.8×TTL", async () => {
	const h = makeHarness({ env: { ...ADAPTIVE_ENV }, model: DEEPSEEK_MODEL });
	await h.prime();
	assert.equal(h.handle.timing().cacheKind, "fixed-ttl");
	assert.equal(h.handle.timing().suppressed, false);

	h.advance(2159_000);
	await h.handle.tick();
	assert.equal(h.calls.length, 0, "before the gate");

	h.advance(2_000);
	await h.handle.tick();
	assert.equal(h.calls.length, 1, "at 0.8 × 45min");
});

test("long-retention (kimi) is not muted but its gate is ~96min, so short idleness never fires", async () => {
	const h = makeHarness({ env: { ...ADAPTIVE_ENV, PI_HEARTBEAT_VERBOSE: "1" }, model: KIMI_MODEL });
	await h.prime();
	const timing = h.handle.timing();
	assert.equal(timing.cacheKind, "long-retention");
	assert.equal(timing.suppressed, false);
	assert.equal(timing.ttlSec, TTL_KIMI_SEC);
	assert.equal(timing.refreshAfterMs, 5760_000, "0.8 × 7200s = 96min");

	
	h.advance(60 * 60_000);
	await h.handle.tick();
	assert.equal(h.calls.length, 0, "1h 空闲 < 96min 闸门 → 不发（长保留本来就不需要）");

	
	const skips = h.logs.map((l) => JSON.parse(l)).filter((r) => r.event === "skip");
	assert.ok(skips.every((r) => r.reason !== "probabilistic-cache"), "long-retention 不能被打成 probabilistic");
	assert.ok(skips.some((r) => r.reason === "recent-activity"));

	
	h.advance(37 * 60_000);
	await h.handle.tick();
	assert.equal(h.calls.length, 1, "超过闸门后照常发一次");
});

test("switching from sol to deepseek turns heartbeats back on", async () => {
	const h = makeHarness({ env: { ...ADAPTIVE_ENV }, model: SOL_MODEL });
	await h.prime();
	h.advance(40 * 60_000);
	await h.handle.tick();
	assert.equal(h.calls.length, 0, "sol suppressed");

	(h.ctx as { model: Model<any> }).model = DEEPSEEK_MODEL;
	assert.equal(h.handle.timing().suppressed, false);
	
	await h.handle.tick();
	assert.equal(h.calls.length, 1, "deepseek 闸门已过 → 立即按新模型策略发");
});

test("the probabilistic mute is explained once, even without PI_HEARTBEAT_VERBOSE", async () => {
	const h = makeHarness({ env: { ...ADAPTIVE_ENV }, model: SOL_MODEL });
	await h.prime();

	
	h.advance(60 * 60_000);
	await h.handle.tick();
	h.advance(60 * 60_000);
	await h.handle.tick();
	h.advance(60 * 60_000);
	await h.handle.tick();
	assert.equal(h.calls.length, 0);

	const skips = h.logs.map((l) => JSON.parse(l)).filter((r) => r.event === "skip");
	assert.equal(skips.length, 1, "静音原因只记一次，不刷屏");
	assert.equal(skips[0].reason, "probabilistic-cache");
	assert.match(skips[0].note, /心跳无效/);
});
