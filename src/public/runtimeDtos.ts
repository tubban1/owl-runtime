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
  provenance: Record<string, unknown> | null;
  executionRevision: PublicExecutionRevisionRefV1 | null;
  executionActivation: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
  runCount: number;
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

export type PublicScheduleV1 = {
  schemaVersion: 1;
  id: string;
  label: string;
  enabled: boolean;
  trigger: Record<string, unknown>;
  runCount: number;
  nextRunAt: string | null;
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
