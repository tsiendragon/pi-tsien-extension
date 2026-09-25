/**
 * capability — a layer for reusable, verifiable execution units.
 *
 * A capability is a contract plus two ways to satisfy it: a natural-language
 * skill and a code implementation. The code path runs in a `node --permission`
 * sandbox that has no filesystem or network access outside its own directory, so
 * every model call goes through the host proxy (`capability/llm-proxy.ts`), which
 * owns the API key, the prompt template, the cache and the cost accounting.
 *
 * Tools:
 *   capability_ls    list capabilities (name, layer, status, sensitivity, version)
 *   capability_run   run a capability's code implementation
 *
 * Business capabilities are supplied through `PI_CAPABILITY_ROOTS` (a
 * `:`-separated list of directories) and override generic ones on name collision.
 */

import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { Capability } from "./capability/core.ts";
import { loadCapabilityConfig, agentDir } from "./capability/config.ts";
import { appendLedger } from "./capability/ledger.ts";
import { createLlmProxy, type LlmUse } from "./capability/llm-proxy.ts";
import { discoverCapabilities, findCapability, type CapabilityRoot } from "./capability/registry.ts";
import { setCapabilityStatus } from "./capability/promote.ts";
import { runCapability } from "./capability/sandbox/runner.ts";
import { writeCapabilitySkill } from "./capability/skill.ts";

const EXTENSION_DIR = fileURLToPath(new URL(".", import.meta.url));

/**
 * Capability roots, lowest precedence first.
 *
 *  L1  built into this extension
 *  L2  `<cwd>/.pi/capabilities`      — any repo that ships this directory works with no config
 *  L2  `~/.pi/agent/capability/capabilities`
 *  L2  `capability.json` `roots`     — point at any repository or directory
 *  L2  `PI_CAPABILITY_ROOTS`         — test / one-off override
 *
 * Later roots win on name collision, so a business capability overrides a
 * generic one. Nothing here assumes any particular repository exists.
 */
function capabilityRoots(cwd: string): CapabilityRoot[] {
	const roots: CapabilityRoot[] = [
		{ dir: join(EXTENSION_DIR, "capability", "capabilities"), layer: "L1" },
		{ dir: join(cwd, ".pi", "capabilities"), layer: "L2" },
		{ dir: join(agentDir(), "capability", "capabilities"), layer: "L2" },
	];
	const extra = [...(loadCapabilityConfig().roots ?? [])];
	const fromEnv = process.env.PI_CAPABILITY_ROOTS?.trim();
	if (fromEnv) {
		const separator = process.platform === "win32" ? ";" : ":";
		extra.push(...fromEnv.split(separator));
	}
	for (const entry of extra) {
		const dir = entry.trim();
		if (dir) roots.push({ dir, layer: "L2" });
	}
	return roots;
}

