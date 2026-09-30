import { createHash } from "node:crypto";
import { PRIMITIVE_ABI_VERSION, routePrimitive } from "../primitives/primitiveRuntime.js";
import {
  getActionContract,
  type ActionContract,
  type RetryPolicy,
  type RiskLevel,
} from "../runtime/actionContracts.js";
import {
  listGlobalEpisodes,
  type GlobalEpisodeRecord,
} from "../runtime/episodicStore.js";
import { buildTaskEvidenceReceipt } from "../runtime/taskEvidence.js";
import {
  readPersistentTask,
  type PersistentTask,
} from "../tasks/taskStore.js";
import {
  USER_SKILL_ABI_VERSION,
  type SkillCandidateRecord,
  type UserSkillInputSpec,
  type UserSkillManifest,
} from "./userSkillTypes.js";
import {
  userSkillDigest,
  validateUserSkillManifest,
} from "./userSkillRuntime.js";
import {
  listSkillCandidates,
  readUserSkillRegistry,
} from "./userSkillStore.js";

export type WorkflowSkillDiscoveryRequest = {
  minSuccessfulRuns?: number;
  scanLimit?: number;
  limit?: number;
  includeBlocked?: boolean;
};

type EligibleRun = {
  episode: GlobalEpisodeRecord;
  task: PersistentTask;
  evidenceDigest: string;
};

type GeneralizedValue = {
  value: unknown;
  inputs: Record<string, UserSkillInputSpec>;
  variablePaths: string[];
  blockedPaths: string[];
};

const RISK_ORDER: Record<RiskLevel, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

const RETRY_ORDER: Record<RetryPolicy, number> = {
  automatic: 0,
  manual: 1,
  never: 2,
};

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, stableValue(child)]),
    );
  }
  return value;
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function digest(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function clampInteger(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value!), min), max);
}

function normalizedStepIds(task: PersistentTask): Map<string, string> {
  return new Map(
    task.steps.map((step, index) => [step.id, `step${index + 1}`]),
  );
}

function normalizeRefs(value: unknown, stepIds: Map<string, string>): unknown {
  if (Array.isArray(value)) {
    return value.map((child) => normalizeRefs(child, stepIds));
  }
  if (!value || typeof value !== "object") return value;
  const object = value as Record<string, unknown>;
  if (Object.keys(object).length === 1 && typeof object.$ref === "string") {
    const [source, ...rest] = object.$ref.split(".");
    const normalized = stepIds.get(source);
    return normalized
      ? { $ref: [normalized, ...rest].join(".") }
      : { $ref: object.$ref };
  }
  return Object.fromEntries(
    Object.entries(object).map(([key, child]) => [
      key,
      normalizeRefs(child, stepIds),
    ]),
  );
}

function structuralDescriptor(task: PersistentTask) {
  const stepIds = normalizedStepIds(task);
  return {
    label: task.label.trim().normalize("NFKC").toLowerCase(),
    steps: task.steps.map((step) => ({
      primitive: step.primitive ?? null,
      op: step.op ?? null,
      dependsOn: step.dependsOn
        .map((id) => stepIds.get(id) ?? id)
        .sort(),
      verificationSpec: step.verificationSpec ?? null,
    })),
  };
}

function scalarType(
  values: unknown[],
): "string" | "number" | "boolean" | null {
  const types = new Set(values.map((value) => typeof value));
  if (types.size !== 1) return null;
  const [type] = [...types];
  return type === "string" || type === "number" || type === "boolean"
    ? type
    : null;
}

export function workflowDiscoveryParameterName(
  stepId: string,
  path: string[],
): string {
  const logical = [stepId, ...path].join("_");
  const normalized = logical
    .replace(/[^A-Za-z0-9_]/g, "_")
    .replace(/_+/g, "_");
  const prefixed = /^[A-Za-z_]/.test(normalized)
    ? normalized
    : `input_${normalized}`;
  const needsSuffix =
    prefixed !== logical ||
    prefixed.length > 64;
  if (!needsSuffix) return prefixed;

  const suffix = digest(logical).slice(0, 10);
  const prefix = prefixed.slice(0, 53).replace(/_+$/g, "") || "input";
  return `${prefix}_${suffix}`.slice(0, 64);
}

function mergeGeneralized(
  target: GeneralizedValue,
  child: GeneralizedValue,
): void {
  Object.assign(target.inputs, child.inputs);
  target.variablePaths.push(...child.variablePaths);
  target.blockedPaths.push(...child.blockedPaths);
}

