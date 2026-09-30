export const PUBLIC_RUNTIME_DTO_VERSION = 1 as const;

export type PublicTaskStatusV1 =
  | "pending"
  | "running"
  | "paused"
  | "waiting_approval"
  | "blocked"
  | "failed"
  | "completed"
  | "cancelled";

export type PublicTaskStepStateV1 =
  | "pending"
  | "running"
  | "waiting_approval"
  | "succeeded"
  | "failed"
  | "needs_review";

export type PublicExecutionRevisionRefV1 = {
  version: 1;
  digest: string;
};

export type PublicExecutionActivationV1 = {
  version: 1;
  id: string;
  revisionDigest: string;
  testTaskId: string;
  evidenceDigest: string;
  activatedAt: string;
};

export type PublicTaskProvenanceV1 =
  | {
      kind: "skill_candidate_test";
      candidateId: string;
      candidateDigest: string;
      inputDigest: string;
    }
  | {
      kind: "user_skill";
      skillId: string;
      skillVersion: string;
      skillDigest: string;
    }
  | {
      kind: "activated_revision";
      activationId: string;
      testTaskId: string;
      revisionDigest: string;
    };

export type PublicObservationV1 = {
  schemaVersion: 1;
  id: string;
  channel: string;
  provider: string;
  state: string;
  evidenceCount: number;
};

export type PublicVerificationReceiptV1 = {
  schemaVersion: 1;
  id: string;
  specId: string;
  status: "verified" | "failed" | "uncertain";
  checkedAt: string;
};

export type PublicTaskStepV1 = {
  id: string;
  action: string;
  state: PublicTaskStepStateV1;
  attempts: number;
  durationMs: number | null;
  error: string | null;
  observation: PublicObservationV1 | null;
  verification: PublicVerificationReceiptV1 | null;
  approval: {
    id: string;
    fingerprint: string | null;
    requestedAt: string | null;
  } | null;
  [key: string]: unknown;
};

export type PublicTaskDetailV1 = {
  schemaVersion: 1;
  id: string;
  label: string;
  status: PublicTaskStatusV1;
  ownerSessionId: string | null;
  provenance: PublicTaskProvenanceV1 | null;
  executionRevision: PublicExecutionRevisionRefV1 | null;
  executionActivation: PublicExecutionActivationV1 | null;
  createdAt: string;
  updatedAt: string;
  runCount: number;
  storage: {
    encryptedAtRest: boolean;
    algorithm: string;
    internalPathsExposed: false;
  };
  staging: {
    artifactCount: number;
    committedArtifactCount: number;
    legacyUncommittedArtifactCount: number;
    artifacts: PublicArtifactRefV1[];
    internalPathsExposed: false;
  };
  steps: PublicTaskStepV1[];
  [key: string]: unknown;
};

export type PublicTaskSummaryV1 = {
  schemaVersion: 1;
  id: string;
  label: string;
  status: PublicTaskStatusV1;
  ownerSessionId: string | null;
  createdAt: string;
  updatedAt: string;
  runCount: number;
  counts: {
    total: number;
    pending: number;
    running: number;
    waitingApproval: number;
    succeeded: number;
    failed: number;
    needsReview: number;
  };
  [key: string]: unknown;
};

export type PublicRunReceiptV1 = {
  schemaVersion: 1;
  id: string;
  label: string;
  status: PublicTaskStatusV1;
  runCount: number;
  wavesExecuted: number;
  runDurationMs: number;
  runResults: Array<Record<string, unknown>>;
  executionRevision: PublicExecutionRevisionRefV1 | null;
  summary: PublicTaskDetailV1;
  alreadyCompleted?: boolean;
};

export type PublicApprovalV1 = {
  schemaVersion: 1;
  id: string;
  subjectType: "action" | "skill";
  subject: string;
  fingerprint: string;
  riskLevel: "low" | "medium" | "high" | "critical";
  sideEffects: string[];
  state: "pending" | "approved" | "consumed" | "denied" | "expired";
  requestedAt: string;
  expiresAt: string;
  approvedAt?: string;
  deniedAt?: string;
  consumedAt?: string;
  ownerSessionId: string;
  ownerTaskId?: string;
  ownerStepId?: string;
  reason: string;
};

export type PublicScheduleTriggerV1 =
  | { kind: "once"; at: string }
  | { kind: "interval"; everyMs: number; startAt?: string }
  | { kind: "daily"; time: string };

export type PublicScheduleV1 = {
  schemaVersion: 1;
  id: string;
  label: string;
  enabled: boolean;
  trigger: PublicScheduleTriggerV1;
  runCount: number;
  nextRunAt: string | null;
  pausedAt: string | null;
  pausedNextRunAt: string | null;
  lastRunAt: string | null;
  lastCompletedAt: string | null;
  lastTaskId: string | null;
  activeTaskId: string | null;
  lastTaskStatus: string | null;
  lastError: string | null;
  stoppedReason: string | null;
  createdAt: string;
  updatedAt: string;
  [key: string]: unknown;
};

