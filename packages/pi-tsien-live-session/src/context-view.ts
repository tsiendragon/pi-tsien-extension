/**
 * Context view — turn "what this session sends to the model" into a structure a
 * dashboard can analyse: the system prompt, the tool definitions and the message
 * history, each with its size and an approximate token count.
 *
 * Two sources, in order of honesty:
 *
 * 1. `provider_request`: the payload pi handed to the provider on the latest
 *    request (`before_provider_request`). That is what the model actually received,
 *    in the provider's own wire format (OpenAI Responses / Chat Completions,
 *    Anthropic Messages, Google, Bedrock Converse), so it is normalized here.
 * 2. `reconstructed`: no request has gone out in this process yet (fresh start,
 *    reload). The view is rebuilt from the current system prompt, the active tools
 *    and the session branch. Extension `context` transforms and per-turn prompt
 *    changes are NOT applied, so it is an approximation and labelled as one.
 *
 * Pure functions only — the extension wires in the live values, tests feed
 * fixtures.
 */
import type { JsonObject } from "./protocol.ts";

/** Each item's readable text is cut to this many characters. */
export const CONTEXT_ITEM_TEXT_LIMIT = 48 * 1024;/**
 * Once the response carries this many characters, remaining items ship only a
 * preview. Characters, not bytes: CJK text is 3 UTF-8 bytes per character, and the
 * whole command result must stay below the broker's 8 MiB frame limit.
 */
export const CONTEXT_TOTAL_TEXT_BUDGET = 1536 * 1024;
/** Preview length used after the total budget is spent. */
export const CONTEXT_PREVIEW_LIMIT = 2 * 1024;
/** The system prompt is shown whole up to this size. */
export const CONTEXT_SYSTEM_TEXT_LIMIT = 256 * 1024;
const TOOL_TEXT_LIMIT = 16 * 1024;
const SETTING_VALUE_LIMIT = 2 * 1024;

export type ContextItemKind = "message" | "tool_call" | "tool_result" | "reasoning" | "other";export type ContextCategory = "system" | "tools" | "user" | "assistant" | "tool_call" | "tool_result" | "reasoning" | "other";

export interface ContextViewItem {
  readonly index: number;
  readonly kind: ContextItemKind;
  readonly category: ContextCategory;
  readonly role: string;
  readonly label: string;
  readonly text: string;
  readonly chars: number;
  readonly tokens: number;
  readonly images?: number;
  readonly truncated?: boolean;
}

export interface ContextViewTool {
  readonly name: string;
  readonly description: string;
  readonly descriptionChars: number;
  readonly parameters: string;
  readonly parametersChars: number;
  readonly tokens: number;
  readonly truncated?: boolean;
}

export interface ContextViewSystemPart {
  readonly kind: "base" | "context_file" | "skills" | "guidelines";
  readonly label: string;
  readonly chars: number;
  readonly tokens: number;
  readonly count?: number;
}

/**
 * Shape version of {@link ContextView}. Bumped when a field changes meaning.
 *
 * A view WITHOUT this field came from an older extension build (or from a Pi
 * session still running one), so a consumer must not read missing fields as "there
 * is nothing here" — that is the difference between “empty” and “not reported”.
 */
export const CONTEXT_VIEW_VERSION = 1 as const;

export interface ContextView {
  readonly version: number;
  readonly source: "provider_request" | "reconstructed";
  readonly format: string;
  readonly generatedAt: number;
  readonly capturedAt?: number;
  readonly model?: { readonly provider: string; readonly id: string };
  readonly system: { readonly text: string; readonly chars: number; readonly tokens: number; readonly truncated?: boolean };
  readonly systemParts: readonly ContextViewSystemPart[];
  readonly tools: readonly ContextViewTool[];
  readonly messages: readonly ContextViewItem[];
  readonly totals: {
    readonly tokens: number;
    readonly chars: number;
    readonly byCategory: Readonly<Record<ContextCategory, number>>;
  };
  /** pi's own context usage (from the last provider usage report), for calibration. */
  readonly contextUsage?: { readonly tokens: number | null; readonly contextWindow: number; readonly percent: number | null };
  /** Non-content request fields (model, reasoning, tool_choice, …), JSON-rendered. */
  readonly settings: Readonly<Record<string, string>>;
  readonly truncated: boolean;
}

