import {
  estimateTokens,
  type ExtensionAPI,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  truncateToWidth,
  visibleWidth,
  type OverlayHandle,
  type TUI,
} from "@earendil-works/pi-tui";
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

type JobStatus = "running" | "done" | "error" | "cancelled";
type InteractiveStatus = "running" | "idle" | "unknown" | "exited" | "cancelled";
type UnknownRecord = Record<string, unknown>;

interface UsageSnapshot {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  turns: number;
}

interface ContextSnapshot {
  /** Pi reports this as the latest prompt size or a trailing-context estimate. */
  tokens?: number;
  contextWindow?: number;
  percent?: number;
  /** Local token estimates for the current prompt payload. */
  system: number;
  skills: number;
  tools: number;
  /** Total of user input, model output, and other non-tool history. */
  history: number;
  /** Tokens in assistant tool-call blocks. */
  toolCalls?: number;
  /** Results from tools other than the built-in read tool. */
  toolResults: number;
  /** Content returned by the built-in read tool. */
  fileReads?: number;
  userInput?: number;
  assistantOutput?: number;
  otherHistory?: number;
  estimatedTotal: number;
}

interface AgentMetrics {
  version: 1 | 2 | 3;
  updatedAt: number;
  context: ContextSnapshot;
  usage: UsageSnapshot;
}

interface InProcessJob {
  id: string;
  status: JobStatus;
  startedAt: number;
  modelLabel?: string;
  liveStatus?: {
    activeTool?: { name?: string; args?: Record<string, unknown> };
    usage?: UsageSnapshot;
  };
  session?: {
    systemPrompt?: string;
    messages?: unknown[];
    getContextUsage?: () => {
      tokens?: number | null;
      contextWindow?: number;
      percent?: number | null;
    };
  };
}

interface InteractiveAgent {
  id: string;
  name?: string;
  task?: string;
  status: InteractiveStatus;
  startedAt: number;
  lastToolName?: string;
  lastToolSummary?: string;
  artifactDir?: string;
  sessionFile?: string;
}

interface WorkflowUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  costUsd?: number;
  cost?: number;
  turns?: number;
}

interface WorkflowJob {
  id: string;
  name: string;
  status: JobStatus;
  startedAt: number;
  parentSessionOwner?: { id: number; generation: number };
  snapshot: {
    agentsSpawned?: number;
    runningCount?: number;
    currentPhase?: string;
    lastMessage?: string;
    usage?: WorkflowUsage;
    liveUsage?: WorkflowUsage;
  };
}

interface SessionScope {
  id: number;
  generation: number;
  lifecycle: "registered" | "started" | "shutdown";
  inProcessJobs: Map<string, InProcessJob>;
  interactiveStates: Map<string, InteractiveAgent>;
}

interface MetricsSidebarSummary {
  available: boolean;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  hitRatio: number;
  writeRatio: number;
  uncachedRatio: number;
}

interface SubagenturaRuntime {
  __piSubagenturaSessionScopes?: Map<number, SessionScope>;
  __piSubagenturaActiveSessionScopeId?: number;
  __piSubagenturaActiveSessionScopeGeneration?: number;
  __piSubagenturaWorkflowJobs?: Map<string, WorkflowJob>;
  __piTsienMetricsSidebarGetSummary?: () => MetricsSidebarSummary;
}

interface Snapshot {
  workflows: WorkflowJob[];
  agents: SidebarAgent[];
}

interface SidebarAgent {
  id: string;
  kind: "进程内" | "交互式";
  label: string;
  activity?: string;
  startedAt: number;
  metrics?: AgentMetrics;
}

interface SidebarRuntime {
  done: () => void;
  handle?: OverlayHandle;
  hidden: boolean;
  timer: ReturnType<typeof setInterval>;
}

interface ParentSessionContext {
  model?: { provider: string; id: string };
  getSystemPrompt(): string;
  getContextUsage(): {
    tokens?: number | null;
    contextWindow?: number;
    percent?: number | null;
  } | undefined;
  hasPendingMessages?(): boolean;
  sessionManager: {
    getEntries(): unknown[];
    buildSessionContext?: () => { messages?: unknown[] };
  };
}

interface ParentSessionRuntime {
  model?: { provider: string; id: string };
  metrics?: AgentMetrics;
  hasPendingMessages: boolean;
  systemPrompt: string;
  messages: unknown[];
}

