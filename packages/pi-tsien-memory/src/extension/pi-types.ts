export type JsonSchema = Record<string, unknown>;

export interface AgentMessage {
  role: string;
  content?: unknown;
  [key: string]: unknown;
}

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  details?: unknown;
  isError?: boolean;
}

export interface SessionEntry {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
  [key: string]: unknown;
}

export interface ReadonlySessionManager {
  getSessionId(): string;
  getSessionFile(): string | undefined;
  getEntries(): SessionEntry[];
  getBranch(fromId?: string): SessionEntry[];
  buildContextEntries(): SessionEntry[];
}

export interface ExtensionUIContext {
  notify(message: string, type?: "info" | "warning" | "error"): void;
  setStatus(key: string, text: string | undefined): void;
  confirm(title: string, message: string, options?: { timeout?: number }): Promise<boolean>;
  select(title: string, options: string[], optionsConfig?: { timeout?: number }): Promise<string | undefined>;
  input(title: string, placeholder?: string, options?: { timeout?: number }): Promise<string | undefined>;
}

export interface ExtensionContext {
  cwd: string;
  mode: "tui" | "rpc" | "json" | "print" | string;
  hasUI: boolean;
  ui: ExtensionUIContext;
  sessionManager: ReadonlySessionManager;
  isProjectTrusted(): boolean;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
  killed: boolean;
}

export interface ExtensionCommandContext extends ExtensionContext {
  waitForIdle(): Promise<void>;
}

export interface ToolDefinition {
  name: string;
  label: string;
  description: string;
  approval?: "read" | "write" | "exec";
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters: JsonSchema;
  executionMode?: "sequential" | "parallel";
  execute(toolCallId: string, params: any, signal: AbortSignal | undefined, onUpdate: ((result: ToolResult) => void) | undefined, ctx: ExtensionContext): Promise<ToolResult>;
}

export interface ToolInfo {
  name: string;
  sourceInfo?: { source: string; [key: string]: unknown };
}

export interface BeforeAgentStartEvent {
  prompt: string;
  systemPrompt: string;
}

export interface ContextEvent {
  messages: AgentMessage[];
}

export interface InputEvent {
  text: string;
  source: "interactive" | "rpc" | "extension" | string;
  streamingBehavior?: "steer" | "followUp";
}

export interface AgentEndEvent {
  messages: AgentMessage[];
}

export interface ToolResultEvent {
  toolName: string;
  toolCallId: string;
  input: Record<string, unknown>;
  content: unknown[];
  isError: boolean;
}

export interface SessionBeforeCompactEvent {
  branchEntries: SessionEntry[];
  signal: AbortSignal;
}

export interface ExtensionEventBus {
  emit(channel: string, data: unknown): void;
  on(channel: string, handler: (data: unknown) => void): () => void;
}

export interface PiExtensionAPI {
  on(event: string, handler: (event: any, ctx: ExtensionContext) => unknown | Promise<unknown>): void;
  registerTool(tool: ToolDefinition): void;
  registerCommand(name: string, options: { description?: string; handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }): void;
  appendEntry<T = unknown>(customType: string, data?: T): void;
  exec(command: string, args: string[], options?: { cwd?: string; timeout?: number; signal?: AbortSignal }): Promise<ExecResult>;
  getAllTools(): ToolInfo[];
  getActiveTools(): string[];
  setActiveTools(toolNames: string[]): void;
  events?: ExtensionEventBus;
}
