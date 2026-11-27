import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import subagentWorkbench from "pi-tsien-subagent-workbench/src/index.ts";
import {
  RATING_SCORE_MAX,
  RatingLedger,
  normalizeRating,
} from "pi-tsien-subagent-workbench/src/rating-ledger.ts";

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "subagent-ratings-"));
  dirs.push(dir);
  return dir;
}

describe("normalizeRating", () => {
  it("keeps a valid score with trimmed tags and note", () => {
    expect(normalizeRating({ workId: " work-1 ", score: 4, tags: [" proof-check ", "", "numeric"], note: " ok " })).toEqual({
      workId: "work-1",
      score: 4,
      tags: ["proof-check", "numeric"],
      note: "ok",
    });
  });

  it("rejects scores, tags, and notes outside the documented bounds", () => {
    expect(() => normalizeRating({ workId: "w", score: 0 })).toThrow(/1 to 5/);
    expect(() => normalizeRating({ workId: "w", score: RATING_SCORE_MAX + 1 })).toThrow(/1 to 5/);
    expect(() => normalizeRating({ workId: "w", score: 3.5 })).toThrow(/1 to 5/);
    expect(() => normalizeRating({ workId: "  ", score: 3 })).toThrow(/workId/);
    expect(() => normalizeRating({ workId: "w", score: 3, tags: Array.from({ length: 9 }, (_, i) => `t${i}`) })).toThrow(/8 tags/);
    expect(() => normalizeRating({ workId: "w", score: 3, tags: ["x".repeat(41)] })).toThrow(/40 characters/);
    expect(() => normalizeRating({ workId: "w", score: 3, note: "x".repeat(501) })).toThrow(/500 characters/);
  });
});

describe("RatingLedger", () => {
  it("appends one JSON line per rating, in order", async () => {
    const file = path.join(tempDir(), "nested", "subagent-ratings.jsonl");
    const ledger = new RatingLedger(file);
    ledger.record({ v: 1, at: 1, workId: "a", score: 5, tags: ["literature"] });
    ledger.record({ v: 1, at: 2, workId: "b", score: 2, kind: "workflow", status: "failed" });
    await ledger.flush();
    const lines = readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(lines).toEqual([
      { v: 1, at: 1, workId: "a", score: 5, tags: ["literature"] },
      { v: 1, at: 2, workId: "b", score: 2, kind: "workflow", status: "failed" },
    ]);
  });
});

describe("subagent_rate", () => {
  function install(): { tools: Map<string, any>; entries: Array<[string, unknown]>; ctx: any } {
    const tools = new Map<string, any>();
    const entries: Array<[string, unknown]> = [];
    const pi = {
      on: vi.fn(),
      registerCommand: vi.fn(),
      registerTool: vi.fn((tool: any) => tools.set(tool.name, tool)),
      appendEntry: vi.fn((type: string, data: unknown) => entries.push([type, data])),
    };
    subagentWorkbench(pi as any);
    return { tools, entries, ctx: {} };
  }

  it("is registered and rejects an out-of-range score without writing", async () => {
    const dir = tempDir();
    vi.stubEnv("PI_CODING_AGENT_DIR", dir);
    const { tools, entries } = install();
    expect(tools.has("subagent_rate")).toBe(true);
    const result = await tools
      .get("subagent_rate")
      .execute("rate", { workId: "work-1", score: 9 }, new AbortController().signal, undefined, {});
    expect(result.details.ok).toBe(false);
    expect(entries).toHaveLength(0);
  });

  it("records the score with job metadata so a later review can join it", async () => {
    const dir = tempDir();
    vi.stubEnv("PI_CODING_AGENT_DIR", dir);
    const { tools, entries } = install();
    const result = await tools
      .get("subagent_rate")
      .execute(
        "rate",
        { workId: "work-unknown", score: 3, tags: ["proof-check"], note: "needed one fix" },
        new AbortController().signal,
        undefined,
        {},
      );
    expect(result.details.ok).toBe(true);
    expect(result.details.record).toMatchObject({ workId: "work-unknown", score: 3, tags: ["proof-check"] });
    expect(entries[0]?.[0]).toBe("subagent-rating");
    await vi.waitFor(() => {
      const file = path.join(dir, "subagent-ratings.jsonl");
      expect(JSON.parse(readFileSync(file, "utf8").trim())).toMatchObject({
        v: 1,
        workId: "work-unknown",
        score: 3,
        note: "needed one fix",
      });
    });
  });
});