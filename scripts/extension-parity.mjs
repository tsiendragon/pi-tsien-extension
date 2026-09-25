#!/usr/bin/env node
/**
 * Extension parity harness.
 *
 * Loads every extension listed in an `extensions.config.json` through a recording stub of the
 * pi extension API, and writes a JSON fingerprint per entry (registered tools / commands /
 * event handlers / call signatures). Run it once to capture a baseline, then again after a
 * refactor (e.g. moving `extensions/x.ts` into `packages/pi-tsien-x`) and compare:
 *
 *   node --import tsx scripts/extension-parity.mjs --config config/extensions.standalone.json --out /tmp/before.json
 *   node --import tsx scripts/extension-parity.mjs --config /tmp/new.config.json --baseline /tmp/before.json
 *
 * Exit code is 1 when anything differs, so it can gate a cleanup commit.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const REPO_ROOT = resolve(import.meta.dirname, "..");

function parseArgs(argv) {
	const args = { config: null, out: null, baseline: null, label: null, agentDir: null };
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "--config") args.config = argv[++i];
		else if (arg === "--out") args.out = argv[++i];
		else if (arg === "--baseline") args.baseline = argv[++i];
		else if (arg === "--label") args.label = argv[++i];
		else if (arg === "--agent-dir") args.agentDir = argv[++i];
		else throw new Error(`unknown argument: ${arg}`);
	}
	if (!args.config) throw new Error("--config <extensions.config.json> is required");
	return args;
}

function expandVars(input) {
	return input
		.replace(/\$\{PI_TSIEN_EXTENSION_ROOT\}/g, process.env.PI_TSIEN_EXTENSION_ROOT ?? REPO_ROOT)
		.replace(/\$\{EAGLEEYE_AI_DEV_ROOT\}/g, process.env.EAGLEEYE_AI_DEV_ROOT ?? "\u0000EAGLEEYE_AI_DEV_ROOT\u0000");
}

/** Compact, stable fingerprint of a value. Keeps key names (depth <= 2) but never dumps payloads. */
function fingerprint(value, depth = 0) {
	if (value === null) return "null";
	const type = typeof value;
	if (type === "string") {
		const short = value.length > 32 ? `${value.slice(0, 32)}…` : value;
		return JSON.stringify(short);
	}
	if (type === "number" || type === "boolean" || type === "bigint") return String(value);
	if (type === "function") return "fn";
	if (type === "undefined") return "undefined";
	if (Array.isArray(value)) {
		if (depth >= 3) return `[${value.length}]`;
		const head = value.slice(0, 4).map((item) => fingerprint(item, depth + 1));
		return `[${head.join(",")}${value.length > 4 ? ",…" : ""}]`;
	}
	if (type === "object") {
		const keys = Object.keys(value).sort();
		if (depth >= 3) return `{${keys.length}}`;
		const head = keys.slice(0, 12).map((key) => `${key}:${fingerprint(value[key], depth + 1)}`);
		return `{${head.join(",")}${keys.length > 12 ? ",…" : ""}}`;
	}
	return type;
}

/** Chainable recording stub: `pi.ui.notify("x")` records `ui.notify` with its argument shape. */
function createRecorder(calls) {
	const proxyFor = (prefix) =>
		new Proxy(function () {}, {
			get(_target, property) {
				if (typeof property === "symbol" || property === "then" || property === "inspect") return undefined;
				const path = prefix ? `${prefix}.${property}` : String(property);
				return (...args) => {
					calls.push([path, args.map((arg) => fingerprint(arg))]);
					return proxyFor(path);
				};
			},
			apply(_target, _this, args) {
				calls.push([prefix, args.map((arg) => fingerprint(arg))]);
				return proxyFor(prefix);
			},
			has: () => true,
		});
	return proxyFor("");
}

