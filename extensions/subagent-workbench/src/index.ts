import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
} from "@earendil-works/pi-tui";
import { registerChildMultiTool } from "./multi-tool.ts";
import {
  WORKBENCH_RUNTIME_SYMBOL,
  createWorkbenchRuntimeHost,
  installWorkbenchRuntime,
  type SubagentWorkbenchRuntime as WorkbenchRuntime,
} from "./runtime.ts";
import {
  openConversationWorkbench,
  type ConversationWorkbenchHandle,
} from "./conversation-workbench.ts";
import {
  WorkbenchController,
  type WorkbenchJobQuery,
  type WorkbenchRunWarning,
  type WorkbenchWorkflowPreflight,
  type WorkbenchWorkflowRequest,
  type WorkbenchWorkflowResult,
} from "./workbench-controller.ts";
import type { WorkbenchJobSnapshot } from "./job-registry.ts";
import {
  installTaskNavigation,
  type TaskNavigationHandle,
  type TaskNavigationTarget,
} from "./task-navigation.ts";
import { registerWorkbenchDashboardBridge } from "./dashboard-bridge.ts";
import { clearLiveFeature, publishLiveFeature } from "../../lib/live-observer.ts";
import {
  SAVED_WORKFLOW_VERSION,
  loadWorkflowDefinition,
  saveWorkflowDefinition,
  type SavedWorkflowDefinition,
} from "./workflow-store.ts";
import {
  loadWorkflowRun,
  saveWorkflowRun,
  workflowRunPath,
} from "./workflow-run-store.ts";
import { compileWorkflowJavaScript } from "./workflow-javascript.ts";
import type { SubagentTraceContext } from "./subagent-service.ts";
import { parseTraceContext } from "../../trajectory-recorder.ts";
const WORKBENCH_API_VERSION = 1 as const;
const VIEW_ROWS = 18;
const TOOL_OUTPUT_CHARS = 64 * 1024;
const RESULT_WAIT_MAX_MS = 30_000;

type WorkbenchRuntimeSnapshot = ReturnType<WorkbenchRuntime["getSnapshot"]>;

type LiveConversationSummary = WorkbenchRuntimeSnapshot["conversations"]["items"][number];

function projectLiveConversationSummary(
  conversation: LiveConversationSummary,
): Omit<LiveConversationSummary, "messages" | "timeline"> {
  const {
    id,
    label,
    status,
    updatedAt,
    availability,
    activeRunId,
    latestRunStatus,
    provider,
    model,
    thinkingLevel,
    usage,
    transcriptTruncated,
    error,
    workflowId,
    needsAttention,
    lastHeartbeatAt,
    stalled,
  } = conversation;
  return {
    id,
    label,
    status,
    updatedAt,
    availability,
    activeRunId,
    latestRunStatus,
    provider,
    model,
    thinkingLevel,
    usage,
    transcriptTruncated,
    error,
    workflowId,
    needsAttention,
    lastHeartbeatAt,
    stalled,
  };
}

/**
 * Live-session feature cards only need workbench status. Full transcripts are
 * served by the Dashboard Extension Bridge and must not be broadcast on every
 * heartbeat through the bounded live-session event channel.
 */
export function projectLiveFeatureSnapshot(
  snapshot: WorkbenchRuntimeSnapshot,
  generatedAt = Date.now(),
) {
  return {
    revision: snapshot.revision,
    generatedAt,
    conversations: {
      total: snapshot.conversations.total,
      running: snapshot.conversations.running,
      needsAttention: snapshot.conversations.needsAttention,
      completed: snapshot.conversations.completed,
      items: snapshot.conversations.items.map(projectLiveConversationSummary),
    },
    workflows: snapshot.workflows,
    runHealth: snapshot.runHealth,
  };
}

const ThinkingLevelParam = Type.Union([
  Type.Literal("off"),
  Type.Literal("minimal"),
  Type.Literal("low"),
  Type.Literal("medium"),
  Type.Literal("high"),
  Type.Literal("xhigh"),
  Type.Literal("max"),
]);

const AgentToolParams = Type.Object({
  task: Type.String({
    minLength: 1,
    description: "A bounded task for the subagent to complete.",
  }),
  label: Type.Optional(
    Type.String({ description: "Short label shown in the Workbench." }),
  ),
  cwd: Type.Optional(
    Type.String({
      description: "Working directory. Defaults to the main Agent cwd.",
    }),
  ),
  model: Type.Optional(
    Type.String({
      pattern: "^[^/\\s]+/\\S+$",
      description:
        "Optional exact provider/model override. Short or fuzzy model names are rejected.",
    }),
  ),
  thinking: Type.Optional(ThinkingLevelParam),
  context: Type.Optional(
    Type.String({
      description:
        "Optional explicit context in addition to project context files.",
    }),
  ),
  background: Type.Optional(
    Type.Boolean({
      description:
        "Return immediately while the subagent continues in the Workbench. Defaults to true; set false only when this turn must wait for the result.",
    }),
  ),
});

const WorkbenchResultsParams = Type.Object({
  workIds: Type.Optional(Type.Array(Type.String(), { minItems: 1, maxItems: 8 })),
  mode: Type.Optional(
    Type.Union([Type.Literal("status"), Type.Literal("collect"), Type.Literal("wait")]),
  ),
  waitFor: Type.Optional(Type.Union([Type.Literal("any"), Type.Literal("all")])),
  timeoutMs: Type.Optional(Type.Number({ minimum: 1, maximum: RESULT_WAIT_MAX_MS })),
  includeOutput: Type.Optional(Type.Boolean()),
});

const WorkbenchCancelParams = Type.Object({
  workIds: Type.Array(Type.String(), { minItems: 1, maxItems: 8 }),
  reason: Type.Optional(Type.String()),
});

const WorkflowControlParams = Type.Object({
  workId: Type.String({ minLength: 1 }),
  action: Type.Union([
    Type.Literal("pause"),
    Type.Literal("resume"),
    Type.Literal("retry"),
    Type.Literal("retry_task"),
  ]),
  taskKey: Type.Optional(
    Type.String({
      pattern: "^[A-Za-z][A-Za-z0-9_-]{0,63}$",
      description:
        "Required with retry_task: retry only this failed workflow task and reuse its siblings.",
    }),
  ),
});

const WorkflowTaskParams = Type.Object({
  task: Type.String({ minLength: 1 }),
  key: Type.Optional(
    Type.String({
      pattern: "^[A-Za-z][A-Za-z0-9_-]{0,63}$",
      description:
        "Stable workflow-local key. Later stages can list this key in inputs to receive the task output.",
    }),
  ),
  inputs: Type.Optional(
    Type.Array(Type.String(), {
      maxItems: 8,
      description:
        "Task keys from earlier stages whose outputs are appended to this task's explicit context.",
    }),
  ),
  label: Type.Optional(Type.String()),
  cwd: Type.Optional(Type.String()),
  model: Type.Optional(
    Type.String({
      pattern: "^[^/\\s]+/\\S+$",
      description:
        "Optional exact provider/model override. Short or fuzzy model names are rejected.",
    }),
  ),
  thinking: Type.Optional(ThinkingLevelParam),
  context: Type.Optional(Type.String()),
  outputSchema: Type.Optional(
    Type.Record(Type.String(), Type.Unknown(), {
      description:
        "Optional JSON Schema. Each complete task output must be valid JSON matching this schema.",
    }),
  ),
  when: Type.Optional(
    Type.Union([Type.Boolean(), Type.String()], {
      description:
        "Bounded condition: boolean, one template reference, or ==/!= against a JSON primitive.",
    }),
  ),
  foreach: Type.Optional(
    Type.String({
      minLength: 1,
      description:
        "Template reference resolving to a JSON array. Each item runs one child task with {{item}} and {{index}} available.",
    }),
  ),
  maxItems: Type.Optional(
    Type.Number({
      minimum: 0,
      maximum: 8,
      description: "Hard foreach expansion bound; defaults to eight.",
    }),
  ),
});

