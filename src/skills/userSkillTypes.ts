import type { VerificationSpec } from "../verification/verifier.js";
import type { RuntimePublicEventDraft } from "../runtime/publicEventJournal.js";

export const USER_SKILL_ABI_VERSION = 1 as const;

export type UserSkillRiskLevel = "low" | "medium" | "high" | "critical";
export type UserSkillRetryPolicy = "automatic" | "manual" | "never";
export type UserSkillResource = { key: string; mode: "shared" | "exclusive" };

export type UserSkillInputSpec = {
  type: "string" | "number" | "boolean";
  required?: boolean;
  default?: string | number | boolean;
  description?: string;
};

export type UserSkillContract = {
  riskLevel: UserSkillRiskLevel;
  idempotent: boolean;
  sideEffects: string[];
  retryPolicy: UserSkillRetryPolicy;
  requiresVerification: boolean;
  resources?: UserSkillResource[];
};

export type UserSkillStep = {
  id: string;
  primitive: string;
  op: string;
  args?: Record<string, unknown>;
  dependsOn?: string[];
  verify?: VerificationSpec;
};

export type UserSkillManifest = {
  schemaVersion: 1;
  skillAbiVersion: typeof USER_SKILL_ABI_VERSION;
  id: string;
  version: string;
  title: string;
  description: string;
  requiredPrimitiveAbi: number;
  requiredPrimitives: string[];
  executionMode: "durable";
  inputs: Record<string, UserSkillInputSpec>;
  contract: UserSkillContract;
  steps: UserSkillStep[];
  provenance?: {
    origin?: "external" | "workflow" | "semantic" | "user";
    sourceTaskIds?: string[];
    sourceMemoryIds?: string[];
  };
};

export type SkillValidationIssue = {
  code: string;
  file?: string;
  path: string;
  message: string;
  actual?: unknown;
  required?: unknown;
  allowed?: unknown;
};

export type DerivedSkillContract = UserSkillContract & {
  resources: UserSkillResource[];
};

export type SkillCandidateValidationReport = {
  reportVersion: 1;
  candidateId: string;
  candidateDigest: string;
  valid: boolean;
  targetSkillAbi: typeof USER_SKILL_ABI_VERSION;
  primitiveAbi: {
    runtime: number;
    required: number | null;
  };
  requiredPrimitives: string[];
  allowedPrimitives: string[];
  derivedContract: DerivedSkillContract | null;
  effectiveContract: DerivedSkillContract | null;
  errors: SkillValidationIssue[];
  warnings: SkillValidationIssue[];
  validatedAt: string;
};

export type SkillCandidateRevision = {
  revision: number;
  digest: string;
  createdAt: string;
  manifest: unknown;
};

export type SkillCandidateTestBinding = {
  candidateDigest: string;
  inputDigest: string;
  taskId: string;
  compiledAt: string;
};

export type SkillCandidateStatus = "active" | "dismissed" | "promoted";

export type SkillPromotionReceipt = {
  version: 1;
  id: string;
  candidateId: string;
  candidateDigest: string;
  skillId: string;
  skillVersion: string;
  testTaskId: string;
  m2EvidenceDigest: string;
  effectiveContract: DerivedSkillContract;
  qualityGate: unknown;
  privacyGate: unknown;
  verification: {
    requiredStepIds: string[];
    verifiedStepIds: string[];
    allRequiredVerified: boolean;
  };
  promotedAt: string;
};

export type SkillCandidatePublicEventOutboxEntry = {
  version: 1;
  event: RuntimePublicEventDraft;
  state: "pending" | "published";
  publishedSequence?: number;
  publishedCursor?: string;
  publishedAt?: string;
};

export type SkillCandidateRecord = {
  version: 1;
  id: string;
  status: SkillCandidateStatus;
  createdAt: string;
  updatedAt: string;
  revision: number;
  currentDigest: string;
  revisions: SkillCandidateRevision[];
  validation?: SkillCandidateValidationReport;
  tests: SkillCandidateTestBinding[];
  publicEventOutbox?: SkillCandidatePublicEventOutboxEntry[];
  promotion?: SkillPromotionReceipt;
  dismissedAt?: string;
};

export type InstalledUserSkillVersion = {
  version: string;
  candidateId: string;
  candidateDigest: string;
  installedAt: string;
  manifest: UserSkillManifest;
  promotion: SkillPromotionReceipt;
  uninstalledAt?: string;
};

export type UserSkillActivationEvent = {
  at: string;
  version: string | null;
  reason: "promotion" | "activate" | "rollback" | "uninstall";
};

export type UserSkillRegistryRecord = {
  version: 1;
  skillId: string;
  enabled: boolean;
  activeVersion: string | null;
  createdAt: string;
  updatedAt: string;
  versions: Record<string, InstalledUserSkillVersion>;
  activationHistory: UserSkillActivationEvent[];
};