export interface ContextViewInput {
  readonly source: ContextView["source"];
  readonly payload: unknown;
  readonly capturedAt?: number;
  readonly model?: { readonly provider: string; readonly id: string };
  readonly contextUsage?: { readonly tokens: number | null; readonly contextWindow: number; readonly percent: number | null };
  /** Skip format detection (the reconstructed view is always pi's own format). */
  readonly format?: string;
  /** Override the total text budget (the caller shrinks it when a result is too big). */
  readonly textBudget?: number;
  readonly now?: number;
}

type Rec = Record<string, unknown>;

function rec(value: unknown): Rec | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Rec : undefined;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Rough token estimate: ~4 ASCII characters per token, ~1 token per CJK / other
 * non-ASCII character. Good enough to rank what is big; not a tokenizer.
 */
export function estimateTokens(text: string): number {
  let ascii = 0;
  let other = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) { other++; i++; continue; }
    if (code < 128) ascii++; else other++;
  }
  return Math.ceil(ascii / 4) + other;
}

/** JSON-stringify without dragging inline image / opaque blobs into the text. */
function compactJson(value: unknown, indent = 2): string {
  try {
    return JSON.stringify(value, (key, v) => {
      if (typeof v === "string" && v.length > 4096 && (key === "data" || key === "encrypted_content" || key === "signature" || key === "url" || key === "image_url")) {
        return `[${v.length} chars omitted]`;
      }
      return v;
    }, indent) ?? "";
  } catch {
    return String(value);
  }
}

interface Rendered {
  text: string;
  images: number;
  blocks: Set<"text" | "thinking" | "tool_call" | "tool_result" | "image" | "other">;
}

function renderBlocks(content: unknown, out: Rendered): void {
  if (content == null) return;
  if (typeof content === "string") {
    if (content) { out.text += (out.text ? "\n\n" : "") + content; out.blocks.add("text"); }
    return;
  }
  if (!Array.isArray(content)) {
    renderBlock(content, out);
    return;
  }
  for (const block of content) renderBlock(block, out);
}

function append(out: Rendered, piece: string): void {
  if (!piece) return;
  out.text += (out.text ? "\n\n" : "") + piece;
}

function renderBlock(block: unknown, out: Rendered): void {
  if (typeof block === "string") { append(out, block); out.blocks.add("text"); return; }
  const b = rec(block);
  if (!b) return;
  const type = str(b.type);

  // Image-like blocks of every format: count them, never inline the bytes.
  if (type === "image" || type === "input_image" || type === "image_url" || b.inlineData || b.image) {
    out.images++;
    out.blocks.add("image");
    append(out, "[图片]");
    return;
  }
  if (type === "text" || type === "input_text" || type === "output_text" || (type === "" && typeof b.text === "string")) {
    append(out, str(b.text));
    out.blocks.add("text");
    return;
  }
  if (type === "thinking" || type === "reasoning" || type === "reasoning_text" || type === "summary_text") {
    append(out, str(b.thinking) || str(b.text));
    out.blocks.add("thinking");
    return;
  }
  if (type === "redacted_thinking") {
    append(out, "[思考内容已加密]");
    out.blocks.add("thinking");
    return;
  }
  if (b.reasoningContent) {
    const rc = rec(b.reasoningContent);
    append(out, str(rec(rc?.reasoningText)?.text) || "[思考内容]");
    out.blocks.add("thinking");
    return;
  }
  // Tool calls: Anthropic tool_use, pi toolCall, Gemini functionCall, Bedrock toolUse.
  if (type === "tool_use" || type === "toolCall" || b.functionCall || b.toolUse) {
    const call = rec(b.functionCall) ?? rec(b.toolUse) ?? b;
    const args = call.input ?? call.arguments ?? call.args ?? {};
    append(out, `→ ${str(call.name) || "tool"}(${typeof args === "string" ? args : compactJson(args)})`);
    out.blocks.add("tool_call");
    return;
  }
  // Tool results: Anthropic tool_result, Gemini functionResponse, Bedrock toolResult.
  if (type === "tool_result" || b.functionResponse || b.toolResult) {
    const result = rec(b.functionResponse) ?? rec(b.toolResult) ?? b;
    const name = str(result.name) || str(b.tool_use_id) || str(b.call_id) || str(b.tool_call_id);
    const inner: Rendered = { text: "", images: 0, blocks: new Set() };
    if (result.content !== undefined) renderBlocks(result.content, inner);
    else if (result.response !== undefined) append(inner, compactJson(result.response));
    out.images += inner.images;
    append(out, `← ${name ? `${name} ` : ""}结果\n${inner.text}`);
    out.blocks.add("tool_result");
    return;
  }
  append(out, compactJson(b));
  out.blocks.add("other");
}

