/**
 * Capability status transitions.
 *
 * Promotion is deliberately a user command, never a tool: the design says the
 * agent may draft and run, but only a human may move a capability to `trusted`.
 *
 * The edit is a targeted line replacement so the rest of CAPABILITY.yaml (layout,
 * comments, field order) survives untouched.
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type CapabilityStatus = "draft" | "trusted";

const STATUS_LINE = /^status:[^\S\n]*\S+[^\S\n]*$/m;

export async function setCapabilityStatus(dir: string, status: CapabilityStatus): Promise<void> {
	const path = join(dir, "CAPABILITY.yaml");
	const text = await readFile(path, "utf8");
	if (!STATUS_LINE.test(text)) {
		throw new Error(`no "status:" line in ${path}`);
	}
	const updated = text.replace(STATUS_LINE, `status: ${status}`);
	if (updated === text) return;
	await writeFile(path, updated, "utf8");
}