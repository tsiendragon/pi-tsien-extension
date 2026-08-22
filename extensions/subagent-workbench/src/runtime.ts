import {
  ResourceGovernor,
  type ResourceGovernorOptions,
} from "./resource-governor.ts";

export const WORKBENCH_API_VERSION = 1 as const;
export const WORKBENCH_RUNTIME_SYMBOL = Symbol.for(
  "pi-subagent-workbench.runtime.v1",
);
const WORKBENCH_HOST_SYMBOL = Symbol.for("pi-subagent-workbench.host.v1");

export type ConversationStatus =
  | "queued"
  | "running"
  | "idle"
  | "completed"
  | "failed"
  | "interrupted"
  | "cancelled";

export type ConversationAvailability = "ready" | "unavailable" | "disposed";

export interface ConversationMessage {
  readonly id: string;
  readonly runId: string;
  readonly role: "user" | "assistant" | "system";
  readonly text: string;
  readonly createdAt: number;
  readonly streaming?: boolean;
}

export interface ConversationAssistantBlock {
  readonly type: "text" | "thinking" | "toolCall";
  readonly contentIndex?: number;
  readonly text?: string;
  readonly thinking?: string;
  readonly id?: string;
  readonly name?: string;
  readonly arguments?: unknown;
}

export interface ConversationToolOutput {
  readonly content: readonly {
    readonly type: string;
    readonly text?: string;
    readonly data?: string;
    readonly mimeType?: string;
  }[];
  readonly details?: unknown;
}

export type ConversationTimelineEntry =
  | {
      readonly id: string;
      readonly runId: string;
      readonly type: "user";
      readonly text: string;
      readonly createdAt: number;
    }
  | {
      readonly id: string;
      readonly runId: string;
      readonly type: "assistant";
      readonly content: readonly ConversationAssistantBlock[];
      readonly createdAt: number;
      readonly streaming?: boolean;
      readonly provider?: string;
      readonly model?: string;
      readonly stopReason?: string;
      readonly errorMessage?: string;
    }
  | {
      readonly id: string;
      readonly runId: string;
      readonly type: "tool";
      readonly toolCallId: string;
      readonly name: string;
      readonly args: unknown;
      readonly output?: ConversationToolOutput;
      readonly status: "running" | "completed" | "failed";
      readonly createdAt: number;
    };

export type ConversationThinkingLevel =
  "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface ConversationUsage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly cost: number;
}

export interface ConversationRecord {
  readonly id: string;
  readonly label: string;
  readonly status: ConversationStatus;
  readonly updatedAt: number;
  readonly availability?: ConversationAvailability;
  readonly activeRunId?: string | null;
  readonly latestRunStatus?: ConversationStatus;
  readonly messages?: readonly ConversationMessage[];
  readonly timeline?: readonly ConversationTimelineEntry[];
  readonly provider?: string;
  readonly model?: string;
  readonly thinkingLevel?: ConversationThinkingLevel;
  readonly usage?: ConversationUsage;
  readonly transcriptTruncated?: boolean;
  readonly error?: string | null;
  readonly workflowId?: string;
  readonly needsAttention?: boolean;
  readonly lastHeartbeatAt?: number;
  readonly stalled?: boolean;
}

export type WorkflowStatus =
  | "queued"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

export type WorkflowTaskStatus = ConversationStatus | "skipped";

export interface WorkflowTaskRecord {
  readonly id: string;
  readonly key?: string;
  readonly label: string;
  readonly status: WorkflowTaskStatus;
  readonly sessionId?: string;
  readonly runId?: string;
  readonly error?: string;
}

export interface WorkflowStageRecord {
  readonly id: string;
  readonly label: string;
  readonly status: WorkflowStatus;
  readonly tasks: readonly WorkflowTaskRecord[];
}

