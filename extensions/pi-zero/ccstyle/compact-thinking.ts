import * as piAi from "@earendil-works/pi-ai";
import * as piCodingAgent from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as piTui from "@earendil-works/pi-tui";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

export type CompactThinkingConfig = {
	useSummaryTitlesAsThinkingTitle: boolean;
	previewLines: number;
	animationIntervalMs: number;
};

export type CompactThinkingController = {
	updateConfig(next: CompactThinkingConfig): void;
};

type CompactThinkingOwner = {
	owner: object;
	stop(event?: any, ctx?: any): void;
};

type UpstreamHandler = (event: any, ctx: any) => void;

const COMPACT_THINKING_OWNER = Symbol.for("pi.ccstyle.compact-thinking-owner");

function loadPatchedUpstream(): {
	config: CompactThinkingConfig;
	compactThinking: (api: ExtensionAPI) => void;
} {
	// Fork the upstream entry so a running subagent tool keeps the thinking
	// loading animation until the model emits the next text/thinking boundary.
	// Upstream finalizes on tool_execution_start / message_end, freezing the
	// summary into a static "Thought for Xs" for the whole subagent run.
	const upstreamRequire = createRequire(import.meta.url);
	const upstreamIndexPath = upstreamRequire.resolve("pi-compact-thinking/index.ts");
	const toolStartOriginal = `  pi.on("tool_execution_start", finishThinking);`;
	const toolStartPatched = `  // Subagent tools can run for minutes: keep the thinking loading animation
  // alive for the whole execution and only finalize once the tool ends or the
  // model emits the next text/thinking boundary.
  function resumeAgentThinking(message: AssistantMessage | undefined) {
    if (activeThinking) return;
    const content = message?.content;
    if (!Array.isArray(content)) return;
    const index = content.findIndex((item) => item?.type === "thinking");
    if (index < 0) return;
    startThinking(message, index);
  }
  function messageHasAgentTool(message: AssistantMessage | undefined) {
    return (
      Array.isArray(message?.content) &&
      message.content.some(
        (content) =>
          content?.type === "toolCall" &&
          (content.name === "Agent" ||
            content.name === "Agents" ||
            content.args?.subagent_type != null),
      )
    );
  }
  pi.on("tool_execution_start", (event: any) => {
    if (event.toolName === "Agent" || event.toolName === "Agents") {
      resumeAgentThinking(latestComponent?.lastMessage ?? undefined);
    } else {
      finishThinking();
    }
  });
  pi.on("tool_execution_end", (event: any) => {
    if (event.toolName === "Agent" || event.toolName === "Agents") finishThinking();
  });`;
	const updateBoundaryOriginal = `    } else if (
      update.type === "text_start" ||
      update.type === "toolcall_start" ||
      update.type === "toolcall_delta"
    ) {
      finishThinking();
    }`;
	const updateBoundaryPatched = `    } else if (update.type === "text_start") {
      finishThinking();
    } else if (
      update.type === "toolcall_start" ||
      update.type === "toolcall_delta"
    ) {
      if (messageHasAgentTool(event.message)) {
        resumeAgentThinking(event.message);
      } else {
        finishThinking();
      }
    }`;
	const messageEndOriginal = `  pi.on("message_end", (event) => {
    if (event.message.role === "assistant") finishThinking();
  });`;
	const messageEndPatched = `  pi.on("message_end", (event) => {
    if (event.message.role !== "assistant") return;
    // Agent tool runs after message_end; keep the ticker until tool_execution_end
    // or the next text/thinking boundary.
    if (messageHasAgentTool(event.message)) return;
    finishThinking();
  });`;
	const completedHeadingOriginal = `        heading = thinkingStyle(
          durationText
            ? \`Thought for \${durationText}\`
            : self.hiddenThinkingLabel || "Thinking...",
        );`;
	const completedHeadingPatched = `        const completedLabel = durationText
          ? \`Thought \${durationText}\`
          : self.hiddenThinkingLabel || "Thinking...";
        heading = activeTheme
          ? activeTheme.fg("dim", completedLabel)
          : completedLabel;`;

	// Pi renders mermaid / custom code blocks by passing a markdown `transform`
	// to the Markdown component. The upstream compact-thinking renderer drops it
	// (new Markdown(text, pad, 0, theme)), so mermaid shows as raw source. Restore
	// the transformer chain when this patch rerenders assistant text while
	// thinking is hidden.
	const textRenderOriginal = `      if (content.type === "text" && content.text.trim()) {
        self.contentContainer.addChild(
          new Markdown(content.text.trim(), self.outputPad, 0, self.markdownTheme),
        );
        continue;
      }`;
	const textRenderPatched = `      if (content.type === "text" && content.text.trim()) {
        self.contentContainer.addChild(
          new Markdown(content.text.trim(), self.outputPad, 0, self.markdownTheme, undefined, {
            transform: (markdown: string, availableWidth: number) => {
              let out = markdown;
              for (const transformer of self.markdownTransformers ?? []) {
                try {
                  const result = transformer(out, {
                    messageType: "assistant",
                    isStreaming: self.isStreaming,
                    availableWidth,
                  });
                  if (typeof result === "string") out = result;
                } catch {
                  // Keep current markdown and continue with the next transformer.
                }
              }
              return out;
            },
          }),
        );
        continue;
      }`;

	let upstreamIndexSource = readFileSync(upstreamIndexPath, "utf8");
	if (
		upstreamIndexSource.includes(toolStartOriginal) &&
		upstreamIndexSource.includes(updateBoundaryOriginal) &&
		upstreamIndexSource.includes(messageEndOriginal) &&
		upstreamIndexSource.includes(completedHeadingOriginal) &&
		upstreamIndexSource.includes(textRenderOriginal)
	) {
		upstreamIndexSource = upstreamIndexSource
			.replace(toolStartOriginal, toolStartPatched)
			.replace(updateBoundaryOriginal, updateBoundaryPatched)
			.replace(messageEndOriginal, messageEndPatched)
			.replace(completedHeadingOriginal, completedHeadingPatched)
			.replace(textRenderOriginal, textRenderPatched);
	}
	// The upstream StrictThinkingPreview re-wraps the FULL thinking text on every
	// render. Pi re-renders every visible assistant message on each keystroke, so
	// in a long session the O(n) wrap of large completed thinking blocks happens
	// dozens of times per keypress — the dominant source of TUI lag. Replace it
	// with a bounded, content-keyed cache so unchanged previews are O(1).
	const previewImportOriginal = `import {
  formatThoughtDuration,
  StrictThinkingPreview,
} from "./lib/preview.ts";`;
	const previewImportCached = [
		'import {',
		'  formatThoughtDuration,',
		'  getThinkingToggleHint,',
		'} from "./lib/preview.ts";',
		'',
		'const __ctPreviewCache = new Map();',
		'class StrictThinkingPreview {',
		'  private text: string;',
		'  private padding: number;',
		'  private style: (text: string) => string;',
		'  constructor(text: string, padding: number, style: (text: string) => string) {',
		'    this.text = text;',
		'    this.padding = padding;',
		'    this.style = style;',
		'  }',
		'  render(width: number) {',
		'    const cached = __ctPreviewCache.get(this.text);',
		'    // Cache is keyed on content + width + previewLines so a live config change',
		'    // (e.g. /ccstyle panel) never serves a stale preview. Return a copy so a',
		'    // downstream in-place mutation of the returned lines cannot corrupt the cache.',
		'    if (cached && cached.width === width && cached.previewLines === config.previewLines) return [...cached.lines];',
		'    const lines = new Text(this.style(this.text), this.padding, 0).render(width);',
		'    let out: string[];',
		'    if (lines.length <= config.previewLines) {',
		'      out = lines;',
		'    } else {',
		'      const hiddenLines = lines.length - config.previewLines;',
		'      const noun = hiddenLines === 1 ? "line" : "lines";',
		'      const toggleHint = getThinkingToggleHint();',
		'      const hint = "... (" + hiddenLines + " more " + noun + (toggleHint ? ", " + toggleHint : "") + ")";',
		'      const hintLines = new Text(this.style(hint), this.padding, 0).render(width);',
		'      out = [...hintLines, ...lines.slice(-config.previewLines)];',
		'    }',
		'    if (__ctPreviewCache.size > 400) __ctPreviewCache.clear();',
		'    __ctPreviewCache.set(this.text, { width, previewLines: config.previewLines, lines: out });',
		'    return out;',
		'  }',
		'  invalidate() {}',
		'}',
	].join("\n");
	upstreamIndexSource = upstreamIndexSource.replace(previewImportOriginal, previewImportCached);

	// Reuse Pi's live modules so the upstream prototype patch reaches runtime components.
	const jiti = createJiti(import.meta.url, {
		virtualModules: {
			"@earendil-works/pi-ai": piAi,
			"@earendil-works/pi-coding-agent": piCodingAgent,
			"@earendil-works/pi-tui": piTui,
		},
	});
	const upstreamConfig = (
		jiti("pi-compact-thinking/lib/config.ts") as { config: CompactThinkingConfig }
	).config;
	const compactThinking = (
		jiti.evalModule(upstreamIndexSource, { filename: upstreamIndexPath }) as {
			default: (api: ExtensionAPI) => void;
		}
	).default;
	return { config: upstreamConfig, compactThinking };
}

