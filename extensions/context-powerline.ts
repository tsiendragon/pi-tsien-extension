import {
  SettingsManager,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "context-threshold";
const BAR_WIDTH = 12;
const DEFAULT_RESERVE_TOKENS = 16_384;

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(tokens >= 10_000_000 ? 0 : 1)}m`;
  }
  if (tokens >= 1_000) {
    return `${(tokens / 1_000).toFixed(tokens >= 100_000 ? 0 : 1)}k`;
  }
  return `${Math.round(tokens)}`;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function compactionSettings(ctx: ExtensionContext): {
  enabled: boolean;
  reserveTokens: number;
} {
  try {
    const settings = SettingsManager.create(ctx.cwd, undefined, {
      projectTrusted: ctx.isProjectTrusted(),
    }).getCompactionSettings();
    return {
      enabled: settings.enabled,
      reserveTokens: settings.reserveTokens,
    };
  } catch {
    return { enabled: true, reserveTokens: DEFAULT_RESERVE_TOKENS };
  }
}

function renderBar(
  ctx: ExtensionContext,
  used: number,
  threshold: number,
  total: number,
  enabled: boolean,
): string {
  const usedRatio = total > 0 ? clamp(used / total, 0, 1) : 0;
  const filledCells = Math.round(usedRatio * BAR_WIDTH);
  const thresholdCell = enabled && total > 0
    ? clamp(Math.round((threshold / total) * BAR_WIDTH), 0, BAR_WIDTH - 1)
    : -1;

  let bar = "";
  for (let index = 0; index < BAR_WIDTH; index += 1) {
    if (index === thresholdCell) {
      const color = used >= threshold ? "error" : "warning";
      bar += ctx.ui.theme.fg(color, "│");
    } else if (index < filledCells) {
      const color = enabled && used >= threshold ? "error" : "accent";
      bar += ctx.ui.theme.fg(color, "█");
    } else {
      bar += ctx.ui.theme.fg("dim", "░");
    }
  }
  return bar;
}

function updateStatus(ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;

  const usage = ctx.getContextUsage();
  const total = usage?.contextWindow ?? ctx.model?.contextWindow;
  if (!total || total <= 0) {
    ctx.ui.setStatus(STATUS_KEY, undefined);
    return;
  }

  const settings = compactionSettings(ctx);
  const threshold = clamp(total - settings.reserveTokens, 0, total);
  const used = usage?.tokens ?? 0;
  const bar = renderBar(ctx, used, threshold, total, settings.enabled);
  const usedText = usage?.tokens === null || usage?.tokens === undefined
    ? "…"
    : formatTokens(used);

  const detail = settings.enabled
    ? `${usedText}→${formatTokens(threshold)}/${formatTokens(total)}`
    : `${usedText}/${formatTokens(total)} auto-off`;
  const color = settings.enabled && used >= threshold ? "error" : "muted";

  ctx.ui.setStatus(
    STATUS_KEY,
    `${ctx.ui.theme.fg("dim", "ctx")} ${bar} ${ctx.ui.theme.fg(color, detail)}`,
  );
}

export default function contextPowerline(pi: ExtensionAPI): void {
  const update = (_event: unknown, ctx: ExtensionContext) => updateStatus(ctx);

  pi.on("session_start", update);
  pi.on("context", update);
  pi.on("message_end", update);
  pi.on("agent_settled", update);
  pi.on("session_compact", update);
  pi.on("model_select", update);

  pi.on("session_shutdown", (_event, ctx) => {
    ctx.ui.setStatus(STATUS_KEY, undefined);
  });
}
