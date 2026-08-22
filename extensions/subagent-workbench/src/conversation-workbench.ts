import * as PiCodingAgent from "@earendil-works/pi-coding-agent";
import type {
  ExtensionCommandContext,
  KeybindingsManager,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  ScrollView,
  VStack,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type Focusable,
  type TUI,
} from "@earendil-works/pi-tui";
import type {
  ConversationRecord,
  SubagentWorkbenchRuntime,
  WorkflowRecord,
  WorkflowStageRecord,
  WorkflowTaskRecord,
  WorkbenchCommandResult,
  WorkbenchSnapshot,
} from "./runtime.ts";

const {
  AssistantMessageComponent,
  CustomEditor,
  ToolExecutionComponent,
  UserMessageComponent,
} = PiCodingAgent;

type FooterViewModel = {
  readonly pwd: string;
  readonly statsLeft: string;
  readonly modelName: string;
  readonly provider?: string;
  readonly availableProviderCount?: number;
  readonly reasoning?: boolean;
  readonly thinkingLevel?: string;
};

type FooterViewModelComponentConstructor = new (
  model: FooterViewModel,
) => Component;

type HostWorkbenchUiExports = {
  readonly FooterViewModelComponent?: FooterViewModelComponentConstructor;
  readonly getEditorTheme?: () => ConstructorParameters<
    typeof CustomEditor
  >[1];
};

const {
  FooterViewModelComponent: HostFooterViewModelComponent,
  getEditorTheme: hostGetEditorTheme,
} = PiCodingAgent as unknown as HostWorkbenchUiExports;

const getEditorTheme = (): ConstructorParameters<typeof CustomEditor>[1] =>
  hostGetEditorTheme?.() ?? {
    borderColor: (text: string) => text,
    selectList: {
      selectedPrefix: (text: string) => text,
      selectedText: (text: string) => text,
      description: (text: string) => text,
      scrollInfo: (text: string) => text,
      noMatch: (text: string) => text,
    },
  };

class FallbackFooterViewModelComponent implements Component {
  constructor(private readonly model: FooterViewModel) {}

  render(width: number): string[] {
    const reasoning = this.model.reasoning && this.model.thinkingLevel
      ? ` • ${this.model.thinkingLevel}`
      : "";
    const provider = this.model.provider ? ` · ${this.model.provider}` : "";
    return [
      truncateToWidth(
        ` ${this.model.modelName}${reasoning}${provider} · ${this.model.statsLeft}`,
        width,
      ),
    ];
  }

  invalidate(): void {}
}

const FooterViewModelComponent =
  HostFooterViewModelComponent ?? FallbackFooterViewModelComponent;

const LIST_ROWS = 10;

type WorkbenchContext = Pick<ExtensionCommandContext, "cwd" | "model" | "ui">;

type Route =
  | { readonly kind: "list" }
  | { readonly kind: "agent"; readonly sessionId: string }
  | { readonly kind: "workflow"; readonly workflowId: string };

interface Target {
  readonly id: string;
  readonly label: string;
  readonly conversation?: ConversationRecord;
  readonly workflow?: WorkflowRecord;
}

interface WorkflowEntry {
  readonly id: string;
  readonly kind: "stage" | "task";
  readonly stage: WorkflowStageRecord;
  readonly task?: WorkflowTaskRecord;
}

interface ConversationWorkbenchCallbacks {
  readonly close: () => void;
  readonly newAgent: () => Promise<void>;
  readonly sendAgent: (
    sessionId: string,
    message: string,
  ) => Promise<WorkbenchCommandResult>;
  readonly interruptAgent: (
    sessionId: string,
  ) => Promise<WorkbenchCommandResult>;
  readonly interruptWorkflow: (
    workflowId: string,
  ) => Promise<WorkbenchCommandResult>;
  readonly pauseWorkflow: (
    workflowId: string,
  ) => Promise<WorkbenchCommandResult>;
  readonly resumeWorkflow: (
    workflowId: string,
  ) => Promise<WorkbenchCommandResult>;
}

export interface ConversationWorkbenchHandle {
  close(): void;
}

export interface ConversationWorkbenchOptions {
  readonly initialTargetId?: string;
}

function statusSymbol(
  conversation: Pick<ConversationRecord, "status">,
): string {
  switch (conversation.status) {
    case "running":
      return "●";
    case "completed":
    case "idle":
      return "✓";
    case "failed":
      return "!";
    case "interrupted":
      return "‖";
    case "cancelled":
      return "×";
    default:
      return "○";
  }
}

function workflowStatusSymbol(
  workflow: Pick<WorkflowRecord, "status">,
): string {
  switch (workflow.status) {
    case "running":
      return "◆";
    case "paused":
      return "Ⅱ";
    case "completed":
      return "✓";
    case "failed":
      return "!";
    case "cancelled":
      return "×";
    default:
      return "◇";
  }
}

function statusColor(
  status: string,
): "success" | "warning" | "error" | "muted" | "accent" {
  if (status === "running") return "success";
  if (status === "paused") return "warning";
  if (status === "failed") return "error";
  if (status === "interrupted" || status === "cancelled") return "warning";
  if (status === "queued") return "muted";
  return "accent";
}

function cleanLabel(label: string): string {
  return label.replace(/\s+/g, " ").trim() || "Untitled";
}