function generalizeValues(
  values: unknown[],
  stepId: string,
  path: string[],
): GeneralizedValue {
  const result: GeneralizedValue = {
    value: values[0],
    inputs: {},
    variablePaths: [],
    blockedPaths: [],
  };
  if (values.every((value) => stableJson(value) === stableJson(values[0]))) {
    return result;
  }

  const type = scalarType(values);
  if (type) {
    const name = workflowDiscoveryParameterName(
      stepId,
      path.length > 0 ? path : ["value"],
    );
    result.value = { $input: name };
    result.inputs[name] = {
      type,
      required: true,
      description: `Auto-detected variable argument at ${stepId}.${path.join(".") || "value"}`,
    };
    result.variablePaths.push(`${stepId}.${path.join(".") || "value"}`);
    return result;
  }

  if (
    values.every(Array.isArray) &&
    values.every((value) => value.length === (values[0] as unknown[]).length)
  ) {
    const arrays = values as unknown[][];
    const output: unknown[] = [];
    for (let index = 0; index < arrays[0].length; index += 1) {
      const child = generalizeValues(
        arrays.map((array) => array[index]),
        stepId,
        [...path, String(index)],
      );
      output.push(child.value);
      mergeGeneralized(result, child);
    }
    result.value = output;
    return result;
  }

  const objects = values.every(
    (value) => value && typeof value === "object" && !Array.isArray(value),
  );
  if (objects) {
    const records = values as Record<string, unknown>[];
    const keys = Object.keys(records[0]).sort();
    if (
      records.every(
        (record) => stableJson(Object.keys(record).sort()) === stableJson(keys),
      )
    ) {
      const output: Record<string, unknown> = {};
      for (const key of keys) {
        const child = generalizeValues(
          records.map((record) => record[key]),
          stepId,
          [...path, key],
        );
        output[key] = child.value;
        mergeGeneralized(result, child);
      }
      result.value = output;
      return result;
    }
  }

  result.blockedPaths.push(`${stepId}.${path.join(".") || "value"}`);
  return result;
}

function aggregateContract(tasks: PersistentTask[]) {
  const contracts: ActionContract[] = [];
  for (const task of tasks) {
    for (const step of task.steps) {
      const routed = routePrimitive(step.primitive!, step.op!, step.args ?? {});
      contracts.push(getActionContract(routed.routedAction, routed.routedArgs));
    }
  }

  const riskLevel = contracts.reduce<RiskLevel>(
    (current, contract) =>
      RISK_ORDER[contract.riskLevel] > RISK_ORDER[current]
        ? contract.riskLevel
        : current,
    "low",
  );
  const retryPolicy = contracts.reduce<RetryPolicy>(
    (current, contract) =>
      RETRY_ORDER[contract.retryPolicy] > RETRY_ORDER[current]
        ? contract.retryPolicy
        : current,
    "automatic",
  );

  return {
    riskLevel,
    idempotent: contracts.every((contract) => contract.idempotent),
    sideEffects: [
      ...new Set(contracts.flatMap((contract) => contract.sideEffects)),
    ].sort(),
    retryPolicy,
    requiresVerification: contracts.some(
      (contract) => contract.requiresVerification,
    ),
    resources: [],
  };
}

function slugify(label: string): string {
  const slug = label
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "workflow";
}

function candidateSkillId(record: SkillCandidateRecord): string | null {
  const revision = record.revisions.find(
    (item) => item.digest === record.currentDigest,
  );
  const manifest = revision?.manifest;
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return null;
  }
  const id = (manifest as Record<string, unknown>).id;
  return typeof id === "string" && id.trim() ? id : null;
}

function verificationForStep(
  tasks: PersistentTask[],
  index: number,
): PersistentTask["steps"][number]["verificationSpec"] | undefined {
  const specs = tasks.map((task) => task.steps[index]?.verificationSpec);
  return specs.every((spec) => stableJson(spec) === stableJson(specs[0]))
    ? specs[0]
    : undefined;
}

