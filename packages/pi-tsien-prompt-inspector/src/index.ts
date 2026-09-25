import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Prompt Inspector
 *
 * 用两种互补的信息源，把"当前真正喂给大模型的内容"可视化出来：
 *
 * 1. 地面真值：`before_provider_request` 钩子把 provider 序列化前的最终载荷
 *    `event.payload`（系统提示、工具定义、完整消息历史）落盘到
 *    `~/.pi/agent/prompt-inspector/last-request.json`。这是最接近"模型实际收到什么"的版本。
 *
 * 2. 实时重构：没有抓到 payload 时（例如刚启动还没跑对话），`/prompt` 命令用
 *    `ctx.getSystemPrompt()`、`ctx.getSystemPromptOptions()` 和当前会话消息，拼一份近似视图。
 *
 * 用法：
 *   /prompt          渲染最近一次 provider 载荷为 markdown 并用编辑器打开
 *   /prompt raw      直接展示原始 payload JSON
 *   /prompt path     只打印产物文件路径（不打开编辑器）
 */

const STORE_VERSION = 1 as const;
const MAX_EDITOR_CHARS = 120_000;
const VIEWPORT_ROWS = 20;
const MAX_OVERLAY_WIDTH = 140;

type Json = unknown;

interface CapturedRequest {
  version: typeof STORE_VERSION;
  capturedAt: number;
  cwd: string;
  model?: string;
  payload: Json;
}

// ---------------------------------------------------------------------------
// 路径与基础 IO
// ---------------------------------------------------------------------------

function agentDir(): string {
  const fromEnv = process.env.PI_CODING_AGENT_DIR;
  return fromEnv ? resolve(fromEnv) : join(homedir(), ".pi", "agent");
}

function storeDir(): string {
  return join(agentDir(), "prompt-inspector");
}

function lastRequestPath(): string {
  return join(storeDir(), "last-request.json");
}

function markdownPath(): string {
  return join(storeDir(), "last-prompt.md");
}

function ensureStoreDir(): void {
  mkdirSync(storeDir(), { recursive: true });
}

function writeText(path: string, content: string): void {
  ensureStoreDir();
  writeFileSync(path, content, "utf8");
}

function readCaptured(): CapturedRequest | undefined {
  try {
    if (!existsSync(lastRequestPath())) return undefined;
    const raw = JSON.parse(readFileSync(lastRequestPath(), "utf8")) as CapturedRequest;
    if (raw?.version !== STORE_VERSION || raw?.payload == null) return undefined;
    return raw;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// 通用取值与渲染
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function str(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  return String(value);
}

function renderContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((block) => renderContentBlock(block)).join("\n\n");
  }
  if (content == null) return "";
  return JSON.stringify(content, null, 2);
}

function renderContentBlock(block: unknown): string {
  if (typeof block === "string") return block;
  const b = asRecord(block);
  if (!b) return JSON.stringify(block, null, 2);

  const type = str(b.type);
  switch (type) {
    case "text":
      return str(b.text);
    case "thinking":
      return `【思考】\n${str(b.thinking ?? b.text)}`;
    case "tool_use":
    case "toolCall": {
      const input = b.input ?? b.arguments ?? {};
      return `【工具调用 ${str(b.name ?? b.id)}】\n${JSON.stringify(input, null, 2)}`;
    }
    case "tool_result":
    case "toolResult": {
      return `【工具结果】\n${renderContent(b.content ?? "")}`;
    }
    case "image":
    case "image_url": {
      const src = asRecord(b.source ?? b.image_url);
      const media = str(src?.media_type ?? src?.mediaType ?? b.mimeType ?? b.media_type ?? "");
      const data = str(src?.data ?? b.data ?? b.url ?? "");
      return `【图片${media ? ` ${media}` : ""}】${data ? ` ${data.length} 字节` : ""}`;
    }
    default:
      return JSON.stringify(block, null, 2);
  }
}