interface NormalizedItem {
  kind: ContextItemKind;
  role: string;
  label: string;
  text: string;
  images: number;
}

function roleCategory(role: string): ContextCategory {
  if (role === "user") return "user";
  if (role === "assistant" || role === "model") return "assistant";
  if (role === "system" || role === "developer") return "system";
  return "other";
}

function normalizeItem(item: unknown): NormalizedItem {
  const m = rec(item);
  if (!m) {
    return { kind: "message", role: "user", label: "user", text: typeof item === "string" ? item : compactJson(item), images: 0 };
  }
  const type = str(m.type);
  const role = str(m.role);

  // OpenAI Responses items without a role.
  if (type === "reasoning") {
    const out: Rendered = { text: "", images: 0, blocks: new Set() };
    renderBlocks(m.summary, out);
    renderBlocks(m.content, out);
    const encrypted = str(m.encrypted_content);
    if (encrypted) append(out, `[加密推理内容 ${encrypted.length} 字符]`);
    return { kind: "reasoning", role: "reasoning", label: "reasoning", text: out.text, images: 0 };
  }
  if (type === "function_call" || type === "custom_tool_call") {
    const args = m.arguments ?? m.input ?? "";
    return { kind: "tool_call", role: "assistant", label: `调用 ${str(m.name) || "tool"}`, text: typeof args === "string" ? args : compactJson(args), images: 0 };
  }
  if (type === "function_call_output" || type === "custom_tool_call_output") {
    const out: Rendered = { text: "", images: 0, blocks: new Set() };
    renderBlocks(m.output, out);
    return { kind: "tool_result", role: "tool", label: "工具结果", text: out.text, images: out.images };
  }

  // pi-ai's own message format (used by the reconstructed view).
  if (role === "toolResult") {
    const out: Rendered = { text: "", images: 0, blocks: new Set() };
    renderBlocks(m.content, out);
    return { kind: "tool_result", role: "tool", label: `结果 ${str(m.toolName) || "tool"}`, text: out.text, images: out.images };
  }
  // OpenAI Chat Completions tool message.
  if (role === "tool" || role === "function") {
    const out: Rendered = { text: "", images: 0, blocks: new Set() };
    renderBlocks(m.content, out);
    return { kind: "tool_result", role: "tool", label: `结果 ${str(m.name) || str(m.tool_call_id) || "tool"}`, text: out.text, images: out.images };
  }

  const out: Rendered = { text: "", images: 0, blocks: new Set() };
  renderBlocks(m.content ?? m.parts, out);
  // Chat Completions assistant tool calls.
  if (Array.isArray(m.tool_calls)) {
    for (const call of m.tool_calls) {
      const fn = rec(rec(call)?.function);
      append(out, `→ ${str(fn?.name) || "tool"}(${str(fn?.arguments)})`);
      out.blocks.add("tool_call");
    }
  }
  if (typeof m.reasoning_content === "string" && m.reasoning_content) {
    append(out, m.reasoning_content);
    out.blocks.add("thinking");
  }

  const effectiveRole = role || type || "unknown";
  const blocks = out.blocks;
  // Classify by what the message actually carries. Precedence matters for mixed
  // turns (a thinking block next to a tool call is an assistant action, not
  // reasoning on its own); image-only and text-only items stay plain messages.
  let kind: ContextItemKind = "message";
  if (blocks.has("tool_result")) kind = "tool_result";
  else if (blocks.has("tool_call")) kind = "tool_call";
  else if (blocks.has("thinking") && !blocks.has("text")) kind = "reasoning";
  const label = kind === "tool_result" ? "工具结果" : kind === "tool_call" ? "工具调用" : kind === "reasoning" ? "思考" : effectiveRole;
  return { kind, role: effectiveRole, label, text: out.text, images: out.images };
}

function itemCategory(item: NormalizedItem): ContextCategory {
  return item.kind === "message" ? roleCategory(item.role) : item.kind;
}

function systemText(value: unknown): string {
  if (typeof value === "string") return value;
  const out: Rendered = { text: "", images: 0, blocks: new Set() };
  const r = rec(value);
  renderBlocks(r && Array.isArray(r.parts) ? r.parts : value, out);
  return out.text;
}

interface ToolSource { name: string; description: string; parameters: unknown }

