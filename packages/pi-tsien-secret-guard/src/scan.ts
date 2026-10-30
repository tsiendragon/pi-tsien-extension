import type { AllowRule, SecretGuardConfig } from "./config.ts";
import { isSkippedPath, matchesGlob } from "./config.ts";
import { CATEGORY_LABELS, CATEGORY_ORDER, createLineScanner } from "./rules.ts";
import type { AiReviewer, Finding, Hit, ScanReport } from "./types.ts";

interface ParsedLine {
  file: string;
  line: number;
  text: string;
  added: boolean;
}

/**
 * 解析 unified diff，返回带新文件行号的每一行。
 * 保留上下文行是为了识别「上一行写了 secret-guard:allow」这种放行标记。
 */
export function parseDiffLines(diff: string): ParsedLine[] {
  const out: ParsedLine[] = [];
  let file: string | undefined;
  let newLine = 0;
  let skipping = false;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      file = undefined;
      skipping = false;
      continue;
    }
    if (raw.startsWith("+++ ")) {
      const target = raw.slice(4).trim();
      if (target === "/dev/null") {
        file = undefined;
        skipping = true;
        continue;
      }
      file = target.replace(/^[ab]\//, "").replace(/^"|"$/g, "");
      continue;
    }
    if (skipping || !file) continue;
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      newLine = Number(hunk[1]);
      continue;
    }
    if (raw.startsWith("+")) {
      out.push({ file, line: newLine, text: raw.slice(1), added: true });
      newLine += 1;
      continue;
    }
    if (raw.startsWith("-") || raw.startsWith("\\")) continue;
    if (raw.startsWith(" ")) {
      out.push({ file, line: newLine, text: raw.slice(1), added: false });
      newLine += 1;
    }
  }
  return out;
}

const INLINE_MARKER = /secret-guard:\s*allow/i;

function hasInlineAllowance(lines: ParsedLine[], index: number): boolean {
  const current = lines[index];
  if (INLINE_MARKER.test(current.text)) return true;
  const previous = lines[index - 1];
  return Boolean(previous && previous.file === current.file && !previous.added && INLINE_MARKER.test(previous.text));
}

function matchesAllowRule(finding: Hit, rules: AllowRule[]): AllowRule | undefined {
  return rules.find((rule) => {
    if (!matchesGlob(finding.file, rule.glob)) return false;
    return rule.category === "*" || rule.category === finding.category;
  });
}

export interface ScanDiffOptions {
  diff: string;
  allowRules: AllowRule[];
  config: SecretGuardConfig;
  reviewer?: AiReviewer;
  signal?: AbortSignal;
}

export async function scanDiff(options: ScanDiffOptions): Promise<ScanReport> {
  const { diff, allowRules, config, reviewer, signal } = options;
  const lines = parseDiffLines(diff);
  const scanLine = createLineScanner(config);
  const blocked: Finding[] = [];
  const rescued: Finding[] = [];
  let scannedLines = 0;
  let skippedLines = 0;
  const files = new Set<string>();
  const pending: Finding[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const parsed = lines[index];
    if (!parsed.added) continue;
    if (isSkippedPath(parsed.file, config.skipPaths)) {
      skippedLines += 1;
      continue;
    }
    if (scannedLines >= config.maxLines) {
      skippedLines += 1;
      continue;
    }
    scannedLines += 1;
    files.add(parsed.file);
    const hits = scanLine(parsed.file, parsed.text, parsed.line);
    if (hits.length === 0) continue;

    for (const hit of hits) {
      if (hasInlineAllowance(lines, index)) {
        rescued.push({ ...hit, rescuedBy: "allowlist-inline", reason: "行内 secret-guard:allow 标记" });
        continue;
      }
      const rule = matchesAllowRule(hit, allowRules);
      if (rule) {
        rescued.push({ ...hit, rescuedBy: "allowlist-file", reason: `${rule.glob} → ${rule.reason}` });
        continue;
      }
      if (config.downgrade[hit.category] === "notice") {
        rescued.push({ ...hit, rescuedBy: "config-downgrade", reason: "配置里把该类降级为只提示" });
        continue;
      }
      pending.push(hit);
    }
  }

  const soft = pending.filter((hit) => hit.tier === "soft");
  const rescuable = soft.filter((hit) => config.aiRescueCategories.includes(hit.category));
  const rescues: Finding[] = [];
  let aiStatus: ScanReport["aiStatus"] = "skipped";
  let aiError: string | undefined;

  if (rescuable.length > 0 && config.aiReview && reviewer) {
    try {
      const verdicts = await reviewer(
        rescuable.map((hit) => ({
          category: hit.category,
          file: hit.file,
          line: hit.line,
          snippet: hit.match.slice(0, 200),
        })),
        signal,
      );
      aiStatus = verdicts.length === rescuable.length ? "ok" : "partial";
      rescuable.forEach((hit, index) => {
        const verdict = verdicts[index];
        if (!verdict) return;
        if (verdict.verdict === "example") {
          rescues.push({ ...hit, source: "ai", rescuedBy: "ai-example", reason: verdict.reason || "AI 判定为示例值" });
        }
      });
    } catch (error: unknown) {
      aiStatus = "failed";
      aiError = error instanceof Error ? error.message : String(error);
    }
  }

  // AI 跑不起来时不能把整条提交链路卡死：可救回的软线索降级为提示，其余照样阻断。
  if (aiStatus === "failed" && config.onAiFailure === "notice") {
    for (const hit of rescuable) {
      rescues.push({ ...hit, rescuedBy: "config-downgrade", reason: "AI 复核不可用，按提示放行" });
    }
  }

  for (const hit of rescues) rescued.push(hit);

  const rescuedKeys = new Set(rescued.map((hit) => `${hit.file}|${hit.line}|${hit.category}|${hit.match}`));
  for (const hit of pending) {
    if (rescuedKeys.has(`${hit.file}|${hit.line}|${hit.category}|${hit.match}`)) continue;
    blocked.push(hit);
  }

  const rank = (category: string) => {
    const position = CATEGORY_ORDER.indexOf(category as never);
    return position < 0 ? CATEGORY_ORDER.length : position;
  };
  blocked.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || rank(a.category) - rank(b.category));

  return {
    blocked,
    rescued,
    scannedLines,
    scannedFiles: files.size,
    aiStatus,
    aiError,
    skippedLines,
    warnings: [],
  };
}