const MAX_AGENT_ROWS = 4;
const MAX_WORKFLOW_ROWS = 2;
const METRICS_FILE = "context-metrics.json";
const MAX_METRICS_BYTES = 64 * 1024;
const MAX_FALLBACK_SESSION_BYTES = 2 * 1024 * 1024;
let sidebar: SidebarRuntime | undefined;
let parentSession: ParentSessionRuntime | undefined;

function globalState(): SubagenturaRuntime {
  return globalThis as typeof globalThis & SubagenturaRuntime;
}

function asRecord(value: unknown): UnknownRecord | undefined {
  return value !== null && typeof value === "object"
    ? (value as UnknownRecord)
    : undefined;
}

function nonNegative(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : 0;
}

function optionalNonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function zeroUsage(): UsageSnapshot {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
}

function normalizeUsage(value: unknown): UsageSnapshot {
  const raw = asRecord(value);
  if (!raw) return zeroUsage();
  const costValue = raw.cost;
  const costRecord = asRecord(costValue);
  return {
    input: nonNegative(raw.input),
    output: nonNegative(raw.output),
    cacheRead: nonNegative(raw.cacheRead),
    cacheWrite: nonNegative(raw.cacheWrite),
    cost: nonNegative(costRecord?.total ?? costValue),
    turns: nonNegative(raw.turns),
  };
}

function addUsage(total: UsageSnapshot, next: UsageSnapshot): UsageSnapshot {
  return {
    input: total.input + next.input,
    output: total.output + next.output,
    cacheRead: total.cacheRead + next.cacheRead,
    cacheWrite: total.cacheWrite + next.cacheWrite,
    cost: total.cost + next.cost,
    turns: total.turns + next.turns,
  };
}

function hasUsage(usage: UsageSnapshot): boolean {
  return (
    usage.input > 0 ||
    usage.output > 0 ||
    usage.cacheRead > 0 ||
    usage.cacheWrite > 0 ||
    usage.cost > 0 ||
    usage.turns > 0
  );
}

function usageFromEntries(entries: unknown[]): UsageSnapshot {
  let total = zeroUsage();
  for (const entry of entries) {
    const record = asRecord(entry);
    if (!record) continue;
    if (record.type === "message") {
      const message = asRecord(record.message);
      if (message) total = addUsage(total, normalizeUsage(message.usage));
    } else if (record.type === "compaction" || record.type === "branch_summary") {
      total = addUsage(total, normalizeUsage(record.usage));
    }
  }
  return total;
}

function estimateTextTokens(text: string): number {
  return estimateTokens({ role: "user", content: text });
}

function isExcludedBashMessage(message: UnknownRecord): boolean {
  return message.role === "bashExecution" && message.excludeFromContext === true;
}

function splitSystemPrompt(systemPrompt: string): Pick<
  ContextSnapshot,
  "system" | "skills" | "tools"
> {
  const skillMatch = systemPrompt.match(
    /\n\nThe following skills provide specialized instructions for specific tasks\.[\s\S]*?<\/available_skills>/,
  );
  const toolMatch = systemPrompt.match(
    /(?:^|\n)Available tools:\n[\s\S]*?(?=\n\nIn addition to the tools above|$)/,
  );
  const skills = skillMatch ? estimateTextTokens(skillMatch[0]) : 0;
  const tools = toolMatch ? estimateTextTokens(toolMatch[0]) : 0;
  return {
    system: Math.max(0, estimateTextTokens(systemPrompt) - skills - tools),
    skills,
    tools,
  };
}

