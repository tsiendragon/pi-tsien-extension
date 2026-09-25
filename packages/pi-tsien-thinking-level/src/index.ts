import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";

const EFFORT_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
type EffortLevel = (typeof EFFORT_LEVELS)[number];

function isEffortLevel(value: string): value is EffortLevel {
  return EFFORT_LEVELS.includes(value as EffortLevel);
}

export default function effortExtension(pi: ExtensionAPI): void {
  pi.registerCommand("effort", {
    description: "直接调整 thinking level：off|minimal|low|medium|high|xhigh|max",
    getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
      const normalized = prefix.trim().toLowerCase();
      const matches = EFFORT_LEVELS.filter((level) => level.startsWith(normalized)).map((level) => ({
        value: level,
        label: level,
      }));
      return matches.length > 0 ? matches : null;
    },
    handler: async (args, ctx) => {
      let requested = args.trim().toLowerCase();

      if (!requested) {
        if (!ctx.hasUI) return;
        const selected = await ctx.ui.select(
          `Thinking level（当前：${pi.getThinkingLevel()}）`,
          [...EFFORT_LEVELS],
        );
        if (!selected) return;
        requested = selected;
      }

      if (!isEffortLevel(requested)) {
        ctx.ui.notify(`用法：/effort ${EFFORT_LEVELS.join("|")}`, "warning");
        return;
      }

      pi.setThinkingLevel(requested);
      const effective = pi.getThinkingLevel();
      const suffix = effective === requested ? "" : `（当前模型限制为 ${effective}）`;
      ctx.ui.notify(`Thinking level 已设为 ${effective}${suffix}`, "info");
    },
  });
}
