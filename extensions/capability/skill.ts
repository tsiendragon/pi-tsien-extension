/**
 * Dynamic skill generation for the capability layer.
 *
 * `resources_discover` returns skill directories, and Pi puts each skill's
 * description into the system prompt. That is the adoption channel: without it,
 * the agent only learns a capability exists if it happens to call
 * `capability_ls`. The generated file lands outside the repository, under
 * `~/.pi/agent/capability/skills/`.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { Capability } from "./core.ts";

const SKILL_DIR_NAME = "capability";

function agentDir(): string {
	return process.env.PI_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

export function capabilitySkillDir(): string {
	return join(agentDir(), "capability", "skills", SKILL_DIR_NAME);
}

export async function writeCapabilitySkill(capabilities: readonly Capability[]): Promise<string> {
	const dir = capabilitySkillDir();
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, "SKILL.md"), renderSkill(capabilities), "utf8");
	return dir;
}

function renderSkill(capabilities: readonly Capability[]): string {
	const entries = capabilities.map((capability) => {
		const lines = [
			`- **${capability.name}** (${capability.layer}, ${capability.sensitivity}, ${capability.status}) — ${capability.description ?? ""}`,
		];
		if (capability.when) lines.push(`  - 何时用：${capability.when}`);
		const steps = capability.steps.map((step) => `${step.id}:${step.kind}`).join(", ");
		if (steps) lines.push(`  - 步骤：${steps}`);
		return lines.join("\n");
	});

	const description = [
		"可复用、可验证的执行单元：把重复出现的任务从整轮对话中摘出来，在沙箱里按固定契约执行并留痕。",
		"当同一个任务第二次出现、需要固定的输出结构、或需要成本与结果审计时先看这里。",
		"触发词：重复任务、标准化输出、日志分诊、结构化抽取、留痕。",
	].join("");

	return `---
name: capability
description: '${description}'
---

# Capability

先用 \`capability_ls\` 列出可用能力，再用 \`capability_run\` 执行，不要手工重做已经有的能力。

## 何时使用

- 同一个任务反复出现——第二次做时先查这里，而不是重新推一遍
- 需要固定的输出结构（下游要按 schema 消费）
- 需要留痕（每次调用写入 ledger，含 token、成本、耗时）

## 当前能力

${entries.join("\n")}

## 约束

- 代码在沙箱内执行：无网络，不能读写该能力目录以外的路径
- 模型调用由宿主代理，密钥不进入沙箱
- \`status\` 为 \`draft\` 的能力尚未人工晋升，依赖前先确认输出合理
`;
}