/** 按文件聚合成便于人读的文本。 */
export function formatReport(
  report: ScanReport,
  options: { action: "commit" | "push"; verbose?: boolean },
): string {
  const { blocked, rescued, scannedLines, scannedFiles, aiStatus, aiError, skippedLines } = report;
  const actionLabel = options.action === "commit" ? "提交" : "推送";
  const lines: string[] = [];

  if (blocked.length === 0) {
    lines.push(
      `✅ 敏感信息检查通过：${scannedFiles} 个文件、${scannedLines} 行新增内容，未发现需要阻止${actionLabel}的内容。`,
    );
    if (rescued.length > 0) lines.push(`（有 ${rescued.length} 处命中判定为示例/已加白名单，已放行）`);
    if (skippedLines > 0) {
      lines.push(`注意：还有 ${skippedLines} 行没检查（超出单次上限或被跳过规则忽略），这些行里可能藏着敏感信息。`);
    }
    if (options.verbose) lines.push(...describeRescued(rescued));
    for (const warning of report.warnings) lines.push(`提醒：${warning}`);
    return lines.join("\n");
  }

  const tierLabel = (tier: string) => (tier === "hard" ? "必须处理" : "需要确认");
  lines.push(`⛔ 发现 ${blocked.length} 处敏感信息，已阻止${actionLabel}。`);
  lines.push("");

  const blockByFile = new Map<string, Finding[]>();
  for (const hit of blocked) {
    const list = blockByFile.get(hit.file) ?? [];
    list.push(hit);
    blockByFile.set(hit.file, list);
  }

  for (const [file, hits] of blockByFile) {
    lines.push(`  ${file}`);
    for (const hit of hits) {
      lines.push(`    第${hit.line}行  ${CATEGORY_LABELS[hit.category] ?? hit.category}（${tierLabel(hit.tier)}）  片段：${hit.preview}`);
    }
  }

  lines.push("");
  lines.push("怎么处理：");
  lines.push("  1. 改成占位符或从环境变量读取（推荐）");
  lines.push("  2. 确认是文档示例/测试假数据：在该行（或上一行）加注释 `secret-guard:allow`");
  lines.push("  3. 整类放行：在仓库根写入 .secret-guard-allow，一行一条，格式 `路径glob 类别  # 原因`");
  if (blocked.some((hit) => hit.category === "private_key" || hit.category === "cloud_key" || hit.category === "provider_token")) {
    lines.push("  4. 如果这是真实凭证：删掉代码只是第一步，必须去对应后台把它作废并重新签发，否则它已经算泄漏过。");
  }
  if (aiStatus === "failed") {
    lines.push("");
    lines.push(`注意：AI 复核失败（${aiError ?? "未知原因"}），所有命中按最严格处理。`);
  }
  if (skippedLines > 0) {
    lines.push("");
    lines.push(`注意：有 ${skippedLines} 行因超出上限或被跳过规则忽略（如锁文件、构建产物），这些行没有被检查。`);
  }
  if (options.verbose) lines.push(...describeRescued(rescued));
  if (report.warnings.length > 0) {
    lines.push("");
    for (const warning of report.warnings) lines.push(`提醒：${warning}`);
  }
  return lines.join("\n");
}

function describeRescued(rescued: Finding[]): string[] {
  if (rescued.length === 0) return [];
  const lines = ["", `已放行的命中（${rescued.length} 处）：`];
  for (const hit of rescued) {
    lines.push(`  ${hit.file}:${hit.line}  ${CATEGORY_LABELS[hit.category] ?? hit.category}  ${hit.rescuedBy}  ${hit.reason ?? ""}`);
  }
  return lines;
}