const WorkflowStageParams = Type.Object({
  label: Type.Optional(Type.String()),
  tasks: Type.Array(WorkflowTaskParams, { minItems: 1, maxItems: 8 }),
});

const WorkflowToolParams = Type.Object({
  /** Automatically wrapped as one stage with one task. */
  task: Type.Optional(
    Type.String({
      minLength: 1,
      description:
        "One task to run as a recoverable single-stage workflow. Use this for user-requested workflows or when tracking/retry value justifies it.",
    }),
  ),
  label: Type.Optional(Type.String()),
  parameters: Type.Optional(
    Type.Record(Type.String(), Type.Unknown(), {
      description:
        "JSON values available to reusable Workflow templates through parameters.<name>.",
    }),
  ),
  name: Type.Optional(
    Type.String({
      pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$",
      description:
        "Run a reusable project workflow from .pi/workflows/<name>.json. Do not combine with stages.",
    }),
  ),
  saveAs: Type.Optional(
    Type.String({
      pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$",
      description:
        "Explicitly save this definition to .pi/workflows/<saveAs>.json before running it.",
    }),
  ),
  stages: Type.Optional(
    Type.Array(WorkflowStageParams, { minItems: 1, maxItems: 8 }),
  ),
  javascript: Type.Optional(
    Type.String({
      minLength: 1,
      maxLength: 16 * 1024,
      description:
        "Explicit opt-in, synchronous JavaScript builder. It may only use workflow.stage(label).task(task) and parameters; no I/O, imports, async code, or agent execution. The compiled stages are persisted for retry.",
    }),
  ),
  background: Type.Optional(
    Type.Boolean({
      description:
        "Return immediately while the workflow continues in the Workbench. Defaults to true; set false only when this turn must wait for the result.",
    }),
  ),
  dryRun: Type.Optional(
    Type.Boolean({
      description:
        "Validate and preview the Workflow without saving it, creating a Job, or starting child processes.",
    }),
  ),
  record: Type.Optional(
    Type.Union([Type.Literal("metadata"), Type.Literal("full")], {
      description:
        "Explicitly persist a terminal run under .pi/workflow-runs. metadata omits prompts/outputs; full enables cross-session retry and may contain sensitive data.",
    }),
  ),
});

type ProtectionState = "normal" | "throttled" | "rejecting" | "shedding";

interface GovernorSnapshot {
  active: number;
  queued: number;
  activeLimit: number;
  queueLimit: number;
  processActive?: number;
  processLimit?: number;
  withContextActive?: number;
  withContextLimit?: number;
  protection?: ProtectionState;
  memoryRatio?: number;
  memorySource?: string;
  sampledAt?: number;
  lastResourceExhausted?: string;
  longestQueueWaitMs?: number;
}

interface RunHealthSnapshot {
  running: number;
  stalled: number;
  lastHeartbeatAt?: number;
}

interface WorkbenchSnapshot {
  apiVersion: typeof WORKBENCH_API_VERSION;
  revision: number;
  generatedAt: number;
  governor: GovernorSnapshot;
  runHealth?: RunHealthSnapshot;
  conversations?: {
    total: number;
    running: number;
    needsAttention: number;
    completed: number;
    items?: readonly {
      readonly id: string;
      readonly label: string;
      readonly status: string;
    }[];
  };
  workflows?: {
    total: number;
    active: number;
    failed: number;
    items?: readonly {
      readonly id: string;
      readonly label: string;
      readonly status: string;
    }[];
  };
}

interface WorkbenchCommand {
  type: "refresh";
}

interface WorkbenchCommandResult {
  ok: boolean;
  error?: string;
}

interface SubagentWorkbenchRuntime {
  readonly apiVersion: typeof WORKBENCH_API_VERSION;
  getSnapshot(): WorkbenchSnapshot;
  subscribe(listener: (snapshot: WorkbenchSnapshot) => void): () => void;
  dispatch(command: WorkbenchCommand): Promise<WorkbenchCommandResult>;
}

let activeWorkbench: ConversationWorkbenchHandle | undefined;

function runtimeCandidate(): unknown {
  return (globalThis as Record<PropertyKey, unknown>)[WORKBENCH_RUNTIME_SYMBOL];
}

function isRuntime(value: unknown): value is SubagentWorkbenchRuntime {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<SubagentWorkbenchRuntime>;
  return (
    candidate.apiVersion === WORKBENCH_API_VERSION &&
    typeof candidate.getSnapshot === "function" &&
    typeof candidate.subscribe === "function" &&
    typeof candidate.dispatch === "function"
  );
}

function resolveRuntime(): SubagentWorkbenchRuntime | undefined {
  const candidate = runtimeCandidate();
  return isRuntime(candidate) ? candidate : undefined;
}

function formatAge(timestamp: number | undefined): string {
  if (!timestamp) return "unknown";
  const elapsed = Math.max(0, Date.now() - timestamp);
  if (elapsed < 1_000) return "now";
  if (elapsed < 60_000) return `${Math.floor(elapsed / 1_000)}s ago`;
  return `${Math.floor(elapsed / 60_000)}m ago`;
}

function formatDuration(milliseconds: number | undefined): string {
  if (!milliseconds || milliseconds <= 0) return "0s";
  if (milliseconds < 60_000) return `${Math.ceil(milliseconds / 1_000)}s`;
  return `${Math.ceil(milliseconds / 60_000)}m`;
}

function formatPercent(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "unknown";
  return `${Math.round(value * 100)}%`;
}

class WorkbenchStatusComponent implements Component {
  private runtime: SubagentWorkbenchRuntime | undefined;
  private snapshot: WorkbenchSnapshot | undefined;
  private unsubscribe: (() => void) | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private showHelp = false;
  private renderError: string | undefined;
  private disposed = false;

  constructor(
    private readonly theme: Theme,
    private readonly requestRender: () => void,
    private readonly done: () => void,
  ) {
    this.bindRuntime();
    this.timer = setInterval(() => this.refresh(), 1_000);
    this.timer.unref?.();
  }

  handleInput(input: string): void {
    if (matchesKey(input, "escape") || input.toLowerCase() === "q") {
      this.done();
      return;
    }
    if (input === "?") {
      this.showHelp = !this.showHelp;
      this.requestRender();
      return;
    }
    if (input.toLowerCase() === "r") {
      void this.requestRefresh();
    }
  }

