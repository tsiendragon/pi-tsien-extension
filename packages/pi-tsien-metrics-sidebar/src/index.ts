import {
  type ExtensionAPI,
  type ExtensionContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type Focusable,
  type OverlayHandle,
  type TUI,
} from "@earendil-works/pi-tui";

type UnknownRecord = Record<string, unknown>;

type AssistantLike = {
  role?: unknown;
  timestamp?: unknown;
  provider?: unknown;
  model?: unknown;
  responseModel?: unknown;
  responseId?: unknown;
  api?: unknown;
  stopReason?: unknown;
  content?: unknown;
  usage?: unknown;
};

export interface RequestMetric {
  sequence: number;
  timestamp: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheKnown: boolean;
  provider: string;
  model: string;
  api: string;
  cacheKey: string;
}

export interface MetricsSidebarSummary {
  available: boolean;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  hitRatio: number;
  writeRatio: number;
  uncachedRatio: number;
}

interface MetricsTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  knownInput: number;
  knownPrompt: number;
}

interface MetricsState {
  samples: RequestMetric[];
  seenKeys: Set<string>;
  totals: MetricsTotals;
  nextSequence: number;
}

interface MetricsGlobalState {
  __piTsienMetricsSidebar?: MetricsState;
  __piTsienMetricsSidebarGetSummary?: () => MetricsSidebarSummary;
}

const MAX_SAMPLES = 60;
const GRAPH_SAMPLES = 48;
const GRAPH_LEVELS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

function globalState(): MetricsGlobalState {
  return globalThis as typeof globalThis & MetricsGlobalState;
}

function getMetricsState(): MetricsState {
  const state = globalState();
  if (!state.__piTsienMetricsSidebar) {
    state.__piTsienMetricsSidebar = {
      samples: [],
      seenKeys: new Set<string>(),
      totals: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        knownInput: 0,
        knownPrompt: 0,
      },
      nextSequence: 1,
    };
  }
  return state.__piTsienMetricsSidebar;
}

function asRecord(value: unknown): UnknownRecord | undefined {
  return value !== null && typeof value === "object" ? value as UnknownRecord : undefined;
}

function nonNegative(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function assistantMessage(value: unknown): AssistantLike | undefined {
  const message = asRecord(value) as AssistantLike | undefined;
  return message?.role === "assistant" ? message : undefined;
}

function messageFingerprint(message: AssistantLike): string {
  const usage = asRecord(message.usage);
  const content = Array.isArray(message.content)
    ? message.content.map((part) => {
        const record = asRecord(part);
        return [record?.type, record?.name, record?.id, typeof record?.text === "string" ? record.text.length : ""].join(":");
      }).join(",")
    : "";
  return [
    message.timestamp,
    message.provider,
    message.api,
    message.responseModel ?? message.model,
    message.responseId,
    message.stopReason,
    usage?.input,
    usage?.output,
    usage?.cacheRead,
    usage?.cacheWrite,
    content,
  ].join("|");
}

function cacheKeyFor(message: AssistantLike): string {
  return [
    text(message.provider, "unknown"),
    text(message.api, "unknown"),
    text(message.responseModel ?? message.model, "unknown"),
  ].join("/");
}

function timestampFor(message: AssistantLike): number {
  return typeof message.timestamp === "number" && Number.isFinite(message.timestamp)
    ? message.timestamp
    : Date.now();
}

function promptTokens(sample: RequestMetric): number {
  return sample.input + sample.cacheRead + sample.cacheWrite;
}

function isCacheKnown(_state: MetricsState, sample: RequestMetric): boolean {
  return sample.cacheKnown;
}

function resetMetrics(state: MetricsState): void {
  state.samples = [];
  state.seenKeys.clear();
  state.totals = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    knownInput: 0,
    knownPrompt: 0,
  };
  state.nextSequence = 1;
}

function addAssistantMessage(
  state: MetricsState,
  value: unknown,
  identity?: string,
): void {
  const message = assistantMessage(value);
  if (!message) return;

  const fingerprint = messageFingerprint(message);
  if ((identity && state.seenKeys.has(identity)) || state.seenKeys.has(fingerprint)) return;
  if (identity) state.seenKeys.add(identity);
  state.seenKeys.add(fingerprint);

  const usage = asRecord(message.usage);
  const provider = text(message.provider, "unknown");
  const model = text(message.responseModel ?? message.model, "unknown");
  const api = text(message.api, "unknown");
  const cacheKey = cacheKeyFor(message);
  const sample: RequestMetric = {
    sequence: state.nextSequence,
    timestamp: timestampFor(message),
    input: nonNegative(usage?.input),
    output: nonNegative(usage?.output),
    cacheRead: nonNegative(usage?.cacheRead),
    cacheWrite: nonNegative(usage?.cacheWrite),
    // Pi normalizes some missing provider fields to 0. Only positive values
    // are reliable evidence that this request carried cache accounting data.
    cacheKnown: nonNegative(usage?.cacheRead) > 0 || nonNegative(usage?.cacheWrite) > 0,
    provider,
    model,
    api,
    cacheKey,
  };
  state.nextSequence += 1;
  state.totals.input += sample.input;
  state.totals.output += sample.output;
  state.totals.cacheRead += sample.cacheRead;
  state.totals.cacheWrite += sample.cacheWrite;
  if (sample.cacheKnown) {
    state.totals.knownInput += sample.input;
    state.totals.knownPrompt += promptTokens(sample);
  }
  state.samples.push(sample);
  if (state.samples.length > MAX_SAMPLES) {
    state.samples.splice(0, state.samples.length - MAX_SAMPLES);
  }
}

