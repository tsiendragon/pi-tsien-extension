#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { isGitRepo } from "./git.ts";
import { runScan, type GitAction } from "./run.ts";
import { formatReport } from "./scan.ts";

const USAGE = `secret-guard — 提交/推送前扫描敏感信息

用法：
  secret-guard scan [--staged|--push] [--no-ai]   手动扫一次并打印报告
  secret-guard hook pre-commit                     git 钩子入口
  secret-guard hook pre-push                       git 钩子入口（从 stdin 读推送范围）
  secret-guard install-hooks [--repo]              安装 git 钩子（默认用户级全局）
  secret-guard allow <glob> <类别|*> <原因>         往 .secret-guard-allow 追加一条放行

退出码：0 通过 / 1 发现敏感信息 / 2 自身出错
`;

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function commandScan(args: string[]): Promise<number> {
  const cwd = process.cwd();
  if (!isGitRepo(cwd)) {
    process.stderr.write("secret-guard：当前目录不是 git 仓库\n");
    return 2;
  }
  const action: GitAction = args.includes("--push") ? "push" : "commit";
  const stdin = action === "push" ? await readStdin() : undefined;
  const { loaded, label, report } = await runScan({ cwd, action, stdin, noAi: args.includes("--no-ai") });
  process.stdout.write(`扫描范围：${label}   配置：${loaded.configPath ?? "内置默认"}   放行清单：${loaded.allowlistPath ?? "无"}\n\n`);
  process.stdout.write(`${formatReport(report, { action, verbose: args.includes("--verbose") })}\n`);
  return report.blocked.length > 0 ? 1 : 0;
}

async function commandHook(kind: string): Promise<number> {
  if (process.env.SECRET_GUARD_DISABLE === "1") return 0;
  const cwd = process.cwd();
  if (!isGitRepo(cwd)) return 0;
  const action: GitAction = kind === "pre-push" ? "push" : "commit";
  const stdin = action === "push" ? await readStdin() : undefined;

  let result;
  try {
    result = await runScan({ cwd, action, stdin });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`secret-guard 自身出错：${message}\n本次提交被拦下。确认无误后可用 git ... --no-verify 跳过。\n`);
    return 1;
  }

  const { report } = result;
  if (report.blocked.length === 0) {
    if (report.rescued.length > 0) {
      process.stdout.write(`secret-guard：放行 ${report.rescued.length} 处已确认的示例值。\n`);
    }
    return 0;
  }
  process.stderr.write(`\n${formatReport(report, { action })}\n`);
  return 1;
}

function here(): string {
  return import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname);
}

const BACKUP_SUFFIX = ".before-secret-guard";

/**
 * 仓库原本就有钩子时必须先备份再覆盖，否则等于把人家的钩子删了。
 * 备份文件由 shim 负责链式调用。
 */
function backupExistingHook(file: string): string | undefined {
  if (!fs.existsSync(file)) return undefined;
  const content = fs.readFileSync(file, "utf8");
  if (content.includes("pi-tsien-secret-guard")) return undefined;
  const backup = `${file}${BACKUP_SUFFIX}`;
  fs.copyFileSync(file, backup);
  fs.chmodSync(backup, 0o755);
  return backup;
}

function shimScript(kind: "pre-commit" | "pre-push", cliPath: string): string {
  const guard = kind === "pre-push"
    ? `input=$(cat)
printf "%s" "$input" | node $NODE_FLAGS "$SG_CLI" hook pre-push
code=$?
if [ $code -ne 0 ]; then exit $code; fi`
    : `node $NODE_FLAGS "$SG_CLI" hook pre-commit
code=$?
if [ $code -ne 0 ]; then exit $code; fi`;
  const chain = kind === "pre-push"
    ? `if [ -x "$REAL" ] && [ "$REAL" != "$0" ]; then printf "%s" "$input" | "$REAL" "$@"; fi`
    : `if [ -x "$REAL" ] && [ "$REAL" != "$0" ]; then exec "$REAL" "$@"; fi`;
  return `#!/bin/sh
# 由 pi-tsien-secret-guard 安装。删掉本文件或把 core.hooksPath 改回去即可卸载。
if [ "$SECRET_GUARD_DISABLE" = "1" ]; then exit 0; fi
SG_CLI="${cliPath}"
# Node 22.6 以下不认 TypeScript，退回 tsx 失败时不要卡住提交。
NODE_FLAGS=""
SG_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "$SG_MAJOR" -ge 23 ] 2>/dev/null; then NODE_FLAGS=""; else NODE_FLAGS="--experimental-strip-types"; fi
${guard}
HOOKS="$(git rev-parse --git-common-dir 2>/dev/null)/hooks"
REAL="$HOOKS/${kind}${BACKUP_SUFFIX}"
if [ ! -x "$REAL" ]; then REAL="$HOOKS/${kind}"; fi
${chain}
exit 0
`;
}

