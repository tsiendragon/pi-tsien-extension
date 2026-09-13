import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const DEFAULT_SYSTEM_PROMPT_FILE = join(homedir(), ".pi", "agent", "DefaultSystemPrompt.md");
export const TOOLS_SECTION_MARKER = "\n\nAvailable tools:\n";

export async function readDefaultSystemPrompt(): Promise<string> {
  return readFile(DEFAULT_SYSTEM_PROMPT_FILE, "utf8");
}

export function replaceSystemPromptIntro(systemPrompt: string, customIntro: string): string | undefined {
  const markerIndex = systemPrompt.indexOf(TOOLS_SECTION_MARKER);
  if (markerIndex === -1) return undefined;

  return `${customIntro.trimEnd()}${systemPrompt.slice(markerIndex)}`;
}

export const GUIDELINES_MARKER = "\nGuidelines:\n";

export const ACTION_GUIDELINES = [
  "- State a concrete plan to the user before implementing, then execute to completion.",
  "- Plan first in a hierarchical, small doc set (PLAN.md, STATUS.md, TODO.md, ISSUES.md, PROGRESS.md, README.md, AGENTS.md, DECISION.md, HANDOFF.md); read only the needed file.",
  "- Write structured, modular code.",
  "- Reply in plain, easy-to-understand language (Chinese by default).",
] as const;

export function adjustGuidelinesSection(systemPrompt: string): string {
  let out = systemPrompt;
  out = out.replace(/- Be concise in your responses\n?/g, "");
  out = out.replace(/- Show file paths clearly when working with files\n?/g, "");
  const markerIndex = out.indexOf(GUIDELINES_MARKER);
  if (markerIndex === -1) return out;
  const insertAt = markerIndex + GUIDELINES_MARKER.length;
  return out.slice(0, insertAt) + ACTION_GUIDELINES.join("\n") + "\n" + out.slice(insertAt);
}

export default function defaultSystemPromptExtension(pi: ExtensionAPI): void {
  let notifiedReadError = false;
  let notifiedMissingToolsSection = false;

  pi.on("before_agent_start", async (event, ctx) => {
    let customIntro: string;
    try {
      customIntro = await readDefaultSystemPrompt();
    } catch (error) {
      if (!notifiedReadError && ctx.hasUI) {
        notifiedReadError = true;
        ctx.ui.notify(`无法读取自定义系统提示：${DEFAULT_SYSTEM_PROMPT_FILE}`, "warning");
      }
      return;
    }

    if (customIntro.trim().length === 0) return;

    const introReplaced = replaceSystemPromptIntro(event.systemPrompt, customIntro);
    if (introReplaced === undefined) {
      if (!notifiedMissingToolsSection && ctx.hasUI) {
        notifiedMissingToolsSection = true;
        ctx.ui.notify("未找到 Available tools 段，保留 Pi 原系统提示。", "warning");
      }
      return;
    }

    return { systemPrompt: adjustGuidelinesSection(introReplaced) };
  });
}
