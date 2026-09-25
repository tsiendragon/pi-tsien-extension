import {
  createBashToolDefinition,
  type BashOperations,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

import type { BackgroundCommandManager } from "./manager.ts";

/**
 * Replaces the built-in `bash` tool so foreground commands are executed by the
 * background command manager. That lets a running command be moved to the
 * background (TUI `Ctrl+B`, dashboard button) instead of blocking the turn.
 */
export function registerForegroundHandoffBashTool(
  pi: ExtensionAPI,
  manager: BackgroundCommandManager,
  cwd: string,
): void {
  const renderingDefinition = createBashToolDefinition(cwd);

  pi.registerTool({
    ...renderingDefinition,
    execute(toolCallId, params, signal, onUpdate, ctx) {
      const sessionId = ctx.sessionManager.getSessionId();
      // Fall back to the plain bash implementation whenever the manager is not
      // bound to this Session (background commands disabled, Session swapped, …).
      if (!manager.canHandoffForeground(sessionId)) {
        return createBashToolDefinition(ctx.cwd).execute(toolCallId, params, signal, onUpdate, ctx);
      }
      const operations: BashOperations = {
        exec(command, commandCwd, options) {
          const startedAt = manager.registry.snapshot()
            .find((entry) => entry.toolCallId === toolCallId)?.startedAt;
          return manager.executeForeground({
            toolCallId,
            command,
            cwd: commandCwd,
            sessionId,
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