function collectTools(payload: Rec): ToolSource[] {
  const raw: unknown[] = [];
  if (Array.isArray(payload.tools)) raw.push(...payload.tools);
  const toolConfig = rec(payload.toolConfig);
  if (toolConfig && Array.isArray(toolConfig.tools)) raw.push(...toolConfig.tools);
  const tools: ToolSource[] = [];
  for (const entry of raw) {
    const t = rec(entry);
    if (!t) continue;
    // Gemini groups declarations.
    if (Array.isArray(t.functionDeclarations)) {
      for (const decl of t.functionDeclarations) {
        const d = rec(decl);
        if (d) tools.push({ name: str(d.name), description: str(d.description), parameters: d.parameters ?? d.parametersJsonSchema ?? {} });
      }
      continue;
    }
    const fn = rec(t.function) ?? rec(t.toolSpec) ?? t;
    const inputSchema = rec(fn.inputSchema);
    tools.push({
      name: str(fn.name) || str(t.type) || "tool",
      description: str(fn.description),
      parameters: fn.parameters ?? fn.input_schema ?? inputSchema?.json ?? fn.inputSchema ?? fn.format ?? {},
    });
  }
  return tools;
}

function detectFormat(p: Rec): string {
  if (Array.isArray(p.input) || typeof p.instructions === "string") return "openai-responses";
  if (Array.isArray(p.contents)) return "google";
  if (p.toolConfig || (Array.isArray(p.system) && Array.isArray(p.messages) && rec(p.inferenceConfig))) return "bedrock-converse";
  if (Array.isArray(p.messages) && p.system !== undefined) return "anthropic-messages";
  if (Array.isArray(p.messages)) {
    const first = rec(p.messages[0]);
    if (first && (first.role === "toolResult" || Array.isArray(first.content))) return "pi";
    return "openai-chat";
  }
  return "unknown";
}

const CONTENT_KEYS = new Set(["messages", "input", "contents", "tools", "toolConfig", "system", "instructions", "systemInstruction", "systemPrompt"]);

function collectSettings(p: Rec): Record<string, string> {
  const settings: Record<string, string> = {};
  for (const [key, value] of Object.entries(p)) {
    if (CONTENT_KEYS.has(key) || value === undefined) continue;
    const json = compactJson(value, 0);
    settings[key] = json.length > SETTING_VALUE_LIMIT ? `${json.slice(0, SETTING_VALUE_LIMIT)}…` : json;
  }
  return settings;
}

function systemParts(systemFull: string): ContextViewSystemPart[] {
  const parts: ContextViewSystemPart[] = [];
  let accounted = 0;

  // Project instruction files: the single biggest, most actionable block.
  const filePattern = /<project_instructions path="([^"]*)">[\s\S]*?<\/project_instructions>/g;
  for (const match of systemFull.matchAll(filePattern)) {
    const label = match[1] || "(context file)";
    parts.push({ kind: "context_file", label, chars: match[0].length, tokens: estimateTokens(match[0]) });
    accounted += match[0].length;
  }

  const skills = /<available_skills>[\s\S]*?<\/available_skills>/.exec(systemFull);
  if (skills) {
    const count = (skills[0].match(/<skill>/g) || []).length;
    parts.push({ kind: "skills", label: "Skills 清单", chars: skills[0].length, tokens: estimateTokens(skills[0]), count });
    accounted += skills[0].length;
  }

  const guidelines = /Guidelines:\n([\s\S]*?)(?:\n\n|$)/.exec(systemFull);
  if (guidelines) {
    const count = (guidelines[1].match(/^- /gm) || []).length;
    parts.push({ kind: "guidelines", label: "准则（含扩展追加）", chars: guidelines[1].length, tokens: estimateTokens(guidelines[1]), count });
    accounted += guidelines[1].length;
  }

  const base = systemFull.length - accounted;
  if (base > 0) {
    parts.push({
      kind: "base",
      label: "基础提示（身份 / 工具列表 / 文档索引 / 扩展追加）",
      chars: base,
      tokens: Math.max(0, estimateTokens(systemFull) - parts.reduce((sum, part) => sum + part.tokens, 0)),
    });
  }
  return parts.sort((a, b) => b.chars - a.chars);
}

function clip(text: string, limit: number): { text: string; truncated: boolean } {
  return text.length > limit ? { text: text.slice(0, limit), truncated: true } : { text, truncated: false };
}

const EMPTY_TOTALS = (): Record<ContextCategory, number> => ({
  system: 0, tools: 0, user: 0, assistant: 0, tool_call: 0, tool_result: 0, reasoning: 0, other: 0,
});

