import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const DEFAULT_SYSTEM_PROMPT_FILE = join(homedir(), ".pi", "agent", "DefaultSystemPrompt.md");
/** Legacy (Pi < 1.6) marker; kept for backward compatibility. */
export const TOOLS_SECTION_MARKER = "\n\nAvailable tools:\n";
/** Candidate tools-section markers, highest priority first: Pi >= 1.6 XML `<tools>`, then legacy. */
export const TOOLS_SECTION_MARKERS = ["\n\n<tools>\n", TOOLS_SECTION_MARKER] as const;

function findFirstMarker(text: string, markers: readonly string[]): { index: number; marker: string } | undefined {
  for (const marker of markers) {
    const index = text.indexOf(marker);
    if (index !== -1) return { index, marker };
  }
  return undefined;
}

export async function readDefaultSystemPrompt(): Promise<string> {
  return readFile(DEFAULT_SYSTEM_PROMPT_FILE, "utf8");
}

export function replaceSystemPromptIntro(systemPrompt: string, customIntro: string): string | undefined {
  const found = findFirstMarker(systemPrompt, TOOLS_SECTION_MARKERS);
  if (!found) return undefined;

  return `${customIntro.trimEnd()}${systemPrompt.slice(found.index)}`;
}

/** Legacy (Pi < 1.6) marker; kept for backward compatibility. */
export const GUIDELINES_MARKER = "\nGuidelines:\n";
/** Candidate rules-section markers, highest priority first: Pi >= 1.6 XML `<rules>`, then legacy. */
export const GUIDELINES_SECTION_MARKERS = ["\n\n<rules>\n", GUIDELINES_MARKER] as const;

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
  const found = findFirstMarker(out, GUIDELINES_SECTION_MARKERS);
  if (!found) return out;
  const insertAt = found.index + found.marker.length;
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
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      if (!notifiedReadError && ctx.hasUI) {
        notifiedReadError = true;
        ctx.ui.notify(`无法读取自定义系统提示：${DEFAULT_SYSTEM_PROMPT_FILE}`, "warning");
      }
      return;
    }

    if (customIntro.trim().length === 0) return;

    const introReplaced = replaceSystemPromptIntro(event.systemPrompt, customIntro);
    if (introReplaced === undefined) {
      // Newer Pi reads DefaultSystemPrompt.md itself: prompt already starts with the custom intro.
      const head = customIntro.trim().slice(0, 60);
      if (event.systemPrompt.trimStart().startsWith(head)) {
        return { systemPrompt: adjustGuidelinesSection(event.systemPrompt) };
      }
      if (!notifiedMissingToolsSection && ctx.hasUI) {
        notifiedMissingToolsSection = true;
        ctx.ui.notify("未找到 <tools>/Available tools 段，保留 Pi 原系统提示。", "warning");
      }
      return;
    }

    return { systemPrompt: adjustGuidelinesSection(introReplaced) };
  });
}