function fit(text: string, width: number): string {
  const clipped = truncateToWidth(text, Math.max(0, width), "…");
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

function activeModel(ctx: WorkbenchContext): string | undefined {
  return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
}

class ConversationWorkbenchComponent implements Component, Focusable {
  private snapshot: WorkbenchSnapshot;
  private readonly unsubscribe: () => void;
  private readonly routes: Route[];
  private selectedListId = "main";
  private readonly selectedWorkflowEntry = new Map<string, string>();
  private readonly collapsedStages = new Set<string>();
  private readonly transcriptOffsets = new Map<string, number>();
  private readonly drafts = new Map<string, string>();
  private readonly followUpInput: InstanceType<typeof CustomEditor>;
  private help = false;
  private disposed = false;
  private sending = false;
  private notice: string | undefined;
  private renderError: string | undefined;
  private _focused = false;

  constructor(
    private readonly runtime: SubagentWorkbenchRuntime,
    private readonly tui: TUI,
    private readonly cwd: string,
    keybindings: KeybindingsManager,
    private readonly theme: Theme,
    private readonly requestRender: () => void,
    private readonly viewportRows: () => number,
    private readonly callbacks: ConversationWorkbenchCallbacks,
    initialTargetId?: string,
  ) {
    this.snapshot = runtime.getSnapshot();
    this.routes = this.initialRoutes(initialTargetId);
    this.followUpInput = new CustomEditor(tui, getEditorTheme(), keybindings);
    this.followUpInput.onSubmit = (text) => {
      void this.submitFollowUp(text);
    };
    this.unsubscribe = runtime.subscribe((snapshot) => {
      if (this.disposed) return;
      this.snapshot = snapshot;
      this.reconcileRoute();
      this.requestRender();
    });
    this.syncInput();
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.updateInputFocus();
  }

  handleInput(input: string): void {
    try {
      this.handleInputSafe(input);
    } catch (error) {
      this.renderError = error instanceof Error ? error.message : String(error);
      this.requestRender();
    }
  }

  render(width: number): string[] {
    try {
      this.renderError = undefined;
      if (width <= 0) return [];
      if (width < 24) {
        return this.fillViewport(
          [truncateToWidth("Subagent Workbench needs 24 columns", width)],
          width,
        );
      }
      return this.fillViewport(
        [...this.renderRouteDocument(width), ...this.renderRouteDock(width)],
        width,
      );
    } catch (error) {
      this.renderError = error instanceof Error ? error.message : String(error);
      return this.fillViewport(
        [
          truncateToWidth("Subagent Workbench UI 暂时不可用", width),
          truncateToWidth("后台 Agent 不受影响 · Esc 返回 Main", width),
          truncateToWidth(`Error: ${this.renderError}`, width),
        ],
        width,
      );
    }
  }

  renderRouteDocument(width: number): string[] {
    if (this.help) return this.renderHelp(width);
    const route = this.currentRoute();
    if (route.kind === "agent") return this.renderAgentDocument(width, route);
    if (route.kind === "workflow") return this.renderWorkflow(width, route);
    return this.renderList(width);
  }

  renderRouteDock(width: number): string[] {
    if (this.help) return [];
    const route = this.currentRoute();
    return route.kind === "agent" ? this.renderAgentDock(width, route) : [];
  }

  private fillViewport(lines: string[], width: number): string[] {
    const height = Math.max(1, Math.floor(this.viewportRows()));
    if (lines.length >= height) {
      if (height < 4) return lines.slice(0, height);
      const footerRows = Math.min(3, height - 1);
      return [
        ...lines.slice(0, height - footerRows),
        ...lines.slice(-footerRows),
      ];
    }
    if (lines.length === 0) return Array.from({ length: height }, () => "");
    const bottom = lines.at(-1)!;
    return [
      ...lines.slice(0, -1),
      ...Array.from({ length: height - lines.length }, () => " ".repeat(width)),
      bottom,
    ];
  }

  invalidate(): void {
    this.followUpInput.invalidate();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe();
  }

  private initialRoutes(initialTargetId?: string): Route[] {
    if (!initialTargetId || initialTargetId === "main") {
      return [{ kind: "list" }];
    }
    const workflow = this.snapshot.workflows.items.find(
      (item) => item.id === initialTargetId,
    );
    if (workflow) return [{ kind: "workflow", workflowId: workflow.id }];
    const conversation = this.snapshot.conversations.items.find(
      (item) => item.id === initialTargetId,
    );
    if (!conversation) return [{ kind: "list" }];
    if (conversation.workflowId) {
      return [
        { kind: "workflow", workflowId: conversation.workflowId },
        { kind: "agent", sessionId: conversation.id },
      ];
    }
    return [{ kind: "agent", sessionId: conversation.id }];
  }

  private currentRoute(): Route {
    return this.routes.at(-1) ?? { kind: "list" };
  }

  private currentConversation(): ConversationRecord | undefined {
    const route = this.currentRoute();
    if (route.kind !== "agent") return undefined;
    return this.snapshot.conversations.items.find(
      (conversation) => conversation.id === route.sessionId,
    );
  }

  private currentWorkflow(): WorkflowRecord | undefined {
    const route = this.currentRoute();
    if (route.kind !== "workflow") return undefined;
    return this.snapshot.workflows.items.find(
      (workflow) => workflow.id === route.workflowId,
    );
  }

  private updateInputFocus(): void {
    const conversation = this.currentConversation();
    this.followUpInput.focused = Boolean(
      this._focused && conversation && !conversation.workflowId,
    );
  }

  private syncInput(): void {
    const conversation = this.currentConversation();
    if (!conversation || conversation.workflowId) {
      this.followUpInput.focused = false;
      return;
    }
    const draft = this.drafts.get(conversation.id) ?? "";
    if (this.followUpInput.getText() !== draft) {
      this.followUpInput.setText(draft);
    }
    this.updateInputFocus();
  }

  private navigate(route: Route): void {
    this.routes.push(route);
    this.notice = undefined;
    this.syncInput();
    this.requestRender();
  }

  private back(): void {
    if (this.routes.length > 1) {
      this.routes.pop();
      this.notice = undefined;
      this.syncInput();
      this.requestRender();
      return;
    }
    this.callbacks.close();
  }

  private reconcileRoute(): void {
    const route = this.currentRoute();
    if (
      route.kind === "agent" &&
      !this.snapshot.conversations.items.some(
        (conversation) => conversation.id === route.sessionId,
      )
    ) {
      this.routes.pop();
    } else if (
      route.kind === "workflow" &&
      !this.snapshot.workflows.items.some(
        (workflow) => workflow.id === route.workflowId,
      )
    ) {
      this.routes.pop();
    }
    if (this.routes.length === 0) this.routes.push({ kind: "list" });
    this.syncInput();
  }

  private handleInputSafe(input: string): void {
    if (this.help) {
      if (matchesKey(input, "escape") || input === "?") {
        this.help = false;
        this.requestRender();
      }
      return;
    }
    if (input === "?") {
      this.help = true;
      this.requestRender();
      return;
    }
    const route = this.currentRoute();
    if (route.kind === "agent") {
      this.handleAgentInput(input);
      return;
    }
    if (route.kind === "workflow") {
      this.handleWorkflowInput(input);
      return;
    }
    this.handleListInput(input);
  }

  private handleListInput(input: string): void {
    if (matchesKey(input, "escape") || input.toLowerCase() === "q") {
      this.callbacks.close();
      return;
    }
    if (input.toLowerCase() === "n") {
      void this.callbacks.newAgent();
      return;
    }
    const targets = this.targets();
    const current = Math.max(
      0,
      targets.findIndex((target) => target.id === this.selectedListId),
    );
    if (matchesKey(input, "up") || matchesKey(input, "left")) {
      this.selectedListId =
        targets[(current - 1 + targets.length) % targets.length]!.id;
      this.requestRender();
      return;
    }
    if (matchesKey(input, "down") || matchesKey(input, "right")) {
      this.selectedListId = targets[(current + 1) % targets.length]!.id;
      this.requestRender();
      return;
    }
    if (matchesKey(input, "enter")) {
      const target = targets[current] ?? targets[0]!;
      if (target.id === "main") this.callbacks.close();
      else if (target.workflow) {
        this.navigate({ kind: "workflow", workflowId: target.workflow.id });
      } else if (target.conversation) {
        this.navigate({ kind: "agent", sessionId: target.conversation.id });
      }
      return;
    }
    const target = targets[current];
    if (input.toLowerCase() === "i" && target?.conversation) {
      void this.interruptAgent(target.conversation.id);
    } else if (input.toLowerCase() === "i" && target?.workflow) {
      void this.interruptWorkflow(target.workflow.id);
    }
  }

  private handleAgentInput(input: string): void {
    const conversation = this.currentConversation();
    if (!conversation) {
      this.back();
      return;
    }
    if (matchesKey(input, "escape")) {
      this.back();
      return;
    }
    if (matchesKey(input, "f6")) {
      this.routes.splice(0, this.routes.length, { kind: "list" });
      this.syncInput();
      this.requestRender();
      return;
    }
    if (matchesKey(input, "pageUp")) {
      this.changeTranscriptOffset(
        conversation.id,
        Math.max(4, Math.floor(this.viewportRows()) - 12),
      );
      return;
    }
    if (matchesKey(input, "pageDown")) {
      this.changeTranscriptOffset(
        conversation.id,
        -Math.max(4, Math.floor(this.viewportRows()) - 12),
      );
      return;
    }
    if (matchesKey(input, "end")) {
      this.transcriptOffsets.set(conversation.id, 0);
      this.requestRender();
      return;
    }
    if (matchesKey(input, "ctrl+c")) {
      void this.interruptAgent(conversation.id);
      return;
    }
    if (conversation.workflowId) {
      if (input.toLowerCase() === "i") {
        void this.interruptAgent(conversation.id);
      }
      return;
    }
    this.followUpInput.handleInput(input);
    this.drafts.set(conversation.id, this.followUpInput.getText());
    this.requestRender();
  }

  private handleWorkflowInput(input: string): void {
    const workflow = this.currentWorkflow();
    if (!workflow) {
      this.back();
      return;
    }
    if (matchesKey(input, "escape")) {
      this.back();
      return;
    }
    if (matchesKey(input, "f6")) {
      this.routes.splice(0, this.routes.length, { kind: "list" });
      this.requestRender();
      return;
    }
    const entries = this.workflowEntries(workflow);
    if (entries.length === 0) return;
    const selectedId =
      this.selectedWorkflowEntry.get(workflow.id) ?? entries[0]!.id;
    let index = Math.max(
      0,
      entries.findIndex((entry) => entry.id === selectedId),
    );
    if (matchesKey(input, "up")) {
      index = (index - 1 + entries.length) % entries.length;
      this.selectedWorkflowEntry.set(workflow.id, entries[index]!.id);
      this.requestRender();
      return;
    }
    if (matchesKey(input, "down")) {
      index = (index + 1) % entries.length;
      this.selectedWorkflowEntry.set(workflow.id, entries[index]!.id);
      this.requestRender();
      return;
    }
    const selected = entries[index]!;
    if (matchesKey(input, "left") && selected.kind === "stage") {
      this.collapsedStages.add(selected.stage.id);
      this.requestRender();
      return;
    }
    if (matchesKey(input, "right") && selected.kind === "stage") {
      this.collapsedStages.delete(selected.stage.id);
      this.requestRender();
      return;
    }
    if (matchesKey(input, "enter") && selected.task) {
      const conversation = this.conversationForTask(workflow, selected.task);
      if (conversation) {
        this.navigate({ kind: "agent", sessionId: conversation.id });
      } else {
        this.notice = "This Workflow Agent has not started yet.";
        this.requestRender();
      }
      return;
    }
    if (input.toLowerCase() === "p") {
      if (workflow.status === "paused") {
        void this.resumeWorkflow(workflow.id);
      } else if (workflow.status === "running") {
        void this.pauseWorkflow(workflow.id);
      }
      return;
    }
    if (input === "I") {
      void this.interruptWorkflow(workflow.id);
      return;
    }
    if (input.toLowerCase() === "i") {
      const conversation = selected.task
        ? this.conversationForTask(workflow, selected.task)
        : undefined;
      if (conversation) void this.interruptAgent(conversation.id);
      else void this.interruptWorkflow(workflow.id);
    }
  }

  private async submitFollowUp(text: string): Promise<void> {
    const conversation = this.currentConversation();
    const message = text.trim();
    if (!conversation || conversation.workflowId || !message || this.sending) {
      return;
    }
    this.sending = true;
    this.notice = conversation.activeRunId
      ? "Queueing Follow-up after the active Run…"
      : "Sending Follow-up…";
    this.requestRender();
    try {
      const result = await this.callbacks.sendAgent(conversation.id, message);
      if (result.ok) {
        this.drafts.set(conversation.id, "");
        this.followUpInput.setText("");
        this.notice =
          result.accepted === "queued"
            ? "Follow-up queued for this ChildSession."
            : "Follow-up accepted by this ChildSession.";
      } else {
        this.notice = `Follow-up rejected: ${result.error ?? "unknown error"}`;
      }
    } finally {
      this.sending = false;
      this.requestRender();
    }
  }

  private async interruptAgent(sessionId: string): Promise<void> {
    const result = await this.callbacks.interruptAgent(sessionId);
    this.notice = result.ok
      ? "Agent Run interrupted."
      : `Interrupt failed: ${result.error ?? "unknown error"}`;
    this.requestRender();
  }

  private async pauseWorkflow(workflowId: string): Promise<void> {
    const result = await this.callbacks.pauseWorkflow(workflowId);
    this.notice = result.ok
      ? "Workflow paused at the next stage boundary."
      : `Workflow pause failed: ${result.error ?? "unknown error"}`;
    this.requestRender();
  }

  private async resumeWorkflow(workflowId: string): Promise<void> {
    const result = await this.callbacks.resumeWorkflow(workflowId);
    this.notice = result.ok
      ? "Workflow resumed."
      : `Workflow resume failed: ${result.error ?? "unknown error"}`;
    this.requestRender();
  }

  private async interruptWorkflow(workflowId: string): Promise<void> {
    const result = await this.callbacks.interruptWorkflow(workflowId);
    this.notice = result.ok
      ? "Workflow interrupted."
      : `Workflow interrupt failed: ${result.error ?? "unknown error"}`;
    this.requestRender();
  }

  private changeTranscriptOffset(id: string, delta: number): void {
    this.transcriptOffsets.set(
      id,
      Math.max(0, (this.transcriptOffsets.get(id) ?? 0) + delta),
    );
    this.requestRender();
  }

  private targets(): Target[] {
    return [
      { id: "main", label: "Main" },
      ...this.snapshot.conversations.items
        .filter((conversation) => !conversation.workflowId)
        .map((conversation) => ({
          id: conversation.id,
          label: conversation.label,
          conversation,
        })),
      ...this.snapshot.workflows.items.map((workflow) => ({
        id: workflow.id,
        label: workflow.label,
        workflow,
      })),
    ];
  }

  private workflowEntries(workflow: WorkflowRecord): WorkflowEntry[] {
    const entries: WorkflowEntry[] = [];
    for (const stage of workflow.stages ?? []) {
      entries.push({ id: stage.id, kind: "stage", stage });
      if (this.collapsedStages.has(stage.id)) continue;
      for (const task of stage.tasks) {
        entries.push({ id: task.id, kind: "task", stage, task });
      }
    }
    const selected = this.selectedWorkflowEntry.get(workflow.id);
    if (!selected || !entries.some((entry) => entry.id === selected)) {
      const preferred = entries.find(
        (entry) => entry.task?.status === "running",
      );
      this.selectedWorkflowEntry.set(
        workflow.id,
        preferred?.id ?? entries[0]?.id ?? "",
      );
    }
    return entries;
  }

  private conversationForTask(
    workflow: WorkflowRecord,
    task: WorkflowTaskRecord,
  ): ConversationRecord | undefined {
    if (task.sessionId) {
      const exact = this.snapshot.conversations.items.find(
        (conversation) => conversation.id === task.sessionId,
      );
      if (exact) return exact;
    }
    return this.snapshot.conversations.items.find(
      (conversation) =>
        conversation.workflowId === workflow.id &&
        conversation.label === task.label,
    );
  }

  private renderList(width: number): string[] {
    const panelWidth = width;
    const inner = panelWidth - 2;
    const frame = (text = ""): string =>
      `${this.theme.fg("border", "│")}${fit(text, inner)}${this.theme.fg("border", "│")}`;
    const border = (left: string, right: string): string =>
      this.theme.fg("border", `${left}${"─".repeat(inner)}${right}`);
    const targets = this.targets();
    if (!targets.some((target) => target.id === this.selectedListId)) {
      this.selectedListId = "main";
    }
    const selectedIndex = Math.max(
      0,
      targets.findIndex((target) => target.id === this.selectedListId),
    );
    const start = Math.max(
      0,
      Math.min(
        selectedIndex - Math.floor(LIST_ROWS / 2),
        Math.max(0, targets.length - LIST_ROWS),
      ),
    );
    const rows = [
      border("╭", "╮"),
      frame(
        ` ${this.theme.fg("accent", this.theme.bold("Subagent Workbench"))}` +
          this.theme.fg("dim", ` · revision ${this.snapshot.revision}`),
      ),
      frame(
        ` agents ${this.snapshot.conversations.total} · workflows ${this.snapshot.workflows.total} · active ${this.snapshot.governor.active}/${this.snapshot.governor.activeLimit}`,
      ),
      frame(""),
    ];
    for (const target of targets.slice(start, start + LIST_ROWS)) {
      const selected = target.id === this.selectedListId;
      const prefix = selected ? this.theme.fg("accent", "▸ ") : "  ";
      if (target.conversation) {
        rows.push(
          frame(
            `${prefix}${this.theme.fg(statusColor(target.conversation.status), statusSymbol(target.conversation))} ${this.theme.fg(selected ? "accent" : "text", cleanLabel(target.label))} ${this.theme.fg("dim", target.conversation.status)}`,
          ),
        );
      } else if (target.workflow) {
        rows.push(
          frame(
            `${prefix}${this.theme.fg(statusColor(target.workflow.status), workflowStatusSymbol(target.workflow))} ${this.theme.fg(selected ? "accent" : "text", `Workflow · ${cleanLabel(target.label)}`)} ${this.theme.fg("dim", target.workflow.status)}`,
          ),
        );
      } else {
        rows.push(frame(`${prefix}${this.theme.fg("accent", "Main")}`));
      }
    }
    while (rows.length < LIST_ROWS + 4) rows.push(frame(""));
    if (this.notice)
      rows.push(frame(this.theme.fg("warning", ` ${this.notice}`)));
    rows.push(
      frame(
        this.theme.fg(
          "dim",
          " ↑↓/←→ select · Enter open · n new Agent · i interrupt · Esc Main · ? help",
        ),
      ),
    );
    rows.push(border("╰", "╯"));
    return rows;
  }

  private renderAgentDocument(
    width: number,
    route: Extract<Route, { kind: "agent" }>,
  ): string[] {
    const conversation = this.snapshot.conversations.items.find(
      (item) => item.id === route.sessionId,
    );
    if (!conversation) return this.renderList(width);
    const readOnly = Boolean(conversation.workflowId);
    const rows = [
      fit(
        ` ${this.theme.fg("accent", this.theme.bold(`${readOnly ? "Workflow Agent" : "Subagent"} · ${cleanLabel(conversation.label)}`))}` +
          ` ${this.theme.fg(statusColor(conversation.status), `${statusSymbol(conversation)} ${conversation.status}`)}`,
        width,
      ),
      fit(
        this.theme.fg(
          "dim",
          ` ${readOnly ? `Workflow ${conversation.workflowId} › ` : "Main › Subagent › "}${conversation.id}`,
        ),
        width,
      ),
    ];
    if (conversation.transcriptTruncated) {
      rows.push(
        fit(this.theme.fg("warning", " … earlier transcript evicted"), width),
      );
    }
    rows.push(...this.nativeTimelineLines(conversation, width));
    return rows;
  }

  private renderAgentDock(
    width: number,
    route: Extract<Route, { kind: "agent" }>,
  ): string[] {
    const conversation = this.snapshot.conversations.items.find(
      (item) => item.id === route.sessionId,
    );
    if (!conversation) return [];
    const readOnly = Boolean(conversation.workflowId);
    const rows: string[] = [];
    if (conversation.error) {
      rows.push(
        fit(this.theme.fg("error", ` Error: ${conversation.error}`), width),
      );
    }
    if (this.notice) {
      rows.push(fit(this.theme.fg("warning", ` ${this.notice}`), width));
    }
    rows.push(
      fit(
        this.theme.fg(
          "dim",
          ` Session ${conversation.id}` +
            (conversation.activeRunId
              ? ` · Run ${conversation.activeRunId}`
              : " · ready") +
            (readOnly ? " · read-only" : ""),
        ),
        width,
      ),
    );
    if (!readOnly) {
      rows.push(
        ...this.followUpInput.render(width).map((line) => fit(line, width)),
      );
    }
    rows.push(...this.renderAgentFooter(conversation, width));
    rows.push(
      fit(
        this.theme.fg(
          "dim",
          readOnly
            ? " PgUp/PgDn scroll · End latest · i interrupt · Esc Workflow · ? help"
            : " Enter send/queue · Ctrl+C interrupt · PgUp/PgDn · F6 switch · Esc Main",
        ),
        width,
      ),
    );
    return rows;
  }

  private renderAgentFooter(
    conversation: ConversationRecord,
    width: number,
  ): string[] {
    const latestAssistant = [...(conversation.timeline ?? [])]
      .reverse()
      .find((entry) => entry.type === "assistant");
    const usage = conversation.usage;
    const usageParts = usage
      ? [
          usage.input ? `↑${usage.input}` : "",
          usage.output ? `↓${usage.output}` : "",
          usage.cacheRead ? `R${usage.cacheRead}` : "",
          usage.cacheWrite ? `W${usage.cacheWrite}` : "",
          usage.cost ? `$${usage.cost.toFixed(3)}` : "",
        ].filter(Boolean)
      : [];
    const modelProvider =
      conversation.provider ??
      (latestAssistant?.type === "assistant"
        ? latestAssistant.provider
        : undefined);
    return new FooterViewModelComponent({
      pwd: `${this.cwd} • ${cleanLabel(conversation.label)}`,
      statsLeft: [
        `${statusSymbol(conversation)} ${conversation.status}`,
        `tools ${(conversation.timeline ?? []).filter((entry) => entry.type === "tool").length}`,
        ...usageParts,
        ...(conversation.activeRunId ? ["• streaming"] : []),
      ].join(" "),
      modelName:
        conversation.model ??
        (latestAssistant?.type === "assistant"
          ? (latestAssistant.model ?? "subagent")
          : "subagent"),
      ...(modelProvider ? { provider: modelProvider } : {}),
      reasoning:
        conversation.thinkingLevel !== undefined
          ? true
          : (conversation.timeline ?? []).some(
              (entry) =>
                entry.type === "assistant" &&
                entry.content.some((block) => block.type === "thinking"),
            ),
      ...(conversation.thinkingLevel
        ? { thinkingLevel: conversation.thinkingLevel }
        : {}),
    }).render(width);
  }

  private renderWorkflow(
    width: number,
    route: Extract<Route, { kind: "workflow" }>,
  ): string[] {
    const workflow = this.snapshot.workflows.items.find(
      (item) => item.id === route.workflowId,
    );
    if (!workflow) return this.renderList(width);
    const panelWidth = width;
    const inner = panelWidth - 2;
    const border = (left: string, right: string): string =>
      this.theme.fg("border", `${left}${"─".repeat(inner)}${right}`);
    const frame = (text = ""): string =>
      `${this.theme.fg("border", "│")}${fit(text, inner)}${this.theme.fg("border", "│")}`;
    const entries = this.workflowEntries(workflow);
    const selectedId =
      this.selectedWorkflowEntry.get(workflow.id) ?? entries[0]?.id;
    const selectedIndex = Math.max(
      0,
      entries.findIndex((entry) => entry.id === selectedId),
    );
    const selected = entries[selectedIndex];
    const selectedConversation = selected?.task
      ? this.conversationForTask(workflow, selected.task)
      : undefined;
    const selectedConfiguration = selectedConversation
      ? [
          selectedConversation.provider && selectedConversation.model
            ? `${selectedConversation.provider}/${selectedConversation.model}`
            : selectedConversation.model,
          selectedConversation.thinkingLevel
            ? `effort ${selectedConversation.thinkingLevel}`
            : undefined,
        ]
          .filter(Boolean)
          .join(" · ")
      : "";
    const output = selectedConversation
      ? this.nativeTimelineLines(selectedConversation, Math.max(20, inner - 40))
      : [
          selected?.task?.error ??
            (selected?.task
              ? "Agent has not started or has no output yet."
              : "Select a Workflow Agent to inspect live output."),
        ];
    const leftLines = entries.map((entry) => {
      const pointer = entry.id === selectedId ? "▸ " : "  ";
      if (entry.kind === "stage") {
        const folded = this.collapsedStages.has(entry.stage.id) ? "▸" : "▾";
        return `${pointer}${folded} ${workflowStatusSymbol({ status: entry.stage.status })} ${cleanLabel(entry.stage.label)}`;
      }
      return `${pointer}  ${statusSymbol({ status: entry.task!.status })} ${cleanLabel(entry.task!.label)}`;
    });
    const wideLayout = inner >= 72;
    const extraRows =
      Number(Boolean(workflow.error)) + Number(Boolean(this.notice));
    const contentRows = Math.max(
      4,
      Math.floor(this.viewportRows()) - (wideLayout ? 9 : 11) - extraRows,
    );
    const leftRows = wideLayout
      ? contentRows
      : Math.max(2, Math.ceil(contentRows * 0.45));
    const outputRows = wideLayout
      ? contentRows
      : Math.max(2, contentRows - leftRows);
    const leftStart = Math.max(
      0,
      Math.min(
        selectedIndex - Math.floor(leftRows / 2),
        Math.max(0, leftLines.length - leftRows),
      ),
    );
    const visibleLeft = leftLines.slice(leftStart, leftStart + leftRows);
    const visibleOutput = output.slice(Math.max(0, output.length - outputRows));
    const rows = [
      border("╭", "╮"),
      frame(
        ` ${this.theme.fg("accent", this.theme.bold(`Workflow · ${cleanLabel(workflow.label)}`))}` +
          ` ${this.theme.fg(statusColor(workflow.status), `${workflowStatusSymbol(workflow)} ${workflow.status}`)}` +
          (workflow.currentStage === undefined
            ? ""
            : ` · Stage ${workflow.currentStage + 1}/${workflow.stages?.length ?? "?"}`),
      ),
      frame(` Main › Workflow › ${workflow.id}`),
    ];

    if (wideLayout) {
      const leftWidth = Math.min(38, Math.floor(inner * 0.38));
      const rightWidth = inner - leftWidth - 1;
      rows.push(
        `${this.theme.fg("border", "├")}${"─".repeat(leftWidth)}${this.theme.fg("border", "┬")}${"─".repeat(rightWidth)}${this.theme.fg("border", "┤")}`,
      );
      rows.push(
        `${this.theme.fg("border", "│")}${fit(" Stages", leftWidth)}${this.theme.fg("border", "│")}${fit(` Live Output${selectedConfiguration ? ` · ${selectedConfiguration}` : ""}`, rightWidth)}${this.theme.fg("border", "│")}`,
      );
      for (let index = 0; index < contentRows; index++) {
        const left = visibleLeft[index] ?? "";
        const right = visibleOutput[index] ?? "";
        rows.push(
          `${this.theme.fg("border", "│")}${fit(` ${left}`, leftWidth)}${this.theme.fg("border", "│")}${fit(` ${right}`, rightWidth)}${this.theme.fg("border", "│")}`,
        );
      }
      rows.push(
        `${this.theme.fg("border", "├")}${"─".repeat(leftWidth)}${this.theme.fg("border", "┴")}${"─".repeat(rightWidth)}${this.theme.fg("border", "┤")}`,
      );
    } else {
      rows.push(border("├", "┤"));
      rows.push(frame(" Stages"));
      for (let index = 0; index < leftRows; index++) {
        rows.push(frame(` ${visibleLeft[index] ?? ""}`));
      }
      rows.push(border("├", "┤"));
      rows.push(
        frame(
          ` Live Output${selectedConfiguration ? ` · ${selectedConfiguration}` : ""}`,
        ),
      );
      for (let index = 0; index < outputRows; index++) {
        rows.push(frame(` ${visibleOutput[index] ?? ""}`));
      }
      rows.push(border("├", "┤"));
    }
    const tasks = (workflow.stages ?? []).flatMap((stage) => stage.tasks);
    rows.push(
      frame(
        ` running ${tasks.filter((task) => task.status === "running").length} · queued ${tasks.filter((task) => task.status === "queued").length} · completed ${tasks.filter((task) => task.status === "completed").length}`,
      ),
    );
    if (workflow.error) {
      rows.push(frame(this.theme.fg("error", ` Error: ${workflow.error}`)));
    }
    if (this.notice)
      rows.push(frame(this.theme.fg("warning", ` ${this.notice}`)));
    rows.push(
      frame(
        this.theme.fg(
          "dim",
          " ↑↓ select · ←→ fold · Enter inspect · p pause/resume · i Agent · I Workflow · Esc Main",
        ),
      ),
    );
    rows.push(border("╰", "╯"));
    return rows;
  }

  private renderHelp(width: number): string[] {
    const panelWidth = width;
    const inner = panelWidth - 2;
    const frame = (text = ""): string =>
      `${this.theme.fg("border", "│")}${fit(text, inner)}${this.theme.fg("border", "│")}`;
    const border = (left: string, right: string): string =>
      this.theme.fg("border", `${left}${"─".repeat(inner)}${right}`);
    return [
      border("╭", "╮"),
      frame(
        ` ${this.theme.fg("accent", this.theme.bold("Subagent Workbench Help"))}`,
      ),
      frame(""),
      frame(" Main: F6 focus navigation · arrows select · Enter full screen"),
      frame(" Direct Subagent: type Follow-up · Enter send or queue"),
      frame(" Workflow: arrows select/fold · Enter inspect · p pause/resume"),
      frame(" Ctrl+C/i interrupt Agent · I interrupts whole Workflow"),
      frame(" Esc returns one level without cancelling background work"),
      frame(" ? closes this help"),
      border("╰", "╯"),
    ];
  }

  private nativeTimelineLines(
    conversation: ConversationRecord,
    width: number,
  ): string[] {
    if (!conversation.timeline?.length) {
      return this.transcriptLines(conversation, width);
    }
    const lines: string[] = [];
    for (const entry of conversation.timeline) {
      try {
        if (entry.type === "user") {
          lines.push(...new UserMessageComponent(entry.text).render(width));
          continue;
        }
        if (entry.type === "assistant") {
          const content = entry.content.map((block) => {
            if (block.type === "text") {
              return { type: "text", text: block.text ?? "" };
            }
            if (block.type === "thinking") {
              return { type: "thinking", thinking: block.thinking ?? "" };
            }
            return {
              type: "toolCall",
              id: block.id ?? `${entry.id}:tool-call`,
              name: block.name ?? "tool",
              arguments: block.arguments ?? {},
            };
          });
          const component = new AssistantMessageComponent();
          component.updateContent(
            {
              role: "assistant",
              content,
              provider: entry.provider ?? "workbench",
              model: entry.model ?? "subagent",
              stopReason:
                entry.stopReason ?? (entry.streaming ? "toolUse" : "stop"),
              errorMessage: entry.errorMessage,
              timestamp: entry.createdAt,
              usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: {
                  input: 0,
                  output: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                  total: 0,
                },
              },
            } as any,
            entry.streaming ?? false,
          );
          lines.push(...component.render(width));
          continue;
        }
        const component = new ToolExecutionComponent(
          entry.name,
          entry.toolCallId,
          entry.args,
          {},
          undefined,
          this.tui,
          this.cwd,
        );
        component.markExecutionStarted();
        component.setArgsComplete();
        if (entry.output) {
          component.updateResult(
            {
              content: entry.output.content.map((item) => ({ ...item })),
              ...(entry.output.details === undefined
                ? {}
                : { details: entry.output.details }),
              isError: entry.status === "failed",
            },
            entry.status === "running",
          );
        }
        lines.push(...component.render(width));
      } catch (error) {
        lines.push(
          truncateToWidth(
            `Unable to render ${entry.type} entry: ${error instanceof Error ? error.message : String(error)}`,
            width,
          ),
        );
      }
    }
    return lines;
  }

  private transcriptLines(
    conversation: ConversationRecord,
    width: number,
  ): string[] {
    const lines: string[] = [];
    for (const message of conversation.messages ?? []) {
      const prefix =
        message.role === "user"
          ? "user"
          : message.role === "assistant"
            ? "assistant"
            : "tool";
      const chunks = message.text.split(/\r?\n/);
      for (let index = 0; index < chunks.length; index++) {
        const raw = `${index === 0 ? `${prefix}: ` : "  "}${chunks[index] ?? ""}`;
        lines.push(truncateToWidth(raw, Math.max(1, width), "…"));
      }
    }
    return lines;
  }
}