export interface WorkflowRecord {
  readonly id: string;
  readonly label: string;
  readonly status: WorkflowStatus;
  readonly updatedAt: number;
  readonly currentStage?: number;
  readonly stages?: readonly WorkflowStageRecord[];
  readonly error?: string;
}

export interface WorkbenchSnapshot {
  readonly apiVersion: typeof WORKBENCH_API_VERSION;
  readonly revision: number;
  readonly generatedAt: number;
  readonly governor: {
    readonly active: number;
    readonly queued: number;
    readonly activeLimit: number;
    readonly queueLimit: number;
    readonly protection: "normal";
  };
  readonly runHealth: {
    readonly running: number;
    readonly stalled: number;
    readonly lastHeartbeatAt?: number;
  };
  readonly conversations: {
    readonly total: number;
    readonly running: number;
    readonly needsAttention: number;
    readonly completed: number;
    readonly items: readonly ConversationRecord[];
  };
  readonly lastCommandError?: string;
  readonly workflows: {
    readonly total: number;
    readonly active: number;
    readonly failed: number;
    readonly items: readonly WorkflowRecord[];
  };
}

export type WorkbenchCommand =
  | { readonly type: "refresh" }
  | {
      readonly type: "start-agent";
      readonly task: string;
      readonly label?: string;
      readonly cwd: string;
      readonly model?: string;
      readonly thinking?: ConversationThinkingLevel;
    }
  | {
      readonly type: "start-workflow";
      readonly workflowId?: string;
      readonly label?: string;
      readonly cwd: string;
      readonly model?: string;
      readonly thinking?: ConversationThinkingLevel;
      readonly stages: readonly {
        readonly label?: string;
        readonly tasks: readonly {
          readonly task: string;
          readonly key?: string;
          readonly inputs?: readonly string[];
          readonly label?: string;
          readonly cwd?: string;
          readonly model?: string;
          readonly thinking?: ConversationThinkingLevel;
          readonly context?: string;
        }[];
      }[];
    }
  | { readonly type: "pause-workflow"; readonly workflowId: string }
  | { readonly type: "resume-workflow"; readonly workflowId: string }
  | {
      readonly type: "send-agent";
      readonly sessionId: string;
      readonly message: string;
    }
  | { readonly type: "interrupt-agent"; readonly sessionId: string }
  | { readonly type: "interrupt-workflow"; readonly workflowId: string };

export interface WorkbenchCommandResult {
  readonly ok: boolean;
  readonly error?: string;
  readonly accepted?: "volatile" | "queued";
  readonly sessionId?: string;
  readonly runId?: string;
  readonly workflowId?: string;
}

export interface SubagentWorkbenchRuntime {
  readonly apiVersion: typeof WORKBENCH_API_VERSION;
  getSnapshot(): WorkbenchSnapshot;
  subscribe(listener: (snapshot: WorkbenchSnapshot) => void): () => void;
  dispatch(command: WorkbenchCommand): Promise<WorkbenchCommandResult>;
}

type SnapshotListener = (snapshot: WorkbenchSnapshot) => void;
type WorkbenchCommandHandler = (
  command: Exclude<WorkbenchCommand, { readonly type: "refresh" }>,
) => Promise<WorkbenchCommandResult>;

function freezeConversation(record: ConversationRecord): ConversationRecord {
  return Object.freeze({
    ...record,
    ...(record.messages
      ? {
          messages: Object.freeze(
            record.messages.map((message) => Object.freeze({ ...message })),
          ),
        }
      : {}),
    ...(record.usage ? { usage: Object.freeze({ ...record.usage }) } : {}),
    ...(record.timeline
      ? {
          timeline: Object.freeze(
            record.timeline.map((entry) => {
              if (entry.type === "assistant") {
                return Object.freeze({
                  ...entry,
                  content: Object.freeze(
                    entry.content.map((block) => Object.freeze({ ...block })),
                  ),
                });
              }
              if (entry.type === "tool" && entry.output) {
                return Object.freeze({
                  ...entry,
                  output: Object.freeze({
                    ...entry.output,
                    content: Object.freeze(
                      entry.output.content.map((item) =>
                        Object.freeze({ ...item }),
                      ),
                    ),
                  }),
                });
              }
              return Object.freeze({ ...entry });
            }),
          ),
        }
      : {}),
  });
}