function buildMetrics(
  systemPrompt: string,
  messages: unknown[],
  contextUsage: { tokens?: number | null; contextWindow?: number; percent?: number | null } | undefined,
  usage: UsageSnapshot,
): AgentMetrics {
  const system = splitSystemPrompt(systemPrompt);
  let userInput = 0;
  let assistantOutput = 0;
  let toolCalls = 0;
  let fileReads = 0;
  let toolResults = 0;
  let otherHistory = 0;

  for (const candidate of messages) {
    const message = asRecord(candidate);
    if (!message || isExcludedBashMessage(message)) continue;
    try {
      const tokens = estimateTokens(message as never);
      if (message.role === "user") {
        userInput += tokens;
      } else if (message.role === "assistant") {
        const content = Array.isArray(message.content) ? message.content : [];
        const toolCallBlocks = content.filter(
          (block) => asRecord(block)?.type === "toolCall",
        );
        const toolCallTokens = toolCallBlocks.length
          ? estimateTokens({ ...message, content: toolCallBlocks } as never)
          : 0;
        toolCalls += toolCallTokens;
        assistantOutput += Math.max(0, tokens - toolCallTokens);
      } else if (message.role === "toolResult") {
        if (message.toolName === "read") {
          fileReads += tokens;
        } else {
          toolResults += tokens;
        }
      } else if (message.role === "bashExecution") {
        toolResults += tokens;
      } else {
        otherHistory += tokens;
      }
    } catch {
      // A third-party extension may persist an unknown message shape. Skip it.
    }
  }

  const history = userInput + assistantOutput + toolCalls + otherHistory;
  const estimatedTotal =
    system.system + system.skills + system.tools + history + fileReads + toolResults;
  const tokens = optionalNonNegative(contextUsage?.tokens);
  const contextWindow = optionalNonNegative(contextUsage?.contextWindow);
  const percent = optionalNonNegative(contextUsage?.percent);
  return {
    version: 3,
    updatedAt: Date.now(),
    context: {
      ...system,
      history,
      toolResults,
      fileReads,
      userInput,
      assistantOutput,
      toolCalls,
      otherHistory,
      estimatedTotal,
      ...(tokens !== undefined ? { tokens } : {}),
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      ...(percent !== undefined ? { percent } : {}),
    },
    usage,
  };
}

function sessionRoot(): string {
  return resolve(
    process.env.PI_CODING_AGENT_SESSION_DIR ??
      join(homedir(), ".pi", "agent", "sessions"),
  );
}

/** Resolve a subagent artifact or child session path only when it stays in Pi's session root. */
function allowedSessionPath(path: string | undefined): string | undefined {
  if (!path) return undefined;
  const root = sessionRoot();
  const candidate = resolve(path);
  const rel = relative(root, candidate);
  if (rel === "" || (!rel.startsWith("..") && !rel.includes("../"))) return candidate;
  return undefined;
}

function childMetricsPath(): string | undefined {
  const artifactDir = allowedSessionPath(process.env.ARTIFACT_DIR);
  if (!artifactDir) return undefined;
  try {
    if (!statSync(artifactDir).isDirectory()) return undefined;
  } catch {
    return undefined;
  }
  return join(artifactDir, METRICS_FILE);
}

function writeMetricsAtomically(path: string, metrics: AgentMetrics): void {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(metrics), { encoding: "utf8", mode: 0o600 });
    renameSync(temp, path);
  } catch {
    // Observability must never interfere with the child agent's work.
  }
}

function normalizeMetrics(value: unknown): AgentMetrics | undefined {
  const raw = asRecord(value);
  const contextRaw = asRecord(raw?.context);
  const usageRaw = asRecord(raw?.usage);
  const version = raw?.version;
  if ((version !== 1 && version !== 2 && version !== 3) || !contextRaw || !usageRaw) return undefined;

  const context: ContextSnapshot = {
    system: nonNegative(contextRaw.system),
    skills: nonNegative(contextRaw.skills),
    tools: nonNegative(contextRaw.tools),
    history: nonNegative(contextRaw.history),
    toolResults: nonNegative(contextRaw.toolResults),
    estimatedTotal: nonNegative(contextRaw.estimatedTotal),
  };
  const tokens = optionalNonNegative(contextRaw.tokens);
  const contextWindow = optionalNonNegative(contextRaw.contextWindow);
  const percent = optionalNonNegative(contextRaw.percent);
  const fileReads = optionalNonNegative(contextRaw.fileReads);
  const userInput = optionalNonNegative(contextRaw.userInput);
  const assistantOutput = optionalNonNegative(contextRaw.assistantOutput);
  const toolCalls = optionalNonNegative(contextRaw.toolCalls);
  const otherHistory = optionalNonNegative(contextRaw.otherHistory);
  if (tokens !== undefined) context.tokens = tokens;
  if (contextWindow !== undefined) context.contextWindow = contextWindow;
  if (percent !== undefined) context.percent = percent;
  if (fileReads !== undefined) context.fileReads = fileReads;
  if (userInput !== undefined) context.userInput = userInput;
  if (assistantOutput !== undefined) context.assistantOutput = assistantOutput;
  if (toolCalls !== undefined) context.toolCalls = toolCalls;
  if (otherHistory !== undefined) context.otherHistory = otherHistory;

  return {
    version,
    updatedAt: optionalNonNegative(raw.updatedAt) ?? 0,
    context,
    usage: normalizeUsage(usageRaw),
  };
}

