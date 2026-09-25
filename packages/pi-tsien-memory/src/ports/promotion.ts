export type PromotionType = "knowledge" | "rule" | "skill" | "agent" | "hook" | "plugin";

export interface PromotionEvidenceBundle {
  schemaVersion: 1;
  proposalId: string;
  memoryId: string;
  suggestedType: PromotionType;
  problem: string;
  reusablePattern: string;
  scope: string[];
  exclusions: string[];
  evidence: Array<{ taskHash: string; outcome: "verified"; sourceUri: string }>;
  counterexamples: string[];
  privacyReview: { passed: boolean; findings: string[] };
  suggestedTests: string[];
  components?: Array<{ type: string; responsibility: string }>;
}

export interface PromotionEligibility {
  eligible: boolean;
  verifiedApplications: number;
  distinctTasks: number;
  distinctRepositories: number;
  unresolvedConflicts: number;
  hasSensitiveData: boolean;
  reasons: string[];
}

export interface PromotionPreview {
  proposalId: string;
  memoryId: string;
  eligibility: PromotionEligibility;
  bundle?: PromotionEvidenceBundle;
  jsonPath?: string;
  markdownPath?: string;
}