function buildDraft(
  runs: EligibleRun[],
  structuralDigest: string,
): {
  manifest: UserSkillManifest | null;
  variablePaths: string[];
  blockedPaths: string[];
} {
  const tasks = runs.map((run) => run.task);
  const representative = tasks[0]!;
  const perTaskStepIds = tasks.map(normalizedStepIds);
  const inputs: Record<string, UserSkillInputSpec> = {};
  const variablePaths: string[] = [];
  const blockedPaths: string[] = [];

  const steps = representative.steps.map((step, index) => {
    const id = `step${index + 1}`;
    const normalizedArgs = tasks.map((task, taskIndex) =>
      normalizeRefs(task.steps[index]!.args ?? {}, perTaskStepIds[taskIndex]!),
    );
    const generalized = generalizeValues(normalizedArgs, id, []);
    Object.assign(inputs, generalized.inputs);
    variablePaths.push(...generalized.variablePaths);
    blockedPaths.push(...generalized.blockedPaths);
    const verify = verificationForStep(tasks, index);

    return {
      id,
      primitive: step.primitive!,
      op: step.op!,
      args: generalized.value as Record<string, unknown>,
      dependsOn: step.dependsOn.map(
        (dependency) => perTaskStepIds[0]!.get(dependency) ?? dependency,
      ),
      ...(verify ? { verify } : {}),
    };
  });

  if (blockedPaths.length > 0) {
    return { manifest: null, variablePaths, blockedPaths };
  }

  const taskIds = runs.map((run) => run.task.id);
  const episodeIds = runs.map((run) => run.episode.id);
  const label = representative.label.trim() || "Repeated workflow";
  const manifest: UserSkillManifest = {
    schemaVersion: 1,
    skillAbiVersion: USER_SKILL_ABI_VERSION,
    id: `user.workflow.${slugify(label)}-${structuralDigest.slice(0, 8)}`,
    version: "0.1.0",
    title: label.slice(0, 200),
    description:
      `Auto-drafted from ${runs.length} independently completed Runtime tasks with the same Primitive graph. Review, validate, test, and explicitly promote before production use.`,
    requiredPrimitiveAbi: PRIMITIVE_ABI_VERSION,
    requiredPrimitives: [
      ...new Set(steps.map((step) => step.primitive)),
    ].sort(),
    executionMode: "durable",
    inputs,
    contract: aggregateContract(tasks),
    steps,
    provenance: {
      origin: "workflow",
      sourceTaskIds: taskIds,
      sourceMemoryIds: episodeIds,
    },
  };
  return { manifest, variablePaths, blockedPaths };
}

async function eligibleRun(
  episode: GlobalEpisodeRecord,
): Promise<EligibleRun | null> {
  if (episode.status !== "completed" || episode.provenance) return null;

  let task: PersistentTask;
  try {
    task = await readPersistentTask(episode.taskId);
  } catch {
    return null;
  }

  if (
    task.status !== "completed" ||
    task.provenance ||
    !task.events.some((event) => event.type === "task_completed") ||
    task.steps.length < 2 ||
    task.steps.length > 50 ||
    task.steps.some(
      (step) =>
        step.executionKind !== "primitive" ||
        !step.primitive ||
        !step.op ||
        step.primitive === "sys.exec",
    )
  ) {
    return null;
  }

  const evidence = buildTaskEvidenceReceipt(
    task,
    task.steps.map((step) => step.id),
  );
  if (
    !evidence.allStepsSucceeded ||
    !evidence.verification.allRequiredVerified ||
    evidence.sideEffects.unresolvedStepIds.length > 0 ||
    !episode.evidenceDigest
  ) {
    return null;
  }

  // M2 captures its evidence digest before the Runtime appends later
  // bookkeeping events such as global_episode_indexed. Recomputing the Task
  // receipt afterwards can therefore produce a different digest even though
  // the historical M2 evidence is valid. Keep the immutable episode digest as
  // the source identity and re-check current Task success/verification above.
  return {
    episode,
    task,
    evidenceDigest: episode.evidenceDigest,
  };
}

