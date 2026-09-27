/**
 * pi-zero — a curated pi extension suite
 *
 * Extracted from pi-powerline-footer: powerline status bar + random vibe messages
 * Extracted from pi-cc-extensions: token + elapsed-time stats (bridged into the vibe)
 *
 * Stripped of bash mode, queue, stash, shortcuts, welcome page, git/currency commands.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import type { ExtensionAPI, ReadonlyFooterDataProvider, Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

import { getPreset, PRESETS } from "./powerline/presets.ts";
import { getSeparator } from "./powerline/separators.ts";
import { getFgAnsiCode, ansi } from "./powerline/colors.ts";
import { getDefaultColors } from "./powerline/theme.ts";
import { renderSegment } from "./powerline/segments.ts";
import {
  getGitStatus,
  subscribeGitUpdates,
  refreshGitStatus,
  refreshGitBranch,
  type GitPollingMode,
} from "./powerline/git-status.ts";
import { SessionBranchCache, SessionTokenStatsCache } from "./powerline/token-stats.ts";
import { CoreContextUsageCache } from "./powerline/context-usage.ts";
import { createRenderScheduler } from "./powerline/render-scheduler.ts";
import { isStaleExtensionContextError } from "./powerline/lifecycle.ts";
import {
  PRE_POWERLINE_HOST_SYMBOL,
  PrePowerlineHost,
} from "./powerline/pre-powerline.ts";
import {
  parsePowerlineConfig,
  mergeSegmentOptions,
  mergeSegmentsWithCustomItems,
  collectHiddenExtensionStatusKeys,
  getNotificationExtensionStatuses,
  nextPowerlineSettingWithPreset,
  nextPowerlineSettingWithOptions,
  type PowerlineConfig,
} from "./powerline/powerline-config.ts";
import type {
  ColorScheme,
  SegmentContext,
  StatusLineSegmentId,
  StatusLineSeparatorStyle,
  StatusLinePreset,
} from "./powerline/types.ts";
import {
  initVibeManager,
  onVibeBeforeAgentStart,
  onVibeAgentStart,
  onVibeToolCall,
  onVibeAgentEnd,
  getVibeTheme,
  setVibeTheme,
  getVibeMode,
  setVibeMode,
  getVibeModel,
  setVibeModel,
  hasVibeFile,
  getVibeFileCount,
  parseVibeGenerateArgs,
  generateVibesBatch,
} from "./vibe/working-vibes.ts";
import workingMessage from "./vibe/working-message.ts";
import contextUsageExtension from "./context/context.ts";
import claudeCodeStyle, { getCompactThinkingConfig } from "./ccstyle/claude-code-style.ts";
import { installCompactThinking, type CompactThinkingController } from "./ccstyle/compact-thinking.ts";
import { installUserMessageStyle } from "./ccstyle/user-message-style.ts";
import { installTranscriptWindow } from "./transcript-window/index.ts";

const PRESET_NAMES = Object.keys(PRESETS) as StatusLinePreset[];

let config: PowerlineConfig = {
  preset: "default",
  customItems: [],
  disabledSegments: [],
  invalidDisabledSegments: [],
  layout: null,
  invalidLayoutSegments: [],
  separator: null,
  segmentOptions: {},
  placement: "below",
  invalidPlacement: null,
  welcome: true,
  stashSharpSShortcut: false,
  queue: { captureSigil: "#" },
};

// ═══════════════════════════════════════════════════════════════════════
// Top-level rendering helpers (copied from powerline index.ts)
// ═══════════════════════════════════════════════════════════════════════

function renderSegmentWithWidth(
  segId: StatusLineSegmentId,
  ctx: SegmentContext,
): { content: string; width: number; visible: boolean } {
  const rendered = renderSegment(segId, ctx);
  if (!rendered.visible || !rendered.content) {
    return { content: "", width: 0, visible: false };
  }
  return { content: rendered.content, width: visibleWidth(rendered.content), visible: true };
}

function buildContentFromParts(
  parts: string[],
  separatorStyle: StatusLineSeparatorStyle,
): string {
  if (parts.length === 0) return "";
  const separatorDef = getSeparator(separatorStyle);
  const sepAnsi = getFgAnsiCode("sep");
  const sep = separatorDef.left;
  return " " + parts.join(` ${sepAnsi}${sep}${ansi.reset} `) + ansi.reset + " ";
}

function computeResponsiveLayout(
  ctx: SegmentContext,
  presetDef: ReturnType<typeof getPreset>,
  availableWidth: number,
): { topContent: string; secondaryContent: string } {
  const separatorStyle = config.separator ?? presetDef.separator;
  const separatorDef = getSeparator(separatorStyle);
  const sepWidth = visibleWidth(separatorDef.left) + 2;

  const mergedSegments = mergeSegmentsWithCustomItems(presetDef, config.customItems, {
    layout: config.layout,
    disabledSegments: config.disabledSegments,
  });
  const primaryIds = [...mergedSegments.leftSegments, ...mergedSegments.rightSegments];
  const secondaryIds = mergedSegments.secondarySegments;
  const allSegmentIds = [...primaryIds, ...secondaryIds];
  const rightIds = new Set<StatusLineSegmentId>(mergedSegments.rightSegments);

  type RenderedSegment = { content: string; width: number; alignment: "left" | "right" };
  const renderedSegments: RenderedSegment[] = [];
  for (const segId of allSegmentIds) {
    const { content, width, visible } = renderSegmentWithWidth(segId, ctx);
    if (visible) {
      renderedSegments.push({
        content,
        width,
        alignment: rightIds.has(segId) ? "right" : "left",
      });
    }
  }

  if (renderedSegments.length === 0) {
    return { topContent: "", secondaryContent: "" };
  }

  const alignedMinimumWidth = (segments: RenderedSegment[]): number => {
    const left = segments.filter((segment) => segment.alignment === "left");
    const right = segments.filter((segment) => segment.alignment === "right");
    const rowWidth = (row: RenderedSegment[]) =>
      row.length === 0
        ? 0
        : 2 + row.reduce((sum, segment) => sum + segment.width, 0) + sepWidth * (row.length - 1);
    return rowWidth(left) + rowWidth(right) + (left.length > 0 && right.length > 0 ? 1 : 0);
  };

  const buildAlignedContent = (segments: RenderedSegment[]): string => {
    const leftContent = buildContentFromParts(
      segments.filter((segment) => segment.alignment === "left").map((segment) => segment.content),
      separatorStyle,
    );
    const rightContent = buildContentFromParts(
      segments.filter((segment) => segment.alignment === "right").map((segment) => segment.content),
      separatorStyle,
    );
    if (!rightContent) return leftContent;

    const gap = Math.max(
      leftContent ? 1 : 0,
      availableWidth - visibleWidth(leftContent) - visibleWidth(rightContent),
    );
    return `${leftContent}${" ".repeat(gap)}${rightContent}`;
  };

  const topSegments: RenderedSegment[] = [];
  const overflowSegments: RenderedSegment[] = [];
  let overflow = false;

  for (const segment of renderedSegments) {
    if (!overflow && alignedMinimumWidth([...topSegments, segment]) <= availableWidth) {
      topSegments.push(segment);
    } else {
      overflow = true;
      overflowSegments.push(segment);
    }
  }

  const baseOverhead = 2;
  let secondaryWidth = baseOverhead;
  const secondarySegments: string[] = [];
  for (const segment of overflowSegments) {
    const neededWidth = segment.width + (secondarySegments.length > 0 ? sepWidth : 0);
    if (secondaryWidth + neededWidth <= availableWidth) {
      secondarySegments.push(segment.content);
      secondaryWidth += neededWidth;
    } else {
      break;
    }
  }

  return {
    topContent: buildAlignedContent(topSegments),
    secondaryContent: buildContentFromParts(secondarySegments, separatorStyle),
  };
}

function getUsageTokenTotal(usage: any): number {
  const totalTokens = "totalTokens" in usage && typeof usage.totalTokens === "number" ? usage.totalTokens : 0;
  return totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

// ═══════════════════════════════════════════════════════════════════════
// Extension body
// ═══════════════════════════════════════════════════════════════════════

export default function piZero(pi: ExtensionAPI): void {
  // Register cc's working-message first (token/time + vibe bridge) so it patches ui before anything else
  workingMessage(pi);
  // /context usage inspector (from pi-cc-extensions)
  contextUsageExtension(pi);
  // ccstyle: Claude Code style tool rendering (collapse / compact / animation / rich diff)
  let compactThinking: CompactThinkingController | undefined;
  const compactThinkingBridge: CompactThinkingController = {
    updateConfig(next) {
      compactThinking?.updateConfig(next);
    },
  };
  installUserMessageStyle(pi);
  claudeCodeStyle(pi, undefined, compactThinkingBridge);
  compactThinking = installCompactThinking(pi, getCompactThinkingConfig());
  installTranscriptWindow(pi);

  let powerlineEnabled = true;
  let currentCtx: any = null;
  let footerDataRef: ReadonlyFooterDataProvider | null = null;
  let tuiRef: any = null;
  let isStreaming = false;
  let liveAssistantUsage: any = null;
  let sessionStartTime = Date.now();
  let sessionGeneration = 0;
  let getThinkingLevelFn: (() => string) | null = null;
  let currentThinkingLevel: string | null = null;

  const sessionBranchCache = new SessionBranchCache();
  const tokenStatsCache = new SessionTokenStatsCache();
  const coreContextUsageCache = new CoreContextUsageCache();

  const LAYOUT_CACHE_TTL_MS = 250;
  const STREAMING_LAYOUT_CACHE_TTL_MS = 1000;
  const STATUS_RENDER_DEBOUNCE_MS = 33;
  const CONTEXT_STATUS_RENDER_MS = 250;
  const EDITOR_STATUS_DEFER_MS = 150;

  let lastLayoutWidth = 0;
  let lastLayoutResult: { topContent: string; secondaryContent: string } | null = null;
  let lastLayoutTimestamp = 0;
  let layoutDirty = true;
  let forceNextLayoutRecompute = false;
  let lastEditorInputAt = 0;

  const resetLayoutCache = (): void => {
    lastLayoutResult = null;
    layoutDirty = true;
    sessionBranchCache.reset();
    tokenStatsCache.reset();
    coreContextUsageCache.reset();
  };

  const statusRenderScheduler = createRenderScheduler(() => {
    const msSinceInput = Date.now() - lastEditorInputAt;
    if (layoutDirty && !forceNextLayoutRecompute && msSinceInput < EDITOR_STATUS_DEFER_MS) {
      statusRenderScheduler.schedule(Math.max(0, EDITOR_STATUS_DEFER_MS - msSinceInput));
      return;
    }
    tuiRef?.requestRender();
  }, STATUS_RENDER_DEBOUNCE_MS);

  const requestStatusRender = (delayMs?: number): void => {
    layoutDirty = true;
    statusRenderScheduler.schedule(delayMs);
  };

  const requestImmediateStatusRender = (): void => {
    layoutDirty = true;
    forceNextLayoutRecompute = true;
    statusRenderScheduler.cancel();
    statusRenderScheduler.schedule(0);
  };

  const prePowerlineErrorKeys = new Set<string>();
  const prePowerlineHost = new PrePowerlineHost({
    requestRender: () => tuiRef?.requestRender(),
    onError: (key, error) => {
      if (prePowerlineErrorKeys.has(key)) return;
      prePowerlineErrorKeys.add(key);
      const message = error instanceof Error ? error.message : String(error);
      currentCtx?.ui?.notify?.(`pre-powerline component ${key} disabled: ${message}`, "error");
    },
  });
  const globalSymbols = globalThis as unknown as Record<symbol, unknown>;
  globalSymbols[PRE_POWERLINE_HOST_SYMBOL] = prePowerlineHost;

  const getGitPollingMode = (): GitPollingMode => {
    const presetDef = getPreset(config.preset);
    return mergeSegmentOptions(presetDef.segmentOptions, config.segmentOptions).git?.polling ?? "event";
  };

  const refreshGitFromEvent = (branchMayHaveChanged = false): void => {
    if (!powerlineEnabled || !currentCtx?.hasUI) return;
    const mode = getGitPollingMode();
    if (mode === "off") return;
    if (branchMayHaveChanged) refreshGitBranch();
    if (mode === "event") refreshGitStatus();
  };

  // ── Status bar construction (simplified from powerline: no queue/shell) ──

  function buildSegmentContext(ctx: any, theme: Theme): SegmentContext {
    const presetDef = getPreset(config.preset);
    const colors: ColorScheme = presetDef.colors ?? getDefaultColors();

    const sessionEvents = sessionBranchCache.get(ctx.sessionManager);
    const tokenStats = tokenStatsCache.get(sessionEvents);
    const { input, output, cacheRead, cacheWrite, cost, subagentCost } = tokenStats;
    const lastAssistant = tokenStats.lastAssistant;
    const thinkingLevelFromSession = tokenStats.thinkingLevelFromSession;

    const latestUsage = isStreaming ? liveAssistantUsage ?? lastAssistant?.usage : lastAssistant?.usage;
    const coreContextUsage = isStreaming && liveAssistantUsage ? null : coreContextUsageCache.get(ctx);
    const contextTokens = coreContextUsage?.contextTokens ?? (latestUsage ? getUsageTokenTotal(latestUsage) : 0);
    const contextWindow = coreContextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
    const contextPercent = coreContextUsage?.contextPercent ?? (contextWindow > 0 ? (contextTokens / contextWindow) * 100 : 0);

    const segmentOptions = mergeSegmentOptions(presetDef.segmentOptions, config.segmentOptions);

    const gitBranch = footerDataRef?.getGitBranch() ?? null;
    const gitStatus = getGitStatus(gitBranch, segmentOptions.git?.polling);
    const extensionStatuses = footerDataRef?.getExtensionStatuses() ?? new Map();
    const customItemsById = new Map(config.customItems.map((item) => [item.id, item]));
    const hiddenExtensionStatusKeys = collectHiddenExtensionStatusKeys(config.customItems);

    const usingSubscription = ctx.model
      ? (ctx.modelRegistry?.isUsingOAuth?.(ctx.model) ?? false)
      : false;

    const thinkingLevel = currentThinkingLevel ?? thinkingLevelFromSession ?? getThinkingLevelFn?.() ?? "off";

    return {
      model: ctx.model,
      thinkingLevel,
      sessionId: ctx.sessionManager?.getSessionId?.(),
      cwd: ctx.cwd,
      usageStats: { input, output, cacheRead, cacheWrite, cost, subagentCost },
      contextTokens,
      contextPercent,
      contextWindow,
      autoCompactEnabled: ctx.settingsManager?.getCompactionSettings?.()?.enabled ?? true,
      customCompactionEnabled: false,
      usingSubscription,
      queueSummary: { compacting: false, queueCount: 0, ideaCount: 0, blockedCount: 0 },
      sessionStartTime,
      shellModeActive: false,
      shellRunning: false,
      shellName: null,
      shellCwd: null,
      git: gitStatus,
      extensionStatuses,
      hiddenExtensionStatusKeys,
      customItemsById,
      options: segmentOptions,
      theme,
      colors,
    };
  }

  function getResponsiveLayout(
    width: number,
    theme: Theme,
  ): { topContent: string; secondaryContent: string } {
    const now = Date.now();
    const cacheTtl = isStreaming ? STREAMING_LAYOUT_CACHE_TTL_MS : LAYOUT_CACHE_TTL_MS;

    if (lastLayoutResult && lastLayoutWidth === width) {
      const msSinceInput = now - lastEditorInputAt;
      const typingRecently = msSinceInput < EDITOR_STATUS_DEFER_MS;
      if (!forceNextLayoutRecompute && typingRecently && (layoutDirty || now - lastLayoutTimestamp >= cacheTtl)) {
        return lastLayoutResult;
      }
      if (!layoutDirty && now - lastLayoutTimestamp < cacheTtl) {
        return lastLayoutResult;
      }
    }

    const presetDef = getPreset(config.preset);
    let segmentCtx: SegmentContext;
    try {
      segmentCtx = buildSegmentContext(currentCtx, theme);
    } catch (error) {
      if (!isStaleExtensionContextError(error)) throw error;
      currentCtx = null;
      lastLayoutWidth = width;
      lastLayoutResult = { topContent: "", secondaryContent: "" };
      lastLayoutTimestamp = now;
      layoutDirty = false;
      forceNextLayoutRecompute = false;
      return lastLayoutResult;
    }

    lastLayoutWidth = width;
    lastLayoutResult = computeResponsiveLayout(segmentCtx, presetDef, width);
    lastLayoutTimestamp = now;
    layoutDirty = false;
    forceNextLayoutRecompute = false;
    return lastLayoutResult;
  }

  function renderPowerlineStatusLines(width: number, tui: any, theme: Theme): string[] {
    if (!currentCtx) return [];

    const notifications: string[] = [];
    if (footerDataRef) {
      const statuses = footerDataRef.getExtensionStatuses();
      const hiddenExtensionStatusKeys = collectHiddenExtensionStatusKeys(config.customItems);
      for (const value of getNotificationExtensionStatuses(statuses, hiddenExtensionStatusKeys)) {
        const lineContent = ` ${value}`;
        if (visibleWidth(lineContent) <= width) notifications.push(lineContent);
      }
    }

    return [...notifications, ...prePowerlineHost.render(width, tui, theme)];
  }

  function renderPowerlinePrimaryLines(width: number, theme: Theme): string[] {
    if (!currentCtx) return [];
    const layout = getResponsiveLayout(width, theme);
    return layout.topContent ? [layout.topContent] : [];
  }

  function renderPowerlineSecondaryLines(width: number, theme: Theme): string[] {
    if (!currentCtx) return [];
    const layout = getResponsiveLayout(width, theme);
    return layout.secondaryContent ? [layout.secondaryContent] : [];
  }

  function installStatusBar(ctx: any): void {
    const primaryPlacement = config.placement === "below" ? "belowEditor" : "aboveEditor";

    ctx.ui.setWidget("powerline-status", (tui: any, theme: Theme) => ({
      dispose() {
        prePowerlineHost.disposeComponents();
      },
      invalidate() {
        prePowerlineHost.invalidate();
        requestStatusRender();
      },
      render(width: number): string[] {
        return renderPowerlineStatusLines(width, tui, theme);
      },
    }), { placement: primaryPlacement });

    ctx.ui.setWidget("powerline-top", (_tui: any, theme: Theme) => ({
      dispose() {},
      invalidate() {
        resetLayoutCache();
      },
      render(width: number): string[] {
        return renderPowerlinePrimaryLines(width, theme);
      },
    }), { placement: primaryPlacement });

    ctx.ui.setWidget("powerline-secondary", (_tui: any, theme: Theme) => ({
      dispose() {},
      invalidate() {
        resetLayoutCache();
      },
      render(width: number): string[] {
        return renderPowerlineSecondaryLines(width, theme);
      },
    }), { placement: "belowEditor" });
  }

  function setupFooter(ctx: any): void {
    ctx.ui.setFooter((tui: any, _theme: Theme, footerData: ReadonlyFooterDataProvider) => {
      footerDataRef = footerData;
      tuiRef = tui;
      const unsubBranch = footerData.onBranchChange(() => requestStatusRender());
      const unsubGit = subscribeGitUpdates(() => requestStatusRender());
      return {
        dispose() {
          unsubBranch();
          unsubGit();
        },
        invalidate() {
          requestStatusRender();
        },
        render(): string[] {
          return [];
        },
      };
    });
  }

  function teardownStatusBar(ctx: any): void {
    if (!ctx?.ui) return;
    ctx.ui.setWidget("powerline-status", undefined);
    ctx.ui.setWidget("powerline-top", undefined);
    ctx.ui.setWidget("powerline-secondary", undefined);
    ctx.ui.setFooter(undefined);
    prePowerlineHost.disposeComponents();
    footerDataRef = null;
    tuiRef = null;
    resetLayoutCache();
  }

  // ── Events ──

  pi.on("session_start", async (_event, ctx) => {
    sessionGeneration++;
    sessionStartTime = Date.now();
    currentCtx = ctx;
    prePowerlineErrorKeys.clear();
    prePowerlineHost.disposeComponents();
    globalSymbols[PRE_POWERLINE_HOST_SYMBOL] = prePowerlineHost;
    isStreaming = false;
    liveAssistantUsage = null;
    // Clear any leftover shared vibe from a previous session/reload.
    delete (globalThis as any)[Symbol.for("pi.zero.vibe")];

    config = parsePowerlineConfig(readSettings(ctx.cwd).powerline, PRESET_NAMES);
    powerlineEnabled = readPowerlineEnabled(ctx.cwd);
    getThinkingLevelFn = () => ctx.thinkingLevel ?? "off";
    currentThinkingLevel = getThinkingLevelFn();
    initVibeManager(ctx);

    if (ctx.hasUI && powerlineEnabled) {
      installStatusBar(ctx);
      setupFooter(ctx);
      refreshGitFromEvent(true);
    }
  });

  pi.on("thinking_level_select", async (event, ctx) => {
    if (typeof event?.level === "string") {
      // The session_start snapshot is stale after switching thinking levels;
      // adopt the freshly selected level so the powerline segment stays in sync
      // without a reload.
      currentThinkingLevel = event.level;
      if (ctx) currentCtx = ctx;
      resetLayoutCache();
      requestImmediateStatusRender();
    }
  });

  pi.on("session_shutdown", async () => {
    sessionGeneration++;
    statusRenderScheduler.cancel();
    if (globalSymbols[PRE_POWERLINE_HOST_SYMBOL] === prePowerlineHost) {
      delete globalSymbols[PRE_POWERLINE_HOST_SYMBOL];
    }
    prePowerlineHost.reset();
    currentCtx = null;
    footerDataRef = null;
    getThinkingLevelFn = null;
    currentThinkingLevel = null;
    liveAssistantUsage = null;
    tuiRef = null;
    resetLayoutCache();
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (ctx?.hasUI) {
      onVibeBeforeAgentStart(event.prompt, (msg?: string) => {
        if (typeof msg === "string" && msg.trim()) {
          (globalThis as any)[Symbol.for("pi.zero.vibe")] = msg.trim();
        }
        ctx.ui.setWorkingMessage(msg);
      });
    }
  });

  pi.on("agent_start", async (_event, ctx) => {
    isStreaming = true;
    liveAssistantUsage = null;
    onVibeAgentStart();
    currentCtx = ctx;
  });

  pi.on("message_update", async (event, ctx) => {
    const message = event.message;
    if (
      message?.role === "assistant"
      && message.usage
      && message.stopReason !== "error"
      && message.stopReason !== "aborted"
      && getUsageTokenTotal(message.usage) > 0
    ) {
      liveAssistantUsage = message.usage;
      currentCtx = ctx;
      layoutDirty = true;
      statusRenderScheduler.schedule(CONTEXT_STATUS_RENDER_MS);
    }
  });

  pi.on("message_end", async (event, ctx) => {
    currentCtx = ctx;
    coreContextUsageCache.reset();
    const message = event.message;
    if (message?.role === "assistant" && message.usage) {
      if (message.stopReason === "error" || message.stopReason === "aborted") {
        liveAssistantUsage = null;
      } else if (getUsageTokenTotal(message.usage) > 0) {
        liveAssistantUsage = message.usage;
      }
    }
    requestImmediateStatusRender();
  });

  pi.on("turn_end", async (_event, ctx) => {
    currentCtx = ctx;
    coreContextUsageCache.reset();
    requestImmediateStatusRender();
  });

  pi.on("tool_call", async (event, ctx) => {
    if (ctx.hasUI) {
      onVibeToolCall(event.toolName, event.input, ctx.ui.setWorkingMessage, getRecentAgentContext(ctx));
    }
  });

  pi.on("tool_result", async (event) => {
    if (event.toolName === "write" || event.toolName === "edit") {
      refreshGitFromEvent();
      requestStatusRender();
    }
    if (event.toolName === "bash" && event.input?.command) {
      const cmd = String(event.input.command);
      if (/\bgit\s+(add|am|apply|branch|checkout|cherry-pick|clean|commit|merge|mv|pull|rebase|reset|restore|revert|rm|stash|switch)\b/.test(cmd)) {
        refreshGitFromEvent(true);
        requestStatusRender();
      }
    }
  });

  pi.on("agent_end", async (_event, ctx) => {
    isStreaming = false;
    liveAssistantUsage = null;
    if (ctx.hasUI) {
      onVibeAgentEnd((msg?: string) => {
        if (msg === undefined) {
          delete (globalThis as any)[Symbol.for("pi.zero.vibe")];
        }
        ctx.ui.setWorkingMessage(msg);
      });
    }
  });

  pi.registerCommand("vibe", {
    description: "Set working message theme. Usage: /vibe [theme|off|mode|model|generate]",
    handler: async (args, ctx) => {
      const parts = args?.trim().split(/\s+/) || [];
      const subcommand = parts[0]?.toLowerCase();

      // No args: show current status
      if (!args || !args.trim()) {
        const theme = getVibeTheme();
        const mode = getVibeMode();
        const model = getVibeModel();
        let status = `Vibe: ${theme || "off"} | Mode: ${mode} | Model: ${model}`;
        if (theme && mode === "file") {
          const count = getVibeFileCount(theme);
          status += count > 0 ? ` | File: ${count} vibes` : " | File: not found";
        }
        ctx.ui.notify(status, "info");
        return;
      }

      // /vibe model [spec] - show or set model
      if (subcommand === "model") {
        const modelSpec = parts.slice(1).join(" ");
        if (!modelSpec) {
          ctx.ui.notify(`Current vibe model: ${getVibeModel()}`, "info");
          return;
        }
        if (!modelSpec.includes("/")) {
          ctx.ui.notify("Invalid model format. Use: provider/modelId (e.g., openai-codex/gpt-5.4-mini)", "error");
          return;
        }
        const persisted = setVibeModel(modelSpec);
        if (persisted) {
          ctx.ui.notify(`Vibe model set to: ${modelSpec}`, "info");
        } else {
          ctx.ui.notify(`Vibe model set to: ${modelSpec} (not persisted; check settings.json)`, "warning");
        }
        return;
      }

      // /vibe mode [generate|file] - show or set mode
      if (subcommand === "mode") {
        const newMode = parts[1]?.toLowerCase();
        if (!newMode) {
          ctx.ui.notify(`Current vibe mode: ${getVibeMode()}`, "info");
          return;
        }
        if (newMode !== "generate" && newMode !== "file") {
          ctx.ui.notify("Invalid mode. Use: generate or file", "error");
          return;
        }
        const theme = getVibeTheme();
        if (newMode === "file" && theme && !hasVibeFile(theme)) {
          ctx.ui.notify(`No vibe file for "${theme}". Run /vibe generate ${theme} first`, "error");
          return;
        }
        const persisted = setVibeMode(newMode);
        if (persisted) {
          ctx.ui.notify(`Vibe mode set to: ${newMode}`, "info");
        } else {
          ctx.ui.notify(`Vibe mode set to: ${newMode} (not persisted; check settings.json)`, "warning");
        }
        return;
      }

      // /vibe generate <theme> [count] - generate vibes and save to file
      if (subcommand === "generate") {
        const parsed = parseVibeGenerateArgs(parts.slice(1));
        if (!parsed) {
          ctx.ui.notify("Usage: /vibe generate <theme> [count]", "error");
          return;
        }
        const { theme, count } = parsed;
        ctx.ui.notify(`Generating ${count} vibes for "${theme}"...`, "info");
        const result = await generateVibesBatch(theme, count);
        if (result.success) {
          ctx.ui.notify(`Generated ${result.count} vibes for "${theme}" → ${result.filePath}`, "info");
        } else {
          ctx.ui.notify(`Failed to generate vibes: ${result.error}`, "error");
        }
        return;
      }

      // /vibe off - disable
      if (subcommand === "off") {
        const persisted = setVibeTheme(null);
        if (persisted) {
          ctx.ui.notify("Vibe disabled", "info");
        } else {
          ctx.ui.notify("Vibe disabled (not persisted; check settings.json)", "warning");
        }
        return;
      }

      // /vibe <theme> - set theme (preserve original casing)
      const theme = args.trim();
      const persisted = setVibeTheme(theme);
      const mode = getVibeMode();
      if (mode === "file" && !hasVibeFile(theme)) {
        const suffix = persisted ? "" : " (not persisted; check settings.json)";
        ctx.ui.notify(`Vibe set to: ${theme} (file mode, but no file found - run /vibe generate ${theme})${suffix}`, "warning");
      } else if (persisted) {
        ctx.ui.notify(`Vibe set to: ${theme}`, "info");
      } else {
        ctx.ui.notify(`Vibe set to: ${theme} (not persisted; check settings.json)`, "warning");
      }
    },
  });

  pi.registerCommand("powerline", {
    description: "Configure powerline status (on, off, refresh, preset, placement)",
    handler: async (args, ctx) => {
      currentCtx = ctx;

      if (!args?.trim()) {
        ctx.ui.notify(
          `Powerline: ${powerlineEnabled ? "on" : "off"} | preset=${config.preset} | placement=${config.placement} | presets: ${Object.keys(PRESETS).join(", ")}`,
          "info",
        );
        return;
      }

      const normalizedArgs = args.trim().toLowerCase();

      if (normalizedArgs === "refresh") {
        refreshGitFromEvent(true);
        requestImmediateStatusRender();
        ctx.ui.notify("Git status refresh requested", "info");
        return;
      }

      // /powerline on|off — toggle the status bar
      if (normalizedArgs === "on" || normalizedArgs === "off") {
        const enable = normalizedArgs === "on";
        powerlineEnabled = enable;
        if (ctx.hasUI) {
          if (enable) {
            installStatusBar(ctx);
            setupFooter(ctx);
            refreshGitFromEvent(true);
            requestImmediateStatusRender();
          } else {
            teardownStatusBar(ctx);
          }
        }
        if (writePowerlineEnabled(ctx.cwd, enable)) {
          ctx.ui.notify(`Powerline ${enable ? "enabled" : "disabled"}`, "info");
        } else {
          ctx.ui.notify(`Powerline ${enable ? "enabled" : "disabled"} (not persisted; check settings.json)`, "warning");
        }
        return;
      }

      const placementMatch = /^placement(?:\s+(above|below|toggle))?$/.exec(normalizedArgs);
      if (placementMatch) {
        const requested = placementMatch[1];
        config.placement =
          requested === "above" || requested === "below"
            ? requested
            : config.placement === "above"
              ? "below"
              : "above";
        config.invalidPlacement = null;
        // Re-install widgets so the new placement actually applies, then repaint.
        if (ctx.hasUI) installStatusBar(ctx);
        resetLayoutCache();
        requestImmediateStatusRender();
        if (
          writePowerlineSetting(ctx.cwd, (existing) =>
            nextPowerlineSettingWithOptions(existing, { placement: config.placement }, config.preset),
          )
        ) {
          ctx.ui.notify(`Powerline placement set to: ${config.placement}`, "info");
        } else {
          ctx.ui.notify(`Powerline placement set to: ${config.placement} (not persisted; check settings.json)`, "warning");
        }
        return;
      }

      const preset = normalizePresetValue(args);
      if (preset) {
        config.preset = preset;
        refreshGitFromEvent(true);
        resetLayoutCache();
        requestImmediateStatusRender();
        if (writePowerlineSetting(ctx.cwd, (existing) => nextPowerlineSettingWithPreset(existing, preset))) {
          ctx.ui.notify(`Preset set to: ${preset}`, "info");
        } else {
          ctx.ui.notify(`Preset set to: ${preset} (not persisted; check settings.json)`, "warning");
        }
        return;
      }

      ctx.ui.notify(`Available presets: ${Object.keys(PRESETS).join(", ")}`, "info");
    },
  });

  function getRecentAgentContext(ctx: any): string | undefined {
    const sessionEvents = ctx.sessionManager?.getBranch?.() ?? [];
    for (let i = sessionEvents.length - 1; i >= 0; i--) {
      const e = sessionEvents[i];
      if (e.type === "message" && e.message?.role === "assistant") {
        const content = e.message.content;
        if (!Array.isArray(content)) continue;
        for (const block of content) {
          if (block.type === "text" && block.text) {
            const text = block.text.trim();
            if (text.length > 0) return text.slice(0, 200);
          }
        }
      }
    }
    return undefined;
  }
}

function readSettings(cwd: string): Record<string, unknown> {
  const globalPath = join(process.env.PI_CODING_AGENT_DIR ?? homedir(), ".pi", "agent", "settings.json");
  const projectPath = join(cwd, ".pi", "settings.json");
  const merged: Record<string, unknown> = {};
  for (const p of [globalPath, projectPath]) {
    try {
      if (existsSync(p)) Object.assign(merged, JSON.parse(readFileSync(p, "utf8")));
    } catch {
      // ignore unreadable settings
    }
  }
  return merged;
}

function writePowerlineSetting(cwd: string, update: (existing: unknown) => unknown): boolean {
  const globalPath = join(process.env.PI_CODING_AGENT_DIR ?? homedir(), ".pi", "agent", "settings.json");
  try {
    const existing = existsSync(globalPath) ? JSON.parse(readFileSync(globalPath, "utf8")) : {};
    if (typeof existing !== "object" || existing === null || Array.isArray(existing)) return false;
    existing.powerline = update(existing.powerline);
    mkdirSync(dirname(globalPath), { recursive: true });
    writeFileSync(globalPath, JSON.stringify(existing, null, 2) + "\n");
    return true;
  } catch {
    return false;
  }
}

/** Read the powerline status bar toggle from settings (default on). */
function readPowerlineEnabled(cwd: string): boolean {
  const pl = readSettings(cwd).powerline;
  return pl && typeof pl === "object" && !Array.isArray(pl) ? (pl as { enabled?: unknown }).enabled !== false : true;
}

function writePowerlineEnabled(cwd: string, enabled: boolean): boolean {
  return writePowerlineSetting(cwd, (existing) => {
    const base =
      existing && typeof existing === "object" && !Array.isArray(existing) ? existing : {};
    return { ...(base as Record<string, unknown>), enabled };
  });
}

function normalizePresetValue(value: string): StatusLinePreset | null {
  const v = value.trim().toLowerCase();
  return v in PRESETS ? (v as StatusLinePreset) : null;
}
