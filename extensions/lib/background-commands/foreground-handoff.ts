import {
  createBashToolDefinition,
  type BashOperations,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

import type { BackgroundCommandManager } from "./manager.ts";

export function registerForegroundHandoffBashTool(
  pi: ExtensionAPI,
  manager: BackgroundCommandManager,
  cwd: string,
): void {
  const renderingDefinition = createBashToolDefinition(cwd);

  pi.registerTool({
    ...renderingDefinition,
    execute(toolCallId, params, signal, onUpdate, ctx) {
      const operations: BashOperations = {
        exec(command, commandCwd, options) {
          const startedAt = manager.registry.snapshot()
            .find((entry) => entry.toolCallId === toolCallId)?.startedAt;
          return manager.executeForeground({
            toolCallId,
            command,
            cwd: commandCwd,
            sessionId: ctx.sessionManager.getSessionId(),
            startedAt,
            timeoutSeconds: options.timeout,
            env: options.env,
            signal: options.signal,
            onData: options.onData,
          });
        },
      };
      const executionDefinition = createBashToolDefinition(ctx.cwd, { operations });
      return executionDefinition.execute(toolCallId, params, signal, onUpdate, ctx);
    },
  });
}