  render(width: number): string[] {
    try {
      this.renderError = undefined;
      return this.renderSafe(width);
    } catch (error) {
      this.renderError = error instanceof Error ? error.message : String(error);
      return this.renderDegraded(width);
    }
  }

  invalidate(): void {}

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  private bindRuntime(): void {
    const next = resolveRuntime();
    if (next === this.runtime) return;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.runtime = next;
    this.snapshot = undefined;
    if (!next) return;
    try {
      this.snapshot = next.getSnapshot();
      this.unsubscribe = next.subscribe((snapshot) => {
        if (this.disposed) return;
        this.snapshot = snapshot;
        this.requestRender();
      });
    } catch (error) {
      this.renderError = error instanceof Error ? error.message : String(error);
    }
  }

  private refresh(): void {
    if (this.disposed) return;
    this.bindRuntime();
    if (this.runtime) {
      try {
        this.snapshot = this.runtime.getSnapshot();
      } catch (error) {
        this.renderError =
          error instanceof Error ? error.message : String(error);
      }
    }
    this.requestRender();
  }

  private async requestRefresh(): Promise<void> {
    this.bindRuntime();
    if (!this.runtime) {
      this.requestRender();
      return;
    }
    try {
      const result = await this.runtime.dispatch({ type: "refresh" });
      if (!result.ok)
        this.renderError = result.error ?? "Runtime refresh failed.";
      this.snapshot = this.runtime.getSnapshot();
    } catch (error) {
      this.renderError = error instanceof Error ? error.message : String(error);
    }
    this.requestRender();
  }

  private renderSafe(width: number): string[] {
    if (width <= 0) return [];
    if (width < 3) return [truncateToWidth("W", width)];
    const panelWidth = Math.min(width, 100);
    const innerWidth = panelWidth - 2;
    const frame = (content: string): string => {
      const clipped = truncateToWidth(content, innerWidth, "…");
      return (
        this.theme.fg("border", "│") +
        clipped +
        " ".repeat(Math.max(0, innerWidth - visibleWidth(clipped))) +
        this.theme.fg("border", "│")
      );
    };
    const border = (left: string, fill: string, right: string): string =>
      this.theme.fg("border", `${left}${fill.repeat(innerWidth)}${right}`);

    if (this.showHelp) {
      return [
        border("╭", "─", "╮"),
        frame(
          ` ${this.theme.fg("accent", this.theme.bold("Subagent Workbench Help"))}`,
        ),
        frame(""),
        frame(" r   refresh runtime snapshot"),
        frame(" ?   close this help"),
        frame(" Esc/q   return to Main"),
        frame(""),
        frame(
          this.theme.fg(
            "dim",
            " This M0 view is read-only; agent controls arrive in later milestones.",
          ),
        ),
        border("╰", "─", "╯"),
      ];
    }

    if (!this.runtime || !this.snapshot) {
      return [
        border("╭", "─", "╮"),
        frame(
          ` ${this.theme.fg("warning", this.theme.bold("Subagent Workbench unavailable"))}`,
        ),
        frame(""),
        frame(" pi-subagent-workbench Runtime API v1 was not found."),
        frame(
          " Running agents are not cancelled; reload after installing the matching runtime.",
        ),
        frame(""),
        frame(
          this.theme.fg("dim", " r refresh · ? help · Esc/q return to Main"),
        ),
        border("╰", "─", "╯"),
      ];
    }

    const snapshot = this.snapshot;
    const governor = snapshot.governor;
    const protection = governor.protection ?? "normal";
    const protectionColor =
      protection === "normal"
        ? "success"
        : protection === "throttled"
          ? "warning"
          : "error";
    const conversations = snapshot.conversations;
    const workflows = snapshot.workflows;
    const health = snapshot.runHealth;
    const rows = [
      border("╭", "─", "╮"),
      frame(
        ` ${this.theme.fg("accent", this.theme.bold("Subagent Workbench · Status"))}` +
          this.theme.fg("dim", ` · revision ${snapshot.revision}`),
      ),
      frame(
        ` Governor  active ${governor.active}/${governor.activeLimit}` +
          ` · queued ${governor.queued}/${governor.queueLimit}`,
      ),
      frame(
        ` Protection ${this.theme.fg(protectionColor, protection)}` +
          ` · memory ${formatPercent(governor.memoryRatio)}` +
          ` · source ${governor.memorySource ?? "unknown"}`,
      ),
      frame(
        ` Process   ${governor.processActive ?? 0}/${governor.processLimit ?? "?"}` +
          ` · with-context ${governor.withContextActive ?? 0}/${governor.withContextLimit ?? "?"}`,
      ),
      frame(
        ` Health    running ${health?.running ?? 0}` +
          ` · stalled ${health?.stalled ?? 0}` +
          ` · heartbeat ${formatAge(health?.lastHeartbeatAt)}`,
      ),
      frame(
        ` Agents    total ${conversations?.total ?? 0}` +
          ` · running ${conversations?.running ?? 0}` +
          ` · attention ${conversations?.needsAttention ?? 0}` +
          ` · completed ${conversations?.completed ?? 0}`,
      ),
      frame(
        ` Workflows total ${workflows?.total ?? 0}` +
          ` · active ${workflows?.active ?? 0}` +
          ` · failed ${workflows?.failed ?? 0}`,
      ),
      frame(
        ` Queue     longest ${formatDuration(governor.longestQueueWaitMs)}` +
          ` · sampled ${formatAge(governor.sampledAt)}`,
      ),
    ];

    if (governor.lastResourceExhausted) {
      rows.push(
        frame(
          this.theme.fg(
            "warning",
            ` Last limit ${governor.lastResourceExhausted}`,
          ),
        ),
      );
    }
    if (this.renderError) {
      rows.push(
        frame(this.theme.fg("error", ` Runtime warning ${this.renderError}`)),
      );
    }
    while (rows.length < VIEW_ROWS) rows.push(frame(""));
    rows.push(
      frame(this.theme.fg("dim", " r refresh · ? help · Esc/q return to Main")),
    );
    rows.push(border("╰", "─", "╯"));
    return rows;
  }

  private renderDegraded(width: number): string[] {
    return [
      truncateToWidth(
        "Subagent Workbench UI is temporarily unavailable.",
        width,
      ),
      truncateToWidth("Agents continue running in the background.", width),
      truncateToWidth(
        `Error: ${this.renderError ?? "unknown render error"}`,
        width,
      ),
      truncateToWidth("Esc/q return to Main", width),
    ];
  }
}

async function openStatusWorkbench(
  ctx: ExtensionCommandContext,
): Promise<void> {
  if (ctx.mode !== "tui") {
    ctx.ui.notify(
      "/subagent-workbench is only available in interactive TUI mode.",
      "warning",
    );
    return;
  }
  if (activeWorkbench) {
    ctx.ui.notify("Subagent Workbench is already open.", "info");
    return;
  }

  let component: WorkbenchStatusComponent | undefined;
  let doneView: (() => void) | undefined;
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    component?.dispose();
    doneView?.();
  };
  activeWorkbench = { close };
  try {
    await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
      doneView = () => done(undefined);
      component = new WorkbenchStatusComponent(
        theme,
        () => tui.requestRender(),
        close,
      );
      return component;
    });
  } finally {
    close();
    if (activeWorkbench?.close === close) activeWorkbench = undefined;
  }
}