function freezeWorkflow(record: WorkflowRecord): WorkflowRecord {
  return Object.freeze({
    ...record,
    ...(record.stages
      ? {
          stages: Object.freeze(
            record.stages.map((stage) =>
              Object.freeze({
                ...stage,
                tasks: Object.freeze(
                  stage.tasks.map((task) => Object.freeze({ ...task })),
                ),
              }),
            ),
          ),
        }
      : {}),
  });
}

function globalRecord(): Record<PropertyKey, unknown> {
  return globalThis as Record<PropertyKey, unknown>;
}

export class WorkbenchRuntimeHost implements SubagentWorkbenchRuntime {
  readonly apiVersion = WORKBENCH_API_VERSION;
  readonly governor: ResourceGovernor;

  private readonly conversations = new Map<string, ConversationRecord>();
  private readonly workflows = new Map<string, WorkflowRecord>();
  private readonly listeners = new Set<SnapshotListener>();
  private readonly unsubscribeGovernor: () => void;
  private revision = 0;
  private commandHandler: WorkbenchCommandHandler | undefined;
  private lastCommandError: string | undefined;
  private snapshot: WorkbenchSnapshot;

  constructor(governorOptions: ResourceGovernorOptions = {}) {
    this.governor = new ResourceGovernor(governorOptions);
    this.snapshot = this.buildSnapshot();
    this.unsubscribeGovernor = this.governor.subscribe(() => {
      this.refresh();
    });
  }

  getSnapshot(): WorkbenchSnapshot {
    return this.snapshot;
  }