function readInteractiveMetrics(agent: InteractiveAgent): AgentMetrics | undefined {
  const artifactDir = allowedSessionPath(agent.artifactDir);
  if (artifactDir) {
    const metricsPath = join(artifactDir, METRICS_FILE);
    try {
      if (statSync(metricsPath).size <= MAX_METRICS_BYTES) {
        const metrics = normalizeMetrics(JSON.parse(readFileSync(metricsPath, "utf8")));
        if (metrics) return metrics;
      }
    } catch {
      // Older children have no sidecar yet; fall back to their session file below.
    }
  }

  const sessionFile = allowedSessionPath(agent.sessionFile);
  if (!sessionFile) return undefined;
  try {
    if (statSync(sessionFile).size > MAX_FALLBACK_SESSION_BYTES) return undefined;
    const entries = readFileSync(sessionFile, "utf8")
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
    const usage = usageFromEntries(entries);
    return hasUsage(usage)
      ? {
          version: 1,
          updatedAt: 0,
          context: {
            system: 0,
            skills: 0,
            tools: 0,
            history: 0,
            toolResults: 0,
            estimatedTotal: 0,
          },
          usage,
        }
      : undefined;
  } catch {
    return undefined;
  }
}

function inProcessMetrics(job: InProcessJob): AgentMetrics | undefined {
  const session = job.session;
  const usage = normalizeUsage(job.liveStatus?.usage);
  if (!session) {
    return hasUsage(usage)
      ? {
          version: 1,
          updatedAt: Date.now(),
          context: {
            system: 0,
            skills: 0,
            tools: 0,
            history: 0,
            toolResults: 0,
            estimatedTotal: 0,
          },
          usage,
        }
      : undefined;
  }
  try {
    return buildMetrics(
      session.systemPrompt ?? "",
      session.messages ?? [],
      session.getContextUsage?.(),
      usage,
    );
  } catch {
    return undefined;
  }
}

function currentScope(): SessionScope | undefined {
  const state = globalState();
  const id = state.__piSubagenturaActiveSessionScopeId;
  const generation = state.__piSubagenturaActiveSessionScopeGeneration;
  if (typeof id !== "number" || typeof generation !== "number") return undefined;
  const scope = state.__piSubagenturaSessionScopes?.get(id);
  return scope?.lifecycle === "started" && scope.generation === generation
    ? scope
    : undefined;
}

function snapshot(): Snapshot {
  const scope = currentScope();
  if (!scope) return { workflows: [], agents: [] };

  const owner = { id: scope.id, generation: scope.generation };
  const workflows = [...(globalState().__piSubagenturaWorkflowJobs?.values() ?? [])]
    .filter(
      (job) =>
        job.status === "running" &&
        job.parentSessionOwner?.id === owner.id &&
        job.parentSessionOwner?.generation === owner.generation,
    )
    .sort((a, b) => a.startedAt - b.startedAt);

  const inProcess = [...scope.inProcessJobs.values()]
    .filter((job) => job.status === "running")
    .map<SidebarAgent>((job) => ({
      id: job.id,
      kind: "进程内",
      label: job.id,
      activity: formatInProcessActivity(job),
      startedAt: job.startedAt,
      metrics: inProcessMetrics(job),
    }));

  const interactive = [...scope.interactiveStates.values()]
    .filter(
      (agent) =>
        agent.status === "running" ||
        agent.status === "idle" ||
        agent.status === "unknown",
    )
    .map<SidebarAgent>((agent) => ({
      id: agent.id,
      kind: "交互式",
      label: agent.name || agent.task || agent.id,
      activity: formatInteractiveActivity(agent),
      startedAt: agent.startedAt,
      metrics: readInteractiveMetrics(agent),
    }));

  return {
    workflows,
    agents: [...inProcess, ...interactive].sort((a, b) => a.startedAt - b.startedAt),
  };
}

function formatInProcessActivity(job: InProcessJob): string | undefined {
  const tool = job.liveStatus?.activeTool;
  if (!tool?.name) return job.modelLabel ? `模型：${job.modelLabel}` : undefined;
  const details = summarizeArguments(tool.args);
  return details ? `${tool.name}：${details}` : tool.name;
}

function formatInteractiveActivity(agent: InteractiveAgent): string | undefined {
  if (agent.lastToolName && agent.lastToolSummary) {
    return `${agent.lastToolName}：${agent.lastToolSummary}`;
  }
  if (agent.lastToolName) return agent.lastToolName;
  if (agent.status === "idle") return "等待后续指令";
  if (agent.status === "unknown") return "状态暂时不可用";
  return undefined;
}

