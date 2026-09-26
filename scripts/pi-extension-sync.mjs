#!/usr/bin/env node

import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DEFAULT_REPO_ROOT = resolve(dirname(SCRIPT_PATH), "..");
const EXTENSION_FILE = /\.(?:[cm]?[jt]s)$/;
const PACKAGE_ID = /^[a-z][a-z0-9-]*$/;

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

function packageSource(entry) {
	if (typeof entry === "string") return entry;
	if (entry && typeof entry === "object" && typeof entry.source === "string") return entry.source;
	throw new Error(`Invalid package entry: ${JSON.stringify(entry)}`);
}

function npmName(source) {
	const spec = source.slice(4);
	if (spec.startsWith("@")) {
		const versionAt = spec.indexOf("@", spec.indexOf("/") + 1);
		return versionAt === -1 ? spec : spec.slice(0, versionAt);
	}
	const versionAt = spec.lastIndexOf("@");
	return versionAt <= 0 ? spec : spec.slice(0, versionAt);
}

function stripRef(path) {
	const refAt = path.lastIndexOf("@");
	return refAt > path.lastIndexOf("/") ? path.slice(0, refAt) : path;
}

function gitParts(source) {
	let raw = source.startsWith("git:") ? source.slice(4) : source;
	let host;
	let path;
	const scp = raw.match(/^[^@]+@([^:]+):(.+)$/);
	if (scp) {
		host = scp[1];
		path = scp[2];
	} else if (/^[a-z]+:\/\//i.test(raw)) {
		const parsed = new URL(raw);
		host = parsed.hostname;
		path = parsed.pathname.replace(/^\//, "");
	} else {
		const slash = raw.indexOf("/");
		if (slash <= 0) throw new Error(`Invalid git source: ${source}`);
		host = raw.slice(0, slash);
		path = raw.slice(slash + 1);
	}
	path = stripRef(path).replace(/\.git$/, "");
	if (!host || !path || path.includes("..")) throw new Error(`Invalid git source: ${source}`);
	return { host, path };
}

function packageIdentity(source, baseDir) {
	if (source.startsWith("npm:")) return `npm:${npmName(source)}`;
	if (/^(?:git:|https?:|ssh:|git:\/\/)/.test(source)) {
		const { host, path } = gitParts(source);
		return `git:${host}/${path}`;
	}
	return `local:${resolve(baseDir, source)}`;
}

function packageInstallRoot(source, agentDir) {
	if (source.startsWith("npm:")) return join(agentDir, "npm", "node_modules", npmName(source));
	if (/^(?:git:|https?:|ssh:|git:\/\/)/.test(source)) {
		const { host, path } = gitParts(source);
		return join(agentDir, "git", host, path);
	}
	return resolve(agentDir, source);
}

function firstExisting(candidates, label) {
	const found = candidates.filter(Boolean).find((candidate) => existsSync(candidate));
	if (!found) throw new Error(`Cannot resolve ${label}`);
	return resolve(found);
}

function createContext({ repoRoot, agentDir, env }) {
	const piTsienRoot = firstExisting(
		[env.PI_TSIEN_EXTENSION_ROOT, repoRoot],
		"${PI_TSIEN_EXTENSION_ROOT}; set PI_TSIEN_EXTENSION_ROOT",
	);
	// Resolved lazily: configs that never reference the marketplace checkout
	// (for example the standalone profile) must sync on machines that do not
	// have pi-marketplace installed.
	let marketplaceRoot;
	return {
		piTsienRoot,
		get marketplaceRoot() {
			marketplaceRoot ??= firstExisting(
				[env.PI_MARKETPLACE_ROOT, resolve(piTsienRoot, "..", "pi-marketplace")],
				"${PI_MARKETPLACE_ROOT}; set PI_MARKETPLACE_ROOT or clone pi-marketplace beside pi-tsien-extension",
			);
			return marketplaceRoot;
		},
		agentDir,
		home: env.HOME ? resolve(env.HOME) : homedir(),
	};
}

function expandString(value, context) {
	const expanded = value
		.replaceAll("${PI_TSIEN_EXTENSION_ROOT}", context.piTsienRoot)
		.replaceAll("${PI_AGENT_DIR}", context.agentDir)
		.replaceAll("${HOME}", context.home);
	if (!expanded.includes("${PI_MARKETPLACE_ROOT}")) return expanded;
	return expanded.replaceAll("${PI_MARKETPLACE_ROOT}", context.marketplaceRoot);
}

function normalizePackages(entries, context, agentDir) {
	const seenIds = new Set();
	const seenSources = new Set();
	return entries.map((entry) => {
		if (!entry || typeof entry !== "object" || typeof entry.id !== "string" || typeof entry.source !== "string") {
			throw new Error(`Invalid package declaration: ${JSON.stringify(entry)}`);
		}
		if (!PACKAGE_ID.test(entry.id)) throw new Error(`Invalid package id: ${entry.id}`);
		if (seenIds.has(entry.id)) throw new Error(`Duplicate package id: ${entry.id}`);
		seenIds.add(entry.id);
		const source = expandString(entry.source, context);
		const identity = packageIdentity(source, agentDir);
		if (seenSources.has(identity)) throw new Error(`Duplicate package source: ${source}`);
		seenSources.add(identity);
		if (isAbsolute(source) && !existsSync(source)) throw new Error(`Local package does not exist: ${source}`);
		return { id: entry.id, source, root: packageInstallRoot(source, agentDir) };
	});
}

function normalizeLoadOrder(entries, packages, context) {
	const packageById = new Map(packages.map((entry) => [entry.id, entry]));
	const seen = new Set();
	return entries.map((entry, index) => {
		if (!entry || typeof entry !== "object" || typeof entry.path !== "string") {
			throw new Error(`Invalid loadOrder entry at index ${index}`);
		}
		let absolute;
		let label;
		if (entry.package !== undefined) {
			if (typeof entry.package !== "string" || !packageById.has(entry.package)) {
				throw new Error(`Unknown package in loadOrder: ${String(entry.package)}`);
			}
			if (isAbsolute(entry.path) || entry.path.split(/[\\/]/).includes("..")) {
				throw new Error(`Package extension path must stay inside its package: ${entry.path}`);
			}
			const pkg = packageById.get(entry.package);
			absolute = resolve(pkg.root, entry.path);
			if (relative(pkg.root, absolute).startsWith(`..${sep}`)) {
				throw new Error(`Package extension escapes its package: ${entry.path}`);
			}
			label = `${entry.package}:${entry.path}`;
			if (existsSync(pkg.root) && !existsSync(absolute)) throw new Error(`Extension does not exist: ${label}`);
		} else {
			const expanded = expandString(entry.path, context);
			if (!isAbsolute(expanded)) throw new Error(`Direct extension must resolve to an absolute path: ${entry.path}`);
			absolute = resolve(expanded);
			label = absolute;
			if (!existsSync(absolute)) throw new Error(`Direct extension does not exist: ${absolute}`);
		}
		if (!EXTENSION_FILE.test(absolute)) throw new Error(`Unsupported extension file: ${label}`);
		if (seen.has(absolute)) throw new Error(`Duplicate extension in loadOrder: ${label}`);
		seen.add(absolute);
		return { absolute, label };
	});
}

function sameEntry(left, right) {
	return JSON.stringify(left) === JSON.stringify(right);
}

function timestamp(date = new Date()) {
	return date.toISOString().replace(/[:.]/g, "-");
}

export function buildSyncPlan({
	configPath,
	agentDir = join(homedir(), ".pi", "agent"),
	repoRoot = DEFAULT_REPO_ROOT,
	env = process.env,
} = {}) {
	const absoluteAgentDir = resolve(agentDir);
	const absoluteRepoRoot = resolve(repoRoot);
	const absoluteConfigPath = resolve(configPath ?? join(absoluteAgentDir, "extensions.config.json"));
	const config = readJson(absoluteConfigPath);
	if (config.version !== 1) throw new Error(`Unsupported config version: ${String(config.version)}`);
	if (!Array.isArray(config.packages) || !Array.isArray(config.loadOrder)) {
		throw new Error("Config must contain ordered packages and loadOrder arrays");
	}
	if (
		config.prune?.packages !== true ||
		config.prune?.extensions !== true ||
		config.prune?.autoDiscoveredExtensions !== "quarantine"
	) {
		throw new Error("Strict management requires package/extension pruning and auto-extension quarantine");
	}

	const context = createContext({ repoRoot: absoluteRepoRoot, agentDir: absoluteAgentDir, env });
	const packages = normalizePackages(config.packages, context, absoluteAgentDir);
	const orderedExtensions = normalizeLoadOrder(config.loadOrder, packages, context);
	const desiredPackages = packages.map(({ source }) => ({ source, autoload: false }));
	const desiredExtensions = orderedExtensions.map(({ absolute }) => absolute);

	const settingsPath = join(absoluteAgentDir, "settings.json");
	const settings = existsSync(settingsPath) ? readJson(settingsPath) : {};
	const currentPackages = Array.isArray(settings.packages) ? settings.packages : [];
	const currentExtensions = Array.isArray(settings.extensions) ? settings.extensions : [];
	const currentByIdentity = new Map(
		currentPackages.map((entry) => [packageIdentity(packageSource(entry), absoluteAgentDir), entry]),
	);
	const desiredByIdentity = new Map(
		desiredPackages.map((entry) => [packageIdentity(entry.source, absoluteAgentDir), entry]),
	);
	const packageAdds = [];
	const packageUpdates = [];
	const packageRemovals = [];
	for (const [identity, entry] of desiredByIdentity) {
		const current = currentByIdentity.get(identity);
		if (!current) packageAdds.push(entry);
		else if (!sameEntry(current, entry)) packageUpdates.push({ from: current, to: entry });
	}
	for (const [identity, entry] of currentByIdentity) {
		if (!desiredByIdentity.has(identity)) packageRemovals.push(entry);
	}

	// Pi supports `-path` (disabled), `+path` (force enabled) and `!path` (excluded) override entries.
	// They are user intent written by Pi's own /config UI or the dashboard, so strict pruning must
	// keep them verbatim instead of treating them as unknown paths and dropping them.
	const isOverrideEntry = (entry) => typeof entry === "string" && /^[!+-]/.test(entry);
	const preservedOverrides = currentExtensions.filter(isOverrideEntry);
	const disabledByOverride = new Set(
		preservedOverrides
			.filter((entry) => entry.startsWith("-") || entry.startsWith("!"))
			.map((entry) => resolve(absoluteAgentDir, entry.slice(1))),
	);
	const managedCurrentExtensions = currentExtensions.filter((entry) => !isOverrideEntry(entry));
	const effectiveExtensions = desiredExtensions.filter((entry) => !disabledByOverride.has(entry));
	const normalizedCurrentExtensions = managedCurrentExtensions.map((entry) => resolve(absoluteAgentDir, entry));
	const desiredSet = new Set(effectiveExtensions);
	const currentSet = new Set(normalizedCurrentExtensions);
	const extensionAdds = orderedExtensions.filter(
		(entry) => !currentSet.has(entry.absolute) && !disabledByOverride.has(entry.absolute),
	);
	const extensionRemovals = managedCurrentExtensions.filter(
		(_entry, index) => !desiredSet.has(normalizedCurrentExtensions[index]),
	);
	const packageOrderChanged = !sameEntry(currentPackages, desiredPackages);
	const loadOrderChanged = !sameEntry(normalizedCurrentExtensions, effectiveExtensions);

	const autoExtensionsDir = join(absoluteAgentDir, "extensions");
	const autoExtensionRemovals = existsSync(autoExtensionsDir)
		? readdirSync(autoExtensionsDir, { withFileTypes: true })
			.filter((entry) => entry.isFile() && /\.(?:[cm]?[jt]s)(?:\.disabled)?$/.test(entry.name))
			.map((entry) => ({ name: entry.name, path: join(autoExtensionsDir, entry.name) }))
			.filter((entry) => !desiredSet.has(resolve(entry.path)))
			.sort((left, right) => left.name.localeCompare(right.name))
		: [];

	return {
		configPath: absoluteConfigPath,
		agentDir: absoluteAgentDir,
		settingsPath,
		settings,
		desiredPackages,
		desiredExtensions: effectiveExtensions,
		preservedOverrides,
		orderedExtensions,
		packageAdds,
		packageUpdates,
		packageRemovals,
		extensionAdds,
		extensionRemovals,
		packageOrderChanged,
		loadOrderChanged,
		autoExtensionRemovals,
		changed: packageOrderChanged || loadOrderChanged || autoExtensionRemovals.length > 0,
	};
}

function atomicWriteJson(path, value) {
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.tmp-${process.pid}`;
	writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
	renameSync(temporary, path);
}

export function applySyncPlan(plan, { now = new Date() } = {}) {
	if (!plan.changed) return { changed: false };
	const stamp = timestamp(now);
	const backupDir = join(plan.agentDir, "extension-sync-backups", stamp);
	const quarantineDir = join(plan.agentDir, "extension-quarantine", stamp);
	mkdirSync(backupDir, { recursive: true });
	if (existsSync(plan.settingsPath)) copyFileSync(plan.settingsPath, join(backupDir, "settings.json"));
	atomicWriteJson(plan.settingsPath, {
		...plan.settings,
		packages: plan.desiredPackages,
		extensions: [...plan.desiredExtensions, ...(plan.preservedOverrides ?? [])],
	});
	if (plan.autoExtensionRemovals.length > 0) {
		mkdirSync(quarantineDir, { recursive: true });
		for (const removal of plan.autoExtensionRemovals) renameSync(removal.path, join(quarantineDir, removal.name));
	}
	return {
		changed: true,
		backupDir,
		quarantineDir: plan.autoExtensionRemovals.length ? quarantineDir : undefined,
	};
}

export function formatSyncPlan(plan) {
	const lines = [plan.changed ? "Pi extension sync changes:" : "Pi extensions already match the ordered user config."];
	for (const entry of plan.packageAdds) lines.push(`  package + ${entry.source}`);
	for (const update of plan.packageUpdates) lines.push(`  package ~ managed install: ${update.to.source}`);
	for (const entry of plan.packageRemovals) lines.push(`  package - ${packageSource(entry)}`);
	if (plan.packageOrderChanged) {
		lines.push("  package install order:");
		plan.desiredPackages.forEach((entry, index) => lines.push(`    ${index + 1}. ${entry.source}`));
	}
	for (const entry of plan.extensionAdds) lines.push(`  extension + ${entry.label}`);
	for (const entry of plan.extensionRemovals) lines.push(`  extension - ${entry}`);
	for (const entry of plan.preservedOverrides ?? []) lines.push(`  extension override kept: ${entry}`);
	if (plan.loadOrderChanged) {
		lines.push("  extension load order:");
		plan.orderedExtensions.forEach((entry, index) => lines.push(`    ${index + 1}. ${entry.label}`));
	}
	for (const removal of plan.autoExtensionRemovals) lines.push(`  auto extension - ${removal.name} -> quarantine`);
	return lines.join("\n");
}

function parseArgs(argv) {
	const options = { apply: false, configPath: undefined, agentDir: join(homedir(), ".pi", "agent") };
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--apply") options.apply = true;
		else if (arg === "--config") options.configPath = argv[++index];
		else if (arg === "--agent-dir") options.agentDir = argv[++index];
		else if (arg === "--help" || arg === "-h") options.help = true;
		else throw new Error(`Unknown argument: ${arg}`);
	}
	if (options.configPath === undefined) options.configPath = join(options.agentDir, "extensions.config.json");
	if (!options.configPath || !options.agentDir) throw new Error("--config and --agent-dir require values");
	return options;
}

function printHelp() {
	console.log(`Usage: node scripts/pi-extension-sync.mjs [options]\n\nOptions:\n  --apply              Apply ordered install/load config (default: dry-run)\n  --config <path>      Config path (default: ~/.pi/agent/extensions.config.json)\n  --agent-dir <path>   Pi agent directory\n  -h, --help           Show this help`);
}

function main() {
	try {
		const options = parseArgs(process.argv.slice(2));
		if (options.help) {
			printHelp();
			return;
		}
		const plan = buildSyncPlan(options);
		console.log(formatSyncPlan(plan));
		if (!options.apply) {
			if (plan.changed) console.log("Dry-run only. Re-run with --apply to reconcile.");
			return;
		}
		const result = applySyncPlan(plan);
		if (result.changed) {
			console.log(`Applied. Backup: ${result.backupDir}`);
			if (result.quarantineDir) console.log(`Quarantine: ${result.quarantineDir}`);
			console.log("Reload or restart Pi to use the ordered extension set.");
		}
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) main();
