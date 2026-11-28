/**
 * 子代理角色注册表（类似 Claude Code 的 .claude/agents/*.md）。
 *
 * 每个角色是 ~/.pi/agent/subagents/<name>.md：
 *   ---
 *   description: 什么时候用（主 agent 据此选择）
 *   base: read_only | code | research | web_code   # 决定工具集
 *   tier: light                                    # 默认档位（可选）
 *   ---
 *   角色定位与工作方式（系统 prompt 正文）
 *
 * 三处共用：runner-stage 按 base 给工具集，model-router 按 tier 给默认档位，
 * provider 按名字注入 rules/subagent-prompts/<name>.md（由 rules/build.py 生成）。
 *
 * Fail-closed 约定：frontmatter 里的 base/tier 只是字符串，写错（`base: admin`、
 * `tier: turbo`）时**不再**静默回退到权限最大的 `code` 工具集。解析失败的角色会
 * 被标记 `invalid: true` 并记录原因，base 退到最小权限的 `read_only`，同时
 * `roleValidationReport()` 给出机器可读的清单（`build.py` 可用它把非法角色标出来）。
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const ROLE_BASES = ["read_only", "code", "research", "web_code"] as const;
export type RoleBase = (typeof ROLE_BASES)[number];

/**
 * 声明了不可用 base 时使用的工具集。取最小权限，而不是旧的 `code`
 * （`code` 是最大权限，静默回退到它等于把写错的角色升权）。
 */
export const FALLBACK_ROLE_BASE: RoleBase = "read_only";

/** 与 model-router.ts 的 TIERS 保持一致（此处不 import，避免与 model-router 形成循环依赖）。 */
export const ROLE_TIERS = ["micro", "light", "medium", "heavy", "ultra"] as const;
export type RoleTier = (typeof ROLE_TIERS)[number];

export type RoleIssueField = "frontmatter" | "base" | "tier" | "maxTurns" | "maxTokens";

/**
 * 角色级预算。两项都可选；未声明即没有角色级上限。
 * 非法值（0、负数、非整数、非数字）记进 issues 并被丢弃，绝不静默当成无限。
 */
export interface RoleBudget {
	/** 模型回合上限（助手消息数）。 */
	readonly maxTurns?: number;
	/** 累计 token 上限（input + output）。 */
	readonly maxTokens?: number;
}

/** 一条解析问题：字段、声明值与可读原因。 */
export interface RoleValidationIssue {
	readonly field: RoleIssueField;
	readonly value?: string;
	readonly reason: string;
}

export interface RoleProfile {
	readonly name: string;
	readonly description: string;
	/** 生效的工具集来源；角色非法时是最小权限的 read_only。 */
	readonly base: RoleBase;
	readonly tier?: string;
	readonly promptPath: string;
	/** 角色文件是否通过校验；true 时不得当作正常角色静默启动。 */
	readonly invalid: boolean;
	/** 一句话说明为什么非法（写进日志、角色清单与校验报告）。 */
	readonly invalidReason?: string;
	/** 角色声明的预算（maxTurns / maxTokens）；未声明时省略。 */
	readonly budget?: RoleBudget;
	/** 结构化的校验问题，便于程序区分 base 与 tier、预算字段。 */
	readonly issues: readonly RoleValidationIssue[];
	/** 角色定义文件路径（解析失败时也给出，便于排查）。 */
	readonly sourcePath?: string;
}

export type PromptState = "present" | "missing" | "empty" | "unreadable";

export interface RoleValidationEntry {
	readonly name: string;
	readonly file: string;
	readonly valid: boolean;
	readonly base: RoleBase;
	readonly tier?: string;
	readonly budget?: RoleBudget;
	readonly invalidReason?: string;
	readonly issues: readonly RoleValidationIssue[];
	readonly promptPath: string;
	readonly promptState: PromptState;
}

export interface RoleValidationReport {
	readonly version: 1;
	/** 角色定义目录。 */
	readonly rolesDir: string;
	/** 角色 prompt 目录（由 rules/build.py 生成）。 */
	readonly promptDir: string;
	readonly roles: readonly RoleValidationEntry[];
	/** 非法角色名，按字母序；为空表示全部通过。 */
	readonly invalid: readonly string[];
	/** 角色 prompt 缺失/为空/不可读的角色名（即使角色本身合法）。 */
	readonly missingPrompts: readonly string[];
}

export function rolesDirPath(): string {
	return process.env.PI_SUBAGENT_ROLES_DIR || join(homedir(), ".pi/agent/subagents");
}

