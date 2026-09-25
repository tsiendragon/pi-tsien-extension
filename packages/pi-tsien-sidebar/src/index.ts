import {
  estimateTokens,
  type ExtensionAPI,
  type ExtensionContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  truncateToWidth,
  visibleWidth,
  type OverlayHandle,
  type TUI,
} from "@earendil-works/pi-tui";

type UnknownRecord = Record<string, unknown>;

type ContextUsage = {
  tokens?: number | null;
  contextWindow?: number;
  percent?: number | null;
};

interface UsageSnapshot {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  turns: number;
}

interface ContextSnapshot {
  /** Pi reports this as the latest prompt size or a trailing-context estimate. */
  tokens?: number;
  contextWindow?: number;
  percent?: number;
  /** Local token estimates for the current prompt payload. */
  system: number;
  skills: number;
  tools: number;
  /** Total of user input, model output, and other non-tool history. */
  history: number;
  /** Tokens in assistant tool-call blocks. */
  toolCalls?: number;
  /** Results from tools other than the built-in read tool. */
  toolResults: number;
  /** Content returned by the built-in read tool. */
  fileReads?: number;
  userInput?: number;
  assistantOutput?: number;
  otherHistory?: number;
  estimatedTotal: number;
}

interface AgentMetrics {
  version: 1 | 2 | 3;
  updatedAt: number;
  context: ContextSnapshot;
  usage: UsageSnapshot;
}

interface MetricsSidebarSummary {
  available: boolean;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  hitRatio: number;
  writeRatio: number;
  uncachedRatio: number;
}

interface MainRuntimeState {
  __piTsienMetricsSidebarGetSummary?: () => MetricsSidebarSummary;
}

interface SidebarRuntime {
  done: (result?: unknown) => void;
  handle?: OverlayHandle;
  hidden: boolean;
  timer: ReturnType<typeof setInterval>;
}

interface ParentSessionContext {
  model?: { provider: string; id: string };
  getSystemPrompt(): string;
  getContextUsage(): ContextUsage | undefined;
  hasPendingMessages?(): boolean;
  sessionManager: {
    getEntries(): unknown[];
    buildSessionContext?: () => { messages?: unknown[] };
  };
}

interface ParentSessionRuntime {
  model?: { provider: string; id: string };
  metrics?: AgentMetrics;
  hasPendingMessages: boolean;
  systemPrompt: string;
  messages: unknown[];
}

let sidebar: SidebarRuntime | undefined;
let parentSession: ParentSessionRuntime | undefined;

function globalState(): MainRuntimeState {
  return globalThis as typeof globalThis & MainRuntimeState;
}

function asRecord(value: unknown): UnknownRecord | undefined {
  return value !== null && typeof value === "object"
    ? (value as UnknownRecord)
    : undefined;
}

function nonNegative(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : 0;
}

function optionalNonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function zeroUsage(): UsageSnapshot {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
}

function normalizeUsage(value: unknown): UsageSnapshot {
  const raw = asRecord(value);
  if (!raw) return zeroUsage();
  const costValue = raw.cost;
  const costRecord = asRecord(costValue);
  return {
    input: nonNegative(raw.input),
    output: nonNegative(raw.output),
    cacheRead: nonNegative(raw.cacheRead),
    cacheWrite: nonNegative(raw.cacheWrite),
    cost: nonNegative(costRecord?.total ?? costValue),
    turns: nonNegative(raw.turns),
  };
}

function addUsage(total: UsageSnapshot, next: UsageSnapshot): UsageSnapshot {
  return {
    input: total.input + next.input,
    output: total.output + next.output,
    cacheRead: total.cacheRead + next.cacheRead,
    cacheWrite: total.cacheWrite + next.cacheWrite,
    cost: total.cost + next.cost,
    turns: total.turns + next.turns,
  };
}

function hasUsage(usage: UsageSnapshot): boolean {
  return (
    usage.input > 0 ||
    usage.output > 0 ||
    usage.cacheRead > 0 ||
    usage.cacheWrite > 0 ||
    usage.cost > 0 ||
    usage.turns > 0
  );
}

