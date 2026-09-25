/**
 * Checks the promote/demote status transition.
 *
 * Uses a temp CAPABILITY.yaml so the real packages are untouched. The command
 * handler is a thin wrapper over `setCapabilityStatus`.
 *
 * Usage: npx tsx scripts/capability-promote-check.ts
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { setCapabilityStatus } from "../extensions/capability/promote.ts";

const dir = await mkdtemp(join(tmpdir(), "capability-promote-"));
const file = join(dir, "CAPABILITY.yaml");
const original = "name: demo\nversion: 0.1.0\nstatus: draft\nsteps: []\n";
await writeFile(file, original, "utf8");

await setCapabilityStatus(dir, "trusted");
const afterPromote = await readFile(file, "utf8");
assert.ok(afterPromote.includes("status: trusted"), "status must become trusted");
assert.ok(afterPromote.includes("name: demo"), "other lines must survive");
assert.ok(afterPromote.includes("steps: []"), "field order and trailing fields must survive");

await setCapabilityStatus(dir, "draft");
assert.ok((await readFile(file, "utf8")).includes("status: draft"), "demote must work");

const noStatusDir = await mkdtemp(join(tmpdir(), "capability-nostatus-"));
await writeFile(join(noStatusDir, "CAPABILITY.yaml"), "name: demo\nversion: 0.1.0\n", "utf8");
await assert.rejects(() => setCapabilityStatus(noStatusDir, "trusted"), /no "status:" line/);

console.log("capability promote check: PASS");