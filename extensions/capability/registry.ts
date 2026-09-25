/**
 * Capability discovery.
 *
 * Roots are scanned in order and later roots win, so the caller passes the
 * shared/generic root first and the business root second: a business capability
 * with the same name overrides the generic one.
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { parse as parseYaml } from "yaml";

import { normalizeContract, type Capability } from "./core.ts";

export interface CapabilityRoot {
	/** Directory containing one subdirectory per capability. */
	readonly dir: string;
	/** Label used in listings, e.g. `L1` (generic) or `L2` (business). */
	readonly layer: string;
}

export async function discoverCapabilities(roots: readonly CapabilityRoot[]): Promise<Capability[]> {
	const found = new Map<string, Capability>();
	for (const root of roots) {
		for (const capability of await loadRoot(root)) {
			found.set(capability.name, capability);
		}
	}
	return [...found.values()].sort((left, right) => left.name.localeCompare(right.name));
}

async function loadRoot(root: CapabilityRoot): Promise<Capability[]> {
	// A root may point directly at one capability directory.
	const direct = await loadCapability(root.dir, root.layer);
	if (direct) return [direct];

	let entries;
	try {
		entries = await readdir(root.dir, { withFileTypes: true });
	} catch {
		return [];
	}
	const capabilities: Capability[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const dir = join(root.dir, entry.name);
		// Support both `<root>/<name>/CAPABILITY.yaml` and the marketplace layout
		// `<root>/<name>/current/CAPABILITY.yaml`.
		const capability =
			(await loadCapability(dir, root.layer)) ?? (await loadCapability(join(dir, "current"), root.layer));
		if (capability) capabilities.push(capability);
	}
	return capabilities;
}

async function loadCapability(dir: string, layer: string): Promise<Capability | undefined> {
	let raw: string;
	try {
		raw = await readFile(join(dir, "CAPABILITY.yaml"), "utf8");
	} catch {
		return undefined;
	}
	let parsed: unknown;
	try {
		parsed = parseYaml(raw);
	} catch (error) {
		throw new Error(`invalid CAPABILITY.yaml in ${dir}: ${error instanceof Error ? error.message : String(error)}`);
	}
	const contract = normalizeContract(parsed);
	return contract ? { ...contract, dir, layer } : undefined;
}

export function findCapability(
	capabilities: readonly Capability[],
	name: string,
): Capability | undefined {
	return capabilities.find((capability) => capability.name === name);
}