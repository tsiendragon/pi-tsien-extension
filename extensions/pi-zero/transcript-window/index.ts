import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { TranscriptWindowController } from "./controller.ts";
import { installInteractiveTranscriptPatch } from "./interactive-patch.ts";

/** Register pi-zero's process-local transcript window. */
export function installTranscriptWindow(pi: ExtensionAPI): void {
  const controller = new TranscriptWindowController();
  const restorePatch = installInteractiveTranscriptPatch(controller);

  pi.registerCommand("transcript", {
    description:
      "Control transcript history window: status, expand, collapse, or turns <n>",
    handler: async (args: string | undefined, ctx: ExtensionCommandContext) => {
      await controller.handleCommand(args, ctx);
    },
  });

  pi.on("session_start", async (_event: unknown, ctx: ExtensionContext) => {
    controller.onSessionStart(ctx.cwd);
  });

  pi.on("agent_settled", async (_event: unknown, ctx: ExtensionContext) => {
    controller.onAgentSettled(ctx.sessionManager.buildContextEntries());
  });

  pi.on("session_shutdown", async () => {
    restorePatch();
  });
}