export function promptsDirPath(): string {
	return process.env.PI_SUBAGENT_PROMPT_DIR || join(homedir(), ".pi/agent/rules/subagent-prompts");
}

const cache = new Map<string, RoleProfile | null>();

/** 测试与热更新用：清空角色缓存（环境变量改变后必须调用）。 */
export function clearRoleCache(): void {
	cache.clear();
}

function cacheKey(name: string): string {
	return `${rolesDirPath()}\u0000${promptsDirPath()}\u0000${name}`;
}

function inspectPrompt(path: string): { readonly state: PromptState; readonly text?: string } {
	try {
		if (!existsSync(path)) return { state: "missing" };
		const text = readFileSync(path, "utf8");
		return text.trim() ? { state: "present", text } : { state: "empty" };
	} catch {
		return { state: "unreadable" };
	}
}

export function promptStateAt(path: string): PromptState {
	return inspectPrompt(path).state;
}

function parseFrontmatter(text: string): Record<string, string> | undefined {
	const fm = text.match(/^---\s*\n([\s\S]*?)\n---/);
	if (!fm) return undefined;
	const meta: Record<string, string> = {};
	for (const line of fm[1].split("\n")) {
		const m = line.match(/^(\w+):\s*([^#]*)/);
		if (m) meta[m[1]] = m[2].trim();
	}
	return meta;
}

function isRoleBase(value: string | undefined): value is RoleBase {
	return value !== undefined && (ROLE_BASES as readonly string[]).includes(value);
}

function isRoleTier(value: string): value is RoleTier {
	return (ROLE_TIERS as readonly string[]).includes(value);
}

/**
 * 解析一个整数字段：未声明返回 undefined；非法值记 issue 并返回 undefined。
 * 预算字段写错时**不**给默认上限（不能把"写错"变成"无限制"或"意外截断"），
 * 而是让角色被标成 invalid，由调用方决定是否启动。
 */
function parseBudgetField(
	field: "maxTurns" | "maxTokens",
	raw: string | undefined,
	issues: RoleValidationIssue[],
): number | undefined {
	if (raw === undefined || raw === "") return undefined;
	if (!/^[0-9]+$/.test(raw)) {
		issues.push({
			field,
			value: raw,
			reason: `${field} "${raw}" must be a positive integer`,
		});
		return undefined;
	}
	const value = Number(raw);
	if (!Number.isSafeInteger(value) || value <= 0) {
		issues.push({
			field,
			value: raw,
			reason: `${field} "${raw}" must be a positive integer`,
		});
		return undefined;
	}
	return value;
}

/** 解析一个角色文件；解析问题不会抛错，而是记进 issues 并置 invalid。 */
export function parseRoleProfile(
	name: string,
	file = join(rolesDirPath(), `${name}.md`),
	promptPath = join(promptsDirPath(), `${name}.md`),
): RoleProfile | undefined {
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch (error) {
		return {
			name,
			description: "",
			base: FALLBACK_ROLE_BASE,
			promptPath,
			invalid: true,
			invalidReason: `cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`,
			issues: [
				{
					field: "frontmatter",
					reason: `cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`,
				},
			],
			sourcePath: file,
		};
	}

	const meta = parseFrontmatter(text);
	const issues: RoleValidationIssue[] = [];

	let base: RoleBase = FALLBACK_ROLE_BASE;
	const declaredBase = meta?.base?.trim();
	if (isRoleBase(declaredBase)) {
		base = declaredBase;
	} else if (declaredBase) {
		issues.push({
			field: "base",
			value: declaredBase,
			reason: `base "${declaredBase}" is not one of ${ROLE_BASES.join("|")}; falling back to ${FALLBACK_ROLE_BASE} (least privilege)`,
		});
	} else {
		issues.push({
			field: "base",
			reason: `frontmatter has no base; falling back to ${FALLBACK_ROLE_BASE} (least privilege)`,
		});
	}

	let tier: string | undefined;
	const declaredTier = meta?.tier?.trim();
	if (!declaredTier) {
		// 未声明 tier 不是错误：由 subagent-models.json 的 defaultTier（或 roles 表）决定。
	} else if (isRoleTier(declaredTier)) {
		tier = declaredTier;
	} else {
		issues.push({
			field: "tier",
			value: declaredTier,
			reason: `tier "${declaredTier}" is not one of ${ROLE_TIERS.join("|")}; no tier is applied (the router default is used)`,
		});
	}

	const maxTurns = parseBudgetField("maxTurns", meta?.maxTurns, issues);
	const maxTokens = parseBudgetField("maxTokens", meta?.maxTokens, issues);
	const budget: RoleBudget | undefined =
		maxTurns === undefined && maxTokens === undefined
			? undefined
			: Object.freeze({
					...(maxTurns === undefined ? {} : { maxTurns }),
					...(maxTokens === undefined ? {} : { maxTokens }),
				});
	const finalReason = issues.length ? issues.map((issue) => issue.reason).join("; ") : undefined;
	return {
		name,
		description: meta?.description || "",
		base,
		...(tier ? { tier } : {}),
		...(budget ? { budget } : {}),
		promptPath,
		invalid: issues.length > 0,
		...(finalReason ? { invalidReason: finalReason } : {}),
		issues,
		sourcePath: file,
	};
}

export function roleProfile(name: string): RoleProfile | undefined {
	const key = cacheKey(name);
	if (cache.has(key)) return cache.get(key) ?? undefined;

	if (!/^[A-Za-z0-9_-]+$/.test(name)) {
		cache.set(key, null);
		return undefined;
	}
	const file = join(rolesDirPath(), `${name}.md`);
	if (!existsSync(file)) {
		cache.set(key, null);
		return undefined;
	}
	const profile = parseRoleProfile(name, file) ?? null;
	cache.set(key, profile);
	return profile ?? undefined;
}

/**
 * 扫描角色目录，给出机器可读的校验清单（供 rules/build.py 或运维脚本使用）。
 * 非法角色会带着 invalidReason 出现在 `invalid` 里，prompt 缺失的出现在 `missingPrompts` 里。
 */
export function roleValidationReport(): RoleValidationReport {
	const rolesDir = rolesDirPath();
	const promptDir = promptsDirPath();
	let names: string[] = [];
	try {
		names = readdirSync(rolesDir)
			.filter((entry) => entry.endsWith(".md"))
			.map((entry) => entry.slice(0, -3))
			.filter((name) => /^[A-Za-z0-9_-]+$/.test(name))
			.sort();
	} catch {
		names = [];
	}

	const roles: RoleValidationEntry[] = [];
	for (const name of names) {
		const profile = roleProfile(name);
		if (!profile) continue;
		const promptState = inspectPrompt(profile.promptPath).state;
		roles.push({
			name,
			file: profile.sourcePath ?? join(rolesDir, `${name}.md`),
			valid: !profile.invalid,
			base: profile.base,
			...(profile.tier ? { tier: profile.tier } : {}),
			...(profile.budget ? { budget: profile.budget } : {}),
			...(profile.invalidReason ? { invalidReason: profile.invalidReason } : {}),
			issues: profile.issues,
			promptPath: profile.promptPath,
			promptState,
		});
	}

	return {
		version: 1,
		rolesDir,
		promptDir,
		roles,
		invalid: roles.filter((role) => !role.valid).map((role) => role.name),
		missingPrompts: roles.filter((role) => role.promptState !== "present").map((role) => role.name),
	};
}

/** 人类可读的清单；非法角色带 `INVALID` 标记与原因，供 build.py 直接写进角色清单。 */
export function formatRoleValidationReport(report: RoleValidationReport): string {
	const lines: string[] = [];
	for (const role of report.roles) {
		const tier = role.tier ?? "default";
		const prompt =
			role.promptState === "present" ? "prompt ok" : `prompt ${role.promptState}`;
		const budgetParts: string[] = [];
		if (role.budget?.maxTurns !== undefined) budgetParts.push(`maxTurns ${role.budget.maxTurns}`);
		if (role.budget?.maxTokens !== undefined) budgetParts.push(`maxTokens ${role.budget.maxTokens}`);
		const budget = budgetParts.length ? ` · 预算 ${budgetParts.join(" / ")}` : "";
		lines.push(
			`${role.valid ? "ok" : "INVALID"} · ${role.name} · 工具集 ${role.base} · 默认 ${tier} · ${prompt}${budget}`,
		);
		if (!role.valid && role.invalidReason) lines.push(`  原因: ${role.invalidReason}`);
	}
	if (report.roles.length === 0) lines.push(`未找到角色定义（${report.rolesDir}）。`);
	if (report.invalid.length) {
		lines.push(`非法角色 ${report.invalid.length} 个: ${report.invalid.join(", ")}`);
	}
	if (report.missingPrompts.length) {
		lines.push(`缺少 prompt 的角色: ${report.missingPrompts.join(", ")}（运行 rules/build.py 生成）`);
	}
	return lines.join("\n");
}