export default function capabilityExtension(pi: ExtensionAPI): void {
	const cache = new Map<string, unknown>();
	let loadedFor: string | undefined;
	let loaded: Promise<Capability[]> | undefined;
	const ensure = (cwd: string = process.cwd()): Promise<Capability[]> => {
		if (loadedFor !== cwd) {
			loadedFor = cwd;
			loaded = discoverCapabilities(capabilityRoots(cwd));
		}
		return loaded!;
	};
	const invalidate = (): void => {
		loadedFor = undefined;
		loaded = undefined;
	};

	// Adoption channel: publish one skill whose description lands in the system
	// prompt, so the agent knows the capabilities exist without being told.
	pi.on("resources_discover", async (event) => {
		const capabilities = await ensure(event.cwd);
		if (capabilities.length === 0) return {};
		const dir = await writeCapabilitySkill(capabilities);
		return { skillPaths: [dir] };
	});

	pi.registerCommand("capability", {
		description: "管理能力：/capability [ls | promote <name> | demote <name>]",
		handler: async (args, ctx) => {
			const usage = "用法：/capability [ls | promote <name> | demote <name>]";
			const [sub, name] = args.trim().split(/\s+/);

			if (!sub || sub === "ls") {
				const capabilities = await ensure();
				const lines = capabilities.map(
					(capability) =>
						`${capability.name} [${capability.layer}] ${capability.status} ${capability.sensitivity} v${capability.version}`,
				);
				ctx.ui.notify(lines.length > 0 ? lines.join("\n") : "没有发现能力", "info");
				return;
			}

			if (sub !== "promote" && sub !== "demote") {
				ctx.ui.notify(usage, "warning");
				return;
			}

			const capability = findCapability(await ensure(), name ?? "");
			if (!capability) {
				ctx.ui.notify(`未找到能力：${name ?? ""}`, "warning");
				return;
			}

			const status = sub === "promote" ? "trusted" : "draft";
			try {
				await setCapabilityStatus(capability.dir, status);
			} catch (error) {
				ctx.ui.notify(`更新失败：${error instanceof Error ? error.message : String(error)}`, "error");
				return;
			}
			// Drop the cached discovery so the next call sees the new status.
			invalidate();
			ctx.ui.notify(`${capability.name} → ${status}（下次 capability_ls 生效）`, "info");
		},
	});

	pi.registerTool({
		name: "capability_ls",
		label: "List Capabilities",
		description:
			"List the reusable capabilities available in this workspace, with layer, status, sensitivity, version and steps.",
		promptSnippet:
			"Use capability_ls to see which reusable capabilities exist before redoing the work by hand.",
		parameters: Type.Object({}),
		async execute(): Promise<AgentToolResult<unknown>> {
			const capabilities = await ensure();
			const rows = capabilities.map((capability) => ({
				name: capability.name,
				layer: capability.layer,
				status: capability.status,
				sensitivity: capability.sensitivity,
				version: capability.version,
				steps: capability.steps.map((step) => `${step.id}:${step.kind}`).join(", "),
				description: capability.description,
				when: capability.when,
			}));
			return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }], details: rows };
		},
	});

	pi.registerTool({
		name: "capability_run",
		label: "Run Capability",
		description:
			"Run a capability's code implementation inside the sandbox. The input must match the capability contract; model calls are proxied by the host.",
		promptSnippet:
			"Use capability_run to execute a reusable capability instead of redoing the same work by hand.",
		parameters: Type.Object({
			name: Type.String({ description: "Capability name, as shown by capability_ls" }),
			input: Type.Any({ description: "JSON input matching the capability contract" }),
		}),
		async execute(
			_toolCallId,
			params,
			_signal,
			_onUpdate,
			ctx: ExtensionContext,
		): Promise<AgentToolResult<unknown>> {
			const capabilities = await ensure();
			const capability = findCapability(capabilities, String(params.name));
			if (!capability) throw new Error(`unknown capability: ${params.name}`);

			const uses: LlmUse[] = [];
			const llm = createLlmProxy({
				registry: ctx.modelRegistry,
				capability,
				cache,
				onUse: (use) => uses.push(use),
			});

			const limits = capability.limits ?? {};
			const result = await runCapability({
				capabilityDir: capability.dir,
				input: params.input,
				llm,
				...(limits.timeoutMs !== undefined ? { timeoutMs: limits.timeoutMs } : {}),
				...(limits.maxOutputBytes !== undefined ? { maxOutputBytes: limits.maxOutputBytes } : {}),
				...(limits.maxLlmCalls !== undefined ? { maxLlmCalls: limits.maxLlmCalls } : {}),
			});

			await appendLedger({
				ts: new Date().toISOString(),
				capability: capability.name,
				impl: "code",
				ok: result.ok,
				durationMs: result.durationMs,
				llmCalls: result.llmCalls,
				cacheHits: result.cacheHits,
				tokens: result.tokens,
				costUsd: result.costUsd,
				...(result.error !== undefined ? { error: result.error } : {}),
				...(ctx.sessionManager?.getSessionId?.() !== undefined
					? { sessionId: ctx.sessionManager.getSessionId() }
					: {}),
			});

			return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
		},
	});
}