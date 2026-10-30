import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtraPatternInput } from "./types.ts";

export interface SecretGuardConfig {
  enabled: boolean;
  aiReview: boolean;
  /** 形如 "provider/model"；留空用当前会话模型 */
  aiModel?: string;
  aiTimeoutMs: number;
  /** 单次最多扫描多少新增行，超出部分跳过并告警 */
  maxLines: number;
  skipPaths: string[];
  /** 额外内网域名后缀，如 "mycorp\\.com" */
  extraInternalPatterns: string[];
  /** 把某个类别整体降级为只提示（不阻断）。默认空 = 全部阻断 */
  downgrade: Partial<Record<string, "notice">>;
  /**
   * AI 复核不可用时怎么办：
   * notice = 软线索降级为提示放行，硬凭证仍然阻断（默认，不阻塞日常提交）
   * block  = 全部阻断（更严，但模型不可用时会卡住所有提交）
   */
  onAiFailure: "notice" | "block";
  /**
   * 允许 AI 判为「示例」后放行的类别。
   * 只包含“可疑字符串”这类类别；内网地址、手机号、姓名等一律只认人工白名单。
   * 因为模型会把真实手机号/真实姓名当成示例放过，那个代价太大。
   */
  aiRescueCategories: string[];
  /** 纯关键词（子串匹配，不区分大小写）。命中即阻断，只认人工白名单。 */
  blockedKeywords: string[];
  /** 自定义正则规则，补内置规则没覆盖的自家格式 */
  extraPatterns: ExtraPatternInput[];
}

export const DEFAULT_CONFIG: SecretGuardConfig = {
  enabled: true,
  aiReview: true,
  aiTimeoutMs: 12_000,
  maxLines: 6_000,
  skipPaths: [
    "**/*.lock",
    "**/package-lock.json",
    "**/pnpm-lock.yaml",
    "**/yarn.lock",
    "**/node_modules/**",
    "**/dist/**",
    "**/build/**",
    "**/.git/**",
    "**/vendor/**",
    "**/*.min.js",
    "**/*.min.css",
    "**/*.map",
    "**/*.snap",
    "**/.secret-guard-allow",
    "**/.secret-guard.local.json",
  ],
  extraInternalPatterns: [],
  downgrade: {},
  onAiFailure: "notice",
  aiRescueCategories: ["high_entropy", "credential_assignment", "local_path"],
  blockedKeywords: [],
  extraPatterns: [],
};

export interface AllowRule {
  glob: string;
  category: string;
  reason: string;
  source: "file";
}

/** 会把内容提交进仓库的配置层里，出现了本该私有的规则。 */
export interface SharedRuleLeak {
  path: string;
  fields: string[];
  keywordCount: number;
  patternCount: number;
}

export interface LoadedConfig {
  config: SecretGuardConfig;
  /** 可提交配置里放了私有规则，需要在报告里挡下来 */
  sharedRuleLeaks: SharedRuleLeak[];
  /** 其它值得提醒的配置问题 */
  warnings: string[];
  allowlist: AllowRule[];
  /** 实际读取到的配置路径，用于报告 */
  configPath?: string;
  allowlistPath?: string;
  root: string;
}

interface ParsedConfig {
  value: unknown;
  error?: string;
}

