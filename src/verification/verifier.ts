import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ActionContract } from "../runtime/actionContracts.js";
import type { Observation } from "../observation/observationAbi.js";

export const VERIFIER_ABI_VERSION = 1 as const;

export const VERIFICATION_STATUSES = [
  "verified",
  "failed",
  "uncertain",
] as const;

export const VERIFICATION_OPERATORS = [
  "exists",
  "equals",
  "contains",
  "matches",
  "truthy",
  "falsy",
  "gt",
  "gte",
  "lt",
  "lte",
] as const;

export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];
export type VerificationOperator = (typeof VERIFICATION_OPERATORS)[number];
export type VerificationFollowUp = "accept" | "reobserve" | "retry" | "review";

export type VerificationExpectation = {
  path: string;
  operator: VerificationOperator;
  expected?: unknown;
  description?: string;
};

export type VerificationSpec = {
  id: string;
  description?: string;
  expectations: VerificationExpectation[];
};

export type VerificationCheck = {
  path: string;
  operator: VerificationOperator;
  status: "passed" | "failed" | "uncertain";
  expected?: unknown;
  actual?: unknown;
  message: string;
};

export type VerificationReceipt = {
  abiVersion: typeof VERIFIER_ABI_VERSION;
  verificationId: string;
  specId: string;
  checkedAt: string;
  status: VerificationStatus;
  observationIds: string[];
  checks: VerificationCheck[];
  evidence: Observation["evidence"];
};

const expectationSchema = z.object({
  path: z.string().min(1),
  operator: z.enum(VERIFICATION_OPERATORS),
  expected: z.unknown().optional(),
  description: z.string().min(1).optional(),
});

export const verificationSpecSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1).optional(),
  expectations: z.array(expectationSchema).min(1),
});

function resolvePath(root: unknown, path: string): { found: boolean; value?: unknown } {
  const segments = path.split(".").filter(Boolean);
  let current = root;
  for (const segment of segments) {
    if (current === null || typeof current !== "object") return { found: false };
    if (!(segment in (current as Record<string, unknown>))) return { found: false };
    current = (current as Record<string, unknown>)[segment];
  }
  return { found: true, value: current };
}

function compare(expectation: VerificationExpectation, actual: unknown): boolean {
  switch (expectation.operator) {
    case "exists":
      return true;
    case "equals":
      return Object.is(actual, expectation.expected);
    case "contains":
      if (typeof actual === "string" && typeof expectation.expected === "string") {
        return actual.includes(expectation.expected);
      }
      if (Array.isArray(actual)) return actual.some((value) => Object.is(value, expectation.expected));
      return false;
    case "matches":
      return typeof actual === "string" && typeof expectation.expected === "string"
        ? new RegExp(expectation.expected).test(actual)
        : false;
    case "truthy":
      return Boolean(actual);
    case "falsy":
      return !actual;
    case "gt":
      return typeof actual === "number" && typeof expectation.expected === "number" && actual > expectation.expected;
    case "gte":
      return typeof actual === "number" && typeof expectation.expected === "number" && actual >= expectation.expected;
    case "lt":
      return typeof actual === "number" && typeof expectation.expected === "number" && actual < expectation.expected;
    case "lte":
      return typeof actual === "number" && typeof expectation.expected === "number" && actual <= expectation.expected;
  }
}

export function verifyObservation(
  observation: Observation,
  specInput: VerificationSpec,
): VerificationReceipt {
  const spec = verificationSpecSchema.parse(specInput) as VerificationSpec;
  const checks: VerificationCheck[] = spec.expectations.map((expectation) => {
    const resolved = resolvePath(observation, expectation.path);
    if (!resolved.found) {
      if (expectation.operator === "exists") {
        return {
          path: expectation.path,
          operator: expectation.operator,
          status: "failed",
          expected: expectation.expected,
          message: `Required path ${expectation.path} does not exist.`,
        };
      }
      return {
        path: expectation.path,
        operator: expectation.operator,
        status: "uncertain",
        expected: expectation.expected,
        message: `Cannot evaluate ${expectation.path}; the observation does not contain it.`,
      };
    }

    const passed = compare(expectation, resolved.value);
    return {
      path: expectation.path,
      operator: expectation.operator,
      status: passed ? "passed" : "failed",
      expected: expectation.expected,
      actual: resolved.value,
      message: passed
        ? expectation.description ?? `${expectation.path} satisfied ${expectation.operator}.`
        : `${expectation.path} did not satisfy ${expectation.operator}.`,
    };
  });

  const status: VerificationStatus = checks.some((check) => check.status === "failed")
    ? "failed"
    : checks.some((check) => check.status === "uncertain")
      ? "uncertain"
      : "verified";

  return {
    abiVersion: VERIFIER_ABI_VERSION,
    verificationId: `verification_${Date.now().toString(36)}_${randomUUID().replaceAll("-", "").slice(0, 12)}`,
    specId: spec.id,
    checkedAt: new Date().toISOString(),
    status,
    observationIds: [observation.observationId],
    checks,
    evidence: observation.evidence,
  };
}

export function uncertainVerificationReceipt(
  specInput: VerificationSpec,
  reason: string,
  observation?: Observation | null,
): VerificationReceipt {
  const spec = verificationSpecSchema.parse(specInput) as VerificationSpec;
  return {
    abiVersion: VERIFIER_ABI_VERSION,
    verificationId:
      `verification_${Date.now().toString(36)}_${randomUUID().replaceAll("-", "").slice(0, 12)}`,
    specId: spec.id,
    checkedAt: new Date().toISOString(),
    status: "uncertain",
    observationIds: observation ? [observation.observationId] : [],
    checks: [
      {
        path: "$observation",
        operator: "exists",
        status: "uncertain",
        message: reason,
      },
    ],
    evidence: observation?.evidence ?? [],
  };
}

export function verificationFollowUp(
  receipt: VerificationReceipt,
  contract: Pick<ActionContract, "idempotent" | "retryPolicy" | "sideEffects">,
): VerificationFollowUp {
  if (receipt.status === "verified") return "accept";

  if (receipt.status === "uncertain") {
    if (contract.sideEffects.length === 0 && contract.idempotent) return "reobserve";
    return "review";
  }

  if (contract.idempotent && contract.retryPolicy === "automatic") return "retry";
  return "review";
}

export function getVerifierAbiManifest() {
  return {
    version: VERIFIER_ABI_VERSION,
    stability: "candidate" as const,
    statuses: [...VERIFICATION_STATUSES],
    operators: [...VERIFICATION_OPERATORS],
    invariant:
      "UNCERTAIN verification never authorizes automatic replay of a non-idempotent or side-effecting action.",
  };
}
