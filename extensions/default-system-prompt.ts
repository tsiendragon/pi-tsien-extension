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

    const systemPrompt = replaceSystemPromptIntro(event.systemPrompt, customIntro);
    if (systemPrompt === undefined) {
      if (!notifiedMissingToolsSection && ctx.hasUI) {
        notifiedMissingToolsSection = true;
        ctx.ui.notify("未找到 Available tools 段，保留 Pi 原系统提示。", "warning");
      }
      return;
    }

    return { systemPrompt };
  });
}
