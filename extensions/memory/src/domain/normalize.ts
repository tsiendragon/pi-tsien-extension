import type { MemoryKind, StructuredClaim } from "./types.ts";
import { sha256 } from "../shared/hash.ts";

export function normalizeText(input: string): string {
  return input
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function contentHash(input: string): string {
  return sha256(normalizeText(input));
}

export function normalizeClaimPart(input: string): string {
  return normalizeText(input).toLocaleLowerCase("en-US");
}

export function claimKey(claim: StructuredClaim): string {
  return sha256(`${normalizeClaimPart(claim.subject)}\0${normalizeClaimPart(claim.predicate)}`);
}

export function claimValueText(claim: StructuredClaim): string {
  return typeof claim.value === "string" ? claim.value : JSON.stringify(claim.value);
}

export interface ExtractedClaim {
  kind: MemoryKind;
  claim?: StructuredClaim;
  explicitGlobal: boolean;
}

const GLOBAL_PREFERENCE = /(?:i\s+prefer|i\s+always|i\s+never|我的偏好|我偏好|以后(?:都|请)?|从现在开始|不要再)/i;
const DECISION = /(?:we\s+(?:decided|will)|decision|决定|采用|改为|使用)/i;

export function extractClaim(content: string): ExtractedClaim {
  const normalized = normalizeText(content);
  const explicitGlobal = GLOBAL_PREFERENCE.test(normalized) && !/(?:这个项目|本项目|当前仓库|this repo|this project)/i.test(normalized);

  const match = normalized.match(/(?:use|using|使用|采用|改为)\s+([\w.@+/#:-]{2,80})/i);
  if (match?.[1]) {
    return {
      kind: DECISION.test(normalized) ? "decision" : "preference",
      explicitGlobal,
      claim: {
        subject: "runtime.tooling",
        predicate: "preferred_value",
        value: match[1],
        polarity: "positive",
        qualifiers: {},
      },
    };
  }

  const version = normalized.match(/(?:node(?:\.js)?|python|typescript)\s*(?:版本|version)?\s*(?:是|为|:)?\s*v?([0-9]+(?:\.[0-9]+){0,2})/i);
  if (version?.[1]) {
    const subject = /python/i.test(normalized) ? "runtime.python" : /typescript/i.test(normalized) ? "runtime.typescript" : "runtime.node";
    return {
      kind: DECISION.test(normalized) ? "decision" : "experience",
      explicitGlobal,
      claim: {
        subject,
        predicate: "required_version",
        value: version[1],
        polarity: "positive",
        qualifiers: {},
      },
    };
  }

  if (GLOBAL_PREFERENCE.test(normalized)) {
    return { kind: "preference", explicitGlobal };
  }
  if (DECISION.test(normalized)) return { kind: "decision", explicitGlobal };
  return { kind: "experience", explicitGlobal: false };
}

export function extractSearchTerms(input: string): string[] {
  const normalized = normalizeText(input).toLocaleLowerCase("en-US");
  const words = normalized.match(/[a-z0-9_./:@+-]+/g) ?? [];
  const cjk = [...normalized].filter((char) => /[\u3400-\u9fff]/u.test(char));
  const grams: string[] = [];
  for (let i = 0; i < cjk.length; i += 1) {
    if (cjk[i]) grams.push(cjk[i]);
    if (cjk[i] && cjk[i + 1]) grams.push(`${cjk[i]}${cjk[i + 1]}`);
    if (cjk[i] && cjk[i + 1] && cjk[i + 2]) grams.push(`${cjk[i]}${cjk[i + 1]}${cjk[i + 2]}`);
  }
  return [...new Set([...words, ...grams])].filter((term) => term.length > 0).slice(0, 40);
}

export function buildSearchText(content: string, claim?: StructuredClaim): string {
  const terms = extractSearchTerms(content);
  if (claim) {
    terms.push(...extractSearchTerms(claim.subject), ...extractSearchTerms(claim.predicate), ...extractSearchTerms(claimValueText(claim)));
  }
  return [...new Set(terms)].join(" ").slice(0, 4096);
}

export function escapeFtsTerm(term: string): string {
  return `"${term.replaceAll('"', '""')}"`;
}
