import type { SecretDecision, SecretFilter } from "../../ports/memory.ts";

const patterns: Array<[string, RegExp]> = [
  ["pem_private_key", /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/i],
  ["jwt", /\beyJ[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\b/],
  ["cloud_access_key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ["github_token", /\b(?:ghp|gho|ghs|ghr)_[A-Za-z0-9]{20,}\b/],
  ["bearer_token", /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b/i],
  ["credential_assignment", /(?:password|passwd|secret|api[_-]?key|token)\s*[:=]\s*[^\s,;]{8,}/i],
  ["credential_url", /https?:\/\/[^\s/@]+:[^\s/@]+@/i],
];

export class DefaultSecretFilter implements SecretFilter {
  inspect(input: string): SecretDecision {
    const findings = patterns.filter(([, pattern]) => pattern.test(input)).map(([name]) => name);
    if (findings.length > 0) return { action: "reject", findings };
    if (looksHighEntropy(input)) return { action: "reject", findings: ["high_entropy_value"] };
    return { action: "allow" };
  }

  scrubQuery(input: string): string {
    let result = input;
    for (const [, pattern] of patterns) result = result.replace(pattern, " ");
    return result.slice(0, 2000);
  }
}

function looksHighEntropy(input: string): boolean {
  const candidates = input.match(/[A-Za-z0-9+/=_-]{32,}/g) ?? [];
  return candidates.some((candidate) => {
    const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((pattern) => pattern.test(candidate)).length;
    return candidate.length >= 40 && classes >= 3;
  });
}