function usageFromEntries(entries: unknown[]): UsageSnapshot {
  let total = zeroUsage();
  for (const entry of entries) {
    const record = asRecord(entry);
    if (!record) continue;
    if (record.type === "message") {
      const message = asRecord(record.message);
      if (message) total = addUsage(total, normalizeUsage(message.usage));
    } else if (record.type === "compaction" || record.type === "branch_summary") {
      total = addUsage(total, normalizeUsage(record.usage));
    }
  }
  return total;
}

function estimateTextTokens(text: string): number {
  return estimateTokens({ role: "user", content: text, timestamp: 0 });
}

function isExcludedBashMessage(message: UnknownRecord): boolean {
  return message.role === "bashExecution" && message.excludeFromContext === true;
}

function splitSystemPrompt(
  systemPrompt: string,
): Pick<ContextSnapshot, "system" | "skills" | "tools"> {
  const skillMatch = systemPrompt.match(
    /\n\nThe following skills provide specialized instructions for specific tasks\.[\s\S]*?<\/available_skills>/,
  );
  const toolMatch = systemPrompt.match(
    /(?:^|\n)Available tools:\n[\s\S]*?(?=\n\nIn addition to the tools above|$)/,
  );
  const skills = skillMatch ? estimateTextTokens(skillMatch[0]) : 0;
  const tools = toolMatch ? estimateTextTokens(toolMatch[0]) : 0;
  return {
    system: Math.max(0, estimateTextTokens(systemPrompt) - skills - tools),
    skills,
    tools,
  };
}

function buildMetrics(
  systemPrompt: string,
  messages: unknown[],
  contextUsage: ContextUsage | undefined,
  usage: UsageSnapshot,
): AgentMetrics {
  const system = splitSystemPrompt(systemPrompt);
  let userInput = 0;
  let assistantOutput = 0;
  let toolCalls = 0;
  let fileReads = 0;
  let toolResults = 0;
  let otherHistory = 0;

  for (const candidate of messages) {
    const message = asRecord(candidate);
    if (!message || isExcludedBashMessage(message)) continue;
    try {
      const tokens = estimateTokens(message as never);
      if (message.role === "user") {
        userInput += tokens;
      } else if (message.role === "assistant") {
        const content = Array.isArray(message.content) ? message.content : [];
        const toolCallBlocks = content.filter(
          (block) => asRecord(block)?.type === "toolCall",
        );
        const toolCallTokens = toolCallBlocks.length
          ? estimateTokens({ ...message, content: toolCallBlocks } as never)
          : 0;
        toolCalls += toolCallTokens;
        assistantOutput += Math.max(0, tokens - toolCallTokens);
      } else if (message.role === "toolResult") {
        if (message.toolName === "read") {
          fileReads += tokens;
        } else {
          toolResults += tokens;
        }
      } else if (message.role === "bashExecution") {
        toolResults += tokens;
      } else {
        otherHistory += tokens;
      }
    } catch {
      // Unknown message shapes should not break the information panel.
    }
  }

  const history = userInput + assistantOutput + toolCalls + otherHistory;
  const estimatedTotal =
    system.system + system.skills + system.tools + history + fileReads + toolResults;
  const tokens = optionalNonNegative(contextUsage?.tokens);
  const contextWindow = optionalNonNegative(contextUsage?.contextWindow);
  const percent = optionalNonNegative(contextUsage?.percent);
  return {
    version: 3,
    updatedAt: Date.now(),
    context: {
      ...system,
      history,
      toolResults,
      fileReads,
      userInput,
      assistantOutput,
      toolCalls,
      otherHistory,
      estimatedTotal,
      ...(tokens !== undefined ? { tokens } : {}),
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      ...(percent !== undefined ? { percent } : {}),
    },
    usage,
  };
}

