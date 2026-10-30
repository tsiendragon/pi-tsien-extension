import { execFileSync } from "node:child_process";

export interface DiffScope {
  /** 描述这次扫描的范围，仅用于日志 */
  label: string;
  diff: string;
}

function run(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
}

function tryRun(cwd: string, args: string[]): string | undefined {
  try {
    return run(cwd, args);
  } catch {
    return undefined;
  }
}

export function isGitRepo(cwd: string): boolean {
  return tryRun(cwd, ["rev-parse", "--is-inside-work-tree"])?.trim() === "true";
}

/** 暂存区相对 HEAD 的新增内容（pre-commit 与手动扫描都用它）。 */
export function readStagedDiff(cwd: string): DiffScope {
  const args = ["diff", "--cached", "--unified=1", "--no-color", "--no-ext-diff", "--diff-filter=ACMR", "--"];
  const diff = tryRun(cwd, args) ?? "";
  return { label: "暂存区", diff };
}

/**
 * 尚未推送的提交内容。pre-push 会从 stdin 给我们 local sha / remote sha，
 * 直接用区间 diff 最准；拿不到就退化成「所有还没进远程分支的提交」。
 */
export function readUnpushedDiff(cwd: string, stdin?: string): DiffScope {
  const ranges = (stdin ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts.length === 4)
    .map(([localRef, localSha, , remoteSha]) => ({ localRef, localSha, remoteSha }));

  const diffs: string[] = [];
  for (const range of ranges) {
    if (/^0+$/.test(range.localSha)) continue;
    const args = /^0+$/.test(range.remoteSha)
      ? ["log", "-p", "--unified=1", "--no-color", "--no-ext-diff", "--format=", range.localSha, "--not", "--remotes"]
      : ["diff", "--unified=1", "--no-color", "--no-ext-diff", range.remoteSha, range.localSha, "--"];
    const chunk = tryRun(cwd, args);
    if (chunk) diffs.push(chunk);
  }
  if (diffs.length > 0) return { label: "待推送提交", diff: diffs.join("\n") };

  const upstream = tryRun(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"])?.trim();
  if (upstream) {
    const chunk = tryRun(cwd, ["diff", "--unified=1", "--no-color", "--no-ext-diff", `${upstream}...HEAD`, "--"]);
    if (chunk) return { label: `${upstream}..HEAD`, diff: chunk };
  }

  const fallback = tryRun(cwd, ["log", "-p", "--unified=1", "--no-color", "--no-ext-diff", "--format=", "HEAD", "--not", "--remotes"]);
  return { label: "所有未进远程分支的提交", diff: fallback ?? "" };
}

/** 当前仓库 git 用户信息里的名字，用来识别“自己的本机路径”。 */
export function gitUserNames(cwd: string): string[] {
  const email = tryRun(cwd, ["config", "user.email"])?.trim() ?? "";
  const name = tryRun(cwd, ["config", "user.name"])?.trim() ?? "";
  const out = new Set<string>();
  if (email.includes("@")) out.add(email.split("@")[0].toLowerCase());
  if (name) out.add(name.toLowerCase());
  return [...out];
}

/** git 自己认的 hooks 目录（不受 core.hooksPath 影响时的真实位置）。 */
export function repoHooksDir(cwd: string): string | undefined {
  const commonDir = tryRun(cwd, ["rev-parse", "--git-common-dir"])?.trim();
  if (!commonDir) return undefined;
  return `${commonDir.replace(/\/+$/, "")}/hooks`;
}