/** 扫描命中的类别。新增类别必须同时补 CATEGORY_LABELS。 */
export type Category =
  | "private_key"
  | "cloud_key"
  | "provider_token"
  | "jwt"
  | "credential_url"
  | "internal_host"
  | "local_path"
  | "email"
  | "phone_cn"
  | "id_card_cn"
  | "person_name"
  | "high_entropy"
  | "credential_assignment"
  | "custom_keyword"
  | "custom_pattern"
  | "config_layer_misuse";

/**
 * hard = 只有人显式加白名单才能放行。
 * soft = AI 判定为「示例/占位」时可以自动放行，否则一样阻断。
 */
export type Tier = "hard" | "soft";

/** 命中来源：规则、AI 附加判断。 */
export type HitSource = "rule" | "ai";

export interface Hit {
  file: string;
  /** 新文件中的行号（1 起） */
  line: number;
  category: Category;
  tier: Tier;
  ruleId: string;
  source: HitSource;
  /** 去空白后的命中原文，仅内存使用，不落盘 */
  match: string;
  /** 脱敏后的展示片段 */
  preview: string;
}

export type Rescue =
  | "allowlist-inline"
  | "allowlist-file"
  | "config-downgrade"
  | "ai-example";

export interface Finding extends Hit {
  rescuedBy?: Rescue;
  reason?: string;
}

export type AiVerdictKind = "real" | "example" | "unclear";

export interface AiVerdict {
  verdict: AiVerdictKind;
  reason: string;
}

export interface AiReviewItem {
  category: Category;
  file: string;
  line: number;
  snippet: string;
}

/** AI 审核后端。返回数组长度必须与输入一致，顺序对应。 */
export type AiReviewer = (items: AiReviewItem[], signal?: AbortSignal) => Promise<AiVerdict[]>;

export type AiStatus = "skipped" | "ok" | "partial" | "failed";

export interface ScanReport {
  /** 最终阻断项 */
  blocked: Finding[];
  /** 被自动放行的项（白名单、文档示例、AI 判为示例） */
  rescued: Finding[];
  /** 扫描过的新增行数 */
  scannedLines: number;
  /** 扫描过的新增文件数 */
  scannedFiles: number;
  aiStatus: AiStatus;
  aiError?: string;
  /** 因为超出上限被跳过扫描的行数 */
  skippedLines: number;
  /** 配置层面的提醒，不影响放行与否 */
  warnings: string[];
}
/** 配置里自定义的正则规则，用来补内置规则没覆盖的自家格式。 */
export interface ExtraPatternInput {
  id: string;
  /** 正则源码，字符串形式，方便写在 JSON 里 */
  pattern: string;
  category?: Category;
  tier?: Tier;
  /** 正则修饰符，默认 "i"（不区分大小写）。要严格区分大小写时传 "" */
  flags?: string;
  note?: string;
}