// ---------------------------------------------------------------------------
// 系统提示提取
// ---------------------------------------------------------------------------

/**
 * 返回 provider 载荷里的系统提示。Anthropic 格式放在 `system`，
 * OpenAI 格式放在 `messages[0]`（role 为 system / developer）。
 */
function extractSystem(payload: Json): { text: string; found: boolean } {
  const p = asRecord(payload);
  if (!p) return { text: "", found: false };
  if (typeof p.system === "string") return { text: p.system, found: true };
  if (Array.isArray(p.system)) return { text: renderContent(p.system), found: true };

  if (Array.isArray(p.messages)) {
    const first = asRecord(p.messages[0]);
    const role = str(first?.role);
    if (role === "system" || role === "developer") {
      return { text: renderContent(first?.content), found: true };
    }
  }
  return { text: "（此载荷中系统提示内嵌于消息序列，见下方 messages）", found: false };
}

// ---------------------------------------------------------------------------
// 消息序列渲染（provider payload 里的 messages）
// ---------------------------------------------------------------------------

function renderPayloadMessages(messages: unknown): string {
  if (!Array.isArray(messages) || messages.length === 0) return "（无消息）";
  const out: string[] = [];
  messages.forEach((item, index) => {
    const msg = asRecord(item);
    if (!msg) {
      out.push(`### [${index + 1}] (raw)\n${JSON.stringify(item, null, 2)}`);
      return;
    }
    const role = str(msg.role) || "(unknown)";
    let body = renderContent(msg.content);

    // OpenAI assistant 消息可能用 tool_calls 而不是 content 块
    const toolCalls = msg.tool_calls;
    if (Array.isArray(toolCalls) && toolCalls.length > 0) {
      const calls = toolCalls
        .map((tc) => {
          const c = asRecord(tc);
          const fn = asRecord(c?.function);
          return `【工具调用 ${str(c?.id)} ${str(fn?.name)}】\n${str(fn?.arguments)}`;
        })
        .join("\n");
      body = body ? `${body}\n\n${calls}` : calls;
    }

    // OpenAI tool 消息
    if (role === "tool" && msg.tool_call_id) {
      body = `【工具结果 ${str(msg.tool_call_id)}】\n${body}`;
    }

    out.push(`### [${index + 1}] ${role}\n${body || "(空)"}`);
  });
  return out.join("\n\n");
}

// ---------------------------------------------------------------------------
// 消息序列渲染（fallback：当前会话 entries）
// ---------------------------------------------------------------------------

function renderSessionEntries(entries: unknown[]): string {
  const out: string[] = [];
  let index = 0;
  for (const item of entries) {
    const entry = asRecord(item);
    const message = asRecord(entry?.message);
    if (!message) continue;
    index += 1;

    const role = str(message.role) || "(unknown)";
    let body = "";
    switch (role) {
      case "user":
        body = renderContent(message.content);
        break;
      case "assistant":
        body = renderContent(message.content);
        break;
      case "toolResult":
        body = `工具：${str(message.toolName)}\n${renderContent(message.content)}`;
        break;
      case "bashExecution":
        body = `$ ${str(message.command)}\n${str(message.output)}`;
        break;
      case "custom":
      case "hookMessage":
        body = renderContent(message.content);
        break;
      case "branchSummary":
        body = str(message.summary);
        break;
      case "compactionSummary":
        body = str(message.summary);
        break;
      default:
        body = renderContent(message.content);
    }
    out.push(`### [${index}] ${role}\n${body || "(空)"}`);
  }
  return out.length > 0 ? out.join("\n\n") : "（无消息）";
}

// ---------------------------------------------------------------------------
// 系统提示构成信息（skills / tools / context files / guidelines）
// ---------------------------------------------------------------------------