export type PublicArtifactRetentionClassV1 =
  | "cache"
  | "task_staging"
  | "intermediate"
  | "log"
  | "failed_debug"
  | "observation_payload"
  | "saved"
  | "task_metadata"
  | "audit";

export type PublicArtifactRefV1 = {
  schemaVersion: 1;
  artifactId: string;
  objectId: string;
  digest: `sha256:${string}`;
  mediaType: string;
  sizeBytes: number;
  createdAt: string;
  retentionClass: PublicArtifactRetentionClassV1;
  provenance?: {
    taskId?: string;
    executionRevisionId?: string;
    evidenceId?: string;
  };
};

export type PublicStorageLifecycleV1 =
  | "ACTIVE"
  | "EXPIRED"
  | "RECLAIMABLE"
  | "GC_PENDING"
  | "PINNED"
  | "AUDIT_HOLD"
  | "DELETED";

export type PublicStorageArtifactV1 = {
  schemaVersion: 1;
  artifact: PublicArtifactRefV1;
  lifecycle: PublicStorageLifecycleV1;
  expiresAt: string | null;
  reclaimableAt: string | null;
  pinnedAt: string | null;
  holdReason: string | null;
};

export type PublicStorageStatusV1 = {
  schemaVersion: 1;
  foundationVersion: 1;
  retentionVersion: 1;
  reconciliationVersion: 1;
  metadataStore: {
    provider: "sqlite";
    schemaVersion: 1;
    database: "state/owl.db";
    absolutePathExposed: false;
    secretsStoredHere: false;
  };
  health: "healthy" | "degraded" | "needs_attention";
  usage: {
    logicalReferenceCount: number;
    uniqueReferencedObjectCount: number;
    uniqueReferencedBytes: number;
    unreferencedObjectCount: number;
    unreferencedBytes: number;
    staleStagingCount: number;
  };
  lifecycleCounts: Record<string, number>;
  retentionClassCounts: Record<string, number>;
  retentionDefaultsMs: Record<PublicArtifactRetentionClassV1, number | null>;
  internalPathsExposed: false;
};

export type PublicStorageReconciliationV1 = {
  version: 1;
  checkedAt: string;
  health: "healthy" | "degraded" | "needs_attention";
  referencedObjectCount: number;
  physicalObjectCount: number;
  missingReferences: Array<{
    artifactId: string;
    objectId: string;
    digest: string;
  }>;
  corruptObjects: Array<{
    objectId: string;
    digest: string;
    reason: string;
  }>;
  unreferencedObjects: Array<{
    objectId: string;
    digest: string;
    sizeBytes: number;
  }>;
  staleStaging: Array<{
    taskId: string;
    ageMs: number;
  }>;
  internalPathsExposed: false;
};

export type PublicStorageGcReceiptV1 = {
  schemaVersion: 1;
  evaluatedAt: string;
  dryRun: boolean;
  retiredReferenceIds: string[];
  deletedObjectIds: string[];
  reclaimedBytes: number;
  retainedSharedObjectIds: string[];
};

export type PublicLegacyStorageInventoryItemV1 = {
  version: 1;
  source: "computer-mcp" | "agentos" | "owl-runtime";
  relativePath: string;
  sizeBytes: number;
  modifiedAt: string;
  inferredType: string;
  digest: `sha256:${string}`;
  migrationDecision: "migrate" | "discardable" | "review";
  retentionClass: PublicArtifactRetentionClassV1 | null;
  confidence: number;
};

export type PublicLegacyStorageInventoryV1 = {
  version: 1;
  createdAt: string;
  roots: Array<{
    source: "computer-mcp" | "agentos" | "owl-runtime";
    exists: boolean;
    fileCount: number;
    sizeBytes: number;
  }>;
  items: PublicLegacyStorageInventoryItemV1[];
  totals: {
    bytes: number;
    migrateBytes: number;
    discardableBytes: number;
    reviewBytes: number;
  };
};

export type PublicLegacyStorageMigrationReceiptV1 = {
  version: 1;
  migratedAt: string;
  confirmed: true;
  migrated: Array<{
    source: "computer-mcp" | "agentos" | "owl-runtime";
    relativePath: string;
    artifact: PublicArtifactRefV1;
  }>;
  objectIds: string[];
  migratedBytes: number;
  uniqueObjectBytes: number;
  deduplicatedBytes: number;
  reclaimableLegacyBytes: number;
  reviewBytes: number;
  legacyDeleted: false;
};

export type PublicDeleteReceiptV1 = {
  schemaVersion: 1;
  id: string;
  deleted: true;
  [key: string]: unknown;
};

export type PublicApprovalActionResultV1 = {
  schemaVersion: 1;
  approval: PublicApprovalV1;
  resume?: Record<string, unknown> | null;
  task?: PublicTaskDetailV1 | null;
};
