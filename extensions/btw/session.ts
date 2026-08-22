import {
  type AgentSession,
  type AgentSessionEvent,
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionContext,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  sessionEntryToContextMessages,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import {
  createSessionHistoryTool,
  SESSION_HISTORY_TOOL_NAME,
  type SessionHistorySnapshot,
  snapshotSessionHistory,
} from "./history-tool.ts";

const READ_ONLY_FILE_TOOLS = ["read", "grep", "find", "ls"] as const;
const STARTUP_TIMEOUT_MS = 15_000;

const SYSTEM_PROMPT = `You are BTW, a temporary read-only side-chat agent.

You receive the same compaction-aware context snapshot that the parent agent currently uses. Use it to understand references such as "the previous error", "that file", or "the approach we just discussed".

Older parent-session messages omitted from the current context by compaction are not preloaded. Call session_history only when the user's question requires those older details; otherwise answer from the current context. The history tool is a read-only snapshot of the parent's active branch.

You may inspect local files using only the available read-only tools. You cannot modify files, execute shell commands, access write tools, or affect the parent agent's session. Never claim that you changed a file.

Your new messages and tool results belong only to this temporary side chat. Answer directly and keep the response focused.`;

type ParentMessages = ReturnType<typeof sessionEntryToContextMessages>;

export type BtwConversationItem = {
  role: "user" | "assistant" | "notice";
  text: string;
};

export type BtwSnapshot = {
  apiVersion: 1;
  revision: number;
  generatedAt: number;
  status: "ready" | "busy" | "closed";
  parentMessageCount: number;
  model: string;
  activity: string;
  conversation: BtwConversationItem[];
};

function snapshotParentMessages(ctx: ExtensionContext): ParentMessages {
  const messages = ctx.sessionManager
    .buildContextEntries()
    .flatMap((entry) => sessionEntryToContextMessages(entry));
  return structuredClone(messages);
}

function snapshotParentHistory(ctx: ExtensionContext): SessionHistorySnapshot {
  return snapshotSessionHistory(ctx.sessionManager.getBranch());
}

function messageText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const candidate = message as {
    content?: string | Array<{ type?: string; text?: string }>;
  };
  if (typeof candidate.content === "string") return candidate.content;
  if (!Array.isArray(candidate.content)) return "";
  return candidate.content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text ?? "")
    .join("\n");
}

async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function summarizeTool(name: string, args: unknown): string {
  if (!args || typeof args !== "object") return name;
  const record = args as Record<string, unknown>;
  const target = record.path ?? record.query ?? record.pattern;
  return typeof target === "string" && target.trim() ? `${name} ${target}` : name;
}

export class BtwSessionController {
  readonly conversation: BtwConversationItem[] = [];
  parentMessageCount: number;
  activity = "";
  busy = false;
  onChange?: () => void;

  private readonly session: AgentSession;
  private readonly ctx: ExtensionContext;
  private readonly historySnapshot: SessionHistorySnapshot;
  private readonly unsubscribe: () => void;
  private disposed = false;
  private disposing = false;
  private cancelRequested = false;
  private currentSubmit: Promise<void> | undefined;
  private activeAssistant: BtwConversationItem | undefined;
  private readonly listeners = new Set<(snapshot: BtwSnapshot) => void>();
  private revision = 0;

  private constructor(
    ctx: ExtensionContext,
    session: AgentSession,
    parentMessageCount: number,
    historySnapshot: SessionHistorySnapshot,
  ) {
    this.ctx = ctx;
    this.session = session;
    this.parentMessageCount = parentMessageCount;
    this.historySnapshot = historySnapshot;
    this.unsubscribe = session.subscribe((event) => this.handleEvent(event));
  }

