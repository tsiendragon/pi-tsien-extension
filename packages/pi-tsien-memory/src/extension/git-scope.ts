import type { ExecResult, PiExtensionAPI } from "./pi-types.ts";
import type { ScopeContext } from "../domain/types.ts";
import { repositoryIdFromRemote, branchName } from "../adapters/pi/scope-resolver.ts";
import { sha256 } from "../shared/hash.ts";

export async function resolveScope(pi: PiExtensionAPI, cwd: string, sessionId: string, profileId: string): Promise<ScopeContext> {
  const root = await git(pi, cwd, ["rev-parse", "--show-toplevel"]);
  if (root.code !== 0 || !root.stdout.trim()) return { profileId, sessionId, cwd, repositoryId: sha256(`workspace:${cwd}`) };
  const gitDir = await git(pi, cwd, ["rev-parse", "--git-common-dir"]);
  const remote = await git(pi, cwd, ["config", "--get", "remote.origin.url"]);
  const branch = await git(pi, cwd, ["branch", "--show-current"]);
  const repositoryId = repositoryIdFromRemote(remote.stdout.trim(), gitDir.stdout.trim() || `${root.stdout.trim()}/.git`);
  const resolvedBranch = branchName(branch.stdout);
  return resolvedBranch ? { profileId, sessionId, cwd, repositoryId, branch: resolvedBranch } : { profileId, sessionId, cwd, repositoryId };
}

async function git(pi: PiExtensionAPI, cwd: string, args: string[]): Promise<ExecResult> {
  try {
    return await pi.exec("git", args, { cwd, timeout: 1000 });
  } catch {
    return { stdout: "", stderr: "git unavailable", code: 1, killed: false };
  }
}
