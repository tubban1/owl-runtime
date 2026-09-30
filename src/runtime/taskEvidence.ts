import { createHash } from "node:crypto";
import type { PersistentTask } from "../tasks/taskStore.js";

export type TaskEvidenceReceipt = {
  version: 1;
  taskId: string;
  taskStatus: PersistentTask["status"];
  completedAt: string | null;
  stepIds: string[];
  eventTypes: string[];
  evidenceDigest: string;
  allStepsSucceeded: boolean;
  unresolvedStepIds: string[];
  verification: {
    requiredStepIds: string[];
    verifiedStepIds: string[];
    failedStepIds: string[];
    uncertainStepIds: string[];
    missingStepIds: string[];
    allRequiredVerified: boolean;
  };
  sideEffects: {
    stepIds: string[];
    unresolvedStepIds: string[];
  };
};

export function buildTaskEvidenceReceipt(
  task: PersistentTask,
  requestedStepIds?: string[],
): TaskEvidenceReceipt {
  const requested =
    requestedStepIds && requestedStepIds.length > 0
      ? requestedStepIds.map((item) => item.trim()).filter(Boolean)
      : task.steps.filter((step) => step.state === "succeeded").map((step) => step.id);
  const stepIds = [...new Set(requested)];
  const selected = stepIds.map((id) => task.steps.find((step) => step.id === id));
  const existing = selected.filter(
    (step): step is PersistentTask["steps"][number] => Boolean(step),
  );

  const unresolvedStepIds = existing
    .filter((step) => step.state !== "succeeded")
    .map((step) => step.id);
  const requiredStepIds = existing
    .filter((step) => Boolean(step.requiresVerification))
    .map((step) => step.id);
  const verifiedStepIds = existing
    .filter(
      (step) =>
        Boolean(step.requiresVerification) &&
        step.verification?.status === "verified",
    )
    .map((step) => step.id);
  const failedStepIds = existing
    .filter(
      (step) =>
        Boolean(step.requiresVerification) &&
        step.verification?.status === "failed",
    )
    .map((step) => step.id);
  const uncertainStepIds = existing
    .filter(
      (step) =>
        Boolean(step.requiresVerification) &&
        step.verification?.status === "uncertain",
    )
    .map((step) => step.id);
  const missingStepIds = existing
    .filter(
      (step) =>
        Boolean(step.requiresVerification) && step.verification === undefined,
    )
    .map((step) => step.id);

  const sideEffectStepIds = existing
    .filter((step) => (step.sideEffects?.length ?? 0) > 0)
    .map((step) => step.id);
  const unresolvedSideEffectStepIds = existing
    .filter((step) => {
      if ((step.sideEffects?.length ?? 0) === 0) return false;
      if (step.state !== "succeeded") return true;
      if (step.requiresVerification) {
        return step.verification?.status !== "verified";
      }
      return false;
    })
    .map((step) => step.id);

  const eventTypes = [...new Set(task.events.map((event) => event.type))];
  // IMPORTANT: this exact digest payload preserves the pre-1.x M2→M3
  // evidenceDigest algorithm. Skill governance may add checks around it, but
  // must not redefine the evidence identity.
  const evidence = {
    taskId: task.id,
    taskStatus: task.status,
    completedAt: task.completedAt ?? null,
    steps: stepIds.map((id) => {
      const step = task.steps.find((item) => item.id === id);
      return {
        id,
        exists: Boolean(step),
        state: step?.state ?? null,
        primitive: step?.primitive ?? null,
        op: step?.op ?? null,
        resultDigest:
          step?.state === "succeeded" && step.result !== undefined
            ? createHash("sha256")
                .update(JSON.stringify(step.result))
                .digest("hex")
            : null,
      };
    }),
    events: task.events.map((event) => ({
      type: event.type,
      stepId: event.stepId ?? null,
    })),
  };

  return {
    version: 1,
    taskId: task.id,
    taskStatus: task.status,
    completedAt: task.completedAt ?? null,
    stepIds,
    eventTypes,
    evidenceDigest: createHash("sha256")
      .update(JSON.stringify(evidence))
      .digest("hex"),
    allStepsSucceeded:
      selected.length === stepIds.length &&
      existing.every((step) => step.state === "succeeded"),
    unresolvedStepIds,
    verification: {
      requiredStepIds,
      verifiedStepIds,
      failedStepIds,
      uncertainStepIds,
      missingStepIds,
      allRequiredVerified:
        failedStepIds.length === 0 &&
        uncertainStepIds.length === 0 &&
        missingStepIds.length === 0 &&
        verifiedStepIds.length === requiredStepIds.length,
    },
    sideEffects: {
      stepIds: sideEffectStepIds,
      unresolvedStepIds: unresolvedSideEffectStepIds,
    },
  };
}
