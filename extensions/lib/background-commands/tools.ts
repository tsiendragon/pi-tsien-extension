import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import {
  MAX_BACKGROUND_TITLE_LENGTH,
} from "../command-ui/command-registry.ts";
import { formatElapsedDuration } from "../command-ui/running-commands-widget.ts";
import {
  DEFAULT_BACKGROUND_TAIL_LINES,
  MAX_BACKGROUND_TAIL_LINES,
  type BackgroundCommandManager,
} from "./manager.ts";
import type { BackgroundTaskSnapshot } from "./types.ts";

export const BACKGROUND_COMMAND_TOOL_NAMES = [
  "background_command_start",
  "background_command_status",
  "background_command_output",
  "background_command_cancel",
] as const;

function safeNotify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error"): void {
  try {
    ctx.ui.notify(message, level);
  } catch {
    // UI lifecycle errors must not change Tool or process ownership semantics.
  }
}

function jsonResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    details: value,
  };
}

function currentSessionId(ctx: ExtensionContext): string {
  return ctx.sessionManager.getSessionId();
}

function assertCurrentSession(manager: BackgroundCommandManager, ctx: ExtensionContext): void {
  if (manager.currentSessionId !== currentSessionId(ctx)) {
    throw new Error("Background task access is limited to the current Session");
  }
}

function publicTask(task: BackgroundTaskSnapshot) {
  return {
    taskId: task.id,
    owner: task.owner,
    mode: task.mode,
    title: task.title,
    status: task.state,
    command: task.command,
    cwd: task.cwd,
    pid: task.pid,
    startedAt: task.startedAt,
    endedAt: task.endedAt,
    exitCode: task.exitCode,
    exitSignal: task.exitSignal,
    exitReason: task.exitReason,
    timeoutMs: task.timeoutMs,
    outputBytes: task.outputBytes,
    outputFile: task.outputFile,
    error: task.error,
    experimentalPlatform: task.experimentalPlatform,
  };
}

export function sanitizeBackgroundToolOutput(value: string): string {
  return stripTerminalSequences(value)
    .replace(/\r\n?/gu, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "");
}

export function formatBackgroundCompletionSummary(task: BackgroundTaskSnapshot): string {
  const duration = formatElapsedDuration((task.endedAt ?? Date.now()) - task.startedAt);
  const exit = task.exitReason === "timeout"
    ? "timed out"
    : task.exitReason === "output_limit"
      ? "output limit reached"
      : task.state === "cancelled"
        ? "cancelled"
        : `exit=${task.exitCode ?? task.exitSignal ?? "unknown"}`;
  return `Background task ${task.id} [${task.title}] finished: ${exit} after ${duration}. Read its output with background_command_output and continue the task.`;
}

export function registerBackgroundCommandTools(
  pi: ExtensionAPI,
  manager: BackgroundCommandManager,
  isEnabled: () => boolean = () => true,
): void {
  const assertEnabled = () => {
    if (!isEnabled()) {
      throw new Error("Background commands are disabled by backgroundCommands.enabled");
    }
  };
  pi.registerTool({
    name: "background_command_start",
    label: "Start background command",
    description: "Start a user-requested Bash command in the background and return its task ID. Use ordinary bash otherwise.",
    promptSnippet: "Start a requested Bash command in the background.",
    promptGuidelines: [
      "Set a timeout for tests and builds; omit it only for long-lived servers.",
      "Use the returned task ID with the background status, output, or cancel tools; do not manage its PID directly.",
    ],
    parameters: Type.Object({
      command: Type.String({ minLength: 1, description: "Bash command to execute in the current Agent working directory" }),
      title: Type.Optional(Type.String({ maxLength: MAX_BACKGROUND_TITLE_LENGTH, description: "Optional short human-readable label shown in the task UI" })),
      timeout: Type.Optional(Type.Number({ exclusiveMinimum: 0, description: "Timeout in seconds; omitted means no timeout" })),
    }, { additionalProperties: false }),
    executionMode: "parallel",
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      let task: BackgroundTaskSnapshot;
      try {
        assertEnabled();
        assertCurrentSession(manager, ctx);
        task = await manager.start({
          command: params.command,
          title: params.title,
          cwd: ctx.cwd,
          sessionId: currentSessionId(ctx),
          sessionFile: ctx.sessionManager.getSessionFile(),
          provider: ctx.model?.provider,
          model: ctx.model?.id,
          thinkingLevel: ctx.thinkingLevel,
          timeoutSeconds: params.timeout,
          launchSignal: signal,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        safeNotify(ctx, `Cannot start background command: ${message}`, "error");
        throw error;
      }
      if (manager.claimSharedWorkdirNotice()) {
        safeNotify(
          ctx,
          "后台任务与主 Agent 共享当前工作目录；两者同时修改同一文件可能产生冲突。",
          "warning",
        );
      }
      return jsonResult({
        taskId: task.id,
        owner: task.owner,
        mode: task.mode,
        title: task.title,
        status: task.state,
        outputFile: task.outputFile,
        pid: task.pid,
        experimentalPlatform: task.experimentalPlatform,
      });
    },
  });

  pi.registerTool({
    name: "background_command_status",
    label: "Background command status",
    description: "Return the current state and metadata of one background task from the current Session.",
    promptSnippet: "Inspect one current-Session background command by task ID",
    parameters: Type.Object({
      taskId: Type.String({ pattern: "^bash-[a-z0-9]{4,16}$", description: "Background task ID returned by background_command_start" }),
    }, { additionalProperties: false }),
    executionMode: "parallel",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      assertEnabled();
      assertCurrentSession(manager, ctx);
      return jsonResult(publicTask(manager.get(params.taskId)));
    },
  });

  pi.registerTool({
    name: "background_command_output",
    label: "Background command output",
    description: "Read a bounded in-memory output tail for one background task from the current Session. Use the Read Tool on outputFile only when more complete output is necessary.",
    promptSnippet: "Read a bounded output tail from one current-Session background command",
    parameters: Type.Object({
      taskId: Type.String({ pattern: "^bash-[a-z0-9]{4,16}$", description: "Background task ID returned by background_command_start" }),
      tailLines: Type.Optional(Type.Integer({
        minimum: 1,
        maximum: MAX_BACKGROUND_TAIL_LINES,
        description: `Number of trailing lines to return; defaults to ${DEFAULT_BACKGROUND_TAIL_LINES}`,
      })),
    }, { additionalProperties: false }),
    executionMode: "parallel",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      assertEnabled();
      assertCurrentSession(manager, ctx);
      const output = manager.output(params.taskId, params.tailLines ?? DEFAULT_BACKGROUND_TAIL_LINES);
      return jsonResult({
        taskId: output.taskId,
        title: output.title,
        command: output.command,
        status: output.state,
        output: sanitizeBackgroundToolOutput(output.output),
        tailLines: output.tailLines,
        outputBytes: output.outputBytes,
        outputFile: output.outputFile,
        truncated: output.truncated,
      });
    },
  });

  pi.registerTool({
    name: "background_command_cancel",
    label: "Cancel background command",
    description: "Cancel one current-Session background task and wait for its process group to exit. Completed tasks are returned unchanged.",
    promptSnippet: "Cancel one current-Session background command and its process group",
    parameters: Type.Object({
      taskId: Type.String({ pattern: "^bash-[a-z0-9]{4,16}$", description: "Background task ID returned by background_command_start" }),
    }, { additionalProperties: false }),
    executionMode: "parallel",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      assertEnabled();
      assertCurrentSession(manager, ctx);
      return jsonResult(publicTask(await manager.cancel(params.taskId)));
    },
  });
}