/** Normalize a provider payload (or a reconstructed pi-format one) into a ContextView. */
export function buildContextView(input: ContextViewInput): ContextView {
  const p = rec(input.payload) ?? {};
  const format = input.format ?? detectFormat(p);

  // ── system prompt ──
  const systemPieces: string[] = [];
  for (const key of ["instructions", "system", "systemInstruction", "systemPrompt"] as const) {
    if (p[key] !== undefined) {
      const text = systemText(p[key]);
      if (text) systemPieces.push(text);
    }
  }

  // ── messages ──
  let rawItems: unknown[] = [];
  if (Array.isArray(p.messages)) rawItems = p.messages;
  else if (Array.isArray(p.input)) rawItems = p.input;
  else if (typeof p.input === "string") rawItems = [{ role: "user", content: p.input }];
  else if (Array.isArray(p.contents)) rawItems = p.contents;

  let index = 0;
  // Leading system / developer messages are the system prompt for chat-style APIs.
  while (index < rawItems.length) {
    const role = str(rec(rawItems[index])?.role);
    if (role !== "system" && role !== "developer") break;
    systemPieces.push(normalizeItem(rawItems[index]).text);
    index++;
  }

  const byCategory = EMPTY_TOTALS();
  let truncated = false;
  let budget = input.textBudget ?? CONTEXT_TOTAL_TEXT_BUDGET;

  const systemFull = systemPieces.join("\n\n");
  const systemClip = clip(systemFull, Math.min(CONTEXT_SYSTEM_TEXT_LIMIT, Math.max(CONTEXT_PREVIEW_LIMIT, budget)));
  if (systemClip.truncated) truncated = true;
  budget -= systemClip.text.length;
  const systemTokens = estimateTokens(systemFull);
  byCategory.system += systemTokens;

  // ── tools ──
  const tools: ContextViewTool[] = collectTools(p).map(tool => {
    const parameters = compactJson(tool.parameters, 0);
    const tokens = estimateTokens(tool.name) + estimateTokens(tool.description) + estimateTokens(parameters);
    byCategory.tools += tokens;
    const description = clip(tool.description, TOOL_TEXT_LIMIT);
    const params = clip(parameters, TOOL_TEXT_LIMIT);
    if (description.truncated || params.truncated) truncated = true;
    budget -= description.text.length + params.text.length;
    return {
      name: tool.name,
      description: description.text,
      descriptionChars: tool.description.length,
      parameters: params.text,
      parametersChars: parameters.length,
      tokens,
      ...(description.truncated || params.truncated ? { truncated: true } : {}),
    };
  });

  // ── messages ──
  const messages: ContextViewItem[] = [];
  for (let i = index; i < rawItems.length; i++) {
    const item = normalizeItem(rawItems[i]);
    const category = itemCategory(item);
    const tokens = estimateTokens(item.text) + item.images * 1_000;
    byCategory[category] += tokens;
    const limit = budget > 0 ? CONTEXT_ITEM_TEXT_LIMIT : CONTEXT_PREVIEW_LIMIT;
    const clipped = clip(item.text, limit);
    if (clipped.truncated) truncated = true;
    budget -= clipped.text.length;
    messages.push({
      index: messages.length,
      kind: item.kind,
      category,
      role: item.role,
      label: item.label,
      text: clipped.text,
      chars: item.text.length,
      tokens,
      ...(item.images ? { images: item.images } : {}),
      ...(clipped.truncated ? { truncated: true } : {}),
    });
  }

  const totalTokens = Object.values(byCategory).reduce((sum, n) => sum + n, 0);
  const totalChars = systemFull.length
    + tools.reduce((sum, t) => sum + t.name.length + t.descriptionChars + t.parametersChars, 0)
    + messages.reduce((sum, m) => sum + m.chars, 0);

  return {
    version: CONTEXT_VIEW_VERSION,
    source: input.source,
    format,
    generatedAt: input.now ?? Date.now(),
    ...(input.capturedAt !== undefined ? { capturedAt: input.capturedAt } : {}),
    ...(input.model ? { model: { provider: input.model.provider, id: input.model.id } } : {}),
    system: { text: systemClip.text, chars: systemFull.length, tokens: systemTokens, ...(systemClip.truncated ? { truncated: true } : {}) },
    systemParts: systemParts(systemFull),
    tools,
    messages,
    totals: { tokens: totalTokens, chars: totalChars, byCategory },
    ...(input.contextUsage ? { contextUsage: input.contextUsage } : {}),
    settings: collectSettings(p),
    truncated,
  };
}

/** The ContextView is plain data by construction; this only narrows the type for the wire. */
export function contextViewJson(view: ContextView): JsonObject {
  return view as unknown as JsonObject;
}

