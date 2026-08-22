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
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DEFAULT_REPO_ROOT = resolve(dirname(SCRIPT_PATH), "..");
const EXTENSION_FILE = /\.(?:[cm]?[jt]s)(?:\.disabled)?$/;

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

function packageSource(entry) {
	if (typeof entry === "string") return entry;
	if (entry && typeof entry === "object" && typeof entry.source === "string") return entry.source;
	throw new Error(`Invalid package entry: ${JSON.stringify(entry)}`);
}

function npmIdentity(source) {
	const spec = source.slice(4);
	if (spec.startsWith("@")) {
		const versionAt = spec.indexOf("@", spec.indexOf("/") + 1);
		return versionAt === -1 ? spec : spec.slice(0, versionAt);
	}
	const versionAt = spec.lastIndexOf("@");
	return versionAt <= 0 ? spec : spec.slice(0, versionAt);
}

function gitIdentity(source) {
	const withoutPrefix = source.startsWith("git:") ? source.slice(4) : source;
	const refAt = withoutPrefix.lastIndexOf("@");
	const authorityAt = withoutPrefix.indexOf("@");
	return refAt > authorityAt ? withoutPrefix.slice(0, refAt) : withoutPrefix;
}

function packageIdentity(entry, baseDir) {
	const source = packageSource(entry);
	if (source.startsWith("npm:")) return `npm:${npmIdentity(source)}`;
	if (/^(?:git:|https?:|ssh:|git:\/\/)/.test(source)) return `git:${gitIdentity(source)}`;
	return `local:${resolve(baseDir, source)}`;
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
	const eagleeyeRoot = firstExisting(
		[env.EAGLEEYE_AI_DEV_ROOT, resolve(piTsienRoot, "..", "eagleeye-ai-dev")],
		"${EAGLEEYE_AI_DEV_ROOT}; set EAGLEEYE_AI_DEV_ROOT or clone eagleeye-ai-dev beside pi-tsien-extension",
	);
	return {
		piTsienRoot,
		eagleeyeRoot,
		agentDir,
		home: env.HOME ? resolve(env.HOME) : homedir(),
	};
}

function expandString(value, context) {
	return value
		.replaceAll("${PI_TSIEN_EXTENSION_ROOT}", context.piTsienRoot)
		.replaceAll("${EAGLEEYE_AI_DEV_ROOT}", context.eagleeyeRoot)
		.replaceAll("${PI_AGENT_DIR}", context.agentDir)
		.replaceAll("${HOME}", context.home);
}

function expandPackage(entry, context) {
	if (typeof entry === "string") return expandString(entry, context);
	if (!entry || typeof entry !== "object" || typeof entry.source !== "string") {
		throw new Error(`Invalid package entry: ${JSON.stringify(entry)}`);
	}
	if (!Array.isArray(entry.extensions)) {
		throw new Error(`Package must declare an extensions allowlist: ${entry.source}`);
	}
	for (const pattern of entry.extensions) {
		if (typeof pattern !== "string" || !pattern.startsWith("+") || pattern.length === 1) {
			throw new Error(`Extension allowlist entries must use +relative/path: ${String(pattern)}`);
		}
	}
	return { ...entry, source: expandString(entry.source, context) };
}

function assertUniquePackages(packages, baseDir) {
	const seen = new Set();
	for (const entry of packages) {
		const identity = packageIdentity(entry, baseDir);
		if (seen.has(identity)) throw new Error(`Duplicate package identity: ${identity}`);
		seen.add(identity);
	}
}

