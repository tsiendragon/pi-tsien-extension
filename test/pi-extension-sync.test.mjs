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

test("sync preserves configured package install order and extension load order", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-extension-sync-"));
	const repoRoot = join(root, "pi-tsien-extension");
	const marketplaceRoot = join(root, "pi-marketplace");
	const agentDir = join(root, ".pi", "agent");
	const configPath = join(agentDir, "extensions.config.json");
	const directExtension = join(root, "direct.ts");
	mkdirSync(join(repoRoot, "extensions"), { recursive: true });
	mkdirSync(marketplaceRoot, { recursive: true });
	mkdirSync(join(agentDir, "extensions"), { recursive: true });
	writeFileSync(join(repoRoot, "extensions", "goal.ts"), "export default {};");
	writeFileSync(directExtension, "export default {};");
	writeFileSync(join(agentDir, "extensions", "legacy.ts"), "legacy");
	writeJson(join(agentDir, "settings.json"), {
		theme: "dark",
		packages: ["npm:remove", "npm:keep"],
		extensions: ["old.ts"],
	});
	writeJson(configPath, {
		version: 1,
		packages: [
			{ id: "keep", source: "npm:keep" },
			{ id: "tsien", source: "${PI_TSIEN_EXTENSION_ROOT}" },
		],
		loadOrder: [
			{ package: "tsien", path: "extensions/goal.ts" },
			{ package: "keep", path: "index.ts" },
			{ path: directExtension },
		],
		prune: { packages: true, extensions: true, autoDiscoveredExtensions: "quarantine" },
	});

	const plan = buildSyncPlan({
		configPath,
		agentDir,
		repoRoot,
		env: { HOME: root, PI_MARKETPLACE_ROOT: marketplaceRoot },
	});
	assert.deepEqual(plan.packageRemovals, ["npm:remove"]);
	assert.equal(plan.packageUpdates.length, 1);
	assert.equal(plan.packageAdds.length, 1);
	assert.deepEqual(plan.desiredPackages, [
		{ source: "npm:keep", autoload: false },
		{ source: repoRoot, autoload: false },
	]);
	assert.deepEqual(plan.desiredExtensions, [
		join(repoRoot, "extensions", "goal.ts"),
		join(agentDir, "npm", "node_modules", "keep", "index.ts"),
		directExtension,
	]);
	assert.deepEqual(plan.autoExtensionRemovals.map((entry) => entry.name), ["legacy.ts"]);

	const result = applySyncPlan(plan, { now: new Date("2026-08-22T00:00:00.000Z") });
	const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
	assert.equal(settings.theme, "dark");
	assert.deepEqual(settings.packages, plan.desiredPackages);
	assert.deepEqual(settings.extensions, plan.desiredExtensions);
	assert.equal(existsSync(join(agentDir, "extensions", "legacy.ts")), false);
	assert.equal(existsSync(join(result.quarantineDir, "legacy.ts")), true);
	assert.equal(existsSync(join(result.backupDir, "settings.json")), true);
});

