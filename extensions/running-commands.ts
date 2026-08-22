import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { readBackgroundCommandsSettings } from "./lib/background-commands/config.ts";
import {
  BackgroundCommandManager,
  getBackgroundCommandManager,
} from "./lib/background-commands/manager.ts";
import { BackgroundCommandsDashboardAdapter } from "./lib/background-commands/dashboard-bridge.ts";
import { registerDashboardFeatureBridge } from "./lib/dashboard-bridge.ts";
import {
  BACKGROUND_COMMAND_TOOL_NAMES,
  formatBackgroundCompletionSummary,
  registerBackgroundCommandTools,
} from "./lib/background-commands/tools.ts";
import type { BackgroundTaskSnapshot } from "./lib/background-commands/types.ts";
import { CommandAwareEditor } from "./lib/command-ui/command-aware-editor.ts";
import { CommandFocusController } from "./lib/command-ui/focus-controller.ts";
import {
  getPrePowerlineHost,
  type PrePowerlineHostV1,
} from "./lib/command-ui/pre-powerline-client.ts";
import { formatElapsedDuration, RunningCommandsWidget } from "./lib/command-ui/running-commands-widget.ts";

const COMPONENT_KEY = "pi-tsien.running-commands";
const EDITOR_FACTORY_MARKER = Symbol.for("pi.tsien.running-commands.editor.v1");
const OUTPUT_RENDER_THROTTLE_MS = 100;

type EditorFactory = NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>>;

function isRunningCommandsEditorFactory(factory: EditorFactory | undefined): boolean {
  if (!factory) return false;
  const record = factory as unknown as Record<symbol, unknown>;
  return record[EDITOR_FACTORY_MARKER] === true;
}

function markRunningCommandsEditorFactory(factory: EditorFactory): void {
  const record = factory as unknown as Record<symbol, unknown>;
  record[EDITOR_FACTORY_MARKER] = true;
}

function completionNotification(task: BackgroundTaskSnapshot): { message: string; level: "info" | "error" } {
  const duration = formatElapsedDuration((task.endedAt ?? Date.now()) - task.startedAt);
  if (task.state === "succeeded") {
    return {
      message: `✓ Background task finished\n${task.title} · ${task.id} · exit 0 · ${duration}\nOutput: ${task.outputFile}`,
      level: "info",
    };
  }
  const reason = task.exitReason === "timeout"
    ? "timed out"
    : task.exitReason === "output_limit"
      ? "output limit reached"
      : task.state === "cancelled"
        ? "cancelled"
        : `exit ${task.exitCode ?? task.exitSignal ?? "unknown"}`;
  return {
    message: `! Background task ${task.state}\n${task.title} · ${task.id} · ${reason} · ${duration}\n让 Agent 读取 ${task.id} 的输出以查看详情。`,
    level: task.state === "cancelled" ? "info" : "error",
  };
}

function sessionId(ctx: ExtensionContext): string {
  return ctx.sessionManager.getSessionId();
}