function normalizeDirectExtensions(entries, context) {
	const seen = new Set();
	return entries.map((entry) => {
		if (typeof entry !== "string") throw new Error(`Direct extension path must be a string: ${JSON.stringify(entry)}`);
		const expanded = expandString(entry, context);
		if (!isAbsolute(expanded)) throw new Error(`Direct extension must resolve to an absolute path: ${entry}`);
		const absolute = resolve(expanded);
		if (!EXTENSION_FILE.test(absolute)) throw new Error(`Unsupported extension file: ${entry}`);
		if (!existsSync(absolute)) throw new Error(`Direct extension does not exist: ${absolute}`);
		if (seen.has(absolute)) throw new Error(`Duplicate direct extension: ${absolute}`);
		seen.add(absolute);
		return absolute;
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
	if (!Array.isArray(config.packages) || !Array.isArray(config.extensions)) {
		throw new Error("Config must contain packages and extensions arrays");
	}
	if (
		config.prune?.packages !== true ||
		config.prune?.extensions !== true ||
		config.prune?.autoDiscoveredExtensions !== "quarantine"
	) {
		throw new Error("Strict management requires package/direct-extension pruning and auto-extension quarantine");
	}

	const context = createContext({ repoRoot: absoluteRepoRoot, agentDir: absoluteAgentDir, env });
	const desiredPackages = config.packages.map((entry) => expandPackage(entry, context));
	const desiredExtensions = normalizeDirectExtensions(config.extensions, context);
	assertUniquePackages(desiredPackages, absoluteAgentDir);
	for (const entry of desiredPackages) {
		const source = packageSource(entry);
		if (isAbsolute(source) && !existsSync(source)) throw new Error(`Local package does not exist: ${source}`);
	}

	const settingsPath = join(absoluteAgentDir, "settings.json");
	const settings = existsSync(settingsPath) ? readJson(settingsPath) : {};
	const currentPackages = Array.isArray(settings.packages) ? settings.packages : [];
	const currentExtensions = Array.isArray(settings.extensions) ? settings.extensions : [];
	assertUniquePackages(currentPackages, absoluteAgentDir);

	const currentByIdentity = new Map(currentPackages.map((entry) => [packageIdentity(entry, absoluteAgentDir), entry]));
	const desiredByIdentity = new Map(desiredPackages.map((entry) => [packageIdentity(entry, absoluteAgentDir), entry]));
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

	const normalizedCurrentExtensions = currentExtensions.map((entry) => resolve(absoluteAgentDir, entry));
	const currentExtensionSet = new Set(normalizedCurrentExtensions);
	const desiredExtensionSet = new Set(desiredExtensions);
	const extensionAdds = desiredExtensions.filter((entry) => !currentExtensionSet.has(entry));
	const extensionRemovals = currentExtensions.filter(
		(_entry, index) => !desiredExtensionSet.has(normalizedCurrentExtensions[index]),
	);
	const extensionConfigChanged = !sameEntry(currentExtensions, desiredExtensions);

	const autoExtensionsDir = join(absoluteAgentDir, "extensions");
	const allowedAutoPaths = new Set(desiredExtensions);
	const autoExtensionRemovals = existsSync(autoExtensionsDir)
		? readdirSync(autoExtensionsDir, { withFileTypes: true })
			.filter((entry) => entry.isFile() && EXTENSION_FILE.test(entry.name))
			.map((entry) => ({ name: entry.name, path: join(autoExtensionsDir, entry.name) }))
			.filter((entry) => !allowedAutoPaths.has(resolve(entry.path)))
			.sort((left, right) => left.name.localeCompare(right.name))
		: [];

	const packageConfigChanged = !sameEntry(currentPackages, desiredPackages);
	return {
		configPath: absoluteConfigPath,
		agentDir: absoluteAgentDir,
		settingsPath,
		settings,
		desiredPackages,
		desiredExtensions,
		packageAdds,
		packageUpdates,
		packageRemovals,
		extensionAdds,
		extensionRemovals,
		autoExtensionRemovals,
		changed: packageConfigChanged || extensionConfigChanged || autoExtensionRemovals.length > 0,
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
		extensions: plan.desiredExtensions,
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

function describeEntry(entry) {
	return packageSource(entry);
}

export function formatSyncPlan(plan) {
	const lines = [plan.changed ? "Pi extension sync changes:" : "Pi extensions already match the user config."];
	for (const entry of plan.packageAdds) lines.push(`  package + ${describeEntry(entry)}`);
	for (const update of plan.packageUpdates) {
		lines.push(`  package ~ filters/source: ${describeEntry(update.to)}`);
	}
	for (const entry of plan.packageRemovals) lines.push(`  package - ${describeEntry(entry)}`);
	for (const entry of plan.extensionAdds) lines.push(`  extension + ${entry}`);
	for (const entry of plan.extensionRemovals) lines.push(`  extension - ${entry}`);
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
	console.log(`Usage: node scripts/pi-extension-sync.mjs [options]\n\nOptions:\n  --apply              Apply the user config (default is dry-run)\n  --config <path>      Config path (default: ~/.pi/agent/extensions.config.json)\n  --agent-dir <path>   Pi agent directory\n  -h, --help           Show this help`);
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
			console.log("Reload or restart Pi to load the user-selected extensions.");
		}
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) main();
