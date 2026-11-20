import { readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

/** Child transcripts are only useful while someone is debugging; two weeks is plenty. */
export const DEFAULT_SESSION_RETENTION_DAYS = 14;

export interface PruneResult {
  readonly deleted: number;
  readonly bytes: number;
  readonly kept: number;
  readonly failed: number;
}

export function sessionRetentionDays(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const raw = Number(environment.PI_SUBAGENT_SESSION_TTL_DAYS);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_SESSION_RETENTION_DAYS;
  return Math.min(365, Math.round(raw));
}

/**
 * Deletes child session files older than the retention window.
 *
 * Persisting child sessions is what makes their tool calls and token usage
 * countable, but it runs at roughly 0.5 GB a day, so the directory needs a
 * ceiling. Only `*.jsonl` files directly inside `dir` are touched; anything
 * else (and the directory itself) is left alone.
 */
export async function pruneSubagentSessions(
  dir: string,
  retentionDays = sessionRetentionDays(),
  now = Date.now(),
): Promise<PruneResult> {
  const cutoff = now - retentionDays * 86_400_000;
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return { deleted: 0, bytes: 0, kept: 0, failed: 0 };
  }
  let deleted = 0;
  let bytes = 0;
  let kept = 0;
  let failed = 0;
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const path = join(dir, name);
    try {
      const info = await stat(path);
      if (!info.isFile() || info.mtimeMs > cutoff) {
        kept += 1;
        continue;
      }
      await unlink(path);
      deleted += 1;
      bytes += info.size;
    } catch {
      failed += 1;
    }
  }
  return { deleted, bytes, kept, failed };
}