import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  JobLedger,
  defaultJobLedgerPath,
} from "pi-tsien-subagent-workbench/src/job-ledger.ts";

const readLines = (file: string): Record<string, unknown>[] =>
  readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);

describe("JobLedger", () => {
  it("appends one JSON line per record in order", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "pi-job-ledger-"));
    const file = path.join(dir, "nested", "jobs.jsonl");
    const ledger = new JobLedger(file);
    ledger.record({
      v: 1,
      at: 1,
      workId: "work_a",
      kind: "agent",
      status: "queued",
      role: "code",
      tier: "light",
    });
    ledger.record({ v: 1, at: 2, workId: "work_a", kind: "agent", status: "completed" });
    await ledger.flush();
    const lines = readLines(file);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ workId: "work_a", status: "queued", role: "code", tier: "light" });
    expect(lines[1]).toMatchObject({ workId: "work_a", status: "completed" });
  });

  it("keeps writing after a record that cannot be serialized", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "pi-job-ledger-"));
    const file = path.join(dir, "jobs.jsonl");
    const ledger = new JobLedger(file);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    // JSON.stringify throws inside record(); the queue must still accept the next line.
    expect(() => ledger.record(circular as never)).toThrow();
    ledger.record({ v: 1, at: 3, workId: "work_b", kind: "workflow", status: "failed" });
    await ledger.flush();
    expect(readLines(file)).toEqual([
      expect.objectContaining({ workId: "work_b", kind: "workflow", status: "failed" }),
    ]);
  });

  it("defaults to <agent dir>/subagent-jobs.jsonl", () => {
    expect(defaultJobLedgerPath({ PI_CODING_AGENT_DIR: "/tmp/agent-dir" })).toBe(
      "/tmp/agent-dir/subagent-jobs.jsonl",
    );
    expect(defaultJobLedgerPath({}).endsWith(path.join(".pi", "agent", "subagent-jobs.jsonl"))).toBe(true);
  });
});