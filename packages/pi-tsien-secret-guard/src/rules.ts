import type { Category, ExtraPatternInput, Hit, Tier } from "./types.ts";

export const CATEGORY_LABELS: Record<Category, string> = {
  private_key: "私钥",
  cloud_key: "云平台密钥",
  provider_token: "服务令牌",
  jwt: "登录令牌",
  credential_url: "带账号密码的网址",
  internal_host: "内网地址",
  local_path: "本机个人路径",
  email: "电子邮箱",
  phone_cn: "手机号",
  id_card_cn: "身份证号",
  person_name: "个人姓名",
  high_entropy: "疑似密钥的随机串",
  credential_assignment: "明文口令赋值",
  custom_keyword: "自定义禁止词",
  custom_pattern: "自定义规则命中",
  config_layer_misuse: "私有规则放进了会提交的文件",
};

/** 公开文档里常见的示例值，出现它们说明是在写示例而不是真泄漏。 */
const DOC_EXAMPLES = [
  "akiaiosfodnn7example",
  "wjalrxutnfemi/k7mdeng/bpxrficyexamplekey",
  "akia" + "iiosfodnn7example",
  "11010519491231002x",
  "110101199003076171",
  "13800138000",
  "18888888888",
  "19999999999",
  "123456789012345678",
  "your-api-key",
  "your_api_key",
  "your-token",
  "your_token",
  "changeme",
  "replace-me",
  "placeholder",
];

const GENERIC_PATH_USERS = new Set([
  "user", "username", "users", "you", "your", "your-name", "your_name", "yourname",
  "me", "name", "someone", "app", "node", "docker", "root", "ubuntu",
  "runner", "vscode", "codespace", "circleci", "jenkins", "gitlab-runner",
  "ec2-user", "admin", "default", "test", "example",
]);

const GENERIC_PHONES = new Set(["13800138000", "18888888888", "13999999999", "19999999999"]);
const GENERIC_NAMES = new Set([
  "张三", "李四", "王五", "赵六", "某某", "未知", "匿名", "测试",
  "样例", "示例", "用户", "客户", "本人", "持卡", "姓名",
]);

/** 内网/非公网 IPv4 段，排除回环、保留文档段与全零。 */
const PRIVATE_IPV4 =
  /(?<![\d.])(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})(?![\d.])/;

const IGNORED_IPV4 = /^(?:127\.|0\.|255\.|169\.254\.|192\.0\.2\.|198\.51\.100\.|203\.0\.113\.|224\.|240\.)/;

const INTERNAL_TLD = /(?<![\w.-])((?:[a-z0-9][a-z0-9-]*\.)+(?:internal|corp|intranet|intra|lan|local|home\.arpa))(?::\d{2,5})?\b/i;

const K8S_HOST = /(?<![\w.-])((?:[a-z0-9][a-z0-9-]*\.){1,3}[a-z0-9][a-z0-9-]*\.svc(?:\.cluster\.local)?)(?::\d{2,5})?\b/i;

