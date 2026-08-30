import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { BtwPanel } from "./btw/panel.ts";
import { BtwSessionController } from "./btw/session.ts";
import { BtwDashboardAdapter } from "./btw/bridge.ts";
import { registerDashboardFeatureBridge } from "./lib/dashboard-bridge.ts";
import { clearLiveFeature, publishLiveFeature, registerLiveFeatureCommandHandler } from "./lib/live-observer.ts";

type ActiveBtw = {
  cancelled: boolean;
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

  pi.on("session_start", async (_event, ctx) => {
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
    description: "打开读取主会话历史、仅可读文件的临时侧聊窗口",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/btw 仅支持 Pi 交互式终端。", "warning");
        return;
      }
      if (!ctx.model) {
        ctx.ui.notify("当前没有可用模型，无法启动 BTW。", "error");
        return;
      }
      if (activeBtw) {
        ctx.ui.notify("BTW 已经打开或正在启动。", "info");
        return;
      }

      const state: ActiveBtw = {
        cancelled: false,
        startupAbort: new AbortController(),
      };
      activeBtw = state;
      publishLiveFeature("btw", { status: "starting", conversation: [], generatedAt: Date.now() });

      try {
        const controller = await BtwSessionController.create(ctx, state.startupAbort.signal);
        state.controller = controller;
        if (state.cancelled) return;
        state.unsubscribe = controller.subscribe(snapshot => publishLiveFeature("btw", snapshot));
        publishLiveFeature("btw", controller.getSnapshot());

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
      } catch (error) {
        if (!state.cancelled) {
          const detail = error instanceof Error ? error.message : String(error);
          ctx.ui.notify(`BTW 启动失败：${detail}`, "error");
        }
      } finally {
        state.close?.();
        state.unsubscribe?.();
        await state.controller?.dispose();
        clearLiveFeature("btw");
        if (activeBtw === state) activeBtw = undefined;
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
    const state = activeBtw;
    if (!state) return;
    activeBtw = undefined;
    state.cancelled = true;
    state.startupAbort.abort(new Error("主会话已关闭"));
    state.close?.();
    state.unsubscribe?.();
    await state.controller?.dispose();
    clearLiveFeature("btw");
  });
}
