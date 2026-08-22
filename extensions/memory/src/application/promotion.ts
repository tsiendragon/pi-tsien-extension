import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MemoryError, MemoryNotFoundError } from "../domain/errors.ts";
import type { MemoryRepository, SecretFilter } from "../ports/memory.ts";
import type { PromotionEvidenceBundle, PromotionPreview, PromotionType } from "../ports/promotion.ts";
import { memoryId, sha256 } from "../shared/hash.ts";

export class PromotionAdvisor {
  constructor(private readonly repository: MemoryRepository, private readonly secretFilter: SecretFilter, private readonly proposalDir: string, private readonly now: () => number = Date.now) {}

  async preview(memoryIdValue: string): Promise<PromotionPreview> {
    const memory = await this.repository.getById(memoryIdValue);
    if (!memory?.currentRevision) throw new MemoryNotFoundError("Memory cannot be promoted because it has no current revision");
    const stats = await this.repository.applicationStats(memory.id);
    const privacy = this.secretFilter.inspect(memory.currentRevision.content);
    const reasons: string[] = [];
    if (memory.status !== "active") reasons.push("memory must be active");
    if (stats.verifiedApplications < 3) reasons.push("fewer than 3 verified applications");
    if (stats.distinctTasks < 2) reasons.push("fewer than 2 distinct tasks");
    if (stats.distinctRepositories < 2) reasons.push("fewer than 2 distinct repositories");
    if (stats.unresolvedConflicts > 0) reasons.push("unresolved conflicts remain");
    if (privacy.action !== "allow") reasons.push("privacy review rejected or requires redaction");
    const eligibility = { eligible: reasons.length === 0, verifiedApplications: stats.verifiedApplications, distinctTasks: stats.distinctTasks, distinctRepositories: stats.distinctRepositories, unresolvedConflicts: stats.unresolvedConflicts, hasSensitiveData: privacy.action !== "allow", reasons };
    if (!eligibility.eligible) return { proposalId: memoryId("proposal"), memoryId: memory.id, eligibility };

    const proposalId = memoryId("proposal");
    const applications = (await this.repository.listApplications(memory.id)).filter((event) => event.outcome === "verified");
    const sources = await this.repository.listSources(memory.id);
    const suggestedType = classify(memory.currentRevision.content, memory.kind);
    const bundle: PromotionEvidenceBundle = {
      schemaVersion: 1, proposalId, memoryId: memory.id, suggestedType,
      problem: `Repeatedly solving a ${memory.kind} problem across tasks`,
      reusablePattern: memory.currentRevision.content,
      scope: [memory.scope.type],
      exclusions: ["secrets", "credentials", "private source bodies", "automatic external writes"],
      evidence: applications.slice(0, 20).map((event, index) => ({ taskHash: event.taskKeyHash ?? sha256(`${memory.id}:task:${index}`), outcome: "verified", sourceUri: sources[index]?.sourceUri ?? `memory://${memory.id}/application/${index}` })),
      counterexamples: [],
      privacyReview: { passed: true, findings: [] },
      suggestedTests: ["reproduce the pattern in two independent repositories", "verify the expected outcome", "confirm no sensitive data is included"],
      components: suggestedType === "plugin" ? [{ type: "rule", responsibility: "detect the reusable trigger" }, { type: "skill", responsibility: "execute and verify the reusable procedure" }] : undefined,
    };
    const paths = await this.writeBundle(bundle);
    return { proposalId, memoryId: memory.id, eligibility, bundle, ...paths };
  }

  async dismiss(proposalId: string, reason = "user_dismissed"): Promise<void> {
    const bundle = await this.readBundle(proposalId);
    if (!bundle) throw new MemoryError("Promotion proposal was not found", "PROMOTION_NOT_FOUND");
    await writeFile(join(this.proposalDir, `${proposalId}.dismissed.json`), JSON.stringify({ proposalId, reason, dismissedAt: this.now() }, null, 2), { mode: 0o600 });
  }

  async snooze(proposalId: string, until: number): Promise<void> {
    const bundle = await this.readBundle(proposalId);
    if (!bundle) throw new MemoryError("Promotion proposal was not found", "PROMOTION_NOT_FOUND");
    await writeFile(join(this.proposalDir, `${proposalId}.snoozed.json`), JSON.stringify({ proposalId, until }, null, 2), { mode: 0o600 });
  }

  async forget(memoryIdValue: string): Promise<void> {
    try {
      const names = await readdir(this.proposalDir);
      for (const name of names.filter((item) => item.endsWith(".json") && !item.endsWith(".dismissed.json") && !item.endsWith(".snoozed.json"))) {
        const path = join(this.proposalDir, name);
        try { const bundle = JSON.parse(await readFile(path, "utf8")) as PromotionEvidenceBundle; if (bundle.memoryId === memoryIdValue) { await rm(path, { force: true }); await rm(path.replace(/\.json$/u, ".md"), { force: true }); } } catch { /* ignore unrelated proposal */ }
      }
    } catch { /* proposal directory may not exist */ }
  }

  private async writeBundle(bundle: PromotionEvidenceBundle): Promise<{ jsonPath: string; markdownPath: string }> {
    await mkdir(this.proposalDir, { recursive: true, mode: 0o700 });
    const jsonPath = join(this.proposalDir, `${bundle.proposalId}.json`);
    const markdownPath = join(this.proposalDir, `${bundle.proposalId}.md`);
    await writeFile(jsonPath, JSON.stringify(bundle, null, 2), { mode: 0o600 });
    await writeFile(markdownPath, renderMarkdown(bundle), { mode: 0o600 });
    return { jsonPath, markdownPath };
  }

  private async readBundle(proposalId: string): Promise<PromotionEvidenceBundle | undefined> {
    try { return JSON.parse(await readFile(join(this.proposalDir, `${proposalId}.json`), "utf8")) as PromotionEvidenceBundle; } catch { return undefined; }
  }
}

function classify(content: string, kind: string): PromotionType {
  const text = content.toLocaleLowerCase();
  if (text.includes("plugin") || text.includes("插件")) return "plugin";
  if (/(?:step|步骤|run|执行|verify|验证|input|output)/u.test(text) && content.length > 120) return "skill";
  if (content.length <= 160 && (kind === "preference" || /always|never|总是|不要/u.test(text))) return "rule";
  return "knowledge";
}

function renderMarkdown(bundle: PromotionEvidenceBundle): string {
  const lines = [`# Promotion Proposal ${bundle.proposalId}`, "", `- Suggested type: ${bundle.suggestedType}`, `- Memory: ${bundle.memoryId}`, "", "## Reusable pattern", "", bundle.reusablePattern, "", "## Evidence", ""];
  lines.push(...bundle.evidence.map((item) => `- ${item.taskHash}: ${item.sourceUri}`));
  lines.push("", "## Privacy review", "", `- Passed: ${bundle.privacyReview.passed}`, ...bundle.exclusions.map((item) => `- Exclusion: ${item}`));
  if (bundle.components) lines.push("", "## Components", "", ...bundle.components.map((component) => `- ${component.type}: ${component.responsibility}`));
  return `${lines.join("\n")}\n`;
}
