import { mkdtempSync, writeFileSync, utimesSync, existsSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SESSION_RETENTION_DAYS,
  pruneSubagentSessions,
  sessionRetentionDays,
} from "pi-tsien-subagent-workbench/src/session-retention.ts";

const DAY = 86_400_000;

function seed(entries: { name: string; ageDays: number; bytes?: number }[]): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pi-session-retention-"));
  for (const entry of entries) {
    const file = path.join(dir, entry.name);
    writeFileSync(file, "x".repeat(entry.bytes ?? 100));
    const at = new Date(Date.now() - entry.ageDays * DAY);
    utimesSync(file, at, at);
  }
  return dir;
}

describe("pruneSubagentSessions", () => {
  it("deletes only old jsonl files and reports what it freed", async () => {
    const dir = seed([
      { name: "old.jsonl", ageDays: 30, bytes: 1024 },
      { name: "older.jsonl", ageDays: 40, bytes: 2048 },
      { name: "fresh.jsonl", ageDays: 1, bytes: 512 },
      { name: "notes.txt", ageDays: 30, bytes: 256 },
    ]);
    const result = await pruneSubagentSessions(dir, 14);
    expect(result).toMatchObject({ deleted: 2, bytes: 3072, kept: 1, failed: 0 });
    expect(existsSync(path.join(dir, "old.jsonl"))).toBe(false);
    expect(existsSync(path.join(dir, "fresh.jsonl"))).toBe(true);
    // Non-jsonl files are never touched.
    expect(existsSync(path.join(dir, "notes.txt"))).toBe(true);
  });

  it("keeps everything when the window is wide enough", async () => {
    const dir = seed([{ name: "a.jsonl", ageDays: 3 }]);
    const result = await pruneSubagentSessions(dir, 14);
    expect(result).toMatchObject({ deleted: 0, kept: 1 });
    expect(readdirSync(dir)).toHaveLength(1);
  });

  it("is a no-op for a directory that does not exist", async () => {
    const result = await pruneSubagentSessions("/tmp/pi-does-not-exist-xyz", 14);
    expect(result).toEqual({ deleted: 0, bytes: 0, kept: 0, failed: 0 });
  });
});

describe("sessionRetentionDays", () => {
  it("defaults to two weeks and honours the override", () => {
    expect(sessionRetentionDays({})).toBe(DEFAULT_SESSION_RETENTION_DAYS);
    expect(sessionRetentionDays({ PI_SUBAGENT_SESSION_TTL_DAYS: "30" })).toBe(30);
    expect(sessionRetentionDays({ PI_SUBAGENT_SESSION_TTL_DAYS: "0" })).toBe(DEFAULT_SESSION_RETENTION_DAYS);
    expect(sessionRetentionDays({ PI_SUBAGENT_SESSION_TTL_DAYS: "nope" })).toBe(DEFAULT_SESSION_RETENTION_DAYS);
    expect(sessionRetentionDays({ PI_SUBAGENT_SESSION_TTL_DAYS: "9999" })).toBe(365);
  });
});