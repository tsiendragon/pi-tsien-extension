import {
  SettingsManager,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

// Models whose context window is at least this size are treated as "1M"
// window models. For them, compact proactively at TARGET_PERCENT instead of
// waiting for Pi's built-in near-full threshold (contextWindow - reserveTokens).
// Other models (e.g. gpt-5.6) are left untouched and keep the default behavior.
const ONE_MILLION_TOKENS = 1_000_000;
const TARGET_PERCENT = 0.4; // compact once context usage reaches 40%

function compactionEnabled(ctx: ExtensionContext): boolean {
  try {
    const settings = SettingsManager.create(ctx.cwd, undefined, {
      projectTrusted: ctx.isProjectTrusted(),
    }).getCompactionSettings();
    return settings.enabled;
  } catch {
    return true;
  }
}

export default function autoCompactOneMillion(pi: ExtensionAPI): void {
  // Re-armed once usage drops back below the target (e.g. after compaction),
  // so each threshold crossing triggers at most one proactive compaction.
  let armed = true;

  const maybeCompact = (_event: unknown, ctx: ExtensionContext): void => {
    const usage = ctx.getContextUsage();
    const contextWindow = ctx.model?.contextWindow ?? usage?.contextWindow;
    if (!contextWindow || contextWindow < ONE_MILLION_TOKENS) return;

    if (!usage || usage.percent === null || usage.percent === undefined) return;

    if (usage.percent < TARGET_PERCENT * 100) {
      armed = true;
      return;
    }
    if (!armed) return;
    if (!ctx.isIdle()) return;
    if (!compactionEnabled(ctx)) return;

    armed = false;
    ctx.ui.notify(
      `上下文已达 ${Math.round(usage.percent)}%，对 1M 窗口模型提前压缩`,
      "info",
    );
    ctx.compact();
  };

  pi.on("session_start", (_event, ctx) => {
    armed = true;
    maybeCompact(undefined, ctx);
  });
  pi.on("context", maybeCompact);
  pi.on("agent_settled", maybeCompact);
  pi.on("model_select", (_event, ctx) => {
    armed = true;
    maybeCompact(undefined, ctx);
  });
}