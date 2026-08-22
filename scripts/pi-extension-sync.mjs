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
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
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

function discoverEagleEyeRoot(repoRoot, env) {
	const candidates = [
		env.EAGLEEYE_AI_DEV_ROOT,
		resolve(repoRoot, "..", "eagleeye-ai-dev"),
	].filter(Boolean);
	const found = candidates.find((candidate) => existsSync(candidate));
	if (!found) {
		throw new Error(
			"Cannot resolve ${EAGLEEYE_AI_DEV_ROOT}; set EAGLEEYE_AI_DEV_ROOT or clone eagleeye-ai-dev beside this repo",
		);
	}
	return resolve(found);
}

function expandString(value, context) {
	return value
		.replaceAll("${REPO_ROOT}", context.repoRoot)
		.replaceAll("${EAGLEEYE_AI_DEV_ROOT}", context.eagleeyeRoot)
		.replaceAll("${HOME}", context.home);
}

function expandPackage(entry, context) {
	if (typeof entry === "string") return expandString(entry, context);
	if (!entry || typeof entry !== "object" || typeof entry.source !== "string") {
		throw new Error(`Invalid package entry: ${JSON.stringify(entry)}`);
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

function normalizeStandalone(entries, context) {
	const seen = new Set();
	return entries.map((entry) => {
		if (!entry || typeof entry !== "object" || typeof entry.target !== "string" || typeof entry.source !== "string") {
			throw new Error(`Invalid standalone extension: ${JSON.stringify(entry)}`);
		}
		if (basename(entry.target) !== entry.target || !EXTENSION_FILE.test(entry.target)) {
			throw new Error(`Unsafe standalone extension target: ${entry.target}`);
		}
		if (seen.has(entry.target)) throw new Error(`Duplicate standalone extension target: ${entry.target}`);
		seen.add(entry.target);
		const source = expandString(entry.source, context);
		if (!isAbsolute(source)) throw new Error(`Standalone source must resolve to an absolute path: ${entry.source}`);
		if (!existsSync(source)) throw new Error(`Standalone source does not exist: ${source}`);
		return { target: entry.target, source };
	});
}

function sameEntry(left, right) {
	return JSON.stringify(left) === JSON.stringify(right);
}

function timestamp(date = new Date()) {
	return date.toISOString().replace(/[:.]/g, "-");
}

export function buildSyncPlan({
	configPath = join(DEFAULT_REPO_ROOT, "config", "pi-extensions.json"),
	agentDir = join(homedir(), ".pi", "agent"),
	repoRoot = DEFAULT_REPO_ROOT,
	env = process.env,
} = {}) {
	const absoluteConfigPath = resolve(configPath);
	const absoluteAgentDir = resolve(agentDir);
	const absoluteRepoRoot = resolve(repoRoot);
	const config = readJson(absoluteConfigPath);
	if (config.version !== 1) throw new Error(`Unsupported config version: ${String(config.version)}`);
	if (!Array.isArray(config.packages) || !Array.isArray(config.standaloneExtensions)) {
		throw new Error("Config must contain packages and standaloneExtensions arrays");
	}
	if (config.prune?.packages !== true || config.prune?.standaloneExtensions !== "quarantine") {
		throw new Error("Strict management requires prune.packages=true and prune.standaloneExtensions=quarantine");
	}

	const context = {
		repoRoot: absoluteRepoRoot,
		eagleeyeRoot: discoverEagleEyeRoot(absoluteRepoRoot, env),
		home: env.HOME ? resolve(env.HOME) : homedir(),
	};
	const desiredPackages = config.packages.map((entry) => expandPackage(entry, context));
	assertUniquePackages(desiredPackages, absoluteAgentDir);
	const desiredStandalone = normalizeStandalone(config.standaloneExtensions, context);

	for (const entry of desiredPackages) {
		const source = packageSource(entry);
		if (isAbsolute(source) && !existsSync(source)) throw new Error(`Local package does not exist: ${source}`);
	}

	const settingsPath = join(absoluteAgentDir, "settings.json");
	const settings = existsSync(settingsPath) ? readJson(settingsPath) : {};
	const currentPackages = Array.isArray(settings.packages) ? settings.packages : [];
	assertUniquePackages(currentPackages, absoluteAgentDir);

	const currentByIdentity = new Map(
		currentPackages.map((entry) => [packageIdentity(entry, absoluteAgentDir), entry]),
	);
	const desiredByIdentity = new Map(
		desiredPackages.map((entry) => [packageIdentity(entry, absoluteAgentDir), entry]),
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

	const extensionsDir = join(absoluteAgentDir, "extensions");
	const currentStandalone = existsSync(extensionsDir)
		? readdirSync(extensionsDir, { withFileTypes: true })
			.filter((entry) => entry.isFile() && EXTENSION_FILE.test(entry.name))
			.map((entry) => entry.name)
			.sort()
		: [];
	const desiredTargets = new Set(desiredStandalone.map((entry) => entry.target));
	const standaloneChanges = desiredStandalone.flatMap((entry) => {
		const targetPath = join(extensionsDir, entry.target);
		if (!existsSync(targetPath)) return [{ action: "install", ...entry, targetPath }];
		const current = readFileSync(targetPath);
		const desired = readFileSync(entry.source);
		return current.equals(desired) ? [] : [{ action: "update", ...entry, targetPath }];
	});
	const standaloneRemovals = currentStandalone
		.filter((name) => !desiredTargets.has(name))
		.map((name) => ({ name, path: join(extensionsDir, name) }));

	return {
		configPath: absoluteConfigPath,
		agentDir: absoluteAgentDir,
		settingsPath,
		settings,
		desiredPackages,
		packageAdds,
		packageUpdates,
		packageRemovals,
		standaloneChanges,
		standaloneRemovals,
		changed:
			packageAdds.length > 0 ||
			packageUpdates.length > 0 ||
			packageRemovals.length > 0 ||
			standaloneChanges.length > 0 ||
			standaloneRemovals.length > 0,
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
	atomicWriteJson(plan.settingsPath, { ...plan.settings, packages: plan.desiredPackages });

	for (const change of plan.standaloneChanges) {
		mkdirSync(dirname(change.targetPath), { recursive: true });
		if (existsSync(change.targetPath)) {
			const extensionBackupDir = join(backupDir, "extensions");
			mkdirSync(extensionBackupDir, { recursive: true });
			copyFileSync(change.targetPath, join(extensionBackupDir, change.target));
		}
		const temporary = `${change.targetPath}.tmp-${process.pid}`;
		copyFileSync(change.source, temporary);
		renameSync(temporary, change.targetPath);
	}

	if (plan.standaloneRemovals.length > 0) {
		mkdirSync(quarantineDir, { recursive: true });
		for (const removal of plan.standaloneRemovals) {
			renameSync(removal.path, join(quarantineDir, removal.name));
		}
	}
	return { changed: true, backupDir, quarantineDir: plan.standaloneRemovals.length ? quarantineDir : undefined };
}

function describeEntry(entry) {
	return packageSource(entry);
}

export function formatSyncPlan(plan) {
	const lines = [plan.changed ? "Pi extension sync changes:" : "Pi extensions already match the config."];
	for (const entry of plan.packageAdds) lines.push(`  package + ${describeEntry(entry)}`);
	for (const update of plan.packageUpdates) {
		lines.push(`  package ~ ${describeEntry(update.from)} -> ${describeEntry(update.to)}`);
	}
	for (const entry of plan.packageRemovals) lines.push(`  package - ${describeEntry(entry)}`);
	for (const change of plan.standaloneChanges) lines.push(`  standalone ${change.action === "install" ? "+" : "~"} ${change.target}`);
	for (const removal of plan.standaloneRemovals) lines.push(`  standalone - ${removal.name} -> quarantine`);
	return lines.join("\n");
}

function parseArgs(argv) {
	const options = {
		apply: false,
		configPath: join(DEFAULT_REPO_ROOT, "config", "pi-extensions.json"),
		agentDir: join(homedir(), ".pi", "agent"),
	};
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--apply") options.apply = true;
		else if (arg === "--config") options.configPath = argv[++index];
		else if (arg === "--agent-dir") options.agentDir = argv[++index];
		else if (arg === "--help" || arg === "-h") options.help = true;
		else throw new Error(`Unknown argument: ${arg}`);
	}
	if (!options.configPath || !options.agentDir) throw new Error("--config and --agent-dir require values");
	return options;
}

function printHelp() {
	console.log(`Usage: node scripts/pi-extension-sync.mjs [options]\n\nOptions:\n  --apply              Apply the plan (default is dry-run)\n  --config <path>      Manifest path\n  --agent-dir <path>   Pi agent directory\n  -h, --help           Show this help`);
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
			console.log("Restart Pi to load the reconciled extensions.");
		}
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) main();