  static async create(
    ctx: ExtensionContext,
    cancellationSignal?: AbortSignal,
  ): Promise<BtwSessionController> {
    if (!ctx.model) throw new Error("当前没有可用模型");

    const startupSignal = cancellationSignal
      ? AbortSignal.any([cancellationSignal, AbortSignal.timeout(STARTUP_TIMEOUT_MS)])
      : AbortSignal.timeout(STARTUP_TIMEOUT_MS);
    startupSignal.throwIfAborted();
    const parentMessages = snapshotParentMessages(ctx);
    const historySnapshot = snapshotParentHistory(ctx);
    const historyTool = createSessionHistoryTool(historySnapshot);
    const agentDir = getAgentDir();
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
    });
    const resourceLoader = new DefaultResourceLoader({
      cwd: ctx.cwd,
      agentDir,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt: SYSTEM_PROMPT,
    });
    await abortable(resourceLoader.reload(), startupSignal);
    startupSignal.throwIfAborted();

    const modelRuntime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: join(agentDir, "models.json"),
      allowModelNetwork: false,
      signal: startupSignal,
    });

    const effectiveProvider = ctx.modelRegistry.getProvider(ctx.model.provider);
    if (effectiveProvider) modelRuntime.registerNativeProvider(effectiveProvider);
    await modelRuntime.refresh({ allowNetwork: false, signal: startupSignal });

    const childModel = modelRuntime.getModel(ctx.model.provider, ctx.model.id) ?? ctx.model;
    if (!modelRuntime.hasConfiguredAuth(childModel.provider)) {
      const parentAuth = await abortable(
        ctx.modelRegistry.getProviderAuth(ctx.model.provider),
        startupSignal,
      );
      if (parentAuth?.auth.apiKey && !ctx.modelRegistry.isUsingOAuth(ctx.model)) {
        await modelRuntime.setRuntimeApiKey(ctx.model.provider, parentAuth.auth.apiKey, {
          signal: startupSignal,
        });
      }
    }
    if (!modelRuntime.hasConfiguredAuth(childModel.provider)) {
      throw new Error(`模型 ${childModel.provider}/${childModel.id} 没有可复用的认证信息`);
    }
    startupSignal.throwIfAborted();

    const { session } = await createAgentSession({
      cwd: ctx.cwd,
      agentDir,
      model: childModel,
      thinkingLevel: ctx.thinkingLevel,
      modelRuntime,
      sessionManager: SessionManager.inMemory(ctx.cwd),
      settingsManager,
      resourceLoader,
      tools: [...READ_ONLY_FILE_TOOLS, SESSION_HISTORY_TOOL_NAME],
      customTools: [historyTool],
    });

    if (startupSignal.aborted) {
      session.dispose();
      startupSignal.throwIfAborted();
    }
    session.agent.state.messages = [...parentMessages];
    return new BtwSessionController(
      ctx,
      session,
      parentMessages.length,
      historySnapshot,
    );
  }

  get modelLabel(): string {
    const model = this.session.model;
    return model ? `${model.provider}/${model.id}` : "unknown model";
  }

  getSnapshot(): BtwSnapshot {
    return {
      apiVersion: 1,
      revision: this.revision,
      generatedAt: Date.now(),
      status: this.disposed ? "closed" : this.busy ? "busy" : "ready",
      parentMessageCount: this.parentMessageCount,
      model: this.modelLabel,
      activity: this.activity,
      conversation: this.conversation.map(item => ({ ...item })),
    };
  }

  subscribe(listener: (snapshot: BtwSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get lastAnswer(): string | undefined {
    return [...this.conversation]
      .reverse()
      .find((item) => item.role === "assistant" && item.text.trim())
      ?.text.trim();
  }

  async submit(text: string): Promise<void> {
    const prompt = text.trim();
    if (!prompt || this.busy || this.disposed || this.disposing) return;

    this.busy = true;
    this.cancelRequested = false;
    this.activity = "思考中";
    this.conversation.push({ role: "user", text: prompt });
    const assistant: BtwConversationItem = { role: "assistant", text: "" };
    this.activeAssistant = assistant;
    this.conversation.push(assistant);
    this.emitChange();

    const run = this.runSubmit(prompt, assistant);
    this.currentSubmit = run;
    try {
      await run;
    } finally {
      if (this.currentSubmit === run) this.currentSubmit = undefined;
    }
  }

  async refreshParentSnapshot(): Promise<void> {
    if (this.busy) {
      this.conversation.push({ role: "notice", text: "生成期间不能刷新主会话快照。" });
      this.emitChange();
      return;
    }

    const sideMessages = this.session.messages.slice(this.parentMessageCount);
    const parentMessages = snapshotParentMessages(this.ctx);
    const parentHistory = snapshotParentHistory(this.ctx);
    this.session.agent.state.messages = [...parentMessages, ...sideMessages];
    this.historySnapshot.entries = parentHistory.entries;
    this.parentMessageCount = parentMessages.length;
    this.conversation.push({
      role: "notice",
      text: `已刷新主会话快照：${parentMessages.length} 条当前上下文消息，${parentHistory.entries.length} 条完整分支记录。`,
    });
    this.emitChange();
  }

  async abort(): Promise<void> {
    if (!this.busy || this.disposed) return;
    this.cancelRequested = true;
    this.activity = "正在取消";
    this.emitChange();
    await this.session.abort();
    await this.currentSubmit;
  }

  async dispose(): Promise<void> {
    if (this.disposed || this.disposing) return;
    this.disposing = true;
    if (this.busy) {
      this.cancelRequested = true;
      await this.session.abort();
      await this.currentSubmit;
    }
    this.disposed = true;
    this.unsubscribe();
    this.session.dispose();
    this.onChange = undefined;
    this.emitChange();
    this.listeners.clear();
  }

  private handleEvent(event: AgentSessionEvent): void {
    if (this.disposed) return;

    if (event.type === "agent_start" && this.cancelRequested) {
      void this.session.abort();
      return;
    }

    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      if (this.activeAssistant) this.activeAssistant.text += event.assistantMessageEvent.delta;
      this.emitChange();
      return;
    }

    if (event.type === "message_end" && event.message.role === "assistant") {
      const text = messageText(event.message);
      if (this.activeAssistant && text.trim()) this.activeAssistant.text = text;
      this.emitChange();
      return;
    }

    if (event.type === "tool_execution_start") {
      this.activity = `只读工具：${summarizeTool(event.toolName, event.args)}`;
      this.emitChange();
      return;
    }

    if (event.type === "tool_execution_end") {
      this.activity = event.isError ? `工具失败：${event.toolName}` : "继续思考中";
      this.emitChange();
      return;
    }

  }

  private async runSubmit(prompt: string, assistant: BtwConversationItem): Promise<void> {
    try {
      await this.session.prompt(prompt, {
        expandPromptTemplates: false,
        source: "extension",
      });
    } catch (error) {
      if (!this.cancelRequested) {
        const detail = error instanceof Error ? error.message : String(error);
        if (!assistant.text.trim()) assistant.text = `请求失败：${detail}`;
        else this.conversation.push({ role: "notice", text: `请求失败：${detail}` });
      }
    } finally {
      if (this.cancelRequested && !assistant.text.trim()) assistant.text = "（已取消）";
      this.busy = false;
      this.cancelRequested = false;
      this.activity = "";
      if (this.activeAssistant === assistant) this.activeAssistant = undefined;
      this.emitChange();
    }
  }

  private emitChange(): void {
    this.revision += 1;
    this.onChange?.();
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) listener(snapshot);
  }
}
