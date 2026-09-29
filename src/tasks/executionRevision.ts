import { createHash } from "node:crypto";
import type {
  ExecutionTarget,
} from "../runtime/executionTarget.js";

export const EXECUTION_REVISION_VERSION = 1 as const;

export type ExecutionRevisionStep = {
  id: string;
  action: string;
  args?: Record<string, unknown>;
  dependsOn?: string[];
  verify?: unknown;
};

export type ExecutionRevisionInput = {
  label: string;
  steps: ExecutionRevisionStep[];
  maxConcurrency?: number;
  failFast?: boolean;
  executionTarget?: ExecutionTarget;
};

export type ExecutionRevision = {
  version: typeof EXECUTION_REVISION_VERSION;
  digest: string;
  canonical: ExecutionRevisionInput;
};

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, child]) => child !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

export function createExecutionRevision(
  input: ExecutionRevisionInput,
): ExecutionRevision {
  const canonical = canonicalize({
    label: input.label,
    steps: input.steps.map((step) => ({
      id: step.id,
      action: step.action,
      args: step.args ?? {},
      dependsOn: step.dependsOn ?? [],
      ...(step.verify === undefined ? {} : { verify: step.verify }),
    })),
    maxConcurrency: input.maxConcurrency ?? 4,
    failFast: input.failFast ?? true,
    ...(input.executionTarget === undefined
      ? {}
      : { executionTarget: input.executionTarget }),
  }) as ExecutionRevisionInput;
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        version: EXECUTION_REVISION_VERSION,
        canonical,
      }),
    )
    .digest("hex");
  return {
    version: EXECUTION_REVISION_VERSION,
    digest,
    canonical,
  };
}

export function assertExecutionRevisionDigest(
  actualDigest: string | undefined,
  expectedDigest: string | undefined,
): void {
  if (!expectedDigest) return;
  if (!actualDigest || actualDigest !== expectedDigest) {
    const error = new Error(
      "EXECUTION_REVISION_DIGEST_MISMATCH: task execution revision does not match the expected tested revision.",
    );
    (error as Error & { code?: string }).code =
      "EXECUTION_REVISION_DIGEST_MISMATCH";
    throw error;
  }
}


export const EXECUTION_ACTIVATION_VERSION = 1 as const;

export type ExecutionActivation = {
  version: typeof EXECUTION_ACTIVATION_VERSION;
  id: string;
  revisionDigest: string;
  testTaskId: string;
  evidenceDigest: string;
  activatedAt: string;
};

export function createExecutionActivation(input: {
  revisionDigest: string;
  testTaskId: string;
  evidenceDigest: string;
  activatedAt?: string;
}): ExecutionActivation {
  const id = "execact_" + createHash("sha256")
    .update(JSON.stringify({
      version: EXECUTION_ACTIVATION_VERSION,
      revisionDigest: input.revisionDigest,
      testTaskId: input.testTaskId,
      evidenceDigest: input.evidenceDigest,
    }))
    .digest("hex")
    .slice(0, 32);
  return {
    version: EXECUTION_ACTIVATION_VERSION,
    id,
    revisionDigest: input.revisionDigest,
    testTaskId: input.testTaskId,
    evidenceDigest: input.evidenceDigest,
    activatedAt: input.activatedAt ?? new Date().toISOString(),
  };
}
