import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";


const REFRESH_INTERVAL_MS = 1_000;
/** Elapsed time is only shown once the turn has run this long. */
const SHOW_TIMER_AFTER_MS = 3_000;

function formatDuration(ms: number): string {
	const totalSec = Math.floor(ms / 1000);
	const hours = Math.floor(totalSec / 3600);
	const minutes = Math.floor((totalSec % 3600) / 60);
	const seconds = totalSec % 60;
	if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
	if (minutes > 0) return `${minutes}m ${seconds}s`;
	return `${seconds}s`;
}

function formatCount(value: number): string {
	return new Intl.NumberFormat("en-US").format(value);
}

function estimateTextLength(message: any): number {
	if (!Array.isArray(message?.content)) return 0;
	return message.content.reduce((sum: number, block: any) => {
		if (block?.type === "text" && typeof block.text === "string") return sum + block.text.length;
		if (block?.type === "thinking" && block.thinkingSignature?.body)
			return sum + (block.thinkingSignature.body as string).length;
		return sum;
	}, 0);
}

function textBlockLengths(message: any): number[] {
	if (!Array.isArray(message?.content)) return [];
	const lengths: number[] = [];
	for (let index = 0; index < message.content.length; index++) {
		const block = message.content[index];
		if (block?.type === "text" && typeof block.text === "string") {
			lengths[index] = block.text.length;
		} else if (block?.type === "thinking" && block.thinkingSignature?.body) {
			lengths[index] = (block.thinkingSignature.body as string).length;
		}
	}
	return lengths;
}

