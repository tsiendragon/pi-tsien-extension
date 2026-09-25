import type { CaptureProposal, CaptureStrategy, ExplicitMemoryIntent, SettledTurn } from "../ports/memory.ts";
import { extractClaim, normalizeText } from "../domain/normalize.ts";

const REMEMBER = /(?:remember(?:\s+this)?|from now on|always|never again|记住|以后(?:都|请)?|从现在开始|不要再)/i;
const UPDATE = /(?:correct|correction|update|replace|改成|更正|更新|替换|之前.*过时)/i;
const FORGET = /(?:forget|delete.*memory|remove.*memory|忘掉|删除记忆|忘记这条)/i;
const INSPECT = /(?:what do you remember|show.*memory|你记得什么|查看记忆)/i;

export class RuleCaptureStrategy implements CaptureStrategy {
  detectExplicitIntent(text: string): ExplicitMemoryIntent | undefined {
    const normalized = normalizeText(text);
    if (FORGET.test(normalized)) return { action: "forget", explicit: true, targetHint: normalized };
    if (UPDATE.test(normalized)) return { action: "update", explicit: true, targetHint: normalized };
    if (INSPECT.test(normalized)) return { action: "inspect", explicit: true, targetHint: normalized };
    if (REMEMBER.test(normalized)) {
      const requestedScope = /(?:global|全局|always.*all projects|所有项目)/i.test(normalized) ? "global" : /(?:branch|分支)/i.test(normalized) ? "branch" : undefined;
      return { action: "remember", explicit: true, targetHint: normalized, requestedScope };
    }
    return undefined;
  }

  async extract(turn: SettledTurn): Promise<CaptureProposal[]> {
    const text = normalizeText(turn.userText);
    if (!text || text.length < 4 || text.length > 2000 || looksLikeSourceBody(text)) return [];
    const intent = this.detectExplicitIntent(text);
    const extracted = extractClaim(text);
    if (intent?.action === "forget" || intent?.action === "inspect") return [];

    if (intent?.action === "remember") {
      return [{
        content: text,
        kind: extracted.kind,
        scope: turn.scope,
        confidence: 0.98,
        explicit: true,
        explicitGlobal: extracted.explicitGlobal || intent.requestedScope === "global",
        sourceType: "user_message",
        authority: "user_explicit",
        sourceUri: `session://${turn.sessionId}/${turn.userEntryId}`,
        sourceEntryId: turn.userEntryId,
      }];
    }

    return [];
  }
}

function looksLikeSourceBody(text: string): boolean {
  return text.includes("```") || /^diff --git /m.test(text) || /^(?:\s*at .+\n){3,}/m.test(text) || text.split("\n").length > 12;
}