  subscribe(listener: SnapshotListener): () => void {
    this.listeners.add(listener);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.listeners.delete(listener);
    };
  }

  async dispatch(command: WorkbenchCommand): Promise<WorkbenchCommandResult> {
    if (command.type === "refresh") {
      this.refresh();
      return { ok: true };
    }
    if (!this.commandHandler) {
      return { ok: false, error: "workbench_controller_unavailable" };
    }
    try {
      const result = await this.commandHandler(command);
      this.lastCommandError = result.ok ? undefined : result.error;
      this.refresh();
      return Object.freeze({ ...result });
    } catch (error) {
      this.lastCommandError =
        error instanceof Error ? error.message : String(error);
      this.refresh();
      return { ok: false, error: this.lastCommandError };
    }
  }

  setCommandHandler(handler: WorkbenchCommandHandler): () => void {
    if (this.commandHandler && this.commandHandler !== handler) {
      throw new Error("Workbench command handler is already installed.");
    }
    this.commandHandler = handler;
    let installed = true;
    return () => {
      if (!installed) return;
      installed = false;
      if (this.commandHandler === handler) this.commandHandler = undefined;
    };
  }

  reportCommandError(error: string | undefined): void {
    this.lastCommandError = error;
    this.refresh();
  }

  upsertConversation(record: ConversationRecord): void {
    const previous = this.conversations.get(record.id);
    this.conversations.set(
      record.id,
      freezeConversation(previous ? { ...previous, ...record } : record),
    );
    this.refresh();
  }

  removeConversation(id: string): boolean {
    const removed = this.conversations.delete(id);
    if (removed) this.refresh();
    return removed;
  }

  upsertWorkflow(record: WorkflowRecord): void {
    this.workflows.set(record.id, freezeWorkflow(record));
    this.refresh();
  }

  removeWorkflow(id: string): boolean {
    const removed = this.workflows.delete(id);
    if (removed) this.refresh();
    return removed;
  }

  refresh(): WorkbenchSnapshot {
    this.snapshot = this.buildSnapshot();
    for (const listener of [...this.listeners]) {
      try {
        listener(this.snapshot);
      } catch {
        // One extension view cannot break runtime state publication.
      }
    }
    return this.snapshot;
  }

  dispose(): void {
    this.unsubscribeGovernor();
    this.listeners.clear();
    this.commandHandler = undefined;
    this.conversations.clear();
    this.workflows.clear();
  }

  private buildSnapshot(): WorkbenchSnapshot {
    const governor = this.governor.snapshot();
    let running = 0;
    let completed = 0;
    let needsAttention = 0;
    let stalled = 0;
    let lastHeartbeatAt: number | undefined;

    for (const conversation of this.conversations.values()) {
      if (conversation.status === "running") running++;
      if (
        conversation.status === "completed" ||
        conversation.status === "idle"
      ) {
        completed++;
      }
      if (
        conversation.needsAttention ||
        conversation.status === "failed" ||
        conversation.status === "interrupted"
      ) {
        needsAttention++;
      }
      if (conversation.stalled) stalled++;
      if (
        conversation.lastHeartbeatAt !== undefined &&
        (lastHeartbeatAt === undefined ||
          conversation.lastHeartbeatAt > lastHeartbeatAt)
      ) {
        lastHeartbeatAt = conversation.lastHeartbeatAt;
      }
    }

    let activeWorkflows = 0;
    let failedWorkflows = 0;
    for (const workflow of this.workflows.values()) {
      if (workflow.status === "running" || workflow.status === "paused") {
        activeWorkflows++;
      }
      if (workflow.status === "failed" || workflow.status === "cancelled") {
        failedWorkflows++;
      }
    }

    return Object.freeze({
      apiVersion: WORKBENCH_API_VERSION,
      revision: ++this.revision,
      generatedAt: Date.now(),
      governor: Object.freeze({
        active: governor.active,
        queued: governor.queued,
        activeLimit: governor.activeLimit,
        queueLimit: governor.queueLimit,
        protection: "normal" as const,
      }),
      runHealth: Object.freeze({
        running,
        stalled,
        ...(lastHeartbeatAt === undefined ? {} : { lastHeartbeatAt }),
      }),
      conversations: Object.freeze({
        total: this.conversations.size,
        running,
        needsAttention,
        completed,
        items: Object.freeze([...this.conversations.values()]),
      }),
      ...(this.lastCommandError === undefined
        ? {}
        : { lastCommandError: this.lastCommandError }),
      workflows: Object.freeze({
        total: this.workflows.size,
        active: activeWorkflows,
        failed: failedWorkflows,
        items: Object.freeze([...this.workflows.values()]),
      }),
    });
  }
}

export function getWorkbenchRuntimeHost(): WorkbenchRuntimeHost {
  const globals = globalRecord();
  const existing = globals[WORKBENCH_HOST_SYMBOL];
  if (existing instanceof WorkbenchRuntimeHost) return existing;
  const host = new WorkbenchRuntimeHost();
  globals[WORKBENCH_HOST_SYMBOL] = host;
  return host;
}

export function createWorkbenchRuntimeHost(): WorkbenchRuntimeHost {
  return new WorkbenchRuntimeHost();
}

export function installWorkbenchRuntime(): WorkbenchRuntimeHost {
  const host = getWorkbenchRuntimeHost();
  globalRecord()[WORKBENCH_RUNTIME_SYMBOL] = host;
  host.refresh();
  return host;
}

export function uninstallWorkbenchRuntime(): void {
  const globals = globalRecord();
  const host = globals[WORKBENCH_HOST_SYMBOL];
  if (globals[WORKBENCH_RUNTIME_SYMBOL] === host) {
    delete globals[WORKBENCH_RUNTIME_SYMBOL];
  }
  if (host instanceof WorkbenchRuntimeHost) host.dispose();
  delete globals[WORKBENCH_HOST_SYMBOL];
}