function outputUsage(message: any): number {
	const value = Number(message?.usage?.output);
	return Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

/**
 * Extend Pi's footer working row while preserving its spinner and "Working...":
 * `⠋ Working... (↓ 1,234 tokens · 12s)`
 *
 * Live tokens use the same chars/4 estimate as pi-claude-code-ui, then switch to
 * provider `usage.output` whenever the stream exposes an actual count.
 */
export default function (pi: ExtensionAPI): void {
	let turnActive = false;
	let agentStartTime = 0;
	let turnStartTime = 0;
	let responseLength = 0;
	let responseTextBlockLengths: number[] = [];
	let providerOutputTokens = 0;
	let refreshTimer: ReturnType<typeof setTimeout> | null = null;
	let lastMessage: string | null = null;
	// Robust shared-vibe channel: pi-zero writes the current vibe here via a global
	// symbol, so this module does not depend on fragile ui.setWorkingMessage patching.
	const SHARED_VIBE_KEY = Symbol.for("pi.zero.vibe");
	function getSharedVibe(): string {
		const v = (globalThis as any)[SHARED_VIBE_KEY];
		return typeof v === "string" ? v : "";
	}
	let activeCtx: { ui: any; hasUI: boolean } | null = null;

	function tokenCount(): number {
		return providerOutputTokens || Math.max(0, Math.round(responseLength / 4));
	}

	function setTextBlockLength(index: number, length: number): void {
		const previous = responseTextBlockLengths[index] ?? 0;
		responseTextBlockLengths[index] = Math.max(0, length);
		responseLength = Math.max(0, responseLength + responseTextBlockLengths[index] - previous);
	}

	function resetResponseTracking(message?: any): void {
		responseTextBlockLengths = message ? textBlockLengths(message) : [];
		responseLength = message ? estimateTextLength(message) : 0;
		providerOutputTokens = message ? outputUsage(message) : 0;
	}

	function updateProviderUsage(message: any): void {
		const output = outputUsage(message);
		if (output > 0) providerOutputTokens = output;
	}

	function buildWorkingMessage(): string {
		const elapsed = Date.now() - (agentStartTime || turnStartTime);
		const tokens = tokenCount();
		const parts: string[] = [];
		if (tokens > 0) parts.push(`↓ ${formatCount(tokens)} tokens`);
		if (elapsed >= SHOW_TIMER_AFTER_MS || tokens > 0) parts.push(formatDuration(elapsed));
		const stat = parts.length ? ` (${parts.join(" · ")})` : "";
		const vibe = getSharedVibe();
		if (vibe) return `${vibe}${stat}`;
		return parts.length ? `Working...${stat}` : "";
	}

	// Call setWorkingMessage with tolerance for an unavailable TUI.
	function setWorking(ui: any, msg: string | undefined): void {
		if (!ui) return;
		try {
			ui.setWorkingMessage(msg);
		} catch {
			// Noop when the TUI is unavailable.
		}
	}

	function restoreDefaultWorkingMessage(): void {
		lastMessage = null;
		if (!activeCtx?.hasUI) return;
		setWorking(activeCtx.ui, undefined);
	}

	function syncWorkingMessage(force = false): void {
		if (!activeCtx?.hasUI) return;
		const next = buildWorkingMessage();
		if (!next) {
			if (force) restoreDefaultWorkingMessage();
			return;
		}
		if (!force && next === lastMessage) return;
		lastMessage = next;
		setWorking(activeCtx.ui, next);
	}

	function scheduleRefreshTick(): void {
		if (!turnActive || refreshTimer) return;
		refreshTimer = setTimeout(() => {
			refreshTimer = null;
			try {
				syncWorkingMessage();
			} finally {
				scheduleRefreshTick();
			}
		}, REFRESH_INTERVAL_MS);
		refreshTimer.unref?.();
	}

	function stopRefreshLoop(): void {
		if (!refreshTimer) return;
		clearTimeout(refreshTimer);
		refreshTimer = null;
	}

	function clearDisplay(): void {
		stopRefreshLoop();
		agentStartTime = 0;
		turnStartTime = 0;
		resetResponseTracking();
		restoreDefaultWorkingMessage();
	}

	pi.on("before_agent_start", async (_event, ctx) => {
		if (!agentStartTime) agentStartTime = Date.now();
	});

	pi.on("turn_start", async (_event, ctx) => {
		turnActive = true;
		activeCtx = ctx;
		turnStartTime = Date.now();
		if (!agentStartTime) agentStartTime = turnStartTime;
		resetResponseTracking();
		syncWorkingMessage(true);
		scheduleRefreshTick();
	});

	pi.on("message_update", async (event, ctx) => {
		activeCtx = ctx;
		const evt = event?.assistantMessageEvent;
		if (!evt) return;

		if (evt.type === "start") {
			resetResponseTracking(evt.partial);
		} else if (evt.type === "thinking_start" || evt.type === "text_start") {
			setTextBlockLength(evt.contentIndex, 0);
			updateProviderUsage(evt.partial);
		} else if (evt.type === "thinking_delta" || evt.type === "text_delta") {
			const add = typeof evt.delta === "string" ? evt.delta.length : 0;
			setTextBlockLength(evt.contentIndex, (responseTextBlockLengths[evt.contentIndex] ?? 0) + add);
			updateProviderUsage(evt.partial);
		} else if (evt.type === "text_end") {
			setTextBlockLength(
				evt.contentIndex,
				typeof evt.content === "string" ? evt.content.length : 0,
			);
			updateProviderUsage(evt.partial);
		} else if (evt.type === "done") {
			resetResponseTracking(evt.message);
		} else if (evt.type === "error") {
			resetResponseTracking(evt.error);
		} else {
			updateProviderUsage(evt.partial);
		}

		syncWorkingMessage();
		scheduleRefreshTick();
	});

	pi.on("turn_end", async (_event, ctx) => {
		turnActive = false;
		activeCtx = ctx;
		stopRefreshLoop();
		resetResponseTracking();
		// No completion message: return immediately to Pi's default idle state.
		restoreDefaultWorkingMessage();
	});

	pi.on("agent_end", async () => {
		turnActive = false;
		clearDisplay();
	});

	pi.on("session_shutdown", async () => {
		turnActive = false;
		clearDisplay();
		activeCtx = null;
	});
}
