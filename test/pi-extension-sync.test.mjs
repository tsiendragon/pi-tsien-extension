import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { applySyncPlan, buildSyncPlan } from "../scripts/pi-extension-sync.mjs";

function writeJson(path, value) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

test("user config filters package extensions and quarantines unmanaged auto extensions", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-extension-sync-"));
	const repoRoot = join(root, "pi-tsien-extension");
	const eagleeyeRoot = join(root, "eagleeye-ai-dev");
	const agentDir = join(root, ".pi", "agent");
	const configPath = join(agentDir, "extensions.config.json");
	const directExtension = join(root, "direct.ts");
	mkdirSync(repoRoot, { recursive: true });
	mkdirSync(eagleeyeRoot, { recursive: true });
	mkdirSync(join(agentDir, "extensions"), { recursive: true });
	writeFileSync(join(repoRoot, "package.json"), "{}");
	writeFileSync(directExtension, "export default {};");
	writeFileSync(join(agentDir, "extensions", "legacy.ts"), "legacy");
	writeJson(join(agentDir, "settings.json"), {
		theme: "dark",
		packages: ["npm:keep", "npm:remove"],
		extensions: ["old.ts"],
	});
	writeJson(configPath, {
		version: 1,
		packages: [
			{ source: "npm:keep", extensions: ["+index.ts"] },
			{ source: "${PI_TSIEN_EXTENSION_ROOT}", extensions: ["+extensions/goal.ts"] },
		],
		extensions: [directExtension],
		prune: { packages: true, extensions: true, autoDiscoveredExtensions: "quarantine" },
	});

	const plan = buildSyncPlan({
		configPath,
		agentDir,
		repoRoot,
		env: { HOME: root, EAGLEEYE_AI_DEV_ROOT: eagleeyeRoot },
	});
	assert.deepEqual(plan.packageRemovals, ["npm:remove"]);
	assert.equal(plan.packageUpdates.length, 1);
	assert.equal(plan.packageAdds.length, 1);
	assert.deepEqual(plan.extensionAdds, [directExtension]);
	assert.deepEqual(plan.extensionRemovals, ["old.ts"]);
	assert.deepEqual(plan.autoExtensionRemovals.map((entry) => entry.name), ["legacy.ts"]);

	const result = applySyncPlan(plan, { now: new Date("2026-08-22T00:00:00.000Z") });
	const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
	assert.equal(settings.theme, "dark");
	assert.deepEqual(settings.packages, [
		{ source: "npm:keep", extensions: ["+index.ts"] },
		{ source: repoRoot, extensions: ["+extensions/goal.ts"] },
	]);
	assert.deepEqual(settings.extensions, [directExtension]);
	assert.equal(existsSync(join(agentDir, "extensions", "legacy.ts")), false);
	assert.equal(existsSync(join(result.quarantineDir, "legacy.ts")), true);
	assert.equal(existsSync(join(result.backupDir, "settings.json")), true);
});

test("user config requires explicit package extension allowlists", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-extension-sync-invalid-"));
	const repoRoot = join(root, "repo");
	const eagleeyeRoot = join(root, "eagleeye-ai-dev");
	const agentDir = join(root, "agent");
	mkdirSync(repoRoot, { recursive: true });
	mkdirSync(eagleeyeRoot, { recursive: true });
	const configPath = join(agentDir, "extensions.config.json");
	writeJson(configPath, {
		version: 1,
		packages: [{ source: "npm:unbounded" }],
		extensions: [],
		prune: { packages: true, extensions: true, autoDiscoveredExtensions: "quarantine" },
	});
	assert.throws(
		() => buildSyncPlan({ configPath, agentDir, repoRoot, env: { HOME: root, EAGLEEYE_AI_DEV_ROOT: eagleeyeRoot } }),
		/must declare an extensions allowlist/,
	);
});