function rebuildFromBranch(ctx: ExtensionContext): void {
  const state = getMetricsState();
  resetMetrics(state);
  for (const entry of ctx.sessionManager.getBranch()) {
    const record = asRecord(entry);
    if (record?.type !== "message") continue;
    const id = typeof record.id === "string" ? record.id : undefined;
    addAssistantMessage(state, record.message, id);
  }
}

function addLiveMessage(message: unknown): void {
  addAssistantMessage(getMetricsState(), message);
}

function summaryForState(state: MetricsState): MetricsSidebarSummary {
  const { input, output, cacheRead, cacheWrite, knownInput, knownPrompt } = state.totals;
  const available = knownPrompt > 0;
  return {
    available,
    input,
    output,
    cacheRead,
    cacheWrite,
    hitRatio: available ? cacheRead / knownPrompt : 0,
    writeRatio: available ? cacheWrite / knownPrompt : 0,
    uncachedRatio: available ? knownInput / knownPrompt : 0,
  };
}

globalState().__piTsienMetricsSidebarGetSummary = () => summaryForState(getMetricsState());

function formatTokens(value: number): string {
  if (value < 1_000) return `${Math.round(value)}`;
  if (value < 1_000_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(value < 10_000_000 ? 1 : 0)}m`;
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function formatTime(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "--:--:--";
  return new Date(timestamp).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function sampleRatios(
  state: MetricsState,
  sample: RequestMetric,
): [number, number, number] | undefined {
  if (!isCacheKnown(state, sample)) return undefined;
  const prompt = promptTokens(sample);
  if (prompt <= 0) return undefined;
  return [
    sample.cacheRead / prompt,
    sample.cacheWrite / prompt,
    sample.input / prompt,
  ];
}

function graphLine(
  state: MetricsState,
  samples: RequestMetric[],
  ratioIndex: 0 | 1 | 2,
): string {
  return samples.slice(-GRAPH_SAMPLES).map((sample) => {
    const ratios = sampleRatios(state, sample);
    if (!ratios) return "·";
    const index = Math.max(0, Math.min(GRAPH_LEVELS.length - 1, Math.round(ratios[ratioIndex] * (GRAPH_LEVELS.length - 1))));
    return GRAPH_LEVELS[index]!;
  }).join("");
}

class MetricsPanel implements Component, Focusable {
  private _focused = false;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly close: () => void,
  ) {}

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape")) {
      this.close();
    }
  }

  render(width: number): string[] {
    const state = getMetricsState();
    const panelWidth = Math.max(1, width);
    const innerWidth = Math.max(1, panelWidth - 2);
    const terminalRows = Math.max(3, this.tui.terminal.rows);
    const maxRows = Math.max(3, Math.min(Math.floor(terminalRows * 0.82), terminalRows - 2));
    const border = (line: string) => this.theme.fg("border", truncateToWidth(line, panelWidth, ""));
    const row = (content: string) => {
      const clipped = truncateToWidth(content, innerWidth, "…");
      const padding = " ".repeat(Math.max(0, innerWidth - visibleWidth(clipped)));
      return `${border("│")}${clipped}${padding}${border("│")}`;
    };
    const divider = () => border(`├${"─".repeat(innerWidth)}┤`);
    const summary = summaryForState(state);
    const latest = state.samples.at(-1);
    const graphSamples = state.samples.slice(-GRAPH_SAMPLES);

    const lines: string[] = [
      border(`╭${"─".repeat(innerWidth)}╮`),
      row(` ${this.theme.fg("accent", this.theme.bold("Metrics Sidebar"))} ${this.theme.fg("dim", "prompt cache analysis")}`),
      row(` ${this.theme.fg("dim", latest ? `${latest.provider}/${latest.model}` : "当前会话")}`),
      divider(),
    ];

    if (state.samples.length === 0) {
      lines.push(row(this.theme.fg("muted", "暂无模型请求数据")));
    } else {
      lines.push(row(` ${this.theme.fg("accent", "Cache Read")}  ${graphLine(state, graphSamples, 0)}`));
      lines.push(row(` ${this.theme.fg("warning", "Cache Write")} ${graphLine(state, graphSamples, 1)}`));
      lines.push(row(` ${this.theme.fg("success", "Uncached   ")} ${graphLine(state, graphSamples, 2)}`));
    }

    lines.push(divider());
    if (summary.available) {
      lines.push(row(` R ${formatTokens(summary.cacheRead)} · W ${formatTokens(summary.cacheWrite)} · Input ${formatTokens(summary.input)} · Output ${formatTokens(summary.output)}`));
      lines.push(row(` 命中率 ${formatPercent(summary.hitRatio)} · 写入率 ${formatPercent(summary.writeRatio)} · 未缓存 ${formatPercent(summary.uncachedRatio)}`));
    } else {
      lines.push(row(` Input ${formatTokens(summary.input)} · Output ${formatTokens(summary.output)}`));
      lines.push(row(this.theme.fg("muted", "暂无缓存数据（Provider 未返回可确认的缓存字段）")));
    }

    lines.push(divider());
    lines.push(row(this.theme.fg("dim", "最近请求   #序号   时间      Input    Cache R  Cache W  Output")));
    const tailReserve = state.samples.length > 0 ? 3 : 2;
    const availableRows = Math.max(0, maxRows - lines.length - tailReserve);
    const recent = state.samples.slice(-availableRows).reverse();
    for (const sample of recent) {
      const known = isCacheKnown(state, sample);
      lines.push(row(` #${sample.sequence.toString().padStart(3, " ")}  ${formatTime(sample.timestamp)}  ${formatTokens(sample.input).padStart(7, " ")}  ${known ? formatTokens(sample.cacheRead).padStart(7, " ") : "      ?"}  ${known ? formatTokens(sample.cacheWrite).padStart(7, " ") : "      ?"}  ${formatTokens(sample.output).padStart(7, " ")}`));
    }
    if (state.samples.length > recent.length) {
      lines.push(row(this.theme.fg("dim", `… 仅显示最近 ${recent.length} 条，共 ${state.samples.length} 条`)));
    }
    lines.push(row(this.theme.fg("dim", "Esc 关闭")));
    lines.push(border(`╰${"─".repeat(innerWidth)}╯`));

    return lines.slice(0, maxRows);
  }

  invalidate(): void {}

  dispose(): void {}
}

