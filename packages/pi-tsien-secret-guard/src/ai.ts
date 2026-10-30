import { spawn } from "node:child_process";
import type { AiReviewer, AiReviewItem, AiVerdict, Category } from "./types.ts";
import { CATEGORY_LABELS } from "./rules.ts";

const SYSTEM_PROMPT = `你是代码提交前的敏感信息审核员。用户会给你一批从待提交代码里挑出来的可疑片段。
你要逐条判断：这是「真实数据」还是「示例/占位/测试数据」。

判 example（示例）：
- 文档里的占位符，如 your-key-here、xxxxxx、<token>、changeme、{{API_KEY}}
- 公认的公开示例值，如 AWS 文档里的 AKIAIOSFODNN7EXAMPLE、示例身份证号
- 单元测试、fixture、mock 里编造的值
- 配置模板留给使用者填的空位
- 公共联系方式，如开源项目维护者邮箱、公司官网邮箱

判 real（真实数据）：
- 看起来能直接拿来用的真实凭证、真实内网地址
- 真实的真人姓名、手机号、证件号、私人邮箱
- 从生产环境或真实用户数据里复制过来的值

判断不了就判 unclear。

只输出 JSON 数组，不要写任何解释文字、不要用代码块包裹。每个元素长这样：
{"id":1,"verdict":"real","reason":"不超过20个字"}`;

export function buildReviewPrompt(items: AiReviewItem[]): string {
  const lines = items.map((item, index) => {
    const label = CATEGORY_LABELS[item.category as Category] ?? item.category;
    const snippet = item.snippet.replace(/\s+/g, " ").slice(0, 200);
    return `${index + 1}. 文件=${item.file} 行=${item.line} 类别=${label} 片段=${snippet}`;
  });
  return `请审核下面 ${items.length} 条片段：\n\n${lines.join("\n")}`;
}

const BATCH_SIZE = 25;

export function parseVerdicts(raw: string, expected: number): AiVerdict[] {
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  const empty: AiVerdict[] = Array.from({ length: expected }, () => ({ verdict: "unclear", reason: "AI 未返回结果" }));
  if (start < 0 || end <= start) return empty;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return empty;
  }
  if (!Array.isArray(parsed)) return empty;
  const out: AiVerdict[] = empty.map((item) => ({ ...item }));
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const id = typeof record.id === "number" ? record.id : Number(record.id);
    if (!Number.isInteger(id) || id < 1 || id > expected) continue;
    const verdict = record.verdict;
    if (verdict !== "real" && verdict !== "example" && verdict !== "unclear") continue;
    const reason = typeof record.reason === "string" ? record.reason.slice(0, 60) : "";
    out[id - 1] = { verdict, reason };
  }
  return out;
}

async function withBatches(
  items: AiReviewItem[],
  ask: (batch: AiReviewItem[], offset: number, signal?: AbortSignal) => Promise<AiVerdict[]>,
  signal?: AbortSignal,
): Promise<AiVerdict[]> {
  const out: AiVerdict[] = [];
  for (let offset = 0; offset < items.length; offset += BATCH_SIZE) {
    const batch = items.slice(offset, offset + BATCH_SIZE);
    const verdicts = await ask(batch, offset, signal);
    out.push(...verdicts);
  }
  return out;
}

/** Pi 会话内使用：直接走当前会话已认证的模型，不额外起进程。 */
export interface SessionReviewerOptions {
  complete: (prompt: string, signal?: AbortSignal) => Promise<string>;
}

export function createSessionReviewer(options: SessionReviewerOptions): AiReviewer {
  return async (items, signal) =>
    withBatches(items, async (batch, _offset, innerSignal) => {
      const raw = await options.complete(`${SYSTEM_PROMPT}\n\n${buildReviewPrompt(batch)}`, innerSignal);
      return parseVerdicts(raw, batch.length);
    }, signal);
}

/** git 钩子里使用：钩子不在 Pi 进程内，只能另起一次非交互 pi 调用。 */
export interface CliReviewerOptions {
  cwd: string;
  /** 固定模型，形如 "provider/model"；留空用 pi 默认模型 */
  model?: string;
  timeoutMs: number;
  command?: string;
}

export function createCliReviewer(options: CliReviewerOptions): AiReviewer {
  const bin = options.command ?? process.env.SECRET_GUARD_PI_BIN ?? "pi";
  return async (items, signal) =>
    withBatches(items, async (batch, _offset, innerSignal) => {
      const prompt = `${buildReviewPrompt(batch)}`;
      const raw = await runPi(bin, options, prompt, innerSignal ?? signal);
      return parseVerdicts(raw, batch.length);
    }, signal);
}

function runPi(
  bin: string,
  options: CliReviewerOptions,
  prompt: string,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = ["-p", "--no-tools", "--no-extensions", "--no-skills", "--no-context-files", "--no-prompt-templates", "--no-session", "--mode", "text"];
    if (options.model) args.push("--model", options.model);
    args.push("--system-prompt", SYSTEM_PROMPT, "--", prompt);

    const child = spawn(bin, args, { cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`AI 审核超时（${Math.round(options.timeoutMs / 1000)}秒）`));
    }, options.timeoutMs);
    timer.unref?.();

    const onAbort = () => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error("AI 审核被取消"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > 200_000) onAbort();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-2000);
    });
    child.on("error", (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`无法启动 ${bin}：${error.message}`));
    });
    child.on("close", (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (code !== 0) {
        reject(new Error(`${bin} 退出码 ${code}${stderr ? `：${stderr.trim().slice(0, 300)}` : ""}`));
        return;
      }
      resolve(stdout);
    });
  });
}