function readJson(file: string): ParsedConfig {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error: unknown) {
    return { value: undefined, error: error instanceof Error ? error.message : String(error) };
  }
  try {
    return { value: JSON.parse(text) };
  } catch (error: unknown) {
    return { value: undefined, error: error instanceof Error ? error.message : String(error) };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergeConfig(base: SecretGuardConfig, raw: unknown): SecretGuardConfig {
  if (!isRecord(raw)) return base;
  const out: SecretGuardConfig = { ...base };
  if (typeof raw.enabled === "boolean") out.enabled = raw.enabled;
  if (typeof raw.aiReview === "boolean") out.aiReview = raw.aiReview;
  if (typeof raw.aiModel === "string" && raw.aiModel.trim()) out.aiModel = raw.aiModel.trim();
  if (typeof raw.aiTimeoutMs === "number" && raw.aiTimeoutMs > 1000) out.aiTimeoutMs = Math.min(raw.aiTimeoutMs, 120_000);
  if (typeof raw.maxLines === "number" && raw.maxLines > 0) out.maxLines = Math.min(raw.maxLines, 200_000);
  if (Array.isArray(raw.skipPaths)) {
    out.skipPaths = raw.skipPaths.filter((item): item is string => typeof item === "string");
  }
  if (Array.isArray(raw.extraInternalPatterns)) {
    out.extraInternalPatterns = raw.extraInternalPatterns.filter((item): item is string => typeof item === "string");
  }
  if (isRecord(raw.downgrade)) {
    const downgrade: Record<string, "notice"> = {};
    for (const [key, value] of Object.entries(raw.downgrade)) {
      if (value === "notice") downgrade[key] = "notice";
    }
    out.downgrade = downgrade;
  }
  if (raw.onAiFailure === "block" || raw.onAiFailure === "notice") out.onAiFailure = raw.onAiFailure;
  if (Array.isArray(raw.aiRescueCategories)) {
    out.aiRescueCategories = raw.aiRescueCategories.filter((item): item is string => typeof item === "string");
  }
  // 关键词和自定义规则用并集：加配置文件只应该多拦，不应该把上面的层抹掉
  if (Array.isArray(raw.blockedKeywords)) {
    const merged = new Set(out.blockedKeywords);
    for (const item of raw.blockedKeywords) {
      if (typeof item === "string" && item.trim()) merged.add(item.trim());
    }
    out.blockedKeywords = [...merged];
  }
  if (Array.isArray(raw.extraPatterns)) {
    const byId = new Map(out.extraPatterns.map((item) => [item.id, item]));
    for (const item of raw.extraPatterns) {
      if (typeof item !== "object" || item === null) continue;
      const pattern = item as ExtraPatternInput;
      if (typeof pattern.pattern !== "string" || !pattern.id) continue;
      byId.set(pattern.id, pattern);
    }
    out.extraPatterns = [...byId.values()];
  }
  return out;
}

export function parseAllowlist(text: string): AllowRule[] {
  const rules: AllowRule[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 3) continue;
    const reason = parts.slice(2).join(" ").replace(/^#\s*/, "");
    if (!reason) continue;
    rules.push({ glob: parts[0], category: parts[1], reason, source: "file" });
  }
  return rules;
}

/**
 * 这一层配置会不会被提交进仓库。
 * 只有仓库根那两份 .json 会跟着走；.local.json 被 exclude，全局配置在仓库之外。
 */
function isCommittedLayer(layer: string, root: string): boolean {
  if (path.basename(layer) === ".secret-guard.local.json") return false;
  if (layer.startsWith(path.join(os.homedir(), ".config"))) return false;
  return path.dirname(layer) === path.resolve(root);
}

/** 从 cwd 向上找仓库根（含 .git 的目录）。 */
export function findRepoRoot(cwd: string): string {
  let current = path.resolve(cwd);
  for (;;) {
    if (fs.existsSync(path.join(current, ".git"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(cwd);
    current = parent;
  }
}

export interface LoadConfigOptions {
  /** 是否叠加 ~/.config/secret-guard/config.json。默认 true；测试和“只看仓库自己的规则”时传 false */
  withGlobal?: boolean;
}

export function loadConfig(cwd: string, options: LoadConfigOptions = {}): LoadedConfig {
  const root = findRepoRoot(cwd);
  // 从低到高：全局 → 仓库共享 → 仓库私有 → 环境变量指定
  const globalLayer = options.withGlobal === false ? "" : path.join(os.homedir(), ".config", "secret-guard", "config.json");
  const layers = [
    globalLayer,
    path.join(root, ".secret-guard.json"),
    path.join(root, ".secret-guard.local.json"),
    process.env.SECRET_GUARD_CONFIG ?? "",
  ].filter((item): item is string => item.length > 0);

  let config = DEFAULT_CONFIG;
  const applied: string[] = [];
  const sharedRuleLeaks: SharedRuleLeak[] = [];
  const warnings: string[] = [];
  for (const layer of layers) {
    if (!fs.existsSync(layer)) continue;
    const parsed = readJson(layer);
    const raw = parsed.value;
    if (parsed.error) {
      warnings.push(`配置文件解析失败，这一层的规则没有生效：${layer}（${parsed.error}）`);
    } else {
      config = mergeConfig(config, raw);
    }
    applied.push(layer);
    if (isCommittedLayer(layer, root) && isRecord(raw)) {
      const keywords = Array.isArray(raw.blockedKeywords) ? raw.blockedKeywords.length : 0;
      const patterns = Array.isArray(raw.extraPatterns) ? raw.extraPatterns.length : 0;
      if (keywords > 0 || patterns > 0) {
        sharedRuleLeaks.push({
          path: layer,
          fields: [...(keywords > 0 ? ["blockedKeywords"] : []), ...(patterns > 0 ? ["extraPatterns"] : [])],
          keywordCount: keywords,
          patternCount: patterns,
        });
      }
    }
  }
  const configPath = applied.length > 0 ? applied.join(" → ") : undefined;

  const allowCandidates = [
    path.join(root, ".secret-guard-allow"),
    path.join(os.homedir(), ".config", "secret-guard", "allow"),
  ];
  let allowlist: AllowRule[] = [];
  let allowlistPath: string | undefined;
  for (const candidate of allowCandidates) {
    if (!fs.existsSync(candidate)) continue;
    allowlist = allowlist.concat(parseAllowlist(fs.readFileSync(candidate, "utf8")));
    allowlistPath = allowlistPath ? `${allowlistPath},${candidate}` : candidate;
  }

  return { config, allowlist, configPath, allowlistPath, root, sharedRuleLeaks, warnings };
}

/** 极简 glob：支持 **、*、?。够用且零依赖。 */
export function globToRegExp(glob: string): RegExp {
  let out = "^";
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        i += 1;
        if (glob[i + 1] === "/") {
          i += 1;
          out += "(?:.*/)?";
        } else {
          out += ".*";
        }
      } else {
        out += "[^/]*";
      }
      continue;
    }
    if (ch === "?") {
      out += "[^/]";
      continue;
    }
    out += "\\^$+.()|{}[]".includes(ch) ? `\\${ch}` : ch;
  }
  return new RegExp(`${out}$`);
}

export function matchesGlob(file: string, glob: string): boolean {
  return globToRegExp(glob).test(file);
}

export function isSkippedPath(file: string, skipPaths: string[]): boolean {
  return skipPaths.some((glob) => matchesGlob(file, glob));
}