function summarize(calls) {
	const tools = [];
	const commands = [];
	const handlers = new Map();
	for (const [path, args] of calls) {
		const first = args[0] ?? "";
		if (path === "registerTool" || path === "registerTool.renderResult") {
			const match = /name:(".*?")/.exec(first);
			if (match) tools.push(JSON.parse(match[1]));
		} else if (path === "registerCommand") {
			commands.push(first.replace(/^"|"$/g, ""));
		} else if (path === "on" || path === "registerEventHandler") {
			const event = first.replace(/^"|"$/g, "");
			handlers.set(event, (handlers.get(event) ?? 0) + 1);
		}
	}
	return {
		tools: tools.sort(),
		commands: commands.sort(),
		handlers: Object.fromEntries([...handlers].sort(([a], [b]) => a.localeCompare(b))),
	};
}

async function loadEntry(entry, agentDir) {
	const calls = [];
	const pi = createRecorder(calls);
	try {
		await import(pathToFileURL(entry.absPath).href);
		const mod = await import(pathToFileURL(entry.absPath).href);
		const factory = mod.default ?? mod.extension ?? mod.register;
		if (typeof factory !== "function") throw new Error("module has no default export function");
		await factory(pi);
		return { status: "ok", calls, ...summarize(calls) };
	} catch (error) {
		return { status: "error", error: String(error?.message ?? error), calls, ...summarize(calls) };
	} finally {
		void agentDir;
	}
}

const args = parseArgs(process.argv.slice(2));
const agentDir = args.agentDir ?? mkdtempSync(join(tmpdir(), "extension-parity-agent-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

const configPath = resolve(args.config);
const config = JSON.parse(readFileSync(configPath, "utf8"));
const packagesById = new Map(config.packages.map((entry) => [entry.id ?? entry.source, expandVars(entry.source)]));

const entries = [];
let index = 0;
for (const item of config.loadOrder) {
	index += 1;
	const pkgId = item.package ?? [...packagesById.keys()][0];
	const base = packagesById.get(pkgId);
	if (!base) throw new Error(`loadOrder references unknown package: ${pkgId}`);
	const absPath = resolve(base, item.path);
	const loaded = await loadEntry({ absPath }, agentDir);
	entries.push({
		index,
		package: pkgId,
		path: item.path,
		status: loaded.status,
		...(loaded.error ? { error: loaded.error } : {}),
		tools: loaded.tools,
		commands: loaded.commands,
		handlers: loaded.handlers,
		callCount: loaded.calls.length,
		calls: loaded.calls.filter(([path]) => !path.startsWith("ui.") && path !== "getSetting"),
	});
}

const snapshot = {
	label: args.label ?? null,
	config: configPath,
	entryCount: entries.length,
	entries,
};

if (args.out) {
	writeFileSync(args.out, `${JSON.stringify(snapshot, null, 2)}\n`);
	console.log(`wrote ${args.out} (${entries.length} entries, ${entries.filter((e) => e.status === "error").length} errors)`);
}

if (args.baseline) {
	const baseline = JSON.parse(readFileSync(resolve(args.baseline), "utf8"));
	const diffs = [];
	const byIndex = new Map(baseline.entries.map((entry) => [entry.index, entry]));
	if (baseline.entryCount !== snapshot.entryCount) {
		diffs.push(`entry count: ${baseline.entryCount} -> ${snapshot.entryCount}`);
	}
	for (const entry of entries) {
		const before = byIndex.get(entry.index);
		if (!before) {
			diffs.push(`#${entry.index} ${entry.path}: not present in baseline`);
			continue;
		}
		for (const key of ["status", "tools", "commands", "handlers", "callCount", "calls"]) {
			const a = JSON.stringify(before[key]);
			const b = JSON.stringify(entry[key]);
			if (a !== b) diffs.push(`#${entry.index} ${entry.path} (${entry.package}): ${key} changed\n    before: ${a}\n    after:  ${b}`);
		}
	}
	if (diffs.length === 0) {
		console.log(`parity OK: ${entries.length}/${entries.length} entries identical to ${args.baseline}`);
	} else {
		console.log(`parity FAILED (${diffs.length} difference(s) vs ${args.baseline}):`);
		for (const diff of diffs) console.log(`  - ${diff}`);
		process.exitCode = 1;
	}
}