export function installCompactThinking(
	pi: ExtensionAPI,
	initialConfig: CompactThinkingConfig,
): CompactThinkingController {
	const owner = {};
	const host = globalThis as typeof globalThis & {
		[COMPACT_THINKING_OWNER]?: CompactThinkingOwner;
	};

	let upstreamConfig: CompactThinkingConfig | undefined;
	let session: { event: any; ctx: any } | undefined;
	let active = false;
	// Stable pi.on wrappers delegate here so activate/reload never double-binds.
	const delegates = new Map<string, UpstreamHandler>();
	const boundEvents = new Set<string>();

	const restoreAllDurations = (ctx: any): any => {
		const sessionManager = ctx?.sessionManager;
		if (!sessionManager || typeof sessionManager.getEntries !== "function") return ctx;
		return {
			...ctx,
			sessionManager: {
				...sessionManager,
				getBranch: () => sessionManager.getEntries(),
			},
		};
	};

	const bind = (eventName: string) => {
		if (boundEvents.has(eventName)) return;
		boundEvents.add(eventName);
		pi.on(eventName as any, (e: any, ctx: any) => {
			if (!active) return;
			const handler = delegates.get(eventName);
			if (!handler) return;
			handler(e, eventName === "session_tree" ? restoreAllDurations(ctx) : ctx);
		});
	};

	const stop = (event?: any, ctx?: any) => {
		if (!active) return;
		active = false;
		const shutdown = delegates.get("session_shutdown");
		delegates.clear();
		shutdown?.(event ?? session?.event ?? {}, ctx ?? session?.ctx ?? { mode: "rpc", ui: {} });
		if (host[COMPACT_THINKING_OWNER]?.owner === owner) delete host[COMPACT_THINKING_OWNER];
	};

	const activate = (event: any, ctx: any) => {
		// Headless subagent runtimes share this process. Never steal the parent
		// TUI prototype patch or kill its thinking ticker.
		if (ctx?.mode !== "tui") return;

		host[COMPACT_THINKING_OWNER]?.stop(event, ctx);
		session = { event, ctx };

		// upstream lib/config.ts 在模块顶层读取 compact-thinking.json，缺失时
		// 会自建默认配置；预写我们的配置供其读取，加载完成后立即删除，
		// 不在 .pi/agent 下残留文件（文件原本存在时保持不动）。
		const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
		const configPath = join(agentDir, "compact-thinking.json");
		const fileExisted = existsSync(configPath);
		if (!fileExisted) {
			writeFileSync(configPath, `${JSON.stringify(initialConfig, null, 2)}\n`, "utf8");
		}
		let loaded: ReturnType<typeof loadPatchedUpstream>;
		try {
			loaded = loadPatchedUpstream();
		} finally {
			if (!fileExisted) rmSync(configPath, { force: true });
		}
		upstreamConfig = loaded.config;
		Object.assign(upstreamConfig, initialConfig);
		delegates.clear();

		loaded.compactThinking({
			on(eventName: string, handler: UpstreamHandler) {
				if (eventName === "session_start") {
					// Already inside session_start — run immediately.
					handler(event, restoreAllDurations(ctx));
					return;
				}
				if (eventName === "session_shutdown") {
					delegates.set(eventName, handler);
					return;
				}
				delegates.set(eventName, handler);
				bind(eventName);
			},
			appendEntry: (...args: any[]) => (pi.appendEntry as any)(...args),
		} as unknown as ExtensionAPI);

		active = true;
		host[COMPACT_THINKING_OWNER] = { owner, stop };
	};

	pi.on("session_start", (event, ctx) => {
		session = { event, ctx };
		activate(event, ctx);
	});
	pi.on("session_shutdown", (event, ctx) => {
		if (host[COMPACT_THINKING_OWNER]?.owner === owner) stop(event, ctx);
		session = undefined;
	});

	return {
		updateConfig(next) {
			Object.assign(initialConfig, next);
			if (upstreamConfig) Object.assign(upstreamConfig, next);
		},
	};
}
