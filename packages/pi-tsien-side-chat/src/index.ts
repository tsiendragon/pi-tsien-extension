import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { copyToClipboard } from "@earendil-works/pi-coding-agent";
import { BtwPanel } from "./panel.ts";
import { BtwSessionController } from "./session.ts";
import { BtwDashboardAdapter } from "./bridge.ts";
import { registerDashboardFeatureBridge } from "pi-tsien-shared/src/lib/dashboard-bridge.ts";
import { clearLiveFeature, publishLiveFeature, registerLiveFeatureCommandHandler } from "pi-tsien-shared/src/lib/live-observer.ts";

type ActiveBtw = {
  cancelled: boolean;
  /** Whether a panel (TUI overlay) is currently attached to the side chat. */
  panelOpen: boolean;
  startupAbort: AbortController;
  controller?: BtwSessionController;
  unsubscribe?: () => void;
  close?: () => void;
};

export default function btwExtension(pi: ExtensionAPI): void {
  let activeBtw: ActiveBtw | undefined;
  let dashboardAdapter: BtwDashboardAdapter | undefined;
  let dashboardBridgeCleanup: (() => void) | undefined;
  let liveCommandCleanup: (() => void) | undefined;
  let liveSnapshotCleanup: (() => void) | undefined;

  /**
   * Publish the side chat to the dashboard.
   *
   * A retained (panel-closed) side chat is announced as `closed` while still
   * carrying its conversation: the dashboard then shows the earlier exchanges
   * without pretending the panel is open.
   */
  const publishState = (state: ActiveBtw): void => {
    const controller = state.controller;
    if (!controller || state.cancelled) return;
    const snapshot = controller.getSnapshot();
    publishLiveFeature("btw", state.panelOpen ? snapshot : { ...snapshot, status: "closed" });
  };

  const disposeActiveBtw = async (): Promise<void> => {
    const state = activeBtw;
    if (!state) return;
    activeBtw = undefined;
    state.cancelled = true;
    state.startupAbort.abort(new Error("主会话已结束"));
    state.close?.();
    state.unsubscribe?.();
    await state.controller?.dispose();
    clearLiveFeature("btw");
  };

  /** Attach the TUI overlay to a side chat and, optionally, ask right away. */
  const openPanel = async (state: ActiveBtw, ctx: ExtensionContext, question?: string): Promise<void> => {
    const controller = state.controller;
    if (!controller) return;
    state.panelOpen = true;
    publishState(state);
    if (question && !controller.busy) void controller.submit(question);
    try {
      await ctx.ui.custom<void>(
        (tui, theme, _keybindings, done) => {
          let closed = false;
          const close = () => {
            if (closed) return;
            closed = true;
            done(undefined);
          };
          state.close = close;
          if (state.cancelled) close();

          return new BtwPanel(tui, theme, controller, {
            close,
            copyToMain: (text) => {
              ctx.ui.setEditorText(text);
              ctx.ui.notify("已把 BTW 最后一个回答复制到主输入框。", "info");
            },
            copyAnswer: (text) => {
              void copyToClipboard(text).then(
                () => ctx.ui.notify("已把 BTW 最后一个回答以原始 Markdown 复制到剪贴板。", "info"),
                (error) => ctx.ui.notify(
                  `复制到剪贴板失败：${error instanceof Error ? error.message : String(error)}`,
                  "error",
                ),
              );
            },
            notify: (message, level) => ctx.ui.notify(message, level),
          });
        },
        {
          overlay: true,
          overlayOptions: {
            anchor: "right-center",
            width: "70%",
            minWidth: 52,
            maxHeight: "88%",
            margin: 1,
          },
        },
      );
    } finally {
      state.close = undefined;
      state.panelOpen = false;
      publishState(state);
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    // A (re)start means a new parent session: a retained side chat is bound to
    // the previous context and would answer from a dead snapshot, so drop it.
    await disposeActiveBtw();
    if (process.env.PI_SUBAGENT_WORKBENCH_CHILD === "1") return;
    dashboardBridgeCleanup?.();
    liveCommandCleanup?.();
    liveSnapshotCleanup?.();
    await dashboardAdapter?.dispose();
    dashboardAdapter = new BtwDashboardAdapter(ctx);
    if (process.env.PI_RUNTIME === "dashboard") {
      dashboardBridgeCleanup = registerDashboardFeatureBridge(ctx, dashboardAdapter);
    } else if (ctx.mode === "tui" || ctx.mode === "rpc") {
      publishLiveFeature("btw", dashboardAdapter.getSnapshot());
      liveSnapshotCleanup = dashboardAdapter.subscribe(snapshot => publishLiveFeature("btw", snapshot));
      liveCommandCleanup = registerLiveFeatureCommandHandler("btw", command => dashboardAdapter!.dispatch(command));
    }
  });

  pi.registerCommand("btw", {
    description: "打开读取主会话历史、仅可读文件的临时侧聊窗口；可直接跟一个问题（/btw 问题）",
    handler: async (args, ctx) => {
      const question = args.trim();
      const state = activeBtw;

      // A closed panel keeps its side chat, so `/btw` brings the earlier
      // exchanges back instead of starting from scratch (Claude Code's `/btw`
      // reopens on the most recent exchange the same way).
      if (state?.controller && !state.controller.isDisposed) {
        if (ctx.mode !== "tui") {
          if (question && dashboardAdapter) await dashboardAdapter.dispatch({ type: "submit", text: question });
          else ctx.ui.notify("BTW 已经打开：请在 dashboard 的 BTW 面板里继续提问。", "info");
          return;
        }
        if (state.panelOpen) {
          if (!question) {
            ctx.ui.notify("BTW 已经打开。", "info");
            return;
          }
          if (state.controller.busy) {
            ctx.ui.notify("BTW 正在生成；按 Esc 可取消当前回答。", "warning");
            return;
          }
          void state.controller.submit(question);
          return;
        }
        await openPanel(state, ctx, question || undefined);
        return;
      }

      if (ctx.mode !== "tui") {
        // dashboard / rpc: the panel lives in the browser, so ask via the bridge.
        if (question && dashboardAdapter) {
          await dashboardAdapter.dispatch({ type: "submit", text: question });
          return;
        }
        ctx.ui.notify("/btw 仅支持 Pi 交互式终端；在 dashboard 里请用 BTW 面板提问。", "warning");
        return;
      }
      if (!ctx.model) {
        ctx.ui.notify("当前没有可用模型，无法启动 BTW。", "error");
        return;
      }
      if (state) {
        ctx.ui.notify("BTW 正在启动。", "info");
        return;
      }

      const created: ActiveBtw = {
        cancelled: false,
        panelOpen: false,
        startupAbort: new AbortController(),
      };
      activeBtw = created;
      publishLiveFeature("btw", { status: "starting", conversation: [], generatedAt: Date.now() });

      try {
        const controller = await BtwSessionController.create(ctx, created.startupAbort.signal);
        created.controller = controller;
        if (created.cancelled) {
          await controller.dispose();
          return;
        }
        created.unsubscribe = controller.subscribe(() => publishState(created));
        await openPanel(created, ctx, question || undefined);
      } catch (error) {
        if (activeBtw === created) activeBtw = undefined;
        created.unsubscribe?.();
        await created.controller?.dispose();
        clearLiveFeature("btw");
        if (!created.cancelled) {
          const detail = error instanceof Error ? error.message : String(error);
          ctx.ui.notify(`BTW 启动失败：${detail}`, "error");
        }
      }
    },
  });

  pi.on("session_shutdown", async () => {
    dashboardBridgeCleanup?.();
    dashboardBridgeCleanup = undefined;
    liveCommandCleanup?.();
    liveCommandCleanup = undefined;
    liveSnapshotCleanup?.();
    liveSnapshotCleanup = undefined;
    await dashboardAdapter?.dispose();
    dashboardAdapter = undefined;
    await disposeActiveBtw();
  });
}