export default function runningCommands(pi: ExtensionAPI): void {
  const isDashboard = process.env.PI_RUNTIME === "dashboard" && process.env.PI_SUBAGENT_WORKBENCH_CHILD !== "1";
  const manager: BackgroundCommandManager = isDashboard
    ? new BackgroundCommandManager()
    : getBackgroundCommandManager();
  const registry = manager.registry;
  const focus = new CommandFocusController();
  let backgroundCommandsEnabled = true;
  registerBackgroundCommandTools(pi, manager, () => backgroundCommandsEnabled);

  let activeContext: ExtensionContext | undefined;
  let host: PrePowerlineHostV1 | undefined;
  let unregisterComponent: (() => void) | undefined;
  let unsubscribeManager: (() => void) | undefined;
  let editorFactory: EditorFactory | undefined;
  let elapsedTimer: ReturnType<typeof setInterval> | undefined;
  let pendingRender: ReturnType<typeof setTimeout> | undefined;
  let dashboardAdapter: BackgroundCommandsDashboardAdapter | undefined;
  let dashboardBridgeCleanup: (() => void) | undefined;

  const stopTimers = (): void => {
    if (elapsedTimer) clearInterval(elapsedTimer);
    if (pendingRender) clearTimeout(pendingRender);
    elapsedTimer = undefined;
    pendingRender = undefined;
  };

  const requestRender = (immediate = false): void => {
    if (!host) return;
    if (immediate) {
      if (pendingRender) clearTimeout(pendingRender);
      pendingRender = undefined;
      host.requestRender();
      return;
    }
    if (pendingRender) return;
    pendingRender = setTimeout(() => {
      pendingRender = undefined;
      host?.requestRender();
    }, OUTPUT_RENDER_THROTTLE_MS);
    pendingRender.unref?.();
  };

  const updateElapsedTimer = (): void => {
    if (registry.size === 0 || !host) {
      if (elapsedTimer) clearInterval(elapsedTimer);
      elapsedTimer = undefined;
      return;
    }
    if (elapsedTimer) return;
    elapsedTimer = setInterval(() => requestRender(true), 1_000);
    elapsedTimer.unref?.();
  };

  const restoreEditor = (): void => {
    const ctx = activeContext;
    const factory = editorFactory;
    editorFactory = undefined;
    if (!ctx?.hasUI || !factory) return;
    try {
      if (ctx.ui.getEditorComponent() === factory) ctx.ui.setEditorComponent(undefined);
    } catch {
      // Session teardown may invalidate the old UI context before cleanup runs.
    }
  };

  const cleanupUiBindings = (): void => {
    stopTimers();
    restoreEditor();
    unregisterComponent?.();
    unregisterComponent = undefined;
    unsubscribeManager?.();
    unsubscribeManager = undefined;
    host = undefined;
    registry.clearForeground();
    focus.reset();
    activeContext = undefined;
  };

  const installEditor = (ctx: ExtensionContext): void => {
    const existing = ctx.ui.getEditorComponent();
    if (existing && !isRunningCommandsEditorFactory(existing)) {
      ctx.ui.notify(
        "Running commands: another custom editor is active; command display stays enabled, but keyboard focus is disabled.",
        "warning",
      );
      return;
    }
    if (existing && isRunningCommandsEditorFactory(existing)) ctx.ui.setEditorComponent(undefined);

    const factory: EditorFactory = (tui, theme, keybindings) => new CommandAwareEditor(
      tui,
      theme,
      keybindings,
      {
        registry,
        focus,
        requestRender: () => requestRender(true),
      },
    );
    markRunningCommandsEditorFactory(factory);
    editorFactory = factory;
    ctx.ui.setEditorComponent(factory);
  };

  const deliverPendingCompletions = (): void => {
    const ctx = activeContext;
    if (!ctx) return;
    for (const task of manager.pendingCompletions()) {
      try {
        pi.sendMessage({
          customType: "background-command-completion",
          content: formatBackgroundCompletionSummary(task),
          display: false,
          details: {
            taskId: task.id,
            title: task.title,
            state: task.state,
            exitCode: task.exitCode,
            exitReason: task.exitReason,
            outputFile: task.outputFile,
          },
        }, { triggerTurn: true, deliverAs: "followUp" });
        manager.markCompletionDelivered(task.id);
        try {
          const notice = completionNotification(task);
          ctx.ui.notify(notice.message, notice.level);
        } catch {
          // A stale UI context must not duplicate an already queued follow-up summary.
        }
      } catch {
        // sendMessage failed before enqueueing; leave the completion pending for one retry.
      }
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    cleanupUiBindings();
    activeContext = ctx;
    backgroundCommandsEnabled = readBackgroundCommandsSettings(
      ctx.cwd,
      ctx.isProjectTrusted(),
    ).enabled;
    manager.cancelReloadCleanup();
    if (backgroundCommandsEnabled) {
      if (manager.consumeToolsDisabledByConfig()) {
        const activeTools = pi.getActiveTools();
        const restoredTools = [
          ...activeTools,
          ...BACKGROUND_COMMAND_TOOL_NAMES.filter((name) => !activeTools.includes(name)),
        ];
        pi.setActiveTools(restoredTools);
      }
      await manager.bindSession(sessionId(ctx));
      unsubscribeManager = manager.subscribe((event) => {
        focus.reconcile(registry.snapshot());
        updateElapsedTimer();
        // Background output events are already throttled by the process manager.
        requestRender(true);
        if (event.type === "finished") deliverPendingCompletions();
      });
      deliverPendingCompletions();
    } else {
      await manager.shutdown("session_shutdown");
      manager.markToolsDisabledByConfig();
      const disabled = new Set<string>(BACKGROUND_COMMAND_TOOL_NAMES);
      const activeTools = pi.getActiveTools();
      const remainingTools = activeTools.filter((name) => !disabled.has(name));
      if (remainingTools.length !== activeTools.length) pi.setActiveTools(remainingTools);
    }

    if (isDashboard) {
      dashboardBridgeCleanup?.();
      dashboardAdapter?.dispose();
      dashboardAdapter = new BackgroundCommandsDashboardAdapter(manager);
      dashboardBridgeCleanup = registerDashboardFeatureBridge(ctx, dashboardAdapter);
    }

    if (isDashboard || !ctx.hasUI) return;
    host = getPrePowerlineHost();
    if (!host) {
      ctx.ui.notify(
        "Running commands disabled: pi-zero pre-powerline v1 is unavailable. Bash and background Tool execution are unchanged.",
        "warning",
      );
      return;
    }

    unregisterComponent = host.register(
      COMPONENT_KEY,
      (tui, theme) => new RunningCommandsWidget(tui, theme, {
        registry,
        focus,
        getEditorText: () => {
          try {
            return activeContext?.ui.getEditorText() ?? "";
          } catch {
            return "";
          }
        },
      }),
    );
    installEditor(ctx);
    updateElapsedTimer();
    requestRender(true);
  });

  pi.on("tool_execution_start", (event) => {
    if (event.toolName !== "bash") return;
    registry.start(event.toolCallId, event.args);
    focus.reconcile(registry.snapshot());
    updateElapsedTimer();
    requestRender(true);
  });

  pi.on("tool_execution_update", (event) => {
    if (event.toolName !== "bash") return;
    if (registry.update(event.toolCallId, event.partialResult)) requestRender();
  });

  pi.on("tool_execution_end", (event) => {
    if (event.toolName !== "bash") return;
    if (!registry.end(event.toolCallId)) return;
    focus.reconcile(registry.snapshot());
    updateElapsedTimer();
    requestRender(true);
  });

  pi.on("session_shutdown", async (event) => {
    cleanupUiBindings();
    dashboardBridgeCleanup?.();
    dashboardBridgeCleanup = undefined;
    dashboardAdapter?.dispose();
    dashboardAdapter = undefined;
    if (event.reason === "reload" && backgroundCommandsEnabled) {
      manager.scheduleReloadCleanup();
      return;
    }
    await manager.shutdown("session_shutdown");
  });
}