test("sync keeps Pi override entries instead of pruning user disable flags", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-extension-sync-override-"));
	const repoRoot = join(root, "pi-tsien-extension");
	const agentDir = join(root, ".pi", "agent");
	const configPath = join(agentDir, "extensions.config.json");
	mkdirSync(join(repoRoot, "extensions"), { recursive: true });
	writeFileSync(join(repoRoot, "extensions", "sidebar.ts"), "export default {};");
	writeFileSync(join(repoRoot, "extensions", "goal.ts"), "export default {};");
	const sidebarPath = join(repoRoot, "extensions", "sidebar.ts");
	const goalPath = join(repoRoot, "extensions", "goal.ts");
	writeJson(join(agentDir, "settings.json"), {
		packages: [{ source: repoRoot, autoload: false }],
		// A dashboard/Pi disable flag (`-`) plus a force-enable flag (`+`) on a plain path.
		extensions: [goalPath, `-${sidebarPath}`, `+${goalPath}`],
	});
	writeJson(configPath, {
		version: 1,
		packages: [{ id: "tsien", source: "${PI_TSIEN_EXTENSION_ROOT}" }],
		loadOrder: [
			{ package: "tsien", path: "extensions/sidebar.ts" },
			{ package: "tsien", path: "extensions/goal.ts" },
		],
		prune: { packages: true, extensions: true, autoDiscoveredExtensions: "quarantine" },
	});

	const plan = buildSyncPlan({ configPath, agentDir, repoRoot, env: { HOME: root } });
	// The disabled extension must not come back as a plain entry.
	assert.deepEqual(plan.desiredExtensions, [goalPath]);
	assert.deepEqual(plan.preservedOverrides, [`-${sidebarPath}`, `+${goalPath}`]);
	assert.deepEqual(plan.extensionAdds, []);
	assert.deepEqual(plan.extensionRemovals, []);

	applySyncPlan(plan, { now: new Date("2026-08-22T00:00:00.000Z") });
	const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
	assert.deepEqual(settings.extensions, [goalPath, `-${sidebarPath}`, `+${goalPath}`]);

	// Second run: the result is stable, so nothing is reported as changed.
	const second = buildSyncPlan({ configPath, agentDir, repoRoot, env: { HOME: root } });
	assert.equal(second.loadOrderChanged, false);
	assert.deepEqual(second.extensionAdds, []);
});

test("standalone config syncs without a pi-marketplace checkout", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-extension-sync-standalone-"));
	const repoRoot = join(root, "pi-tsien-extension");
	const agentDir = join(root, ".pi", "agent");
	mkdirSync(join(repoRoot, "extensions"), { recursive: true });
	writeFileSync(join(repoRoot, "extensions", "goal.ts"), "export default {};");
	const configPath = join(agentDir, "extensions.config.json");
	writeJson(configPath, {
		version: 1,
		packages: [{ id: "tsien", source: "${PI_TSIEN_EXTENSION_ROOT}" }],
		loadOrder: [{ package: "tsien", path: "extensions/goal.ts" }],
		prune: { packages: true, extensions: true, autoDiscoveredExtensions: "quarantine" },
	});
	const plan = buildSyncPlan({ configPath, agentDir, repoRoot, env: { HOME: root } });
	assert.deepEqual(plan.desiredExtensions, [join(repoRoot, "extensions", "goal.ts")]);
});

test("config that references the marketplace still requires a pi-marketplace checkout", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-extension-sync-marketplace-"));
	const repoRoot = join(root, "pi-tsien-extension");
	const agentDir = join(root, "agent");
	mkdirSync(repoRoot, { recursive: true });
	const configPath = join(agentDir, "extensions.config.json");
	writeJson(configPath, {
		version: 1,
		packages: [{ id: "security-guard", source: "${PI_MARKETPLACE_ROOT}/marketplace/packages/plugins/security-guard/current" }],
		loadOrder: [],
		prune: { packages: true, extensions: true, autoDiscoveredExtensions: "quarantine" },
	});
	assert.throws(
		() => buildSyncPlan({ configPath, agentDir, repoRoot, env: { HOME: root } }),
		/Cannot resolve \$\{PI_MARKETPLACE_ROOT\}/,
	);
});

test("sync rejects load-order paths that escape a package", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-extension-sync-invalid-"));
	const repoRoot = join(root, "repo");
	const marketplaceRoot = join(root, "pi-marketplace");
	const agentDir = join(root, "agent");
	mkdirSync(repoRoot, { recursive: true });
	mkdirSync(marketplaceRoot, { recursive: true });
	const configPath = join(agentDir, "extensions.config.json");
	writeJson(configPath, {
		version: 1,
		packages: [{ id: "repo", source: "${PI_TSIEN_EXTENSION_ROOT}" }],
		loadOrder: [{ package: "repo", path: "../escape.ts" }],
		prune: { packages: true, extensions: true, autoDiscoveredExtensions: "quarantine" },
	});
	assert.throws(
		() => buildSyncPlan({ configPath, agentDir, repoRoot, env: { HOME: root, PI_MARKETPLACE_ROOT: marketplaceRoot } }),
		/must stay inside its package/,
	);
});
