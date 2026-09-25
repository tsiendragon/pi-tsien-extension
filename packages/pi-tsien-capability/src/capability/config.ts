/**
 * Capability layer configuration.
 *
 * Follows the project convention of a JSON file under `~/.pi/agent/`. L1
 * (generic) capabilities ship inside this extension; `roots` lists the business
 * (L2) capability directories, which override L1 entries on name collision.
 *
 * Example `~/.pi/agent/capability.json`:
 *   {
 *     "roots": ["/path/to/marketplace/packages/capabilities"]
 *   }
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface CapabilityConfig {
	readonly roots?: readonly string[];
}

export function agentDir(): string {
	return process.env.PI_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

export function loadCapabilityConfig(): CapabilityConfig {
	const path = process.env.PI_CAPABILITY_CONFIG ?? join(agentDir(), "capability.json");
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		return {};
	}
	try {
		const parsed = JSON.parse(raw) as { roots?: unknown };
		const roots = Array.isArray(parsed.roots)
			? parsed.roots.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
			: undefined;
		return { roots };
	} catch (error) {
		throw new Error(`invalid capability.json at ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
}