function currentModel(ctx: ExtensionContext): string | undefined {
  return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
}

function currentThinking(ctx: ExtensionContext):
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"
  | undefined {
  return ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(
    ctx.thinkingLevel ?? "",
  )
    ? (ctx.thinkingLevel as "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max")
    : undefined;
}

function parentTraceContext(
  ctx: ExtensionContext,
  toolCallId: string,
): SubagentTraceContext {
  let parentSessionId: string | undefined;
  try {
    parentSessionId = ctx.sessionManager?.getSessionId?.();
  } catch {
    parentSessionId = undefined;
  }
  const ambient = parseTraceContext(process.env.PI_TRACE_CONTEXT);
  return {
    ...(ambient ?? {}),
    ...(parentSessionId ? { parentSessionId } : {}),
    parentToolCallId: toolCallId,
  };
}

function workflowRequestFromDefinition(
  definition: SavedWorkflowDefinition,
  ctx: ExtensionContext,
  signal?: AbortSignal,
  traceContext?: SubagentTraceContext,
): WorkbenchWorkflowRequest {
  return {
    label: definition.label,
    parameters: definition.parameters,
    cwd: ctx.cwd,
    model: currentModel(ctx),
    thinking: currentThinking(ctx),
    signal,
    traceContext,
    stages: definition.stages.map((stage) => ({
      label: stage.label,
      tasks: stage.tasks.map((task) => ({
        task: task.task,
        key: task.key,
        inputs: task.inputs,
        label: task.label,
        cwd: task.cwd || ctx.cwd,
        model: task.model || currentModel(ctx),
        thinking: task.thinking ?? currentThinking(ctx),
        context: task.context,
        outputSchema: task.outputSchema,
        when: task.when,
        foreach: task.foreach,
        maxItems: task.maxItems,
      })),
    })),
  };
}

function boundedToolOutput(text: string): string {
  if (text.length <= TOOL_OUTPUT_CHARS) return text;
  return `${text.slice(0, TOOL_OUTPUT_CHARS)}\n… output truncated; open /subagent-workbench for the retained transcript.`;
}

function workflowPreflightOutput(
  preflight: WorkbenchWorkflowPreflight,
): string {
  const lines = [
    `Workflow preflight · ${preflight.stages} Stages · ${preflight.taskDefinitions} definitions · up to ${preflight.maximumChildTasks} child tasks · ${preflight.availableSessionSlots} slots available`,
  ];
  for (const [stageIndex, stage] of preflight.items.entries()) {
    lines.push(`\n## Stage ${stageIndex + 1}: ${stage.label}`);
    for (const task of stage.tasks) {
      const annotations = [
        task.inputs.length ? `inputs=${task.inputs.join(",")}` : undefined,
        task.conditional ? "conditional" : undefined,
        task.foreachMaxItems === undefined
          ? undefined
          : `foreach<=${task.foreachMaxItems}`,
      ].filter(Boolean);
      lines.push(`- ${task.key}${annotations.length ? ` · ${annotations.join(" · ")}` : ""}`);
    }
  }
  return lines.join("\n");
}

function workflowToolOutput(result: WorkbenchWorkflowResult): string {
  const lines = [
    `Workflow ${result.label} (${result.workflowId}) · ${result.status} · attempt ${result.attempt}`,
  ];
  if (result.sourceWorkId) {
    lines.push(
      `Resumed from ${result.sourceWorkId} at Stage ${result.resumedFromStage ?? 1}.`,
    );
  }
  for (const stage of result.stages) {
    lines.push(
      `\n## ${stage.label} · ${stage.status}${stage.reused ? " · reused" : ""}`,
    );
    for (const task of stage.tasks) {
      lines.push(`\n### ${task.label} · ${task.status}`);
      if (task.summary) lines.push(`Conclusion: ${task.summary}`);
      else if (task.output) lines.push(task.output);
      if (task.artifacts?.length) {
        lines.push(
          "Artifacts:\n" +
            task.artifacts
              .map(
                (artifact) =>
                  `- ${artifact.path}${artifact.description ? ` — ${artifact.description}` : ""}`,
              )
              .join("\n"),
        );
      }
      if (task.error) lines.push(`Error: ${task.error}`);
    }
  }
  if (result.error) lines.push(`\nWorkflow error: ${result.error}`);
  return boundedToolOutput(lines.join("\n"));
}

function jobOutput(job: WorkbenchJobSnapshot): string | undefined {
  const result = job.result;
  if (!result || typeof result !== "object") return undefined;
  const record = result as Record<string, unknown>;
  if (
    typeof record.workflowId === "string" &&
    Array.isArray(record.stages)
  ) {
    return workflowToolOutput(result as WorkbenchWorkflowResult);
  }
  return typeof record.output === "string" ? record.output : undefined;
}

function formatJobQuery(
  query: WorkbenchJobQuery,
  includeOutput: boolean,
): string {
  const lines: string[] = [];
  for (const job of query.completed) {
    lines.push(`${job.workId} · ${job.kind} · ${job.status} · ${job.label}`);
    if (job.error) lines.push(`Error: ${job.error}`);
    const output = includeOutput ? jobOutput(job) : undefined;
    if (output) lines.push(boundedToolOutput(output));
  }
  for (const job of query.pending) {
    lines.push(`${job.workId} · ${job.kind} · ${job.status} · ${job.label}`);
  }
  if (query.missing.length) lines.push(`Unknown work IDs: ${query.missing.join(", ")}`);
  return lines.length ? boundedToolOutput(lines.join("\n")) : "No matching Subagent Workbench jobs.";
}

function failedWorkflowTask(
  job: WorkbenchJobSnapshot,
): { stage: string; key: string; error?: string } | undefined {
  if (job.kind !== "workflow" || job.status !== "failed") return undefined;
  const result = job.result as Partial<WorkbenchWorkflowResult> | undefined;
  if (!result?.stages) return undefined;
  for (const stage of result.stages) {
    const task = stage.tasks.find((candidate) => candidate.status === "failed");
    if (task) return { stage: stage.label, key: task.key, error: task.error };
  }
  return undefined;
}

function runWarningSummary(warning: WorkbenchRunWarning): string {
  const idle =
    warning.idleMs === undefined
      ? ""
      : ` No real RPC progress for ${formatDuration(warning.idleMs)}.`;
  const target = warning.workId
    ? `${warning.kind} ${warning.workId}`
    : `${warning.kind} session ${warning.sessionId}`;
  const action = warning.workId
    ? `Inspect with subagent_results and cancel with subagent_cancel workIds=["${warning.workId}"] only if it is stuck or no longer needed.`
    : "Inspect the Workbench and interrupt the Run only if it is stuck or no longer needed.";
  return `Long-running ${target}: ${warning.label}. Runtime ${formatDuration(warning.elapsedMs)}.${idle} The task is still running; this is a warning, not a failure. ${action}`;
}