class WorkbenchFullscreenLayout extends VStack implements Focusable {
  private _focused = false;

  constructor(private readonly workbench: ConversationWorkbenchComponent) {
    const document: Component = {
      render: (width) => workbench.renderRouteDocument(width),
      invalidate: () => workbench.invalidate(),
    };
    const dock: Component = {
      render: (width) => workbench.renderRouteDock(width),
      invalidate: () => workbench.invalidate(),
    };
    const scroll = new ScrollView(document, {
      follow: "end",
      primary: true,
      overscroll: "contain",
      scrollbar: "auto",
    });
    super([
      { component: scroll, basis: "auto", grow: 1, shrink: 1, minSize: 1 },
      { component: dock, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
    ]);
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.workbench.focused = value;
  }

  handleInput(input: string): void {
    this.workbench.handleInput(input);
  }

  dispose(): void {
    this.workbench.dispose();
  }
}

export async function openConversationWorkbench(
  ctx: WorkbenchContext,
  runtime: SubagentWorkbenchRuntime,
  setHandle: (handle: ConversationWorkbenchHandle | undefined) => void,
  options: ConversationWorkbenchOptions = {},
): Promise<void> {
  let doneView: (() => void) | undefined;
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    doneView?.();
  };
  const handle: ConversationWorkbenchHandle = { close };
  setHandle(handle);
  let layout: WorkbenchFullscreenLayout | undefined;
  try {
    await ctx.ui.custom<void>(
      (tui, theme, keybindings, done) => {
        doneView = () => done(undefined);
        const component = new ConversationWorkbenchComponent(
          runtime,
          tui,
          ctx.cwd,
          keybindings,
          theme,
          () => tui.requestRender(),
          () => tui.terminal.rows,
          {
            close,
            newAgent: async () => {
              const task = await ctx.ui.input(
                "New Agent task",
                "Describe one bounded task",
              );
              if (!task?.trim()) return;
              const result = await runtime.dispatch({
                type: "start-agent",
                task: task.trim(),
                label: task.trim().slice(0, 48),
                cwd: ctx.cwd,
                ...(activeModel(ctx) ? { model: activeModel(ctx) } : {}),
              });
              ctx.ui.notify(
                result.ok
                  ? "Agent accepted."
                  : `Agent was not started: ${result.error}`,
                result.ok ? "info" : "error",
              );
            },
            sendAgent: (sessionId, message) =>
              runtime.dispatch({ type: "send-agent", sessionId, message }),
            interruptAgent: (sessionId) =>
              runtime.dispatch({ type: "interrupt-agent", sessionId }),
            interruptWorkflow: (workflowId) =>
              runtime.dispatch({ type: "interrupt-workflow", workflowId }),
            pauseWorkflow: (workflowId) =>
              runtime.dispatch({ type: "pause-workflow", workflowId }),
            resumeWorkflow: (workflowId) =>
              runtime.dispatch({ type: "resume-workflow", workflowId }),
          },
          options.initialTargetId,
        );
        layout = new WorkbenchFullscreenLayout(component);
        return layout;
      },
      { fullscreen: true } as Parameters<typeof ctx.ui.custom>[1],
    );
  } finally {
    layout?.dispose();
    setHandle(undefined);
  }
}
