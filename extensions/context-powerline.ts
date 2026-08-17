import os from "node:os";
import {
  SettingsManager,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "context-threshold";
const MODEL_STATUS_KEY = "model-info";
const MACHINE_STATUS_KEY = "machine-status";
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

let previousCpuSample: { idle: number; total: number } | undefined;

function updateMachineStatus(ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;

  const cpuSample = os.cpus().reduce(
    (sample, cpu) => {
      const times = cpu.times;
      sample.idle += times.idle;
      sample.total += times.user + times.nice + times.sys + times.idle + times.irq;
      return sample;
    },
    { idle: 0, total: 0 },
  );
  const totalDelta = previousCpuSample
    ? cpuSample.total - previousCpuSample.total
    : 0;
  const cpuPercent = previousCpuSample && totalDelta > 0
    ? Math.round(
        (1 - (cpuSample.idle - previousCpuSample.idle) / totalDelta) * 100,
      )
    : 0;
  previousCpuSample = cpuSample;

  const memoryPercent = Math.round(
    ((os.totalmem() - os.freemem()) / os.totalmem()) * 100,
  );
  ctx.ui.setStatus(
    MACHINE_STATUS_KEY,
    `M/C ${memoryPercent}/${clamp(cpuPercent, 0, 100)}%`,
  );
}

function updateStatus(ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;

  const modelId = ctx.model?.id ?? "unknown-model";
  const effort = ctx.thinkingLevel ?? "unknown-effort";
  ctx.ui.setStatus(MODEL_STATUS_KEY, `${modelId}|${effort}`.padEnd(32));

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

  ctx.ui.setStatus(STATUS_KEY, `${bar} ${ctx.ui.theme.fg(color, detail)}`);
}

export default function contextPowerline(pi: ExtensionAPI): void {
  let activeContext: ExtensionContext | undefined;
  let machineTimer: ReturnType<typeof setInterval> | undefined;

  const stopMachineTimer = () => {
    activeContext = undefined;
    previousCpuSample = undefined;
    if (machineTimer) clearInterval(machineTimer);
    machineTimer = undefined;
  };

  const refreshMachineStatus = () => {
    const ctx = activeContext;
    if (!ctx) return;
    try {
      updateMachineStatus(ctx);
    } catch {
      // A session replacement can invalidate ctx before a queued timer runs.
      stopMachineTimer();
    }
  };

  const startMachineTimer = (ctx: ExtensionContext) => {
    stopMachineTimer();
    activeContext = ctx;
    refreshMachineStatus();
    machineTimer = setInterval(refreshMachineStatus, 2_000);
    machineTimer.unref?.();
  };

  const refresh = (_event: unknown, ctx: ExtensionContext) => {
    activeContext = ctx;
    updateStatus(ctx);
    updateMachineStatus(ctx);
  };

  pi.on("session_start", (_event, ctx) => {
    startMachineTimer(ctx);
    updateStatus(ctx);
  });
  pi.on("context", refresh);
  pi.on("message_end", refresh);
  pi.on("agent_settled", refresh);
  pi.on("session_compact", refresh);
  pi.on("model_select", refresh);
  pi.on("thinking_level_select", refresh);

  pi.on("session_shutdown", (_event, ctx) => {
    stopMachineTimer();
    ctx.ui.setStatus(MODEL_STATUS_KEY, undefined);
    ctx.ui.setStatus(STATUS_KEY, undefined);
    ctx.ui.setStatus(MACHINE_STATUS_KEY, undefined);
  });
}
