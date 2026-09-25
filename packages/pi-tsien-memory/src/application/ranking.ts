import type { MemorySearchHit, RankedMemory, RecallQuery } from "../domain/types.ts";
import { normalizeText } from "../domain/normalize.ts";
import { contentHash } from "../domain/normalize.ts";

export async function rankRecall(query: RecallQuery, hits: MemorySearchHit[]): Promise<RankedMemory[]> {
  const ranked = hits.map((hit) => {
    const scopeScore = hit.memory.scope.type === "global" ? 0.75 : hit.memory.scope.type === "repository" ? 0.9 : 1;
    const ageDays = Math.max(0, ((query.now ?? Date.now()) - hit.memory.updatedAt) / 86_400_000);
    const halfLife = hit.memory.kind === "preference" ? 365 : hit.memory.kind === "decision" ? 180 : hit.memory.kind === "continuity" ? 14 : 90;
    const freshnessScore = Math.pow(0.5, ageDays / halfLife);
    const utilityScore = Math.min(1, Math.log2(hit.memory.appliedCount + 1) / 3);
    const score = 0.55 * hit.lexicalScore + 0.2 * scopeScore + 0.15 * hit.memory.confidence + 0.05 * freshnessScore + 0.05 * utilityScore;
    return {
      memory: hit.memory,
      score,
      reasonCodes: [...hit.reasonCodes, `scope:${hit.memory.scope.type}`],
    };
  });

  const seenClaims = new Set<string>();
  const seenContent = new Set<string>((query.currentSessionContents ?? []).map((content) => contentHash(normalizeText(content))));
  const output: RankedMemory[] = [];
  for (const item of ranked.sort((a, b) => b.score - a.score)) {
    if (item.score < query.minScore) continue;
    const claim = item.memory.claimKey;
    if (claim && seenClaims.has(claim)) continue;
    const normalized = normalizeText(item.memory.currentRevision?.content ?? "");
    if (seenContent.has(contentHash(normalized)) || sessionSimilarity(normalized, query.currentSessionContents ?? [])) continue;
    if (claim) seenClaims.add(claim);
    seenContent.add(contentHash(normalized));
    output.push(item);
    if (output.length >= query.maxItems) break;
  }
  return output;
}

function sessionSimilarity(content: string, sessionContents: string[]): boolean {
  const target = shingles(normalizeText(content));
  if (target.size === 0) return false;
  return sessionContents.some((entry) => {
    const source = shingles(normalizeText(entry));
    if (source.size === 0) return false;
    let intersection = 0;
    for (const shingle of target) if (source.has(shingle)) intersection += 1;
    return intersection / (target.size + source.size - intersection) >= 0.8;
  });
}

function shingles(text: string): Set<string> {
  const tokens = text.toLocaleLowerCase().split(/\\s+/u).filter(Boolean);
  const result = new Set<string>();
  for (let index = 0; index < tokens.length - 4; index += 1) result.add(tokens.slice(index, index + 5).join(" "));
  return result;
}

export function estimateTokens(text: string): number {
  let ascii = 0;
  let cjk = 0;
  let other = 0;
  for (const char of text) {
    if (/[A-Za-z0-9]/.test(char)) ascii += 1;
    else if (/[\u3400-\u9fff]/u.test(char)) cjk += 1;
    else other += 1;
  }
  return Math.ceil(ascii / 4) + Math.ceil(cjk / 1.5) + Math.ceil(other / 2);
}

export function fitRecallItems(items: RankedMemory[], maxTokens: number): { items: RankedMemory[]; estimatedTokens: number } {
  const kept: RankedMemory[] = [];
  let total = 0;
  for (const item of items) {
    const content = item.memory.currentRevision?.content ?? "";
    const tokens = estimateTokens(content);
    if (total + tokens > maxTokens) continue;
    kept.push(item);
    total += tokens;
  }
  return { items: kept, estimatedTokens: total };
}
