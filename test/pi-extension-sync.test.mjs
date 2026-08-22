import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { applySyncPlan, buildSyncPlan } from "../scripts/pi-extension-sync.mjs";

function writeJson(path, value) {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

test("strict sync reconciles packages and quarantines unmanaged standalone extensions", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-extension-sync-"));
	const repoRoot = join(root, "pi-tsien-extension");
	const eagleeyeRoot = join(root, "eagleeye-ai-dev");
	const agentDir = join(root, ".pi", "agent");
	const configPath = join(repoRoot, "config", "pi-extensions.json");
	const managedPackage = join(repoRoot, "package.json");
	const marketplacePackage = join(eagleeyeRoot, "plugin", "package.json");
	mkdirSync(repoRoot, { recursive: true });
	mkdirSync(dirname(marketplacePackage), { recursive: true });
	mkdirSync(join(agentDir, "extensions"), { recursive: true });
	writeFileSync(managedPackage, "{}");
	writeFileSync(marketplacePackage, "{}");
	writeFileSync(join(agentDir, "extensions", "legacy.ts"), "legacy");
	writeJson(join(agentDir, "settings.json"), {
		theme: "dark",
		packages: ["npm:keep", "npm:remove"],
	});
	writeJson(configPath, {
		version: 1,
		packages: ["npm:keep", "${REPO_ROOT}", "${EAGLEEYE_AI_DEV_ROOT}/plugin"],
		standaloneExtensions: [],
		prune: { packages: true, standaloneExtensions: "quarantine" },
	});

	const plan = buildSyncPlan({
		configPath,
		agentDir,
		repoRoot,
		env: { HOME: root, EAGLEEYE_AI_DEV_ROOT: eagleeyeRoot },
	});
	assert.deepEqual(plan.packageRemovals, ["npm:remove"]);
	assert.equal(plan.packageAdds.length, 2);
	assert.deepEqual(plan.standaloneRemovals.map((entry) => entry.name), ["legacy.ts"]);

	const result = applySyncPlan(plan, { now: new Date("2026-08-22T00:00:00.000Z") });
	const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
	assert.equal(settings.theme, "dark");
	assert.deepEqual(settings.packages, ["npm:keep", repoRoot, join(eagleeyeRoot, "plugin")]);
	assert.equal(existsSync(join(agentDir, "extensions", "legacy.ts")), false);
	assert.equal(existsSync(join(result.quarantineDir, "legacy.ts")), true);
	assert.equal(existsSync(join(result.backupDir, "settings.json")), true);
});

test("strict sync rejects unsafe standalone targets", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-extension-sync-unsafe-"));
	const repoRoot = join(root, "repo");
	const eagleeyeRoot = join(root, "eagleeye-ai-dev");
	const source = join(root, "source.ts");
	mkdirSync(join(repoRoot, "config"), { recursive: true });
	mkdirSync(eagleeyeRoot, { recursive: true });
	writeFileSync(source, "export default {};");
	const configPath = join(repoRoot, "config", "pi-extensions.json");
	writeJson(configPath, {
		version: 1,
		packages: [],
		standaloneExtensions: [{ target: "../escape.ts", source }],
		prune: { packages: true, standaloneExtensions: "quarantine" },
	});
	assert.throws(
		() => buildSyncPlan({ configPath, agentDir: join(root, "agent"), repoRoot, env: { HOME: root, EAGLEEYE_AI_DEV_ROOT: eagleeyeRoot } }),
		/Unsafe standalone extension target/,
	);
});
