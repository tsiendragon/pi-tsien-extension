import type { LoadedConfig, SecretGuardConfig } from "./config.ts";
import { loadConfig, matchesGlob } from "./config.ts";
import { createCliReviewer } from "./ai.ts";
import { readStagedDiff, readUnpushedDiff } from "./git.ts";
import { parseDiffLines, scanDiff } from "./scan.ts";
import type { AiReviewer, Finding, ScanReport } from "./types.ts";

export type GitAction = "commit" | "push";

export interface RunScanOptions {
  cwd: string;
  action: GitAction;
  /** pre-push 时 git 通过 stdin 给的推送范围 */
  stdin?: string;
  /** 强制关闭 AI 复核（只用规则） */
  noAi?: boolean;
  /** Pi 会话内调用时，用会话模型做复核，避免再起一个进程 */
  reviewerFactory?: (config: SecretGuardConfig) => AiReviewer | undefined;
}

export interface RunScanResult {
  loaded: LoadedConfig;
  label: string;
  report: ScanReport;
}

/** 采集 diff → 规则扫描 → AI 复核 → 出结论。扩展和 CLI 共用这一条路径。 */
export async function runScan(options: RunScanOptions): Promise<RunScanResult> {
  const loaded = loadConfig(options.cwd);
  const scope = options.action === "commit"
    ? readStagedDiff(options.cwd)
    : readUnpushedDiff(options.cwd, options.stdin);

  let reviewer = options.reviewerFactory?.(loaded.config);
  if (!reviewer && loaded.config.aiReview && !options.noAi && scope.diff.trim()) {
    reviewer = createCliReviewer({
      cwd: options.cwd,
      model: loaded.config.aiModel,
      timeoutMs: loaded.config.aiTimeoutMs,
    });
  }

  const report = await scanDiff({
    diff: scope.diff,
    allowRules: loaded.allowlist,
    config: loaded.config,
    reviewer: options.noAi ? undefined : reviewer,
  });
  return { loaded, label: scope.label, report: applyConfigGuards(report, loaded, options.cwd, scope.diff) };
}

/**
 * 配置自己也会泄漏：把 internal_host / 关键词这类规则写进会被提交的
 * .secret-guard.json，等于把内部资产清单一起推上去。
 * 这里把「放错层」变成一条真正的阻断项，而不是靠人记得。
 */
export function applyConfigGuards(report: ScanReport, loaded: LoadedConfig, cwd: string, diff = ""): ScanReport {
  const findings: Finding[] = loaded.sharedRuleLeaks.map((leak) => ({
    file: relativeTo(cwd, leak.path),
    line: 1,
    category: "config_layer_misuse",
    tier: "hard",
    ruleId: "config-layer-misuse",
    source: "rule",
    match: `shared-rules:${leak.fields.join("+")}`,
    preview: `${leak.fields.join(" + ")}（关键词 ${leak.keywordCount} 条、自定义规则 ${leak.patternCount} 条）`,
  }));

  // 私有配置正常不会进 diff；一旦出现，说明是 git add -f 强塞的
  const stagedPrivate = diff
    ? [...new Set(parseDiffLines(diff).map((line) => line.file))].filter((file) => file.endsWith(".secret-guard.local.json"))
    : [];
  for (const file of stagedPrivate) {
    findings.push({
      file,
      line: 1,
      category: "config_layer_misuse",
      tier: "hard",
      ruleId: "private-config-committed",
      source: "rule",
      match: "private-config:committed",
      preview: "私有规则文件被强行加进了提交",
    });
  }

  const allowed = new Set(report.rescued.map((hit) => `${hit.file}|${hit.category}|${hit.match}`));
  const merged = [...report.blocked, ...findings].filter((hit) => {
    if (allowed.has(`${hit.file}|${hit.category}|${hit.match}`)) return false;
    return !allowRuleMatches(hit, loaded);
  });
  const rescued = [...report.rescued];
  for (const finding of findings) {
    if (merged.includes(finding)) continue;
    rescued.push({ ...finding, rescuedBy: "allowlist-file", reason: "放行清单里显式允许了这个配置文件" });
  }
  return { ...report, blocked: merged, rescued, warnings: [...report.warnings, ...loaded.warnings] };
}

function allowRuleMatches(hit: Finding, loaded: LoadedConfig): boolean {
  return loaded.allowlist.some((rule) => {
    if (rule.category !== "*" && rule.category !== hit.category) return false;
    return matchesGlob(hit.file, rule.glob);
  });
}

function relativeTo(cwd: string, file: string): string {
  const prefix = `${cwd.replace(/\/+$/, "")}/`;
  return file.startsWith(prefix) ? file.slice(prefix.length) : file;
}