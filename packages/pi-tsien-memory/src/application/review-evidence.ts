import { normalizeText } from "../domain/normalize.ts";
import type { MemoryKind, ScopeType } from "../domain/types.ts";

export interface ReviewedEvidence {
  content: string;
  kind: MemoryKind;
  basis?: "user_explicit" | "tool_inference" | "recovery_inference";
  evidence?: string;
}

const EXPLICIT_DIRECTIVE = /记住|以后|从现在开始|不要|不再|优先|统一|使用|必须|回复|回答|中文|always|never|prefer|use/i;
const NEEDS_JUDGEMENT = /授权|权限|发布|上线|删除|删掉|清除|凭证|密码|密钥|安全|生产|全局|所有项目|不可逆|外部写入|正式环境/i;

/**
 * A model summary is treated as user-explicit only when an exact user quote supports a low-risk
 * preference or decision. Tool-derived facts and failure lessons never take this shortcut.
 */
export function verifyUserExplicitReview(input: {
  userText: string;
  scopeType: ScopeType;
  reviewed: ReviewedEvidence;
}): { verified: boolean; reasonCode: string } {
  const { reviewed } = input;
  if (reviewed.basis !== "user_explicit") return { verified: false, reasonCode: "not_user_explicit" };
  if (reviewed.kind !== "preference" && reviewed.kind !== "decision") return { verified: false, reasonCode: "not_simple_preference" };
  if (input.scopeType === "global") return { verified: false, reasonCode: "scope_escalation" };
  const evidence = normalizeText(reviewed.evidence ?? "");
  if (evidence.length < 4 || evidence.length > 300) return { verified: false, reasonCode: "evidence_missing" };
  if (!normalizeText(input.userText).includes(evidence)) return { verified: false, reasonCode: "evidence_not_in_user_turn" };
  if (!EXPLICIT_DIRECTIVE.test(evidence)) return { verified: false, reasonCode: "not_explicit_directive" };
  if (NEEDS_JUDGEMENT.test(`${reviewed.content}\n${evidence}`)) return { verified: false, reasonCode: "sensitive_or_ambiguous" };
  return { verified: true, reasonCode: "user_explicit_low_risk" };
}