const CREDENTIAL_URL = /[a-z][a-z0-9+.-]{1,15}:\/\/[^\s/:@"']{1,64}:[^\s/@"']{1,128}@[^\s/:@]+/i;

const PERSONAL_PATH =
  /(?<![\w.\/-])((?:\/home|\/Users)\/[A-Za-z0-9._-]+|[A-Za-z]:\\{1,2}Users\\{1,2}[A-Za-z0-9._-]+)/;

const PERSON_NAME_CONTEXT =
  /(?:姓名|真实姓名|持卡人|客户姓名|用户姓名|联系人姓名|收件人)\s*[:：=]\s*["']?([\u4e00-\u9fa5]{2,4})["']?/;
const PERSON_NAME_JSON =
  /"?\b(?:fullName|full_name|realName|real_name|firstName|first_name|lastName|last_name|holderName|holder_name|customerName|customer_name|legalName|legal_name)\b"?\s*[:=]\s*["']([\u4e00-\u9fa5]{2,4})["']/;

const CREDENTIAL_ASSIGNMENT =
  /(?:password|passwd|pwd|secret|api[_-]?key|apikey|access[_-]?key|secret[_-]?key|private[_-]?key|auth[_-]?token|access[_-]?token|client[_-]?secret)\s*[:=]\s*["']?([^\s"',;]{8,})/i;

const ASSIGNMENT_PLACEHOLDER =
  /^(?:\$\{?|<|\{\{|%\(|process\.env|os\.environ|os\.getenv|env\.|getenv|config\.|settings\.|.*(?:xxx|XXX|\*\*\*|placeholder|change-?me|redacted|dummy|sample|fake|example|todo|none|null|undefined|true|false))/i;

const EMAIL_EXCLUDE_DOMAINS = new Set([
  "example.com", "example.org", "example.net", "test.com", "localhost",
  "types", "media", "import", "param", "returns", "author", "license",
]);

const EMAIL = /(?<![\w.+-])([A-Za-z0-9._%+-]{1,64})@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})(?![\w.-])/;

const PHONE_CN = /(?<![\d+])(?:\+?86[-\s]?)?(1[3-9]\d{9})(?![\d])/;

const ID_CARD = /(?<![\dA-Za-z])(\d{17}[\dXx])(?![\dA-Za-z])/;

const ID_WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
const ID_CHECK = ["1", "0", "X", "9", "8", "7", "6", "5", "4", "3", "2"];

export function isValidIdCard(id: string): boolean {
  if (!/^\d{17}[\dXx]$/.test(id)) return false;
  if (/^0{17}/.test(id)) return false;
  let sum = 0;
  for (let i = 0; i < 17; i += 1) sum += Number(id[i]) * ID_WEIGHTS[i];
  return ID_CHECK[sum % 11] === id[17].toUpperCase();
}

interface RuleSpec {
  id: string;
  category: Category;
  tier: Tier;
  /** 返回命中原文，未命中返回 undefined */
  match: (line: string) => string | undefined;
}

function strip(url: string): string {
  return url.trim();
}

function firstMatch(line: string, re: RegExp, group = 1): string | undefined {
  const m = re.exec(line);
  if (!m) return undefined;
  return m[group] ?? m[0];
}

function isDocExample(text: string): boolean {
  const lower = text.toLowerCase();
  return DOC_EXAMPLES.some((item) => lower.includes(item));
}

const RULES: RuleSpec[] = [
  {
    id: "pem-private-key",
    category: "private_key",
    tier: "hard",
    match: (line) => {
      const m = /-----BEGIN (?:[A-Z0-9 ]{0,32})?PRIVATE KEY-----/.exec(line);
      return m ? m[0] : undefined;
    },
  },
  {
    id: "aws-access-key-id",
    category: "cloud_key",
    tier: "hard",
    match: (line) => firstMatch(line, /\b(?:AKIA|ASIA|ABIA|ACCA|AGPA|AIDA|AIPA|ANPA|ANVA|AROA)[0-9A-Z]{16}\b/),
  },
  {
    id: "aws-secret-access-key",
    category: "cloud_key",
    tier: "hard",
    match: (line) => firstMatch(line, /\baws_?secret_?access_?key\b\s*[:=]\s*["']?([A-Za-z0-9/+=]{40})\b/i),
  },
  {
    id: "aliyun-access-key",
    category: "cloud_key",
    tier: "hard",
    match: (line) => firstMatch(line, /\b(LTAI[A-Za-z0-9]{12,20})\b/),
  },
  {
    id: "tencent-access-key",
    category: "cloud_key",
    tier: "hard",
    match: (line) => firstMatch(line, /\b(AKID[A-Za-z0-9]{32})\b/),
  },
  {
    id: "google-api-key",
    category: "cloud_key",
    tier: "hard",
    match: (line) => firstMatch(line, /\b(AIza[0-9A-Za-z_-]{35})\b/),
  },
  {
    id: "azure-storage-key",
    category: "cloud_key",
    tier: "hard",
    match: (line) => firstMatch(line, /\bAccountKey=([A-Za-z0-9+/=]{40,})/i),
  },
  {
    id: "github-token",
    category: "provider_token",
    tier: "hard",
    match: (line) => firstMatch(line, /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{22,}\b/),
  },
  {
    id: "gitlab-token",
    category: "provider_token",
    tier: "hard",
    match: (line) => firstMatch(line, /\b(glpat-[A-Za-z0-9_-]{20,})\b/),
  },
  {
    id: "openai-anthropic-key",
    category: "provider_token",
    tier: "hard",
    match: (line) => firstMatch(line, /\b(sk-(?:ant-)?[A-Za-z0-9_-]{20,})\b/),
  },
  {
    id: "slack-token",
    category: "provider_token",
    tier: "hard",
    match: (line) => firstMatch(line, /\b(xox[baprs]-[A-Za-z0-9-]{10,})\b/),
  },
  {
    id: "stripe-key",
    category: "provider_token",
    tier: "hard",
    match: (line) => firstMatch(line, /\b((?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,})\b/),
  },
  {
    id: "npm-token",
    category: "provider_token",
    tier: "hard",
    match: (line) => firstMatch(line, /\b(npm_[A-Za-z0-9]{36})\b/),
  },
  {
    id: "huggingface-token",
    category: "provider_token",
    tier: "hard",
    match: (line) => firstMatch(line, /\b(hf_[A-Za-z0-9]{30,})\b/),
  },
  {
    id: "jwt",
    category: "jwt",
    tier: "hard",
    match: (line) => firstMatch(line, /\b(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/),
  },
  {
    id: "credential-url",
    category: "credential_url",
    tier: "hard",
    match: (line) => {
      const m = CREDENTIAL_URL.exec(line);
      return m ? strip(m[0]) : undefined;
    },
  },
  {
    id: "private-ipv4",
    category: "internal_host",
    tier: "soft",
    match: (line) => {
      const m = PRIVATE_IPV4.exec(line);
      if (!m) return undefined;
      return IGNORED_IPV4.test(m[0]) ? undefined : m[0];
    },
  },
  {
    id: "internal-tld",
    category: "internal_host",
    tier: "soft",
    match: (line) => firstMatch(line, INTERNAL_TLD),
  },
  {
    id: "k8s-service-host",
    category: "internal_host",
    tier: "soft",
    match: (line) => firstMatch(line, K8S_HOST),
  },
  {
    id: "personal-home-path",
    category: "local_path",
    tier: "soft",
    match: (line) => {
      const m = PERSONAL_PATH.exec(line);
      if (!m) return undefined;
      const raw = m[1].replaceAll("\\\\", "\\");
      const user = raw.split(/[\\/]/).filter(Boolean).at(-1) ?? "";
      return GENERIC_PATH_USERS.has(user.toLowerCase()) ? undefined : raw;
    },
  },
  {
    id: "email-address",
    category: "email",
    tier: "soft",
    match: (line) => {
      const m = EMAIL.exec(line);
      if (!m) return undefined;
      const before = line.slice(0, m.index);
      // 数据库连接串里 “账号:口令@主机” 的 userinfo 部分不是邮箱
      const scheme = before.lastIndexOf("://");
      if (scheme >= 0 && !/\s/.test(before.slice(scheme))) return undefined;
      const local = m[1].toLowerCase();
      const domain = m[2].toLowerCase();
      if (EMAIL_EXCLUDE_DOMAINS.has(domain.split(".")[0])) return undefined;
      if (EMAIL_EXCLUDE_DOMAINS.has(domain)) return undefined;
      if (/^(?:noreply|no-reply|donotreply)$/.test(local)) return undefined;
      if (/^(?:user|test|example|foo|bar|email|mail|you|your|demo)$/.test(local)) return undefined;
      if (/\bgit@/.test(before.slice(-8)) && /github|gitlab|bitbucket|gitee/.test(domain)) return undefined;
      return m[0];
    },
  },
  {
    id: "phone-cn",
    category: "phone_cn",
    tier: "soft",
    match: (line) => {
      const m = PHONE_CN.exec(line);
      if (!m) return undefined;
      const digits = m[1];
      if (GENERIC_PHONES.has(digits)) return undefined;
      if (/^1(\d)\1{9}$/.test(digits)) return undefined;
      if (/^\d{3}0{8}$/.test(digits)) return undefined;
      return digits;
    },
  },
  {
    id: "id-card-cn",
    category: "id_card_cn",
    tier: "soft",
    match: (line) => {
      const m = ID_CARD.exec(line);
      return m ? m[1] : undefined;
    },
  },
  {
    id: "person-name",
    category: "person_name",
    tier: "soft",
    match: (line) => {
      const raw = PERSON_NAME_CONTEXT.exec(line)?.[1] ?? PERSON_NAME_JSON.exec(line)?.[1];
      if (!raw) return undefined;
      return GENERIC_NAMES.has(raw) ? undefined : raw;
    },
  },
  {
    id: "credential-assignment",
    category: "credential_assignment",
    tier: "soft",
    match: (line) => {
      const m = CREDENTIAL_ASSIGNMENT.exec(line);
      if (!m) return undefined;
      const value = m[1];
      if (ASSIGNMENT_PLACEHOLDER.test(value)) return undefined;
      return `${m[0].slice(0, m[0].length - value.length)}${value}`;
    },
  },
];

/** 香农熵（每字符平均信息量，单位 bit）。随机密钥接近 6，普通单词约 3。 */
function shannon(value: string): number {
  const counts = new Map<string, number>();
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/**
 * 高熵随机串。
 * 字符集刻意不含 “-” 和 “_”：否则 kebab-case 文件名、URL 路径、
 * 长变量名都会被当成密钥。真正的 base64 / hex 密钥照样落进来。
 */
function highEntropyMatch(line: string): string | undefined {
  if (/(?:integrity|checksum|sha256|sha1|hash|digest|etag)\s*[:=]\s*["']?[0-9a-f]{32,}/i.test(line)) return undefined;
  const candidates = line.match(/[A-Za-z0-9+=]{40,}/g);
  if (!candidates) return undefined;
  for (const candidate of candidates) {
    const classes = [/[a-z]/, /[A-Z]/, /[0-9]/].filter((re) => re.test(candidate)).length;
    if (classes < 2) continue;
    if (shannon(candidate) < 3.6) continue;
    return candidate;
  }
  return undefined;
}

const HUNK_FILE_SKIP = /\.(?:md|txt|rst|adoc)$/i;

export type LineScanner = (file: string, line: string, lineNumber: number) => Hit[];

interface CompiledPattern {
  id: string;
  re: RegExp;
  category: Category;
  tier: Tier;
}

/**
 * 用配置里的自定义规则生成一个扫描器。
 * 正则只编译一次，避免每行重复编译；写错的正则直接跳过，不让配置错误拖垮整个扫描。
 */
export function createLineScanner(extra?: {
  blockedKeywords?: string[];
  extraPatterns?: ExtraPatternInput[];
}): LineScanner {
  const keywords = (extra?.blockedKeywords ?? [])
    .map((item) => item.trim())
    .filter((item) => item.length >= 3);
  const patterns: CompiledPattern[] = [];
  for (const item of extra?.extraPatterns ?? []) {
    try {
      patterns.push({
        id: item.id || "custom",
        re: new RegExp(item.pattern, item.flags ?? "i"),
        category: item.category ?? "custom_pattern",
        tier: item.tier ?? "hard",
      });
    } catch {
      // 正则写错就跳过这一条，其余规则照常生效
    }
  }
  return (file, line, lineNumber) => scanLine(file, line, lineNumber, keywords, patterns);
}

/** 对单行跑所有规则，返回命中列表。 */
export function scanLine(
  file: string,
  line: string,
  lineNumber: number,
  keywords: string[] = [],
  patterns: CompiledPattern[] = [],
): Hit[] {
  if (!line.trim()) return [];
  const hits: Hit[] = [];
  for (const rule of RULES) {
    const matched = rule.match(line);
    if (!matched) continue;
    if (isDocExample(matched) || isDocExample(line)) continue;
    if (rule.category === "person_name" && GENERIC_NAMES.has(matched)) continue;
    hits.push({
      file,
      line: lineNumber,
      category: rule.category,
      tier: idCardTier(rule, matched),
      ruleId: rule.id,
      source: "rule",
      match: matched,
      preview: mask(matched),
    });
  }
  const lower = line.toLowerCase();
  for (const keyword of keywords) {
    if (!lower.includes(keyword.toLowerCase())) continue;
    hits.push({
      file,
      line: lineNumber,
      category: "custom_keyword",
      tier: "hard",
      ruleId: "custom-keyword",
      source: "rule",
      match: keyword,
      preview: clip(keyword),
    });
  }
  for (const pattern of patterns) {
    const m = pattern.re.exec(line);
    if (!m) continue;
    const matched = m[0].trim();
    if (!matched) continue;
    hits.push({
      file,
      line: lineNumber,
      category: pattern.category,
      tier: pattern.tier,
      ruleId: pattern.id,
      source: "rule",
      match: matched,
      preview: clip(matched),
    });
  }

  if (!HUNK_FILE_SKIP.test(file)) {
    const entropy = highEntropyMatch(line);
    // 已经被具体规则抓过的串不再当成“疑似随机串”重复上报
    const covered = entropy ? hits.some((hit) => hit.match.includes(entropy)) : false;
    if (entropy && !covered && !isDocExample(entropy)) {
      hits.push({
        file,
        line: lineNumber,
        category: "high_entropy",
        tier: "soft",
        ruleId: "high-entropy",
        source: "rule",
        match: entropy,
        preview: mask(entropy),
      });
    }
  }
  return dedupe(hits);
}

/**
 * 身份证号过了校验位就是真号，必须硬拦；校验位不对的多半是编的，交给 AI 判断，
 * 既挡住真实证件号，又不把文档里的假号当泄漏。
 */
function idCardTier(rule: RuleSpec, matched: string): Tier {
  if (rule.category !== "id_card_cn") return rule.tier;
  return isValidIdCard(matched) ? "hard" : "soft";
}

function dedupe(hits: Hit[]): Hit[] {
  const seen = new Set<string>();
  const out: Hit[] = [];
  for (const hit of hits) {
    const key = `${hit.line}|${hit.category}|${hit.match}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(hit);
  }
  return out;
}

/** 关键词和自定义规则是“标签”不是“凭证”：保留原文，否则看不出该删什么。 */
function clip(value: string): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length <= 60 ? text : `${text.slice(0, 57)}...`;
}

/** 保留首尾少量字符，中间打码，便于定位又不把明文写进日志。 */
export function mask(value: string): string {
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length <= 8) return `${text.slice(0, 2)}***`;
  if (text.length <= 24) return `${text.slice(0, 4)}***${text.slice(-3)}`;
  return `${text.slice(0, 6)}***${text.slice(-4)}`;
}

export const CATEGORY_ORDER: Category[] = [
  "private_key", "cloud_key", "provider_token", "jwt", "credential_url",
  "credential_assignment", "internal_host", "id_card_cn", "phone_cn",
  "email", "person_name", "local_path", "high_entropy",
  "custom_keyword", "custom_pattern", "config_layer_misuse",
];