const PRIVATE_CONFIG = ".secret-guard.local.json";

/** 私有规则文件永远不进仓库：写进 .git/info/exclude，连 .gitignore 都不用动。 */
function ensureExcluded(cwd: string): string | undefined {
  const infoDir = path.join(cwd, ".git", "info");
  if (!fs.existsSync(infoDir)) return undefined;
  const file = path.join(infoDir, "exclude");
  const marker = "# pi-tsien-secret-guard：私有规则，只在本机生效";
  const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  if (existing.includes(PRIVATE_CONFIG)) return file;
  const block = `${existing.endsWith("\n") || existing === "" ? "" : "\n"}${marker}\n${PRIVATE_CONFIG}\n`;
  fs.writeFileSync(file, block, "utf8");
  return file;
}

function ensurePrivateConfigTemplate(cwd: string): string | undefined {
  const file = path.join(cwd, PRIVATE_CONFIG);
  if (fs.existsSync(file)) return file;
  const template = {
    note: "本文件不进仓库，用来放只有你知道的拦截关键词和自家格式。",
    blockedKeywords: [],
    extraPatterns: [],
  };
  fs.writeFileSync(file, `${JSON.stringify(template, null, 2)}\n`, "utf8");
  return file;
}

async function commandInstallHooks(args: string[]): Promise<number> {
  const cliPath = path.join(here(), "cli.ts");
  if (isGitRepo(process.cwd())) {
    const excluded = ensureExcluded(process.cwd());
    const template = ensurePrivateConfigTemplate(process.cwd());
    if (excluded) process.stdout.write(`已登记到 ${excluded}（私有规则不会进仓库）\n`);
    if (template) process.stdout.write(`私有规则文件：${template}\n`);
  }
  const useRepo = args.includes("--repo");
  const target = useRepo ? path.join(process.cwd(), ".git", "hooks") : path.join(os.homedir(), ".git-hooks");
  fs.mkdirSync(target, { recursive: true });
  for (const kind of ["pre-commit", "pre-push"] as const) {
    const file = path.join(target, kind);
    const backup = backupExistingHook(file);
    fs.writeFileSync(file, shimScript(kind, cliPath), "utf8");
    fs.chmodSync(file, 0o755);
    process.stdout.write(`已写入 ${file}\n`);
    if (backup) process.stdout.write(`原有钩子已备份为 ${backup}，之后会被链式调用\n`);
  }
  if (useRepo) {
    process.stdout.write("提示：仓库若设置了 core.hooksPath（例如 husky），本钩子不会生效。\n");
    return 0;
  }
  try {
    execFileSync("git", ["config", "--global", "core.hooksPath", target], { stdio: "ignore" });
  } catch (error: unknown) {
    process.stderr.write(`设置 core.hooksPath 失败：${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  process.stdout.write(`已设置全局 core.hooksPath = ${target}\n`);
  process.stdout.write("之后每个仓库的提交和推送都会先经过这里；仓库自己的 core.hooksPath（如 husky）会覆盖它。\n");
  return 0;
}

async function commandAllow(args: string[]): Promise<number> {
  const [glob, category, ...reasonParts] = args;
  const reason = reasonParts.join(" ").replace(/^#\s*/, "");
  if (!glob || !category || !reason) {
    process.stderr.write("用法：secret-guard allow <glob> <类别|*> <原因>\n");
    return 2;
  }
  const file = path.join(process.cwd(), ".secret-guard-allow");
  const header = fs.existsSync(file) ? "" : "# 路径glob  类别  # 原因（每行必须有原因，否则不生效）\n";
  fs.appendFileSync(file, `${header}${glob} ${category} # ${reason}\n`, "utf8");
  process.stdout.write(`已追加到 ${file}\n`);
  return 0;
}

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case "scan":
      return commandScan(rest);
    case "hook":
      return commandHook(rest[0] ?? "pre-commit");
    case "install-hooks":
      return commandInstallHooks(rest);
    case "allow":
      return commandAllow(rest);
    case "-h":
    case "--help":
    case undefined:
      process.stdout.write(USAGE);
      return 0;
    default:
      process.stderr.write(`未知命令：${command}\n\n${USAGE}`);
      return 2;
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`secret-guard 出错：${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
  },
);