function completionSummary(job: WorkbenchJobSnapshot): string {
  const failedTask = failedWorkflowTask(job);
  if (failedTask) {
    return `Workflow failed at ${failedTask.stage} / ${failedTask.key} (${job.workId}).${failedTask.error ? ` Error: ${failedTask.error}.` : ""} Retry only this task with subagent_workflow_control action=retry_task, workId=${job.workId}, taskKey=${failedTask.key}.`;
  }
  const result = jobOutput(job);
  const detail = job.error
    ? ` Error: ${job.error}`
    : result
      ? ` Result is ready; collect it with subagent_results.`
      : "";
  return `Subagent ${job.kind} ${job.status}: ${job.label} (${job.workId}).${detail}`;
}

export default function subagentWorkbench(pi: ExtensionAPI): void {
  const extensionMarker = Symbol.for("pi-subagent-workbench.extension-instance.v1");
  const isDashboard = process.env.PI_RUNTIME === "dashboard";
  const isChildProcess = process.env.PI_SUBAGENT_WORKBENCH_CHILD === "1";
  const useProcessDedupe = isChildProcess || Boolean(process.env.PI_SLOT_KEY);
  const extensionHost = (useProcessDedupe ? globalThis : pi) as unknown as Record<PropertyKey, unknown>;
  if (extensionHost[extensionMarker]) return;
  extensionHost[extensionMarker] = true;
  const installedRuntime = isDashboard
    ? createWorkbenchRuntimeHost()
    : installWorkbenchRuntime();
  if (isChildProcess) registerChildMultiTool(pi);
  let controller: WorkbenchController | undefined;
  let activeContext: ExtensionContext | undefined;
  const deliverPendingRunWarnings = (): void => {
    const current = controller;
    if (!activeContext || !current || typeof pi.sendMessage !== "function") return;
    for (const warning of current.pendingRunWarnings()) {
      const content = runWarningSummary(warning);
      try {
        pi.sendMessage(
          {
            customType: "subagent-workbench-run-warning",
            content,
            display: false,
            details: { ...warning },
          },
          activeContext.isIdle()
            ? { triggerTurn: true, deliverAs: "followUp" }
            : { triggerTurn: false, deliverAs: "nextTurn" },
        );
        if (activeContext.hasUI) {
          activeContext.ui.notify(content, "warning");
        }
        current.markRunWarningDelivered(warning.id);
      } catch {
        // Retain the warning for the next delivery opportunity.
      }
    }
  };
  const deliverPendingCompletions = (): void => {
    const current = controller;
    if (!activeContext || !current || typeof pi.sendMessage !== "function") return;
    for (const job of current.pendingJobCompletions()) {
      try {
        pi.sendMessage(
          {
            customType: "subagent-workbench-completion",
            content: completionSummary(job),
            display: false,
            details: {
              workId: job.workId,
              kind: job.kind,
              status: job.status,
              ...(job.sessionId ? { sessionId: job.sessionId } : {}),
              ...(job.runId ? { runId: job.runId } : {}),
              ...(job.workflowId ? { workflowId: job.workflowId } : {}),
            },
          },
          job.status === "failed" && activeContext.isIdle()
            ? { triggerTurn: true, deliverAs: "followUp" }
            : { triggerTurn: false, deliverAs: "nextTurn" },
        );
        current.markJobCompletionDelivered(job.workId);
      } catch {
        // Keep it queued: delivery can retry on the next tool call or session start.
      }
    }
  };
  const ensureController = (): WorkbenchController => {
    controller ??= new WorkbenchController(installedRuntime, {
      onJobSettled: () => deliverPendingCompletions(),
      onRunWarning: () => deliverPendingRunWarnings(),
    });
    return controller;
  };

  let dashboardBridgeCleanup: (() => void) | undefined;
  let liveFeatureCleanup: (() => void) | undefined;
  let taskNavigation: TaskNavigationHandle | undefined;
  const openWorkbenchPage = async (
    ctx: ExtensionContext,
    runtime: WorkbenchRuntime,
    initialTargetId?: string,
  ): Promise<void> => {
    taskNavigation?.suspend();
    try {
      await openConversationWorkbench(
        ctx,
        runtime,
        (handle) => {
          activeWorkbench = handle;
        },
        initialTargetId ? { initialTargetId } : {},
      );
    } finally {
      taskNavigation?.resume();
    }
  };
  const openNavigationTarget = async (
    ctx: ExtensionContext,
    target: TaskNavigationTarget,
  ): Promise<void> => {
    if (target.kind === "main") return;
    if (activeWorkbench) {
      ctx.ui.notify("Subagent Workbench is already open.", "info");
      return;
    }
    const runtime = ensureController().runtime;
    await openWorkbenchPage(ctx, runtime, target.id);
  };
  const bindTaskNavigation = (ctx: ExtensionContext): void => {
    if (isDashboard || isChildProcess || !ctx.hasUI || taskNavigation) return;
    taskNavigation = installTaskNavigation(ctx, installedRuntime, {
      onOpen: (target) => openNavigationTarget(ctx, target),
    });
  };

  if (!isChildProcess) {
    pi.on("session_start", async (_event, ctx) => {
      activeContext = ctx;
      bindTaskNavigation(ctx);
      liveFeatureCleanup?.();
      const publishSnapshot = (snapshot: ReturnType<typeof installedRuntime.getSnapshot>) =>
        publishLiveFeature("subagent-workflow", projectLiveFeatureSnapshot(snapshot));
      liveFeatureCleanup = installedRuntime.subscribe(publishSnapshot);
      publishSnapshot(installedRuntime.getSnapshot());
      deliverPendingRunWarnings();
      deliverPendingCompletions();
      if (isDashboard) {
        dashboardBridgeCleanup?.();
        dashboardBridgeCleanup = registerWorkbenchDashboardBridge(
          ctx,
          installedRuntime,
          () => { ensureController(); },
        );
      }
    });

    pi.registerTool({
      name: "subagent_start",
      label: "Subagent Workbench",
      description:
        "Run a bounded process-isolated subagent task. Defaults to background and returns a workId. Use a self-contained task and cwd; parallelize independent work. Use an exact provider/model override; omit model to inherit the current Session model. Never pass a fuzzy short name. Continue while it runs and collect only at a real dependency point; the main Agent retains authorization and final decisions.",
      promptSnippet:
        "Delegate bounded independent work to a full-capability process subagent, normally in background.",
      executionMode: "parallel",
      parameters: AgentToolParams,
      async execute(toolCallId, params, signal, onUpdate, ctx) {
        bindTaskNavigation(ctx);
        onUpdate?.({
          content: [{ type: "text", text: "Subagent is starting…" }],
          details: { status: "running" },
        });
        try {
          const current = ensureController();
          const background = params.background ?? true;
          const submission = current.submitAgent(
            {
              task: params.task,
              label: params.label,
              cwd: params.cwd || ctx.cwd,
              model: params.model || currentModel(ctx),
              thinking: params.thinking ?? currentThinking(ctx),
              context: params.context,
              traceContext: parentTraceContext(ctx, toolCallId),
              signal: background ? undefined : signal,
              parentId: toolCallId,
            },
            background,
          );
          if (background) {
            void submission.completion.catch(() => {
              // The durable job record retains the error for collect/status.
            });
            return {
              content: [
                {
                  type: "text",
                  text: `Subagent accepted in background (${submission.handle.workId}). Track or collect it with subagent_results.`,
                },
              ],
              details: {
                status: submission.handle.status,
                background: true,
                workId: submission.handle.workId,
              },
            };
          }
          const result = await submission.completion;
          return {
            content: [
              {
                type: "text",
                text: boundedToolOutput(
                  result.isError
                    ? `Subagent failed: ${result.errorMessage || result.output}`
                    : result.output,
                ),
              },
            ],
            details: {
              status: result.isError ? "failed" : "completed",
              sessionId: result.sessionId,
              runId: result.runId,
              model: result.model,
              usage: result.usage,
            },
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text",
                text: `Subagent failed: ${error instanceof Error ? error.message : String(error)}`,
              },
            ],
            details: { status: "failed" },
          };
        }
      },
    });

    pi.registerTool({
      name: "subagent_workflow",
      label: "Subagent Workflow",
      description:
        "Run a recoverable single task, staged workflow, or an explicitly requested restricted JavaScript workflow plan. Stages are sequential, tasks within a stage run in parallel, and later stages consume earlier conclusions and artifact paths through task inputs. Use subagent_workflow when the user explicitly requests a workflow, or when a small or large task benefits from tracking, artifacts, or retry; task creates a one-stage workflow. Use stages for explicit sequential/parallel plans. Use javascript only for a bounded, data-independent plan shape that cannot be expressed clearly with stages, when, and foreach. Give reusable producer tasks a key; later Stages may use inputs or bounded tasks.<key> templates. Use outputSchema for machine-consumed JSON, and keep when/foreach expressions minimal and bounded. Use exact provider/model task overrides; omit model to inherit the current Session model. Never pass fuzzy short names. Use dryRun to preview dynamic or saved definitions without creating work. Use record=metadata for output-free audit state; use record=full only when sensitive-output persistence and cross-session retry are explicitly needed. Use name to run a saved project workflow; use saveAs only when reuse is explicitly useful. Prefer background; wait only when correctness or delivery depends on the result.",
      promptSnippet:
        "Run recoverable single-task or staged subagent workflows with explicit prior-task handoffs.",
      executionMode: "parallel",
      parameters: WorkflowToolParams,
      async execute(toolCallId, params, signal, onUpdate, ctx) {
        bindTaskNavigation(ctx);
        onUpdate?.({
          content: [{ type: "text", text: "Subagent workflow is starting…" }],
          details: { status: "running" },
        });
        try {
          const current = ensureController();
          const definitionSources = [
            params.name !== undefined,
            params.stages !== undefined,
            params.task !== undefined,
            params.javascript !== undefined,
          ].filter(Boolean).length;
          if (definitionSources !== 1) {
            throw new TypeError(
              "Provide exactly one of task, stages, javascript, or a saved workflow name.",
            );
          }
          const loaded = params.name
            ? await loadWorkflowDefinition(ctx.cwd, params.name)
            : undefined;
          const compiled =
            params.javascript === undefined
              ? undefined
              : compileWorkflowJavaScript(params.javascript, params.parameters);
          const sourceStages =
            params.stages ??
            compiled?.stages ??
            (params.task
              ? [{ tasks: [{ task: params.task }] }]
              : loaded?.stages);
          if (!sourceStages) {
            throw new TypeError("Workflow definition did not produce stages.");
          }
          const workflowLabel = params.label ?? loaded?.label;
          const workflowParameters =
            params.parameters ?? compiled?.parameters ?? loaded?.parameters;
          const background = params.background ?? true;
          const definition: SavedWorkflowDefinition = {
            version: SAVED_WORKFLOW_VERSION,
            label: workflowLabel,
            parameters: workflowParameters,
            ...(params.javascript === undefined
              ? loaded?.origin
                ? { origin: loaded.origin }
                : {}
              : { origin: { language: "javascript", source: params.javascript } }),
            stages: sourceStages,
          };
          const request = workflowRequestFromDefinition(
            definition,
            ctx,
            background ? undefined : signal,
            parentTraceContext(ctx, toolCallId),
          );
          const preflight = current.preflightWorkflow(request);
          if (params.dryRun) {
            return {
              content: [{ type: "text", text: workflowPreflightOutput(preflight) }],
              details: {
                status: "completed",
                dryRun: true,
                preflight,
              },
            };
          }
          const savedPath = params.saveAs
            ? await saveWorkflowDefinition(ctx.cwd, params.saveAs, definition)
            : undefined;
          const submission = current.submitWorkflow(request, background);
          if (background) {
            const runRecordPath = params.record
              ? workflowRunPath(ctx.cwd, submission.handle.workId)
              : undefined;
            void submission.completion
              .then(async (result) => {
                if (params.record) {
                  await saveWorkflowRun(
                    ctx.cwd,
                    submission.handle.workId,
                    params.record,
                    definition,
                    result,
                  );
                }
              })
              .catch((error: unknown) => {
                if (params.record) {
                  console.error(
                    `[subagent-workbench] Workflow run record failed: ${error instanceof Error ? error.message : String(error)}`,
                  );
                }
                // Never capture a tool ctx here: it may be stale after shutdown/reload.
              });
            return {
              content: [
                {
                  type: "text",
                  text: `Workflow accepted in background (${submission.handle.workId}).${savedPath ? ` Saved definition: ${savedPath}.` : ""}${runRecordPath ? ` Run record will be written to ${runRecordPath}.` : ""} Track or collect it with subagent_results.`,
                },
              ],
              details: {
                status: submission.handle.status,
                background: true,
                workId: submission.handle.workId,
                workflowId: current.getJobs([submission.handle.workId]).pending[0]?.workflowId,
                savedPath,
                runRecordPath,
              },
            };
          }
          const result = await submission.completion;
          const runRecordPath = params.record
            ? await saveWorkflowRun(
                ctx.cwd,
                submission.handle.workId,
                params.record,
                definition,
                result,
              )
            : undefined;
          return {
            content: [
              {
                type: "text",
                text: `${savedPath ? `Saved definition: ${savedPath}\n` : ""}${runRecordPath ? `Saved run record: ${runRecordPath}\n` : ""}${savedPath || runRecordPath ? "\n" : ""}${workflowToolOutput(result)}`,
              },
            ],
            details: {
              status: result.status,
              workflowId: result.workflowId,
              savedPath,
              runRecordPath,
              stages: result.stages.map((stage) => ({
                id: stage.id,
                label: stage.label,
                status: stage.status,
                tasks: stage.tasks.map((task) => ({
                  id: task.id,
                  key: task.key,
                  label: task.label,
                  status: task.status,
                  sessionId: task.sessionId,
                  runId: task.runId,
                  error: task.error,
                })),
              })),
            },
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text",
                text: `Workflow failed: ${error instanceof Error ? error.message : String(error)}`,
              },
            ],
            details: { status: "failed" },
          };
        }
      },
    });

    pi.registerTool({
      name: "subagent_workflow_control",
      label: "Control Subagent Workflow",
      description:
        "Pause or resume a running workflow, retry a terminal workflow, or retry one failed task while reusing its completed siblings. Pause is cooperative: already-running tasks finish, and the next stage waits. retry creates a new background workId, reuses completed Stages, and resumes at the first incomplete Stage. retry_task requires taskKey and reruns only that failed task; completed or skipped siblings in its Stage are reused.",
      promptSnippet:
        "Pause, resume, retry a workflow, or retry one failed workflow task by workId.",
      executionMode: "sequential",
      parameters: WorkflowControlParams,
      async execute(toolCallId, params, _signal, _onUpdate, ctx) {
        activeContext = ctx;
        const current = ensureController();
        if (params.action === "pause") {
          const job = current.pauseWorkflowJob(params.workId);
          return {
            content: [
              {
                type: "text",
                text: job
                  ? `Workflow ${params.workId} paused; running tasks may finish before the next stage waits.`
                  : `Workflow ${params.workId} is not running or cannot be paused.`,
              },
            ],
            details: {
              status: job ? "completed" : "failed",
              action: params.action,
              workId: params.workId,
              workflowStatus: job?.status,
            },
          };
        }
        if (params.action === "resume") {
          const job = current.resumeWorkflowJob(params.workId);
          return {
            content: [
              {
                type: "text",
                text: job
                  ? `Workflow ${params.workId} resumed.`
                  : `Workflow ${params.workId} is not paused or cannot be resumed.`,
              },
            ],
            details: {
              status: job ? "completed" : "failed",
              action: params.action,
              workId: params.workId,
              workflowStatus: job?.status,
            },
          };
        }
        const retryTask = params.action === "retry_task";
        const traceContext = parentTraceContext(ctx, toolCallId);
        if (retryTask && !params.taskKey) {
          return {
            content: [
              {
                type: "text",
                text: "retry_task requires the failed taskKey.",
              },
            ],
            details: {
              status: "failed",
              action: params.action,
              workId: params.workId,
              error: "task_key_required",
            },
          };
        }
        let retry = retryTask
          ? current.retryWorkflowTaskJob(params.workId, params.taskKey!, traceContext)
          : current.retryWorkflowJob(params.workId, traceContext);
        let persistedDefinition: SavedWorkflowDefinition | undefined;
        if (!retry) {
          try {
            const record = await loadWorkflowRun(ctx.cwd, params.workId);
            if (record.mode !== "full") {
              return {
                content: [
                  {
                    type: "text",
                    text: `Workflow ${params.workId} has metadata only; cross-session retry requires record=full.`,
                  },
                ],
                details: {
                  status: "failed",
                  action: params.action,
                  workId: params.workId,
                  error: "full_run_record_required",
                },
              };
            }
            persistedDefinition = record.definition;
            const request = workflowRequestFromDefinition(
              record.definition,
              ctx,
              undefined,
              traceContext,
            );
            retry = retryTask
              ? current.retryWorkflowTaskFromResult(
                  params.workId,
                  request,
                  record.result,
                  params.taskKey!,
                  traceContext,
                )
              : current.retryWorkflowFromResult(
                  params.workId,
                  request,
                  record.result,
                  traceContext,
                );
          } catch (error) {
            if (
              typeof error !== "object" ||
              error === null ||
              !("code" in error) ||
              error.code !== "ENOENT"
            ) {
              return {
                content: [
                  {
                    type: "text",
                    text: `Persisted Workflow retry failed: ${error instanceof Error ? error.message : String(error)}`,
                  },
                ],
                details: {
                  status: "failed",
                  action: params.action,
                  workId: params.workId,
                  error: "persisted_retry_failed",
                },
              };
            }
            // Missing record falls through to the standard unavailable response.
          }
        }
        if (!retry) {
          return {
            content: [
              {
                type: "text",
                text: retryTask
                ? `Workflow ${params.workId} cannot retry task ${params.taskKey}; it must be a failed terminal task with a retained definition.`
                : `Workflow ${params.workId} is not terminal or its definition is unavailable.`,
              },
            ],
            details: {
              status: "failed",
              action: params.action,
              workId: params.workId,
            },
          };
        }
        const retryRecordPath = persistedDefinition
          ? workflowRunPath(ctx.cwd, retry.handle.workId)
          : undefined;
        void retry.completion
          .then(async (result) => {
            if (persistedDefinition) {
              await saveWorkflowRun(
                ctx.cwd,
                retry!.handle.workId,
                "full",
                persistedDefinition,
                result,
              );
            }
          })
          .catch((error: unknown) => {
            if (persistedDefinition) {
              console.error(
                `[subagent-workbench] Workflow retry record failed: ${error instanceof Error ? error.message : String(error)}`,
              );
            }
            // Never capture a tool ctx here: it may be stale after shutdown/reload.
          });
        const retryJob = current.getJobs([retry.handle.workId]).pending[0];
        return {
          content: [
            {
              type: "text",
              text: `${retryTask ? `Workflow task ${params.taskKey} retry` : "Workflow retry"} accepted in background (${retry.handle.workId}).${retryRecordPath ? ` Full run record will be written to ${retryRecordPath}.` : ""}`,
            },
          ],
          details: {
            status: retry.handle.status,
            action: params.action,
            sourceWorkId: params.workId,
            workId: retry.handle.workId,
            attempt: retryJob?.attempt,
            ...(retryTask ? { taskKey: params.taskKey } : {}),
            retryRecordPath,
          },
        };
      },
    });

    pi.registerTool({
      name: "subagent_results",
      label: "Subagent Workbench Results",
      description:
        "Get status or results for subagent work IDs. Use bounded wait only at a real dependency point. Use status or collect while other independent work can continue. Use wait only when the next correct action depends on a result; timeout leaves jobs running. Include workIds whenever known; each call accepts at most eight.",
      promptSnippet: "Inspect or collect background subagent results by workId.",
      executionMode: "sequential",
      parameters: WorkbenchResultsParams,
      async execute(_toolCallId, params, _signal, onUpdate, ctx) {
        activeContext = ctx;
        deliverPendingRunWarnings();
        deliverPendingCompletions();
        const current = ensureController();
        const mode = params.mode ?? "collect";
        const workIds = params.workIds;
        if (mode === "wait" && !workIds?.length) {
          return {
            content: [{ type: "text", text: "workIds are required when mode=wait." }],
            details: { status: "failed", error: "invalid_work_ids" },
          };
        }
        onUpdate?.({
          content: [{ type: "text", text: mode === "wait" ? "Waiting for subagent results…" : "Reading subagent results…" }],
          details: { status: "running", mode },
        });
        const query =
          mode === "wait"
            ? await current.waitForJobs(
                workIds!,
                params.waitFor ?? "all",
                params.timeoutMs ?? RESULT_WAIT_MAX_MS,
              )
            : mode === "status"
              ? current.getJobs(workIds)
              : current.collectJobs(workIds);
        return {
          content: [
            {
              type: "text",
              text: formatJobQuery(query, params.includeOutput ?? mode !== "status"),
            },
          ],
          details: {
            status: "completed",
            mode,
            completed: query.completed.map((job) => ({
              workId: job.workId,
              kind: job.kind,
              status: job.status,
            })),
            pending: query.pending.map((job) => ({
              workId: job.workId,
              kind: job.kind,
              status: job.status,
            })),
            missing: query.missing,
          },
        };
      },
    });

    pi.registerTool({
      name: "subagent_cancel",
      label: "Cancel Subagent Workbench Jobs",
      description:
        "Best-effort cancel queued, running, or paused subagent work IDs. Completed jobs are unchanged. Cancel only work that is no longer needed or is clearly unsafe to continue. Collect status after cancellation when the final state matters.",
      promptSnippet: "Cancel background subagent jobs by workId.",
      executionMode: "sequential",
      parameters: WorkbenchCancelParams,
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        activeContext = ctx;
        const current = ensureController();
        const cancelled = params.workIds.map((workId) => current.cancelJob(workId, params.reason));
        const affected = cancelled.filter((job): job is WorkbenchJobSnapshot => Boolean(job));
        const missing = params.workIds.filter((_workId, index) => !cancelled[index]);
        return {
          content: [
            {
              type: "text",
              text: affected.length
                ? `Cancellation requested for: ${affected.map((job) => job.workId).join(", ")}${missing.length ? `\nUnknown or terminal jobs: ${missing.join(", ")}` : ""}`
                : `No queued, running, or paused jobs were cancelled.${missing.length ? ` Unknown or terminal jobs: ${missing.join(", ")}` : ""}`,
            },
          ],
          details: {
            status: "completed",
            cancelled: affected.map((job) => ({ workId: job.workId, status: job.status })),
            missing,
          },
        };
      },
    });
  }

  pi.on("session_shutdown", async () => {
    activeContext = undefined;
    if (extensionHost[extensionMarker]) delete extensionHost[extensionMarker];
    dashboardBridgeCleanup?.();
    dashboardBridgeCleanup = undefined;
    liveFeatureCleanup?.();
    liveFeatureCleanup = undefined;
    clearLiveFeature("subagent-workflow");
    activeWorkbench?.close();
    activeWorkbench = undefined;
    taskNavigation?.dispose();
    taskNavigation = undefined;
    const current = controller;
    controller = undefined;
    await current?.dispose();
    if (isDashboard) installedRuntime.dispose();
  });

  pi.registerCommand("subagent-workbench", {
    description: "Open or control the Subagent Conversation Workbench",
    handler: async (args, ctx) => {
      bindTaskNavigation(ctx);
      const input = args.trim();
      const [action = "open", ...rest] = input.split(/\s+/);
      const normalized = action.toLowerCase();
      if (normalized === "close") {
        activeWorkbench?.close();
        activeWorkbench = undefined;
        return;
      }
      if (normalized === "status") {
        await openStatusWorkbench(ctx);
        return;
      }
      const runtime = ensureController().runtime;
      if (normalized === "start") {
        const task = rest.join(" ").trim();
        if (!task) {
          ctx.ui.notify("Usage: /subagent-workbench start <task>", "warning");
          return;
        }
        const model = ctx.model
          ? `${ctx.model.provider}/${ctx.model.id}`
          : undefined;
        const result = await runtime.dispatch({
          type: "start-agent",
          task,
          label: task.slice(0, 48),
          cwd: ctx.cwd,
          ...(model ? { model } : {}),
        });
        ctx.ui.notify(
          result.ok
            ? "Agent accepted in memory; open /subagent-workbench to inspect it."
            : `Agent was not started: ${result.error}`,
          result.ok ? "info" : "error",
        );
        return;
      }
      if (normalized !== "open") {
        ctx.ui.notify(
          "Usage: /subagent-workbench [open|status|close|start <task>]",
          "warning",
        );
        return;
      }
      if (ctx.mode !== "tui") {
        ctx.ui.notify(
          "/subagent-workbench open is only available in interactive TUI mode.",
          "warning",
        );
        return;
      }
      if (activeWorkbench) {
        ctx.ui.notify("Subagent Workbench is already open.", "info");
        return;
      }
      await openWorkbenchPage(ctx, runtime);
    },
  });
}