function captureParentSession(
  context: ParentSessionContext,
  systemPrompt: string,
  messages?: unknown[],
): ParentSessionRuntime {
  try {
    const snapshotMessages =
      messages ?? context.sessionManager.buildSessionContext?.().messages ?? [];
    return {
      model: context.model,
      metrics: buildMetrics(
        systemPrompt,
        snapshotMessages,
        context.getContextUsage(),
        usageFromEntries(context.sessionManager.getEntries()),
      ),
      hasPendingMessages: context.hasPendingMessages?.() ?? false,
      systemPrompt,
      messages: snapshotMessages,
    };
  } catch {
    return {
      model: context.model ?? parentSession?.model,
      metrics: parentSession?.metrics,
      hasPendingMessages: false,
      systemPrompt,
      messages: messages ?? parentSession?.messages ?? [],
    };
  }
}

function contextTotal(context: ContextSnapshot): number {
  return context.tokens ?? context.estimatedTotal;
}

function contextPercent(context: ContextSnapshot): number | undefined {
  if (context.percent !== undefined) return Math.max(0, Math.min(100, context.percent));
  if (!context.contextWindow || context.contextWindow <= 0) return undefined;
  return Math.max(0, Math.min(100, (contextTotal(context) / context.contextWindow) * 100));
}

function contextBar(percent: number, width = 10): string {
  const filled = Math.max(0, Math.min(width, Math.round((percent / 100) * width)));
  return `[${"█".repeat(filled)}${"░".repeat(width - filled)}]`;
}

