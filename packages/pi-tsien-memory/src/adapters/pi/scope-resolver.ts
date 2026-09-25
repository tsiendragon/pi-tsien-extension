import { sha256 } from "../../shared/hash.ts";
import type { ScopeResolver } from "../../ports/memory.ts";
import type { MemoryScope, ScopeContext } from "../../domain/types.ts";

export class DefaultScopeResolver implements ScopeResolver {
  visibleScopes(context: ScopeContext): MemoryScope[] {
    const scopes: MemoryScope[] = [{ type: "global", key: `global:${context.profileId}` }];
    if (context.repositoryId) scopes.push({ type: "repository", key: `repository:${context.repositoryId}`, repositoryId: context.repositoryId });
    if (context.repositoryId && context.branch) {
      scopes.push({
        type: "branch",
        key: `branch:${context.repositoryId}:${context.branch}`,
        repositoryId: context.repositoryId,
        branch: context.branch,
      });
    }
    scopes.push({ type: "session", key: `session:${context.sessionId}`, sessionId: context.sessionId });
    return scopes;
  }

  requestedScope(context: ScopeContext, requested: MemoryScope["type"] | undefined, explicitGlobal: boolean): MemoryScope {
    if (requested === "global" && explicitGlobal) return { type: "global", key: `global:${context.profileId}` };
    if (requested === "branch" && context.repositoryId && context.branch) {
      return { type: "branch", key: `branch:${context.repositoryId}:${context.branch}`, repositoryId: context.repositoryId, branch: context.branch };
    }
    if (requested === "session") return { type: "session", key: `session:${context.sessionId}`, sessionId: context.sessionId };
    if (context.repositoryId) return { type: "repository", key: `repository:${context.repositoryId}`, repositoryId: context.repositoryId };
    return { type: "session", key: `session:${context.sessionId}`, sessionId: context.sessionId };
  }
}

export function repositoryIdFromRemote(remote: string, gitCommonDir: string): string {
  const normalized = remote.trim().replace(/^https?:\/\/[^/@]+@/i, "https://").replace(/\.git$/, "").toLowerCase();
  return sha256(normalized ? `remote:${normalized}` : `local:${gitCommonDir}`);
}

export function branchName(raw: string): string | undefined {
  const value = raw.trim();
  if (!value || value === "HEAD" || value.includes("\n")) return undefined;
  return value.slice(0, 200);
}