export {
  DEFAULT_TRANSCRIPT_BYTES,
  WorkbenchController,
  type WorkbenchAgentRequest,
  type WorkbenchControllerOptions,
  type WorkbenchJobQuery,
  type WorkbenchSubmission,
  type WorkbenchWorkflowRequest,
  type WorkbenchWorkflowResult,
  type WorkbenchWorkflowStageRequest,
  type WorkbenchWorkflowStageResult,
  type WorkbenchWorkflowTaskRequest,
  type WorkbenchWorkflowTaskResult,
} from "./workbench-controller.ts";
export {
  WORKBENCH_API_VERSION,
  WORKBENCH_RUNTIME_SYMBOL,
  WorkbenchRuntimeHost,
  getWorkbenchRuntimeHost,
  installWorkbenchRuntime,
  uninstallWorkbenchRuntime,
  type ConversationAvailability,
  type ConversationMessage,
  type ConversationRecord,
  type ConversationStatus,
  type SubagentWorkbenchRuntime,
  type WorkbenchCommand,
  type WorkbenchCommandResult,
  type WorkbenchSnapshot,
  type WorkflowRecord,
  type WorkflowStageRecord,
  type WorkflowStatus,
  type WorkflowTaskRecord,
} from "./runtime.ts";
export {
  WorkbenchJobRegistry,
  type WorkbenchJobKind,
  type WorkbenchJobSnapshot,
  type WorkbenchJobStatus,
  type WorkbenchWorkHandle,
} from "./job-registry.ts";
export {
  DEFAULT_MAX_CONTEXT_BYTES,
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_MAX_TASK_BYTES,
  ProviderCapabilityError,
  ProviderOutputError,
  ProviderRegistry,
  ProviderUnavailableError,
  SubagentExecutionError,
  SubagentInputError,
  SubagentService,
  emptyAgentResult,
  type AgentResult,
  type AgentRunSnapshot,
  type AgentUsage,
  type ChildSessionSnapshot,
  type ContextMode,
  type IsolationMode,
  type ProviderCapabilities,
  type ProviderEvent,
  type ProviderOutputErrorCode,
  type ProviderRunRequest,
  type StartAgentRequest,
  type SubagentInputErrorCode,
  type SubagentPayloadLimits,
  type SubagentProvider,
  type SubagentServiceEvent,
  type SubagentServiceOptions,
} from "./subagent-service.ts";
export {
  PiRpcProcessProvider,
  PiRpcProviderError,
  type PiRpcProcessProviderOptions,
  type PiRpcProviderErrorCode,
  type PiRpcProviderSnapshot,
} from "./providers/pi-rpc-process-provider.ts";
export {
  DEFAULT_ACTIVE_LIMIT,
  DEFAULT_QUEUE_LIMIT,
  ResourceExhaustedError,
  ResourceGovernor,
  ResourcePriority,
  type ResourceAcquireOptions,
  type ResourceGovernorOptions,
  type ResourceGovernorSnapshot,
  type ResourceLease,
} from "./resource-governor.ts";