function summarizeArguments(args: Record<string, unknown> | undefined): string | undefined {
  if (!args) return undefined;
  for (const key of ["path", "task", "name", "command", "workflowId", "jobId"]) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

function safeText(value: string | undefined): string {
  return (value ?? "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function elapsed(startedAt: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  if (seconds < 60) return `${seconds}秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}分${seconds % 60}秒`;
  return `${Math.floor(minutes / 60)}时${minutes % 60}分`;
}

function formatTokens(value: number): string {
  if (value < 1_000) return `${Math.round(value)}`;
  if (value < 1_000_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(1)}m`;
}

function formatCost(value: number): string {
  return `$${value < 0.01 ? value.toFixed(4) : value.toFixed(3)}`;
}

function normalizeWorkflowUsage(usage: WorkflowUsage | undefined): UsageSnapshot {
  return {
    input: nonNegative(usage?.input),
    output: nonNegative(usage?.output),
    cacheRead: nonNegative(usage?.cacheRead),
    cacheWrite: nonNegative(usage?.cacheWrite),
    cost: nonNegative(usage?.costUsd ?? usage?.cost),
    turns: nonNegative(usage?.turns),
  };
}

function contextTotal(context: ContextSnapshot): number {
  return context.tokens ?? context.estimatedTotal;
}

function contextPercent(context: ContextSnapshot): number | undefined {
  if (context.percent !== undefined) return Math.max(0, Math.min(100, context.percent));
  if (!context.contextWindow || context.contextWindow <= 0) return undefined;
  return Math.max(0, Math.min(100, (contextTotal(context) / context.contextWindow) * 100));
}

function contextBar(percent: number, width = 10): string {
  const filled = Math.max(0, Math.min(width, Math.round((percent / 100) * width)));
  return `[${"█".repeat(filled)}${"░".repeat(width - filled)}]`;
}

function captureParentSession(
  context: ParentSessionContext,
  systemPrompt: string,
  messages?: unknown[],
): ParentSessionRuntime {
  try {
    const snapshotMessages = messages ?? context.sessionManager.buildSessionContext?.().messages ?? [];
    return {
      model: context.model,
      metrics: buildMetrics(
        systemPrompt,
        snapshotMessages,
        context.getContextUsage(),
        usageFromEntries(context.sessionManager.getEntries()),
      ),
      hasPendingMessages: context.hasPendingMessages?.() ?? false,
      systemPrompt,
      messages: snapshotMessages,
    };
  } catch {
    return {
      ...parentSession,
      hasPendingMessages: false,
      systemPrompt,
      messages: messages ?? parentSession?.messages ?? [],
    };
  }
}

class SidebarComponent {
  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
  ) {}

  render(width: number): string[] {
    const innerWidth = Math.max(12, width - 2);
    const data = snapshot();
    const lines: string[] = [];
    const runningAgents = data.agents.length;

    lines.push(this.topBorder(innerWidth, "会话概览"));
    this.renderParentSession(lines, innerWidth);
    lines.push(
      this.row(
        innerWidth,
        this.theme.fg(
          runningAgents + data.workflows.length > 0 ? "accent" : "muted",
          `● ${runningAgents} 个子代理 · ${data.workflows.length} 个工作流`,
        ),
      ),
    );

    if (data.workflows.length > 0) {
      lines.push(this.divider(innerWidth, "工作流"));
      for (const workflow of data.workflows.slice(0, MAX_WORKFLOW_ROWS)) {
        const summary = [
          `${workflow.name} (${elapsed(workflow.startedAt)})`,
          `${workflow.snapshot.agentsSpawned ?? 0} 个代理`,
          `${workflow.snapshot.runningCount ?? 0} 个运行中`,
        ].join(" · ");
        lines.push(this.row(innerWidth, this.theme.fg("success", `◇ ${safeText(summary)}`)));
        const detail = workflow.snapshot.currentPhase ?? workflow.snapshot.lastMessage;
        if (detail) lines.push(this.row(innerWidth, this.theme.fg("dim", `  ${safeText(detail)}`)));
        const usage = normalizeWorkflowUsage(
          workflow.snapshot.liveUsage ?? workflow.snapshot.usage,
        );
        if (hasUsage(usage)) {
          lines.push(
            this.row(
              innerWidth,
              this.theme.fg(
                "dim",
                `  用量 ↑${formatTokens(usage.input)} ↓${formatTokens(usage.output)} · ${formatCost(usage.cost)}`,
              ),
            ),
          );
        }
      }
      if (data.workflows.length > MAX_WORKFLOW_ROWS) {
        lines.push(this.row(innerWidth, this.theme.fg("dim", `… 还有 ${data.workflows.length - MAX_WORKFLOW_ROWS} 个工作流`)));
      }
    }

    lines.push(this.divider(innerWidth, "子代理"));
    if (data.agents.length > 0) {
      for (const agent of data.agents.slice(0, MAX_AGENT_ROWS)) {
        lines.push(
          this.row(
            innerWidth,
            this.theme.fg("accent", `● ${safeText(agent.label)} (${elapsed(agent.startedAt)})`),
          ),
        );
        const activity = agent.activity ? `${agent.kind} · ${safeText(agent.activity)}` : agent.kind;
        lines.push(this.row(innerWidth, this.theme.fg("dim", `  ${activity}`)));
      }
      if (data.agents.length > MAX_AGENT_ROWS) {
        lines.push(this.row(innerWidth, this.theme.fg("dim", `… 还有 ${data.agents.length - MAX_AGENT_ROWS} 个子代理`)));
      }
    } else {
      lines.push(this.row(innerWidth, this.theme.fg("muted", "当前没有运行或空闲的子代理")));
    }

    lines.push(this.divider(innerWidth));
    lines.push(this.bottomBorder(innerWidth));
    return lines;
  }

  invalidate(): void {}

  dispose(): void {}

  private renderParentSession(lines: string[], innerWidth: number): void {
    lines.push(this.divider(innerWidth, "当前会话"));
    const session = parentSession;
    if (session?.model) {
      lines.push(this.row(innerWidth, this.theme.fg("accent", `● ${session.model.provider}/${session.model.id}`)));
    }
    this.renderMetrics(lines, innerWidth, session?.metrics);
    if (session?.hasPendingMessages) {
      lines.push(this.row(innerWidth, this.theme.fg("warning", "  排队消息：有待处理的后续指令")));
    }
  }

  private renderMetrics(lines: string[], innerWidth: number, metrics: AgentMetrics | undefined): void {
    if (!metrics) {
      lines.push(this.row(innerWidth, this.theme.fg("dim", "  用量与上下文尚未返回")));
      return;
    }

    const context = metrics.context;
    if (contextTotal(context) > 0 || context.contextWindow !== undefined) {
      const percent = contextPercent(context);
      if (percent !== undefined) {
        const color = percent >= 85 ? "error" : percent >= 70 ? "warning" : "muted";
        lines.push(
          this.row(
            innerWidth,
            this.theme.fg(color, `  上下文 ${percent.toFixed(1)}% ${contextBar(percent)}`),
          ),
        );
      } else {
        lines.push(this.row(innerWidth, this.theme.fg("muted", `  上下文 ${formatTokens(contextTotal(context))}`)));
      }

      const hasBreakdown =
        context.userInput !== undefined ||
        context.assistantOutput !== undefined ||
        context.fileReads !== undefined ||
        context.toolCalls !== undefined ||
        context.otherHistory !== undefined;
      if (hasBreakdown) {
        const rows: Array<[string, number]> = [
          ["系统提示词", context.system],
          ["技能指令", context.skills],
          ["系统工具", context.tools],
          ["用户输入", context.userInput ?? 0],
          ["模型生成", context.assistantOutput ?? 0],
          ["文件读取", context.fileReads ?? 0],
          ["工具调用", context.toolCalls ?? 0],
          ["工具调用结果", context.toolResults],
          ["其它", context.otherHistory ?? 0],
        ];
        const topRanks = new Map<number, number>();
        rows
          .map(([, tokens], index) => ({ index, tokens }))
          .filter(({ tokens }) => tokens > 0)
          .sort((left, right) => right.tokens - left.tokens)
          .slice(0, 3)
          .forEach(({ index }, rank) => topRanks.set(index, rank + 1));
        for (let index = 0; index < rows.length; index += 2) {
          const left = rows[index]!;
          const right = rows[index + 1];
          lines.push(
            this.row(
              innerWidth,
              ` ${this.contextMetricPair(
                innerWidth,
                left,
                right,
                topRanks.get(index),
                topRanks.get(index + 1),
              )}`,
            ),
          );
        }
      } else if (context.estimatedTotal > 0) {
        lines.push(
          this.row(
            innerWidth,
            this.theme.fg("dim", `  历史 ${formatTokens(context.history)} · 工具结果 ${formatTokens(context.toolResults)}`),
          ),
        );
      }
    }

    const metricsSummary = globalState().__piTsienMetricsSidebarGetSummary?.();
    if (metricsSummary) {
      const input = formatTokens(metricsSummary.input);
      if (metricsSummary.available) {
        lines.push(
          this.row(
            innerWidth,
            this.theme.fg(
              "dim",
              `  R${formatTokens(metricsSummary.cacheRead)} W${formatTokens(metricsSummary.cacheWrite)} · 命中率${Math.round(metricsSummary.hitRatio * 100)}% · 未缓存${Math.round(metricsSummary.uncachedRatio * 100)}%`,
            ),
          ),
        );
      } else {
        lines.push(this.row(this.theme.fg("dim", `  缓存暂无数据 · Input ${input}`)));
      }
    } else {
      const usage = metrics.usage;
      if (hasUsage(usage)) {
        lines.push(this.row(this.theme.fg("dim", `  缓存暂无数据 · Input ${formatTokens(usage.input)}`)));
      } else {
        lines.push(this.row(this.theme.fg("dim", "  缓存暂无数据")));
      }
    }
  }

  private topBorder(innerWidth: number, title: string): string {
    const label = truncateToWidth(this.theme.bold(title), Math.max(1, innerWidth - 2), "…");
    const tail = "─".repeat(Math.max(0, innerWidth - visibleWidth(label) - 1));
    return this.theme.fg("border", "╭─") + this.theme.fg("accent", label) + this.theme.fg("border", `${tail}╮`);
  }

  private bottomBorder(innerWidth: number): string {
    return this.theme.fg("border", `╰${"─".repeat(innerWidth)}╯`);
  }

  private contextMetricPair(
    innerWidth: number,
    left: [string, number],
    right?: [string, number],
    leftRank?: number,
    rightRank?: number,
  ): string {
    if (!right) return this.contextMetricText(left, leftRank);
    const gap = "  ";
    const columnWidth = Math.floor((innerWidth - 1 - visibleWidth(gap)) / 2);
    const leftRaw = this.contextMetricRaw(left, leftRank, columnWidth);
    const rightRaw = this.contextMetricRaw(right, rightRank, columnWidth);
    const leftPadding = " ".repeat(Math.max(0, columnWidth - visibleWidth(leftRaw)));
    return `${this.contextMetricText(left, leftRank, leftRaw)}${leftPadding}${gap}${this.contextMetricText(right, rightRank, rightRaw)}`;
  }

  private contextMetricRaw(
    metric: [string, number],
    rank?: number,
    width?: number,
  ): string {
    const badge = rank ? ["", "① ", "② ", "③ "][rank] : "";
    const text = `${badge}${metric[0]} ${formatTokens(metric[1])}`;
    return width === undefined ? text : truncateToWidth(text, width, "…");
  }

  private contextMetricText(
    metric: [string, number],
    rank?: number,
    raw?: string,
  ): string {
    const color = rank === 1 ? "error" : rank === 2 ? "warning" : rank === 3 ? "accent" : "dim";
    return this.theme.fg(color, raw ?? this.contextMetricRaw(metric, rank));
  }

  private divider(innerWidth: number, title?: string): string {
    const label = title ? ` ${title} ` : "";
    const tail = "─".repeat(Math.max(0, innerWidth - visibleWidth(label)));
    return this.theme.fg("border", `├${label}${tail}┤`);
  }

  private row(innerWidth: number, text: string): string {
    const visible = truncateToWidth(text, innerWidth, "…");
    const pad = " ".repeat(Math.max(0, innerWidth - visibleWidth(visible)));
    return this.theme.fg("border", "│") + visible + pad + this.theme.fg("border", "│");
  }
}

function closeSidebar(): void {
  const active = sidebar;
  sidebar = undefined;
  if (!active) return;
  clearInterval(active.timer);
  try {
    active.done();
  } catch {
    // The TUI may already have disposed the overlay during shutdown.
  }
}

function openSidebar(ctx: any): void {
  if (ctx.mode !== "tui") return;
  if (sidebar) {
    sidebar.hidden = false;
    sidebar.handle?.setHidden(false);
    return;
  }

  let runtime: SidebarRuntime | undefined;
  const promise = ctx.ui.custom(
    (tui: TUI, theme: Theme, _keybindings: unknown, done: () => void) => {
      const component = new SidebarComponent(tui, theme);
      const timer = setInterval(() => tui.requestRender(), 1000);
      timer.unref?.();
      runtime = { done, hidden: false, timer };
      sidebar = runtime;
      return component;
    },
    {
      overlay: true,
      overlayOptions: {
        anchor: "top-right",
        width: 48,
        margin: { top: 1, right: 1 },
        visible: (termWidth: number) => termWidth >= 120,
        // A display-only sidebar must never take the editor's keyboard focus.
        nonCapturing: true,
      },
      onHandle: (handle: OverlayHandle) => {
        if (!runtime) return;
        runtime.handle = handle;
        handle.unfocus();
      },
    },
  );

  void Promise.resolve(promise).finally(() => {
    if (sidebar === runtime) closeSidebar();
  });
}

/**
 * Interactive children run this same global extension.  They publish only numeric
 * context/usage snapshots to their already-private artifact directory, letting the
 * parent sidebar show the same breakdown without scraping a terminal pane.
 */
function registerChildMetricsPublisher(pi: ExtensionAPI): void {
  const metricsPath = childMetricsPath();
  if (!metricsPath) return;

  let latestSystemPrompt = "";
  let latestMessages: unknown[] = [];
  let lastContextUsage:
    | { tokens?: number | null; contextWindow?: number; percent?: number | null }
    | undefined;

  const publish = (ctx: {
    getSystemPrompt(): string;
    getContextUsage(): { tokens?: number | null; contextWindow?: number; percent?: number | null } | undefined;
    sessionManager: { getEntries(): unknown[] };
  }) => {
    try {
      latestSystemPrompt ||= ctx.getSystemPrompt();
      lastContextUsage = ctx.getContextUsage() ?? lastContextUsage;
      const metrics = buildMetrics(
        latestSystemPrompt,
        latestMessages,
        lastContextUsage,
        usageFromEntries(ctx.sessionManager.getEntries()),
      );
      writeMetricsAtomically(metricsPath, metrics);
    } catch {
      // Keep the child session fully functional if a future Pi version changes an API.
    }
  };

  pi.on("before_agent_start", (event, ctx) => {
    latestSystemPrompt = event.systemPrompt;
    publish(ctx);
  });
  pi.on("context", (event, ctx) => {
    latestSystemPrompt = ctx.getSystemPrompt();
    latestMessages = event.messages;
    publish(ctx);
  });
  pi.on("message_end", (_event, ctx) => publish(ctx));
  pi.on("agent_settled", (_event, ctx) => publish(ctx));
}

export default function subagentSidebar(pi: ExtensionAPI) {
  registerChildMetricsPublisher(pi);

  pi.on("session_start", (_event, ctx) => {
    const context = ctx as unknown as ParentSessionContext;
    parentSession = captureParentSession(context, ctx.getSystemPrompt());
  });

  pi.on("before_agent_start", (event) => {
    if (parentSession) parentSession.systemPrompt = event.systemPrompt;
  });
  pi.on("context", (event, ctx) => {
    const context = ctx as unknown as ParentSessionContext;
    parentSession = captureParentSession(context, ctx.getSystemPrompt(), event.messages);
  });
  pi.on("message_end", (_event, ctx) => {
    const context = ctx as unknown as ParentSessionContext;
    parentSession = captureParentSession(
      context,
      parentSession?.systemPrompt ?? ctx.getSystemPrompt(),
      parentSession?.messages,
    );
  });

  pi.on("session_shutdown", () => {
    parentSession = undefined;
    closeSidebar();
  });

  pi.registerShortcut("ctrl+alt+s", {
    description: "显示或隐藏子代理侧边栏",
    handler: async (ctx) => {
      if (!sidebar) {
        openSidebar(ctx);
        return;
      }
      sidebar.hidden = !sidebar.hidden;
      sidebar.handle?.setHidden(sidebar.hidden);
    },
  });

  pi.registerCommand("subagent-sidebar", {
    description: "显示、隐藏、关闭或切换子代理与工作流状态面板",
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase();
      if (action && !["show", "hide", "toggle", "close"].includes(action)) {
        ctx.ui.notify("用法：/subagent-sidebar [show|hide|toggle|close]", "warning");
        return;
      }
      if (action === "close") {
        closeSidebar();
        return;
      }
      if (!sidebar) {
        openSidebar(ctx);
        return;
      }
      const hidden = action === "show" ? false : action === "hide" ? true : !sidebar.hidden;
      sidebar.hidden = hidden;
      sidebar.handle?.setHidden(hidden);
    },
  });
}