function formatTokens(value: number): string {
  if (value < 1_000) return `${Math.round(value)}`;
  if (value < 1_000_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(1)}m`;
}

class SidebarComponent {
  constructor(private readonly theme: Theme) {}

  render(width: number): string[] {
    const innerWidth = Math.max(12, width - 2);
    const lines: string[] = [];
    lines.push(this.topBorder(innerWidth, "会话概览"));
    this.renderParentSession(lines, innerWidth);
    lines.push(this.divider(innerWidth));
    lines.push(this.bottomBorder(innerWidth));
    return lines;
  }

  invalidate(): void {}

  dispose(): void {}

  private renderParentSession(lines: string[], innerWidth: number): void {
    lines.push(this.divider(innerWidth, "当前会话"));
    const session = parentSession;
    if (session?.model) {
      lines.push(
        this.row(
          innerWidth,
          this.theme.fg("accent", `● ${session.model.provider}/${session.model.id}`),
        ),
      );
    }
    this.renderMetrics(lines, innerWidth, session?.metrics);
    if (session?.hasPendingMessages) {
      lines.push(
        this.row(
          innerWidth,
          this.theme.fg("warning", "  排队消息：有待处理的后续指令"),
        ),
      );
    }
  }

  private renderMetrics(
    lines: string[],
    innerWidth: number,
    metrics: AgentMetrics | undefined,
  ): void {
    if (!metrics) {
      lines.push(this.row(innerWidth, this.theme.fg("dim", "  用量与上下文尚未返回")));
      return;
    }

    const context = metrics.context;
    if (contextTotal(context) > 0 || context.contextWindow !== undefined) {
      const percent = contextPercent(context);
      if (percent !== undefined) {
        const color = percent >= 85 ? "error" : percent >= 70 ? "warning" : "muted";
        lines.push(
          this.row(
            innerWidth,
            this.theme.fg(
              color,
              `  上下文 ${percent.toFixed(1)}% ${contextBar(percent)}`,
            ),
          ),
        );
      } else {
        lines.push(
          this.row(
            innerWidth,
            this.theme.fg("muted", `  上下文 ${formatTokens(contextTotal(context))}`),
          ),
        );
      }

      const hasBreakdown =
        context.userInput !== undefined ||
        context.assistantOutput !== undefined ||
        context.fileReads !== undefined ||
        context.toolCalls !== undefined ||
        context.otherHistory !== undefined;
      if (hasBreakdown) {
        const rows: Array<[string, number]> = [
          ["系统提示词", context.system],
          ["技能指令", context.skills],
          ["系统工具", context.tools],
          ["用户输入", context.userInput ?? 0],
          ["模型生成", context.assistantOutput ?? 0],
          ["文件读取", context.fileReads ?? 0],
          ["工具调用", context.toolCalls ?? 0],
          ["工具调用结果", context.toolResults],
          ["其它", context.otherHistory ?? 0],
        ];
        const topRanks = new Map<number, number>();
        rows
          .map(([, tokens], index) => ({ index, tokens }))
          .filter(({ tokens }) => tokens > 0)
          .sort((left, right) => right.tokens - left.tokens)
          .slice(0, 3)
          .forEach(({ index }, rank) => topRanks.set(index, rank + 1));
        for (let index = 0; index < rows.length; index += 2) {
          const left = rows[index]!;
          const right = rows[index + 1];
          lines.push(
            this.row(
              innerWidth,
              ` ${this.contextMetricPair(
                innerWidth,
                left,
                right,
                topRanks.get(index),
                topRanks.get(index + 1),
              )}`,
            ),
          );
        }
      } else if (context.estimatedTotal > 0) {
        lines.push(
          this.row(
            innerWidth,
            this.theme.fg(
              "dim",
              `  历史 ${formatTokens(context.history)} · 工具结果 ${formatTokens(context.toolResults)}`,
            ),
          ),
        );
      }
    }

    const metricsSummary = globalState().__piTsienMetricsSidebarGetSummary?.();
    if (metricsSummary) {
      const input = formatTokens(metricsSummary.input);
      if (metricsSummary.available) {
        lines.push(
          this.row(
            innerWidth,
            this.theme.fg(
              "dim",
              `  R${formatTokens(metricsSummary.cacheRead)} W${formatTokens(metricsSummary.cacheWrite)} · 命中率${Math.round(metricsSummary.hitRatio * 100)}% · 未缓存${Math.round(metricsSummary.uncachedRatio * 100)}%`,
            ),
          ),
        );
      } else {
        lines.push(
          this.row(
            innerWidth,
            this.theme.fg("dim", `  缓存暂无数据 · Input ${input}`),
          ),
        );
      }
    } else {
      const usage = metrics.usage;
      if (hasUsage(usage)) {
        lines.push(
          this.row(
            innerWidth,
            this.theme.fg(
              "dim",
              `  缓存暂无数据 · Input ${formatTokens(usage.input)}`,
            ),
          ),
        );
      } else {
        lines.push(this.row(innerWidth, this.theme.fg("dim", "  缓存暂无数据")));
      }
    }
  }

  private topBorder(innerWidth: number, title: string): string {
    const label = truncateToWidth(this.theme.bold(title), Math.max(1, innerWidth - 2), "…");
    const tail = "─".repeat(Math.max(0, innerWidth - visibleWidth(label) - 1));
    return (
      this.theme.fg("border", "╭─") +
      this.theme.fg("accent", label) +
      this.theme.fg("border", `${tail}╮`)
    );
  }

  private bottomBorder(innerWidth: number): string {
    return this.theme.fg("border", `╰${"─".repeat(innerWidth)}╯`);
  }

  private contextMetricPair(
    innerWidth: number,
    left: [string, number],
    right?: [string, number],
    leftRank?: number,
    rightRank?: number,
  ): string {
    if (!right) return this.contextMetricText(left, leftRank);
    const gap = "  ";
    const columnWidth = Math.floor((innerWidth - 1 - visibleWidth(gap)) / 2);
    const leftRaw = this.contextMetricRaw(left, leftRank, columnWidth);
    const rightRaw = this.contextMetricRaw(right, rightRank, columnWidth);
    const leftPadding = " ".repeat(Math.max(0, columnWidth - visibleWidth(leftRaw)));
    return `${this.contextMetricText(left, leftRank, leftRaw)}${leftPadding}${gap}${this.contextMetricText(right, rightRank, rightRaw)}`;
  }

  private contextMetricRaw(
    metric: [string, number],
    rank?: number,
    width?: number,
  ): string {
    const badge = rank ? ["", "① ", "② ", "③ "][rank] : "";
    const text = `${badge}${metric[0]} ${formatTokens(metric[1])}`;
    return width === undefined ? text : truncateToWidth(text, width, "…");
  }

  private contextMetricText(
    metric: [string, number],
    rank?: number,
    raw?: string,
  ): string {
    const color = rank === 1 ? "error" : rank === 2 ? "warning" : rank === 3 ? "accent" : "dim";
    return this.theme.fg(color, raw ?? this.contextMetricRaw(metric, rank));
  }

  private divider(innerWidth: number, title?: string): string {
    const label = title ? ` ${title} ` : "";
    const tail = "─".repeat(Math.max(0, innerWidth - visibleWidth(label)));
    return this.theme.fg("border", `├${label}${tail}┤`);
  }

  private row(innerWidth: number, text: string): string {
    const visible = truncateToWidth(text, innerWidth, "…");
    const pad = " ".repeat(Math.max(0, innerWidth - visibleWidth(visible)));
    return this.theme.fg("border", "│") + visible + pad + this.theme.fg("border", "│");
  }
}

function closeSidebar(): void {
  const active = sidebar;
  sidebar = undefined;
  if (!active) return;
  clearInterval(active.timer);
  try {
    active.done();
  } catch {
    // The TUI may already have disposed the overlay during shutdown.
  }
}

function openSidebar(ctx: ExtensionContext): void {
  if (ctx.mode !== "tui") return;
  if (sidebar) {
    sidebar.hidden = false;
    sidebar.handle?.setHidden(false);
    return;
  }

  let runtime: SidebarRuntime | undefined;
  const promise = ctx.ui.custom(
    (tui: TUI, theme: Theme, _keybindings: unknown, done: (result?: unknown) => void) => {
      const component = new SidebarComponent(theme);
      const timer = setInterval(() => tui.requestRender(), 1000);
      timer.unref?.();
      runtime = { done, hidden: false, timer };
      sidebar = runtime;
      return component;
    },
    {
      overlay: true,
      overlayOptions: {
        anchor: "top-right",
        width: 48,
        margin: { top: 1, right: 1 },
        visible: (termWidth: number) => termWidth >= 120,
        nonCapturing: true,
      },
      onHandle: (handle: OverlayHandle) => {
        if (!runtime) return;
        runtime.handle = handle;
        handle.unfocus();
      },
    },
  );

  void Promise.resolve(promise).finally(() => {
    if (sidebar === runtime) closeSidebar();
  });
}

export default function sidebarExtension(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    const context = ctx as unknown as ParentSessionContext;
    parentSession = captureParentSession(context, ctx.getSystemPrompt());
  });

  pi.on("before_agent_start", (event) => {
    if (parentSession) parentSession.systemPrompt = event.systemPrompt;
  });
  pi.on("context", (event, ctx) => {
    const context = ctx as unknown as ParentSessionContext;
    parentSession = captureParentSession(context, ctx.getSystemPrompt(), event.messages);
  });
  pi.on("message_end", (_event, ctx) => {
    const context = ctx as unknown as ParentSessionContext;
    parentSession = captureParentSession(
      context,
      parentSession?.systemPrompt ?? ctx.getSystemPrompt(),
      parentSession?.messages,
    );
  });

  pi.on("session_shutdown", () => {
    parentSession = undefined;
    closeSidebar();
  });

  pi.registerShortcut("ctrl+alt+s", {
    description: "显示或隐藏当前会话信息侧栏",
    handler: async (ctx) => {
      if (!sidebar) {
        openSidebar(ctx);
        return;
      }
      sidebar.hidden = !sidebar.hidden;
      sidebar.handle?.setHidden(sidebar.hidden);
    },
  });

  pi.registerCommand("sidebar", {
    description: "显示、隐藏、关闭或切换当前会话信息侧栏",
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase();
      if (action && !["show", "hide", "toggle", "close"].includes(action)) {
        ctx.ui.notify("用法：/sidebar [show|hide|toggle|close]", "warning");
        return;
      }
      if (action === "close") {
        closeSidebar();
        return;
      }
      if (!sidebar) {
        openSidebar(ctx);
        return;
      }
      const hidden = action === "show" ? false : action === "hide" ? true : !sidebar.hidden;
      sidebar.hidden = hidden;
      sidebar.handle?.setHidden(hidden);
    },
  });
}