interface MetricsRuntime {
  done: (result: void) => void;
  handle?: OverlayHandle;
}

let runtime: MetricsRuntime | undefined;
let activeTui: TUI | undefined;

function requestMetricsRender(): void {
  activeTui?.requestRender();
}

function closeMetrics(): void {
  const active = runtime;
  runtime = undefined;
  activeTui = undefined;
  active?.done(undefined);
}

function openMetrics(ctx: ExtensionContext): void {
  if (ctx.mode !== "tui") {
    ctx.ui.notify("/metrics-sidebar 仅支持 Pi 交互式终端。", "warning");
    return;
  }
  if (runtime) {
    runtime.handle?.focus();
    return;
  }

  rebuildFromBranch(ctx);
  let created: MetricsRuntime | undefined;
  const promise = ctx.ui.custom<void>(
    (tui, theme, _keybindings, done) => {
      const panel = new MetricsPanel(tui, theme, closeMetrics);
      activeTui = tui;
      created = { done };
      runtime = created;
      return panel;
    },
    {
      overlay: true,
      overlayOptions: {
        anchor: "right-center",
        width: "78%",
        minWidth: 72,
        maxHeight: "82%",
        margin: 1,
      },
      onHandle: (handle) => {
        if (created) created.handle = handle;
      },
    },
  );

  void Promise.resolve(promise).finally(() => {
    if (runtime === created) {
      runtime = undefined;
      activeTui = undefined;
    }
  });
}

function commandAction(args: string, ctx: ExtensionContext): void {
  const action = args.trim().toLowerCase();
  if (action && !["show", "hide", "toggle", "close"].includes(action)) {
    ctx.ui.notify("用法：/metrics-sidebar [show|hide|toggle|close]", "warning");
    return;
  }
  if (action === "hide" || action === "close") {
    closeMetrics();
    return;
  }
  if (action === "toggle" && runtime) {
    closeMetrics();
    return;
  }
  openMetrics(ctx);
}

export default function metricsSidebar(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    rebuildFromBranch(ctx);
    requestMetricsRender();
  });
  pi.on("message_end", (event) => {
    addLiveMessage(event.message);
    requestMetricsRender();
  });
  pi.on("session_tree", (_event, ctx) => {
    rebuildFromBranch(ctx);
    requestMetricsRender();
  });
  pi.on("session_shutdown", () => closeMetrics());

  pi.registerShortcut("ctrl+alt+m", {
    description: "打开或关闭主会话缓存指标弹窗",
    handler: (ctx) => commandAction("toggle", ctx),
  });

  pi.registerCommand("metrics-sidebar", {
    description: "显示主会话 Prompt 缓存指标弹窗",
    handler: async (args, ctx) => commandAction(args, ctx),
  });
}
