import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { BtwPanel } from "./btw/panel.ts";
import { BtwSessionController } from "./btw/session.ts";
import { BtwDashboardAdapter } from "./btw/bridge.ts";
import { registerDashboardFeatureBridge } from "./lib/dashboard-bridge.ts";

type ActiveBtw = {
  cancelled: boolean;
  startupAbort: AbortController;
  controller?: BtwSessionController;
  close?: () => void;
};

export default function btwExtension(pi: ExtensionAPI): void {
  let activeBtw: ActiveBtw | undefined;
  let dashboardAdapter: BtwDashboardAdapter | undefined;
  let dashboardBridgeCleanup: (() => void) | undefined;

  pi.on("session_start", async (_event, ctx) => {
    if (process.env.PI_RUNTIME !== "dashboard" || process.env.PI_SUBAGENT_WORKBENCH_CHILD === "1") return;
    dashboardBridgeCleanup?.();
    await dashboardAdapter?.dispose();
    dashboardAdapter = new BtwDashboardAdapter(ctx);
    dashboardBridgeCleanup = registerDashboardFeatureBridge(ctx, dashboardAdapter);
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

      try {
        const controller = await BtwSessionController.create(ctx, state.startupAbort.signal);
        state.controller = controller;
        if (state.cancelled) return;

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
        await state.controller?.dispose();
        if (activeBtw === state) activeBtw = undefined;
      }
    },
  });

  pi.on("session_shutdown", async () => {
    dashboardBridgeCleanup?.();
    dashboardBridgeCleanup = undefined;
    await dashboardAdapter?.dispose();
    dashboardAdapter = undefined;
    const state = activeBtw;
    if (!state) return;
    activeBtw = undefined;
    state.cancelled = true;
    state.startupAbort.abort(new Error("主会话已关闭"));
    state.close?.();
    await state.controller?.dispose();
  });
}