function renderPromptOptions(ctx: ExtensionCommandContext): string {
  let opts;
  try {
    opts = ctx.getSystemPromptOptions();
  } catch {
    return "";
  }

  const lines: string[] = [];
  lines.push("## 系统 Prompt 构成（当前会话）");
  lines.push("");

  const skills = Array.isArray(opts.skills) ? opts.skills : [];
  if (skills.length > 0) {
    lines.push(`### Skills（${skills.length}）`);
    for (const skill of skills) {
      const s = asRecord(skill);
      const name = str(s?.name) || "(未命名)";
      const filePath = str(s?.filePath);
      lines.push(`- ${name}${filePath ? ` — \`${filePath}\`` : ""}`);
    }
    lines.push("");
  }

  const tools = Array.isArray(opts.selectedTools) ? opts.selectedTools : [];
  if (tools.length > 0) {
    lines.push(`### 当前启用的工具（${tools.length}）`);
    lines.push(`- ${tools.join(", ")}`);
    lines.push("");
  }

  const contextFiles = Array.isArray(opts.contextFiles) ? opts.contextFiles : [];
  if (contextFiles.length > 0) {
    lines.push(`### Context Files（${contextFiles.length}）`);
    for (const file of contextFiles) {
      const f = asRecord(file);
      lines.push(`- \`${str(f?.path)}\``);
    }
    lines.push("");
  }

  const guidelines = Array.isArray(opts.promptGuidelines) ? opts.promptGuidelines : [];
  if (guidelines.length > 0) {
    lines.push(`### 追加 Guidelines（${guidelines.length}）`);
    for (const g of guidelines) {
      lines.push(`- ${str(g)}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// 顶层 markdown 组装
// ---------------------------------------------------------------------------

function renderPayloadMarkdown(req: CapturedRequest): string {
  const system = extractSystem(req.payload);
  const p = asRecord(req.payload);
  const messages = p?.messages;
  const tools = p?.tools;

  const lines: string[] = [];
  lines.push("# Prompt Inspector");
  lines.push("");
  lines.push(`- 来源：真实 provider 载荷（before_provider_request）`);
  lines.push(`- 抓取时间：${new Date(req.capturedAt).toISOString()}`);
  lines.push(`- 模型：${req.model ?? str(p?.model) ?? "未知"}`);
  lines.push(`- 工作目录：${req.cwd}`);
  lines.push("");

  lines.push("## 系统 Prompt");
  lines.push("");
  lines.push(system.text || "（无系统提示）");
  lines.push("");

  lines.push(
    `## 消息序列（${Array.isArray(messages) ? messages.length : 0} 条）`,
  );
  lines.push("");
  lines.push(renderPayloadMessages(messages));
  lines.push("");

  if (tools != null) {
    const count = Array.isArray(tools) ? tools.length : 0;
    lines.push(`## 工具定义（${count}）`);
    lines.push("");
    lines.push("```json");
    lines.push(JSON.stringify(tools, null, 2));
    lines.push("```");
    lines.push("");
  }

  const keys = p ? Object.keys(p) : [];
  lines.push("## 原始载荷字段");
  lines.push("");
  lines.push(keys.map((k) => `- \`${k}\``).join("\n") || "- （空）");
  lines.push("");
  lines.push(`完整原始 JSON：\`${lastRequestPath()}\``);

  return lines.join("\n");
}

function renderFallbackMarkdown(ctx: ExtensionCommandContext): string {
  const systemPrompt = ctx.getSystemPrompt();
  const entries: unknown[] = (ctx.sessionManager.buildContextEntries() ?? []) as unknown[];
  const options = renderPromptOptions(ctx);

  const lines: string[] = [];
  lines.push("# Prompt Inspector");
  lines.push("");
  lines.push("- 来源：实时重构（尚未抓到 provider 载荷，先跑一轮对话即可得到地面真值）");
  lines.push(`- 模型：${ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "未知"}`);
  lines.push(`- 工作目录：${ctx.cwd}`);
  lines.push("");

  lines.push("## 系统 Prompt");
  lines.push("");
  lines.push(systemPrompt || "（无系统提示）");
  lines.push("");

  if (options) {
    lines.push(options);
    lines.push("");
  }

  lines.push("## 消息序列（当前会话）");
  lines.push("");
  lines.push(renderSessionEntries(entries));

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// 展示
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 弹出浮层（只读、可滚动）
// ---------------------------------------------------------------------------

class PromptOverlay implements Component {
  private offset = 0;

  constructor(
    private readonly content: string,
    private readonly filePath: string,
    private readonly theme: Theme,
    private readonly requestRender: () => void,
    private readonly close: () => void,
  ) {}

  handleInput(input: string): void {
    if (
      matchesKey(input, "escape") ||
      matchesKey(input, "return") ||
      input.toLowerCase() === "q"
    ) {
      this.close();
      return;
    }

    let delta = 0;
    if (matchesKey(input, "up")) delta = -1;
    else if (matchesKey(input, "down")) delta = 1;
    else if (matchesKey(input, "pageUp")) delta = -VIEWPORT_ROWS;
    else if (matchesKey(input, "pageDown")) delta = VIEWPORT_ROWS;
    else if (matchesKey(input, "home")) delta = -1_000_000;
    else if (matchesKey(input, "end")) delta = 1_000_000;
    else return;

    // 软换行后的总行数依赖当前宽度，精确 clamp 放在 render 里做，这里只保证不为负。
    this.offset = Math.max(0, this.offset + delta);
    this.requestRender();
  }

  private wrapLines(width: number): string[] {
    const out: string[] = [];
    for (const line of this.content.split("\n")) {
      if (line.length === 0) {
        out.push("");
        continue;
      }
      let rest = line;
      while (rest.length > width) {
        out.push(rest.slice(0, width));
        rest = rest.slice(width);
      }
      out.push(rest);
    }
    return out;
  }

  render(width: number): string[] {
    if (width < 20) return [truncateToWidth("Prompt Inspector：终端过窄", width)];

    const panelWidth = Math.min(width, MAX_OVERLAY_WIDTH);
    const innerWidth = panelWidth - 2;
    const lines = this.wrapLines(innerWidth);
    const maxOffset = Math.max(0, lines.length - VIEWPORT_ROWS);
    this.offset = Math.min(Math.max(0, this.offset), maxOffset);
    const visible = lines.slice(this.offset, this.offset + VIEWPORT_ROWS);

    const pad = (content: string) => {
      const clipped = truncateToWidth(content, innerWidth);
      return clipped + " ".repeat(Math.max(0, innerWidth - visibleWidth(clipped)));
    };
    const frame = (content: string) =>
      this.theme.fg("border", "│") + pad(content) + this.theme.fg("border", "│");

    const position =
      lines.length > VIEWPORT_ROWS
        ? ` ${this.offset + 1}-${Math.min(this.offset + VIEWPORT_ROWS, lines.length)}/${lines.length}`
        : ` ${lines.length} 行`;

    const out = [
      this.theme.fg("border", `╭${"─".repeat(innerWidth)}╮`),
      frame(this.theme.fg("accent", this.theme.bold("Prompt Inspector"))),
      frame(this.theme.fg("muted", ` 完整内容：${this.filePath}`)),
      frame(this.theme.fg("dim", ` ${position} · ↑↓ 滚动 · PgUp/PgDn 翻页 · Home/End · Esc/q 关闭`)),
      frame(this.theme.fg("borderMuted", "─".repeat(innerWidth))),
    ];

    for (const line of visible) out.push(frame(line));
    for (let index = visible.length; index < VIEWPORT_ROWS; index++) out.push(frame(""));

    const moreAbove = this.offset > 0 ? "▲" : " ";
    const moreBelow = this.offset < maxOffset ? "▼" : " ";
    out.push(frame(this.theme.fg("dim", ` ${moreAbove}${moreBelow} 长行已截断，完整版见上方文件路径`)));
    out.push(this.theme.fg("border", `╰${"─".repeat(innerWidth)}╯`));
    return out;
  }

  invalidate(): void {}
}

let activePromptClose: (() => void) | undefined;

function openPromptOverlay(ctx: ExtensionCommandContext, content: string, filePath: string): void {
  activePromptClose?.();
  const token = { close: undefined as (() => void) | undefined };
  void ctx.ui
    .custom<void>(
      (tui, theme, _keybindings, done) => {
        const close = () => done(undefined);
        token.close = close;
        activePromptClose = close;
        return new PromptOverlay(content, filePath, theme, () => tui.requestRender(), close);
      },
      {
        overlay: true,
        overlayOptions: {
          anchor: "center",
          width: "96%",
          minWidth: 60,
          maxHeight: "85%",
        },
      },
    )
    .finally(() => {
      if (activePromptClose === token.close) activePromptClose = undefined;
    });
}

function present(
  ctx: ExtensionCommandContext,
  subtitle: string,
  content: string,
  filePath: string,
  kind: string,
): void {
  const size = content.length;
  if (ctx.mode === "tui" && ctx.hasUI) {
    openPromptOverlay(ctx, content, filePath);
    ctx.ui.notify(`${kind} 已写入：${filePath}（${size} 字符）`, "info");
    return;
  }
  if (ctx.hasUI) {
    ctx.ui.notify(`${kind} 已写入：${filePath}（${size} 字符）`, "info");
    if (content.length <= MAX_EDITOR_CHARS) {
      void ctx.ui.editor(`Prompt Inspector：${subtitle}`, content);
    } else {
      ctx.ui.notify(`内容过长（${size} 字符），请直接打开文件查看`, "warning");
    }
  }
}

// ---------------------------------------------------------------------------
// 扩展入口
// ---------------------------------------------------------------------------

export default function promptInspectorExtension(pi: ExtensionAPI): void {
  // 地面真值：每次发出 provider 请求前，把最终载荷落盘（只读，不替换 payload）。
  pi.on("before_provider_request", (event, ctx) => {
    try {
      const payload = asRecord(event.payload);
      const model =
        str(payload?.model) ||
        (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined);
      const captured: CapturedRequest = {
        version: STORE_VERSION,
        capturedAt: Date.now(),
        cwd: ctx.cwd,
        ...(model ? { model } : {}),
        payload: event.payload,
      };
      ensureStoreDir();
      writeFileSync(lastRequestPath(), JSON.stringify(captured, null, 2), "utf8");
    } catch {
      // 抓取失败不能影响主流程。
    }
  });

  pi.registerCommand("prompt", {
    description: "查看当前输入给大模型的完整 prompt（系统提示/skills/消息/工具）",
    handler: async (args, ctx) => {
      const mode = args.trim().toLowerCase();

      if (mode === "path") {
        const captured = readCaptured();
        const lines = [
          `Markdown：${markdownPath()}`,
          `原始 payload：${lastRequestPath()}${captured ? "（最新）" : "（尚未抓取，先跑一轮对话）"}`,
        ];
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }

      if (mode === "raw" || mode === "json") {
        const captured = readCaptured();
        if (!captured) {
          ctx.ui.notify("尚未抓到 provider 载荷，请先跑一轮对话后再试。", "warning");
          return;
        }
        const raw = JSON.stringify(captured.payload, null, 2);
        present(ctx, "原始 payload", raw, lastRequestPath(), "原始 payload JSON");
        return;
      }

      const captured = readCaptured();
      if (captured) {
        const markdown = `${renderPayloadMarkdown(captured)}\n\n---\n\n${renderPromptOptions(ctx)}\n`;
        writeText(markdownPath(), markdown);
        present(ctx, "Prompt Markdown", markdown, markdownPath(), "Prompt Markdown");
        return;
      }

      const markdown = renderFallbackMarkdown(ctx);
      writeText(markdownPath(), markdown);
      present(ctx, "实时重构", markdown, markdownPath(), "Prompt Markdown（无 payload 重构版）");
    },
  });
}