export async function discoverWorkflowSkillCandidates(
  request: WorkflowSkillDiscoveryRequest = {},
) {
  const minSuccessfulRuns = clampInteger(
    request.minSuccessfulRuns,
    3,
    2,
    20,
  );
  const scanLimit = clampInteger(request.scanLimit, 500, 10, 5000);
  const limit = clampInteger(request.limit, 20, 1, 100);
  const includeBlocked = request.includeBlocked ?? false;
  const episodes = (await listGlobalEpisodes()).slice(0, scanLimit);

  const eligible: EligibleRun[] = [];
  for (const episode of episodes) {
    const run = await eligibleRun(episode);
    if (run) eligible.push(run);
  }

  const groups = new Map<string, EligibleRun[]>();
  for (const run of eligible) {
    const structuralDigest = digest(structuralDescriptor(run.task));
    const group = groups.get(structuralDigest) ?? [];
    group.push(run);
    groups.set(structuralDigest, group);
  }

  const proposals: unknown[] = [];
  const blocked: unknown[] = [];
  const repeatedGroups = [...groups.entries()]
    .filter(([, runs]) => runs.length >= minSuccessfulRuns)
    .sort(
      (a, b) =>
        b[1].length - a[1].length ||
        a[0].localeCompare(b[0]),
    );

  const candidateRecords =
    repeatedGroups.length > 0 ? await listSkillCandidates() : [];

  for (const [structuralDigest, runs] of repeatedGroups) {
    const evidenceRuns = runs.slice(0, 100);
    const built = buildDraft(evidenceRuns, structuralDigest);
    const support = {
      successfulRuns: runs.length,
      sourceRunsUsed: evidenceRuns.length,
      distinctArgumentSets: new Set(
        runs.map((run) =>
          digest(
            run.task.steps.map((step) =>
              normalizeRefs(step.args ?? {}, normalizedStepIds(run.task)),
            ),
          ),
        ),
      ).size,
      recoveryFreeRuns: runs.filter((run) =>
        run.task.steps.every((step) => step.attempts <= 1),
      ).length,
      taskIds: evidenceRuns.map((run) => run.task.id),
      episodeIds: evidenceRuns.map((run) => run.episode.id),
      evidenceDigests: evidenceRuns.map((run) => run.evidenceDigest),
    };

    if (!built.manifest) {
      if (includeBlocked) {
        blocked.push({
          proposalId: `workflow_${structuralDigest.slice(0, 24)}`,
          structuralDigest,
          support,
          blockedReason: "UNPARAMETERIZABLE_ARGUMENT_VARIATION",
          blockedPaths: built.blockedPaths,
        });
      }
      continue;
    }

    const candidateDigest = userSkillDigest(built.manifest);
    const validation = validateUserSkillManifest(
      `proposal_${structuralDigest.slice(0, 24)}`,
      candidateDigest,
      built.manifest,
    ).report;

    const matchingCandidates = candidateRecords
      .filter((record) => candidateSkillId(record) === built.manifest!.id)
      .map((record) => ({
        candidateId: record.id,
        status: record.status,
        currentDigest: record.currentDigest,
        exactDigest: record.currentDigest === candidateDigest,
      }));
    const registry = await readUserSkillRegistry(built.manifest.id);
    const exactDigestCandidateIds = matchingCandidates
      .filter((record) => record.exactDigest)
      .map((record) => record.candidateId);
    const liveCandidates = matchingCandidates.filter(
      (record) => record.status !== "dismissed",
    );
    const exactLiveCandidateIds = liveCandidates
      .filter((record) => record.exactDigest)
      .map((record) => record.candidateId);
    const exactDismissedCandidateIds = matchingCandidates
      .filter(
        (record) => record.status === "dismissed" && record.exactDigest,
      )
      .map((record) => record.candidateId);
    const governanceState = registry
      ? "installed"
      : liveCandidates.length > 0
        ? "candidate_exists"
        : exactDismissedCandidateIds.length > 0
          ? "dismissed"
          : "new";

    proposals.push({
      version: 1,
      proposalId: `workflow_${structuralDigest.slice(0, 24)}`,
      structuralDigest,
      source: "m2_episodic_evidence",
      support,
      parameterization: {
        inputNames: Object.keys(built.manifest.inputs).sort(),
        variablePaths: [...new Set(built.variablePaths)].sort(),
      },
      manifestDigest: candidateDigest,
      manifest: built.manifest,
      validation,
      governance: {
        state: governanceState,
        evidenceRefreshAvailable:
          governanceState === "candidate_exists" &&
          exactLiveCandidateIds.length === 0,
        exactDigestCandidateIds,
        exactLiveCandidateIds,
        exactDismissedCandidateIds,
        candidates: matchingCandidates,
        installed: registry
          ? {
              enabled: registry.enabled,
              activeVersion: registry.activeVersion,
              versions: Object.keys(registry.versions).sort(),
            }
          : null,
      },
      readyForSubmit: validation.valid && governanceState === "new",
      requiresExplicitSubmit: true,
      requiresTestBeforePromotion: true,
      autoPromoted: false,
    });

    if (proposals.length >= limit) break;
  }

  return {
    version: 1,
    policy: {
      minSuccessfulRuns,
      oneRunNeverEnough: true,
      minimumStepCount: 2,
      onlyCompletedPrimitiveTasks: true,
      requiresResolvedVerification: true,
      excludesDerivedSkillRuns: true,
      labelAndVerificationBoundClustering: true,
      writesCandidateStore: false,
      autoPromotes: false,
    },
    scannedEpisodes: episodes.length,
    eligibleRuns: eligible.length,
    repeatedGroups: repeatedGroups.length,
    proposalCount: proposals.length,
    proposals,
    ...(includeBlocked ? { blocked } : {}),
  };
}
