import { createHash } from "node:crypto";
import { z } from "zod";
import {
  PRIMITIVE_ABI_VERSION,
  getPrimitiveCatalog,
  routePrimitive,
} from "../primitives/primitiveRuntime.js";
import { getActionContract } from "../runtime/actionContracts.js";
import {
  createPersistentPrimitiveTask,
  getPersistentTaskStatus,
  validatePrimitiveTaskSteps,
  type PrimitiveTaskStep,
} from "../tasks/taskRuntime.js";
import { readPersistentTask } from "../tasks/taskStore.js";
import { buildTaskEvidenceReceipt } from "../runtime/taskEvidence.js";
import {
  detectObviousSecrets,
  inspectPromotionCandidate,
} from "../runtime/memoryPromotion.js";
import { readGlobalEpisode } from "../runtime/episodicStore.js";
import { authorizeSkill } from "../policy/approvalPolicy.js";
import { injectTestFault } from "../runtime/faultInjection.js";
import { resourceArbiter } from "../runtime/resourceArbiter.js";
import { verificationSpecSchema } from "../verification/verifier.js";
import {
  listSkillCandidates,
  listUserSkillRegistries,
  readSkillCandidate,
  readUserSkillRegistry,
  writeSkillCandidate,
  writeUserSkillRegistry,
} from "./userSkillStore.js";
import {
  USER_SKILL_ABI_VERSION,
  type DerivedSkillContract,
  type SkillCandidateRecord,
  type SkillCandidateValidationReport,
  type SkillPromotionReceipt,
  type SkillValidationIssue,
  type UserSkillContract,
  type UserSkillInputSpec,
  type UserSkillManifest,
  type UserSkillRegistryRecord,
  type UserSkillRetryPolicy,
  type UserSkillRiskLevel,
  type UserSkillStep,
} from "./userSkillTypes.js";

const RISK_ORDER: Record<UserSkillRiskLevel, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};
const RETRY_ORDER: Record<UserSkillRetryPolicy, number> = {
  automatic: 0,
  manual: 1,
  never: 2,
};


const FORBIDDEN_USER_SKILL_PRIMITIVES = new Set([
  "sys.exec",
]);

function candidateResource(candidateId: string) {
  return [{ key: `skill-candidate:${candidateId}`, mode: "exclusive" as const }];
}

function userSkillResource(skillId: string, mode: "shared" | "exclusive" = "exclusive") {
  return [{ key: `user-skill:${skillId}`, mode }];
}

async function withSkillGovernanceResources<T>(
  action: string,
  resources: Array<{ key: string; mode: "shared" | "exclusive" }>,
  operation: () => Promise<T>,
): Promise<T> {
  const leased = await resourceArbiter.withResources(action, resources, operation);
  return leased.result;
}

const inputSpecSchema = z.object({
  type: z.enum(["string", "number", "boolean"]),
  required: z.boolean().optional(),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  description: z.string().min(1).max(500).optional(),
}).strict();

const resourceSchema = z.object({
  key: z.string().min(1).max(512),
  mode: z.enum(["shared", "exclusive"]),
}).strict();

const contractSchema = z.object({
  riskLevel: z.enum(["low", "medium", "high", "critical"]),
  idempotent: z.boolean(),
  sideEffects: z.array(z.string().min(1).max(128)).max(64),
  retryPolicy: z.enum(["automatic", "manual", "never"]),
  requiresVerification: z.boolean(),
  resources: z.array(resourceSchema).max(64).optional(),
}).strict();

const stepSchema = z.object({
  id: z.string().min(1).max(64),
  primitive: z.string().min(1).max(128),
  op: z.string().min(1).max(128),
  args: z.record(z.unknown()).optional(),
  dependsOn: z.array(z.string().min(1).max(64)).max(50).optional(),
  verify: verificationSpecSchema.optional(),
}).strict();

const manifestSchema = z.object({
  schemaVersion: z.literal(1),
  skillAbiVersion: z.literal(USER_SKILL_ABI_VERSION),
  id: z.string().min(1).max(128),
  version: z.string().min(1).max(64),
  title: z.string().min(1).max(200),
  description: z.string().min(1).max(2000),
  requiredPrimitiveAbi: z.number().int().min(1),
  requiredPrimitives: z.array(z.string().min(1).max(128)).max(128),
  executionMode: z.literal("durable"),
  inputs: z.record(inputSpecSchema),
  contract: contractSchema,
  steps: z.array(stepSchema).min(1).max(50),
  provenance: z
    .object({
      origin: z.enum(["external", "workflow", "semantic", "user"]).optional(),
      sourceTaskIds: z.array(z.string().min(1).max(128)).max(100).optional(),
      sourceMemoryIds: z.array(z.string().min(1).max(128)).max(100).optional(),
    }).strict()
    .optional(),
}).strict();

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

export function userSkillDigest(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(stableValue(value)))
    .digest("hex");
}

function newCandidateId(digest: string): string {
  return "candidate_" + digest.slice(0, 24);
}

function issue(
  code: string,
  path: string,
  message: string,
  extra: Partial<SkillValidationIssue> = {},
): SkillValidationIssue {
  return { code, file: "skill.json", path, message, ...extra };
}

function allowedPrimitiveEntries() {
  return (getPrimitiveCatalog() as Array<Record<string, unknown>>).filter(
    (entry) =>
      entry.canonical === true &&
      (entry.tier ?? "core") === "core" &&
      entry.deprecated !== true &&
      !FORBIDDEN_USER_SKILL_PRIMITIVES.has(String(entry.id)),
  );
}

function collectTemplateRefs(
  value: unknown,
  inputs: Set<string>,
  refs: Set<string>,
): void {
  if (Array.isArray(value)) {
    for (const child of value) collectTemplateRefs(child, inputs, refs);
    return;
  }
  if (!value || typeof value !== "object") return;
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object);
  if (keys.length === 1 && typeof object.$input === "string") {
    inputs.add(object.$input);
    return;
  }
  if (keys.length === 1 && typeof object.$ref === "string") {
    const [stepId] = object.$ref.split(".");
    if (stepId) refs.add(stepId);
    return;
  }
  for (const child of Object.values(object)) {
    collectTemplateRefs(child, inputs, refs);
  }
}

function deriveContract(
  manifest: UserSkillManifest,
  errors: SkillValidationIssue[],
  warnings: SkillValidationIssue[],
): DerivedSkillContract | null {
  const allowed = new Map(
    allowedPrimitiveEntries().map((entry) => [String(entry.id), entry]),
  );
  const stepIds = new Set(manifest.steps.map((step) => step.id));
  const usedPrimitives = new Set<string>();
  const contracts: ReturnType<typeof getActionContract>[] = [];

  manifest.steps.forEach((step, index) => {
    const path = "steps." + index;
    const primitive = allowed.get(step.primitive);
    if (!primitive) {
      const catalog = (getPrimitiveCatalog() as Array<Record<string, unknown>>).find(
        (entry) => entry.id === step.primitive,
      );
      errors.push(
        issue(
          catalog
            ? "USER_SKILL_PRIMITIVE_NOT_ALLOWED"
            : "USER_SKILL_PRIMITIVE_UNKNOWN",
          path + ".primitive",
          catalog
            ? "User Skills may use only canonical core Primitives."
            : "Unknown Primitive.",
          {
            actual: step.primitive,
            allowed: [...allowed.keys()],
          },
        ),
      );
      return;
    }

    usedPrimitives.add(step.primitive);
    try {
      const routed = routePrimitive(step.primitive, step.op, step.args ?? {});
      contracts.push(getActionContract(routed.routedAction, routed.routedArgs));
    } catch (error) {
      errors.push(
        issue(
          "USER_SKILL_PRIMITIVE_OP_INVALID",
          path + ".op",
          error instanceof Error ? error.message : String(error),
          { actual: step.op },
        ),
      );
    }

    const inputRefs = new Set<string>();
    const stepRefs = new Set<string>();
    collectTemplateRefs(step.args ?? {}, inputRefs, stepRefs);
    for (const name of inputRefs) {
      if (!(name in manifest.inputs)) {
        errors.push(
          issue(
            "USER_SKILL_INPUT_REFERENCE_UNKNOWN",
            path + ".args",
            "Template references an undeclared input.",
            { actual: name, allowed: Object.keys(manifest.inputs) },
          ),
        );
      }
    }
    for (const ref of stepRefs) {
      if (!stepIds.has(ref)) {
        errors.push(
          issue(
            "USER_SKILL_STEP_REFERENCE_UNKNOWN",
            path + ".args",
            "Template references an unknown step.",
            { actual: ref, allowed: [...stepIds] },
          ),
        );
      }
    }
  });

  const declaredRequired = new Set(manifest.requiredPrimitives);
  for (const primitive of declaredRequired) {
    if (!allowed.has(primitive)) {
      errors.push(
        issue(
          "USER_SKILL_REQUIRED_PRIMITIVE_NOT_ALLOWED",
          "requiredPrimitives",
          "requiredPrimitives may contain only canonical core Primitives.",
          { actual: primitive, allowed: [...allowed.keys()] },
        ),
      );
    }
  }
  for (const primitive of usedPrimitives) {
    if (!declaredRequired.has(primitive)) {
      errors.push(
        issue(
          "USER_SKILL_REQUIRED_PRIMITIVE_MISSING",
          "requiredPrimitives",
          "A Primitive used by the graph is missing from requiredPrimitives.",
          { required: primitive, actual: manifest.requiredPrimitives },
        ),
      );
    }
  }
  for (const primitive of declaredRequired) {
    if (!usedPrimitives.has(primitive)) {
      warnings.push(
        issue(
          "USER_SKILL_REQUIRED_PRIMITIVE_UNUSED",
          "requiredPrimitives",
          "A declared required Primitive is not used by this graph.",
          { actual: primitive },
        ),
      );
    }
  }

  if (contracts.length === 0) return null;

  const highestRisk = contracts.reduce<UserSkillRiskLevel>(
    (current, contract) =>
      RISK_ORDER[contract.riskLevel] > RISK_ORDER[current]
        ? contract.riskLevel
        : current,
    "low",
  );
  const strictestRetry = contracts.reduce<UserSkillRetryPolicy>(
    (current, contract) =>
      RETRY_ORDER[contract.retryPolicy] > RETRY_ORDER[current]
        ? contract.retryPolicy
        : current,
    "automatic",
  );
  const sideEffects = [
    ...new Set(contracts.flatMap((contract) => contract.sideEffects)),
  ].sort();
  const resourcesByKey = new Map<
    string,
    { key: string; mode: "shared" | "exclusive" }
  >();
  for (const contract of contracts) {
    for (const resource of contract.resources) {
      const existing = resourcesByKey.get(resource.key);
      if (!existing || resource.mode === "exclusive") {
        resourcesByKey.set(resource.key, { ...resource });
      }
    }
  }

  const derived: DerivedSkillContract = {
    riskLevel: highestRisk,
    idempotent: contracts.every((contract) => contract.idempotent),
    sideEffects,
    retryPolicy: strictestRetry,
    requiresVerification: contracts.some(
      (contract) => contract.requiresVerification,
    ),
    resources: [...resourcesByKey.values()].sort((a, b) =>
      a.key.localeCompare(b.key),
    ),
  };

  const declared = manifest.contract;
  if (RISK_ORDER[declared.riskLevel] < RISK_ORDER[derived.riskLevel]) {
    errors.push(
      issue(
        "USER_SKILL_CONTRACT_RISK_UNDERSTATED",
        "contract.riskLevel",
        "Declared riskLevel is lower than the Primitive graph requires.",
        { actual: declared.riskLevel, required: derived.riskLevel },
      ),
    );
  }
  if (!derived.idempotent && declared.idempotent) {
    errors.push(
      issue(
        "USER_SKILL_CONTRACT_IDEMPOTENCY_UNDERSTATED",
        "contract.idempotent",
        "The graph contains non-idempotent execution but the Skill declares idempotent=true.",
        { actual: true, required: false },
      ),
    );
  }
  const declaredEffects = new Set(declared.sideEffects);
  const missingEffects = derived.sideEffects.filter(
    (effect) => !declaredEffects.has(effect),
  );
  if (missingEffects.length > 0) {
    errors.push(
      issue(
        "USER_SKILL_CONTRACT_SIDE_EFFECT_MISSING",
        "contract.sideEffects",
        "Declared sideEffects omit effects required by the Primitive graph.",
        { actual: declared.sideEffects, required: derived.sideEffects },
      ),
    );
  }
  if (
    RETRY_ORDER[declared.retryPolicy] < RETRY_ORDER[derived.retryPolicy]
  ) {
    errors.push(
      issue(
        "USER_SKILL_CONTRACT_RETRY_TOO_PERMISSIVE",
        "contract.retryPolicy",
        "Declared retryPolicy is more permissive than the graph allows.",
        { actual: declared.retryPolicy, required: derived.retryPolicy },
      ),
    );
  }
  if (derived.requiresVerification && !declared.requiresVerification) {
    errors.push(
      issue(
        "USER_SKILL_CONTRACT_VERIFICATION_UNDERSTATED",
        "contract.requiresVerification",
        "The graph requires verification but the Skill disables it.",
        { actual: false, required: true },
      ),
    );
  }

  manifest.steps.forEach((step, index) => {
    try {
      const routed = routePrimitive(step.primitive, step.op, step.args ?? {});
      const contract = getActionContract(routed.routedAction, routed.routedArgs);
      if (contract.requiresVerification && !step.verify) {
        warnings.push(
          issue(
            "USER_SKILL_DEFAULT_VERIFIER_DEPENDENCY",
            "steps." + index + ".verify",
            "This step depends on the Runtime default verifier. Promotion will still require a verified receipt.",
          ),
        );
      }
    } catch {
      // Already reported above.
    }
  });

  return derived;
}

function effectiveContract(
  declared: UserSkillContract,
  derived: DerivedSkillContract,
): DerivedSkillContract {
  const resources = new Map<string, { key: string; mode: "shared" | "exclusive" }>();
  for (const resource of [...derived.resources, ...(declared.resources ?? [])]) {
    const existing = resources.get(resource.key);
    if (!existing || resource.mode === "exclusive") {
      resources.set(resource.key, { ...resource });
    }
  }
  return {
    riskLevel:
      RISK_ORDER[declared.riskLevel] >= RISK_ORDER[derived.riskLevel]
        ? declared.riskLevel
        : derived.riskLevel,
    idempotent: declared.idempotent && derived.idempotent,
    sideEffects: [...new Set([...derived.sideEffects, ...declared.sideEffects])].sort(),
    retryPolicy:
      RETRY_ORDER[declared.retryPolicy] >= RETRY_ORDER[derived.retryPolicy]
        ? declared.retryPolicy
        : derived.retryPolicy,
    requiresVerification:
      declared.requiresVerification || derived.requiresVerification,
    resources: [...resources.values()].sort((a, b) => a.key.localeCompare(b.key)),
  };
}

export function validateUserSkillManifest(
  candidateId: string,
  candidateDigest: string,
  raw: unknown,
): {
  report: SkillCandidateValidationReport;
  manifest: UserSkillManifest | null;
} {
  const errors: SkillValidationIssue[] = [];
  const warnings: SkillValidationIssue[] = [];
  const allowedPrimitives = allowedPrimitiveEntries().map((entry) =>
    String(entry.id),
  );

  const actualDigest = userSkillDigest(raw);
  if (actualDigest !== candidateDigest) {
    errors.push(
      issue(
        "USER_SKILL_CANDIDATE_DIGEST_CORRUPT",
        "$",
        "Candidate content does not match the digest bound to this revision.",
        { actual: actualDigest, required: candidateDigest },
      ),
    );
  }

  const secretMatches = detectObviousSecrets(JSON.stringify(stableValue(raw)));
  if (secretMatches.length > 0) {
    errors.push(
      issue(
        "USER_SKILL_EMBEDDED_SECRET_BLOCKED",
        "$",
        "User Skill manifests must not embed credentials or secret material. Pass secrets through governed inputs/providers instead.",
        { actual: secretMatches },
      ),
    );
  }

  const parsed = manifestSchema.safeParse(raw);
  if (!parsed.success) {
    for (const zodIssue of parsed.error.issues) {
      errors.push(
        issue(
          "USER_SKILL_SCHEMA_INVALID",
          zodIssue.path.join(".") || "$",
          zodIssue.message,
        ),
      );
    }
    return {
      manifest: null,
      report: {
        reportVersion: 1,
        candidateId,
        candidateDigest,
        valid: false,
        targetSkillAbi: USER_SKILL_ABI_VERSION,
        primitiveAbi: { runtime: PRIMITIVE_ABI_VERSION, required: null },
        requiredPrimitives: [],
        allowedPrimitives,
        derivedContract: null,
        effectiveContract: null,
        errors,
        warnings,
        validatedAt: new Date().toISOString(),
      },
    };
  }

  const manifest = parsed.data as UserSkillManifest;

  if (!/^user\.[a-z0-9][a-z0-9._-]{0,122}$/.test(manifest.id)) {
    errors.push(
      issue(
        "USER_SKILL_ID_INVALID",
        "id",
        "Phase 1 User Skill ids must use the user.* namespace and lowercase stable characters.",
        { actual: manifest.id, required: "user.<name>" },
      ),
    );
  }
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version)) {
    errors.push(
      issue(
        "USER_SKILL_VERSION_INVALID",
        "version",
        "Skill version must be semantic version-like (for example 1.0.0).",
        { actual: manifest.version },
      ),
    );
  }
  if (manifest.requiredPrimitiveAbi > PRIMITIVE_ABI_VERSION) {
    errors.push(
      issue(
        "USER_SKILL_PRIMITIVE_ABI_UNSUPPORTED",
        "requiredPrimitiveAbi",
        "Candidate requires a newer Primitive ABI than this Runtime supports.",
        {
          actual: manifest.requiredPrimitiveAbi,
          allowed: PRIMITIVE_ABI_VERSION,
        },
      ),
    );
  }

  for (const [name, spec] of Object.entries(manifest.inputs)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name)) {
      errors.push(
        issue(
          "USER_SKILL_INPUT_NAME_INVALID",
          "inputs." + name,
          "Input names must be stable identifiers.",
          { actual: name },
        ),
      );
    }
    if (
      spec.default !== undefined &&
      typeof spec.default !== spec.type
    ) {
      errors.push(
        issue(
          "USER_SKILL_INPUT_DEFAULT_TYPE_MISMATCH",
          "inputs." + name + ".default",
          "Input default does not match its declared type.",
          { actual: typeof spec.default, required: spec.type },
        ),
      );
    }
  }

  const derivedContract = deriveContract(manifest, errors, warnings);
  const normalizedContract = derivedContract
    ? effectiveContract(manifest.contract, derivedContract)
    : null;

  const report: SkillCandidateValidationReport = {
    reportVersion: 1,
    candidateId,
    candidateDigest,
    valid: errors.length === 0,
    targetSkillAbi: USER_SKILL_ABI_VERSION,
    primitiveAbi: {
      runtime: PRIMITIVE_ABI_VERSION,
      required: manifest.requiredPrimitiveAbi,
    },
    requiredPrimitives: [...new Set(manifest.requiredPrimitives)].sort(),
    allowedPrimitives,
    derivedContract,
    effectiveContract: normalizedContract,
    errors,
    warnings,
    validatedAt: new Date().toISOString(),
  };
  return { report, manifest };
}

export async function submitSkillCandidate(manifest: unknown) {
  const encoded = JSON.stringify(stableValue(manifest));
  if (Buffer.byteLength(encoded, "utf8") > 256 * 1024) {
    throw new Error("USER_SKILL_CANDIDATE_TOO_LARGE: maximum encoded size is 256 KiB.");
  }
  const digest = userSkillDigest(manifest);
  const id = newCandidateId(digest);
  return await withSkillGovernanceResources(
    "skill-candidate.submit",
    candidateResource(id),
    async () => {
      try {
        const existing = await readSkillCandidate(id);
        const originalDigest = existing.revisions[0]?.digest;
        if (originalDigest !== digest) {
          throw new Error("USER_SKILL_CANDIDATE_ID_COLLISION");
        }
        return { idempotent: true, candidate: existing };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }

      const now = new Date().toISOString();
      const record: SkillCandidateRecord = {
        version: 1,
        id,
        status: "active",
        createdAt: now,
        updatedAt: now,
        revision: 1,
        currentDigest: digest,
        revisions: [{ revision: 1, digest, createdAt: now, manifest }],
        tests: [],
      };
      await writeSkillCandidate(record);
      return { idempotent: false, candidate: record };
    },
  );
}

export async function getSkillCandidate(id: string) {
  return await readSkillCandidate(id);
}

export async function getSkillCandidates() {
  return await listSkillCandidates();
}

export async function reviseSkillCandidate(input: {
  candidateId: string;
  expectedDigest: string;
  manifest: unknown;
}) {
  return await withSkillGovernanceResources(
    "skill-candidate.revise",
    candidateResource(input.candidateId),
    async () => {

      const record = await readSkillCandidate(input.candidateId);
      if (record.status !== "active") {
        throw new Error(
          "USER_SKILL_CANDIDATE_NOT_REVISABLE: candidate is " + record.status + ".",
        );
      }
      if (record.currentDigest !== input.expectedDigest) {
        throw new Error(
          "USER_SKILL_CANDIDATE_DIGEST_MISMATCH: expected=" +
            input.expectedDigest +
            " current=" +
            record.currentDigest,
        );
      }
      const digest = userSkillDigest(input.manifest);
      if (digest === record.currentDigest) {
        return { idempotent: true, candidate: record };
      }
      const now = new Date().toISOString();
      record.revision += 1;
      record.currentDigest = digest;
      record.revisions.push({
        revision: record.revision,
        digest,
        createdAt: now,
        manifest: input.manifest,
      });
      record.validation = undefined;
      await writeSkillCandidate(record);
      return { idempotent: false, candidate: record };
    },
  );
}

function currentManifest(record: SkillCandidateRecord): unknown {
  const revision = record.revisions.find(
    (item) => item.digest === record.currentDigest,
  );
  if (!revision) {
    throw new Error("USER_SKILL_CANDIDATE_CORRUPT: current revision is missing.");
  }
  return revision.manifest;
}

export async function validateSkillCandidate(input: {
  candidateId: string;
  expectedDigest?: string;
}) {
  return await withSkillGovernanceResources(
    "skill-candidate.validate",
    candidateResource(input.candidateId),
    async () => {

      const record = await readSkillCandidate(input.candidateId);
      if (
        input.expectedDigest &&
        record.currentDigest !== input.expectedDigest
      ) {
        throw new Error(
          "USER_SKILL_CANDIDATE_DIGEST_MISMATCH: expected=" +
            input.expectedDigest +
            " current=" +
            record.currentDigest,
        );
      }
      const result = validateUserSkillManifest(
        record.id,
        record.currentDigest,
        currentManifest(record),
      );
      record.validation = result.report;
      await writeSkillCandidate(record);
      return result.report;
    },
  );
}

export async function dismissSkillCandidate(input: {
  candidateId: string;
  expectedDigest?: string;
}) {
  return await withSkillGovernanceResources(
    "skill-candidate.dismiss",
    candidateResource(input.candidateId),
    async () => {

      const record = await readSkillCandidate(input.candidateId);
      if (
        input.expectedDigest &&
        record.currentDigest !== input.expectedDigest
      ) {
        throw new Error("USER_SKILL_CANDIDATE_DIGEST_MISMATCH");
      }
      if (record.status === "dismissed") return record;
      if (record.status === "promoted") {
        throw new Error("USER_SKILL_CANDIDATE_ALREADY_PROMOTED");
      }
      record.status = "dismissed";
      record.dismissedAt = new Date().toISOString();
      await writeSkillCandidate(record);
      return record;
    },
  );
}

function validateInputs(
  specs: Record<string, UserSkillInputSpec>,
  raw: Record<string, unknown>,
) {
  const errors: SkillValidationIssue[] = [];
  const values: Record<string, string | number | boolean> = {};
  for (const name of Object.keys(raw)) {
    if (!(name in specs)) {
      errors.push(
        issue(
          "USER_SKILL_INPUT_UNKNOWN",
          "inputs." + name,
          "Execution supplied an undeclared input.",
          { actual: name, allowed: Object.keys(specs) },
        ),
      );
    }
  }
  for (const [name, spec] of Object.entries(specs)) {
    const supplied = raw[name];
    const value = supplied === undefined ? spec.default : supplied;
    if (value === undefined) {
      if (spec.required !== false) {
        errors.push(
          issue(
            "USER_SKILL_INPUT_REQUIRED",
            "inputs." + name,
            "Required input is missing.",
            { required: spec.type },
          ),
        );
      }
      continue;
    }
    if (typeof value !== spec.type) {
      errors.push(
        issue(
          "USER_SKILL_INPUT_TYPE_MISMATCH",
          "inputs." + name,
          "Input value has the wrong type.",
          { actual: typeof value, required: spec.type },
        ),
      );
      continue;
    }
    values[name] = value as string | number | boolean;
  }
  return { errors, values };
}

function materializeTemplate(
  value: unknown,
  inputs: Record<string, string | number | boolean>,
): unknown {
  if (Array.isArray(value)) {
    return value.map((child) => materializeTemplate(child, inputs));
  }
  if (!value || typeof value !== "object") return value;
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object);
  if (keys.length === 1 && typeof object.$input === "string") {
    if (!(object.$input in inputs)) {
      throw new Error(
        "USER_SKILL_INPUT_REQUIRED: missing input " + object.$input,
      );
    }
    return inputs[object.$input];
  }
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(object)) {
    result[key] = materializeTemplate(child, inputs);
  }
  return result;
}

function materializeSteps(
  manifest: UserSkillManifest,
  inputs: Record<string, string | number | boolean>,
): PrimitiveTaskStep[] {
  return manifest.steps.map((step) => ({
    id: step.id,
    primitive: step.primitive,
    op: step.op,
    args: materializeTemplate(step.args ?? {}, inputs) as Record<string, unknown>,
    dependsOn: step.dependsOn,
    verify: step.verify,
  }));
}

function testTaskId(candidateDigest: string, inputDigest: string): string {
  const binding = createHash("sha256")
    .update(candidateDigest + "|" + inputDigest)
    .digest("hex")
    .slice(0, 48);
  return "task_skilltest_" + binding;
}

export async function compileSkillCandidateTest(input: {
  candidateId: string;
  expectedDigest: string;
  inputs?: Record<string, unknown>;
}) {
  return await withSkillGovernanceResources(
    "skill-candidate.compile-test",
    candidateResource(input.candidateId),
    async () => {

      const record = await readSkillCandidate(input.candidateId);
      if (record.currentDigest !== input.expectedDigest) {
        throw new Error(
          "USER_SKILL_CANDIDATE_DIGEST_MISMATCH: expected=" +
            input.expectedDigest +
            " current=" +
            record.currentDigest,
        );
      }

      const validated = validateUserSkillManifest(
        record.id,
        record.currentDigest,
        currentManifest(record),
      );
      record.validation = validated.report;
      await writeSkillCandidate(record);
      if (!validated.report.valid || !validated.manifest) {
        return { compiled: false, validation: validated.report };
      }

      const inputValidation = validateInputs(
        validated.manifest.inputs,
        input.inputs ?? {},
      );
      if (inputValidation.errors.length > 0) {
        return {
          compiled: false,
          validation: validated.report,
          inputErrors: inputValidation.errors,
        };
      }

      const steps = materializeSteps(validated.manifest, inputValidation.values);
      try {
        validatePrimitiveTaskSteps(steps);
      } catch (error) {
        return {
          compiled: false,
          validation: validated.report,
          compileErrors: [
            issue(
              "USER_SKILL_TEST_COMPILE_FAILED",
              "steps",
              error instanceof Error ? error.message : String(error),
            ),
          ],
        };
      }

      const inputDigest = userSkillDigest(inputValidation.values);
      const taskId = testTaskId(record.currentDigest, inputDigest);
      try {
        const existing = await readPersistentTask(taskId);
        const provenance = existing.provenance;
        if (
          provenance?.kind !== "skill_candidate_test" ||
          provenance.candidateId !== record.id ||
          provenance.candidateDigest !== record.currentDigest ||
          provenance.inputDigest !== inputDigest
        ) {
          throw new Error("USER_SKILL_TEST_TASK_BINDING_MISMATCH");
        }
        return {
          compiled: true,
          idempotent: true,
          candidateId: record.id,
          candidateDigest: record.currentDigest,
          inputDigest,
          task: await getPersistentTaskStatus(taskId, false),
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }

      const task = await createPersistentPrimitiveTask(
        "Skill candidate test: " + validated.manifest.id + "@" + validated.manifest.version,
        steps,
        {
          taskId,
          provenance: {
            kind: "skill_candidate_test",
            candidateId: record.id,
            candidateDigest: record.currentDigest,
            inputDigest,
          },
        },
      );
      if (
        !record.tests.some(
          (test) =>
            test.candidateDigest === record.currentDigest &&
            test.inputDigest === inputDigest &&
            test.taskId === taskId,
        )
      ) {
        record.tests.push({
          candidateDigest: record.currentDigest,
          inputDigest,
          taskId,
          compiledAt: new Date().toISOString(),
        });
        await writeSkillCandidate(record);
      }
      return {
        compiled: true,
        idempotent: false,
        candidateId: record.id,
        candidateDigest: record.currentDigest,
        inputDigest,
        task,
      };
    },
  );
}

export async function inspectSkillCandidate(input: {
  candidateId: string;
  testTaskId?: string;
}) {
  const record = await readSkillCandidate(input.candidateId);
  const validated = validateUserSkillManifest(
    record.id,
    record.currentDigest,
    currentManifest(record),
  );
  const binding =
    input.testTaskId
      ? record.tests.find(
          (test) =>
            test.taskId === input.testTaskId &&
            test.candidateDigest === record.currentDigest,
        )
      : [...record.tests]
          .reverse()
          .find((test) => test.candidateDigest === record.currentDigest);

  if (!binding) {
    return {
      candidate: record,
      validation: validated.report,
      test: null,
      readiness: {
        promotable: false,
        reasons: ["NO_TEST_TASK_FOR_CURRENT_DIGEST"],
      },
    };
  }

  const task = await readPersistentTask(binding.taskId);
  const provenance = task.provenance;
  const provenanceValid =
    provenance?.kind === "skill_candidate_test" &&
    provenance.candidateId === record.id &&
    provenance.candidateDigest === record.currentDigest &&
    provenance.inputDigest === binding.inputDigest;
  const evidence = buildTaskEvidenceReceipt(
    task,
    task.steps.map((step) => step.id),
  );
  let episode = null;
  try {
    episode = await readGlobalEpisode(task.id);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const episodeProvenanceValid =
    episode?.provenance?.kind === "skill_candidate_test" &&
    episode.provenance.candidateId === record.id &&
    episode.provenance.candidateDigest === record.currentDigest &&
    episode.provenance.inputDigest === binding.inputDigest;

  const manifest = validated.manifest;
  const promotionCandidate =
    manifest
      ? await inspectPromotionCandidate({
          taskId: task.id,
          kind: "procedure",
          title: "User Skill " + manifest.id + "@" + manifest.version,
          content: JSON.stringify(stableValue(manifest)),
          tags: ["user-skill", manifest.id],
          sensitivity: "internal",
          evidenceStepIds: task.steps.map((step) => step.id),
        })
      : null;

  const reasons: string[] = [];
  if (!validated.report.valid) reasons.push("VALIDATION_FAILED");
  if (!provenanceValid) reasons.push("TEST_TASK_BINDING_INVALID");
  if (task.status !== "completed") reasons.push("TEST_TASK_NOT_COMPLETED");
  if (!evidence.allStepsSucceeded) reasons.push("TEST_STEPS_UNRESOLVED");
  if (!evidence.verification.allRequiredVerified) {
    reasons.push("VERIFICATION_UNRESOLVED");
  }
  if (evidence.sideEffects.unresolvedStepIds.length > 0) {
    reasons.push("SIDE_EFFECT_UNRESOLVED");
  }
  if (!episode) reasons.push("M2_EPISODE_MISSING");
  else if (!episodeProvenanceValid) reasons.push("M2_PROVENANCE_MISMATCH");
  if (!promotionCandidate?.qualityGate.passed) reasons.push("QUALITY_GATE_FAILED");
  if (!promotionCandidate?.privacyGate.passed) reasons.push("PRIVACY_GATE_FAILED");

  return {
    candidate: record,
    validation: validated.report,
    test: {
      binding,
      task: await getPersistentTaskStatus(task.id, false),
      provenanceValid,
      evidence,
      m2: episode
        ? {
            episodeId: episode.id,
            contentDigest: episode.contentDigest,
            evidenceDigest: episode.evidenceDigest ?? null,
          }
        : null,
      qualityGate: promotionCandidate?.qualityGate ?? null,
      privacyGate: promotionCandidate?.privacyGate ?? null,
    },
    readiness: {
      promotable: reasons.length === 0,
      reasons,
    },
  };
}

function promotionReceiptId(
  candidateDigest: string,
  taskId: string,
  evidenceDigest: string,
): string {
  return (
    "skillprom_" +
    createHash("sha256")
      .update(candidateDigest + "|" + taskId + "|" + evidenceDigest)
      .digest("hex")
      .slice(0, 32)
  );
}

export async function promoteSkillCandidate(input: {
  candidateId: string;
  expectedDigest: string;
  testTaskId: string;
  confirm: boolean;
}){
  return await withSkillGovernanceResources(
    "skill-candidate.promote",
    candidateResource(input.candidateId),
    async () => {
      if (!input.confirm) {
        throw new Error("USER_SKILL_PROMOTION_CONFIRM_REQUIRED");
      }
      const record = await readSkillCandidate(input.candidateId);
      if (record.currentDigest !== input.expectedDigest) {
        throw new Error("USER_SKILL_CANDIDATE_DIGEST_MISMATCH");
      }
      if (
        record.status === "promoted" &&
        record.promotion?.candidateDigest === record.currentDigest &&
        record.promotion.testTaskId === input.testTaskId
      ) {
        return { idempotent: true, receipt: record.promotion };
      }
      if (record.status === "dismissed") {
        throw new Error("USER_SKILL_CANDIDATE_DISMISSED");
      }

      const inspection = await inspectSkillCandidate({
        candidateId: record.id,
        testTaskId: input.testTaskId,
      });
      if (!inspection.readiness.promotable || !inspection.test) {
        return {
          promoted: false,
          readiness: inspection.readiness,
          validation: inspection.validation,
          test: inspection.test,
        };
      }

      const parsed = manifestSchema.parse(currentManifest(record)) as UserSkillManifest;
      const taskEvidence = inspection.test.evidence;
      const m2EvidenceDigest = inspection.test.m2?.evidenceDigest;
      if (!m2EvidenceDigest) {
        throw new Error("USER_SKILL_M2_EVIDENCE_MISSING");
      }
      const normalizedContract = inspection.validation.effectiveContract;
      if (!normalizedContract) {
        throw new Error("USER_SKILL_EFFECTIVE_CONTRACT_MISSING");
      }

      const now = new Date().toISOString();
      const receipt: SkillPromotionReceipt = {
        version: 1,
        id: promotionReceiptId(
          record.currentDigest,
          input.testTaskId,
          m2EvidenceDigest,
        ),
        candidateId: record.id,
        candidateDigest: record.currentDigest,
        skillId: parsed.id,
        skillVersion: parsed.version,
        testTaskId: input.testTaskId,
        m2EvidenceDigest,
        effectiveContract: normalizedContract,
        qualityGate: inspection.test.qualityGate,
        privacyGate: inspection.test.privacyGate,
        verification: {
          requiredStepIds: taskEvidence.verification.requiredStepIds,
          verifiedStepIds: taskEvidence.verification.verifiedStepIds,
          allRequiredVerified: taskEvidence.verification.allRequiredVerified,
        },
        promotedAt: now,
      };

      return await withSkillGovernanceResources(
        "user-skill.promote",
        userSkillResource(parsed.id),
        async () => {
          let registry = await readUserSkillRegistry(parsed.id);
          if (!registry) {
            registry = {
              version: 1,
              skillId: parsed.id,
              enabled: true,
              activeVersion: parsed.version,
              createdAt: now,
              updatedAt: now,
              versions: {},
              activationHistory: [],
            };
          }

          const existing = registry.versions[parsed.version];
          if (existing) {
            if (existing.candidateDigest !== record.currentDigest) {
              throw new Error(
                "USER_SKILL_VERSION_IMMUTABLE: " +
                  parsed.id +
                  "@" +
                  parsed.version +
                  " already exists with a different digest.",
              );
            }
          } else {
            registry.versions[parsed.version] = {
              version: parsed.version,
              candidateId: record.id,
              candidateDigest: record.currentDigest,
              installedAt: now,
              manifest: parsed,
              promotion: receipt,
            };
          }
          registry.activeVersion = parsed.version;
          registry.enabled = true;
          if (
            registry.activationHistory.at(-1)?.version !== parsed.version ||
            registry.activationHistory.at(-1)?.reason !== "promotion"
          ) {
            registry.activationHistory.push({
              at: now,
              version: parsed.version,
              reason: "promotion",
            });
          }
          await writeUserSkillRegistry(registry);

          injectTestFault("user_skill.after_registry_write_before_candidate");

          record.status = "promoted";
          record.promotion = existing?.promotion ?? receipt;
          await writeSkillCandidate(record);

          return {
            promoted: true,
            idempotent: Boolean(existing),
            receipt: record.promotion,
            registry,
          };
        },
      );
    },
  );
}

function summarizeRegistry(record: UserSkillRegistryRecord) {
  return {
    skillId: record.skillId,
    enabled: record.enabled,
    activeVersion: record.activeVersion,
    versions: Object.values(record.versions)
      .sort((a, b) => b.installedAt.localeCompare(a.installedAt))
      .map((version) => ({
        version: version.version,
        candidateDigest: version.candidateDigest,
        installedAt: version.installedAt,
        uninstalledAt: version.uninstalledAt ?? null,
        active: record.activeVersion === version.version,
      })),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export async function listUserSkills() {
  return {
    skills: (await listUserSkillRegistries()).map(summarizeRegistry),
  };
}

export async function getUserSkill(skillId: string) {
  const record = await readUserSkillRegistry(skillId);
  if (!record) throw new Error("USER_SKILL_NOT_FOUND: " + skillId);
  return record;
}

export async function setUserSkillEnabled(skillId: string, enabled: boolean) {
  return await withSkillGovernanceResources(
    "user-skill.set-enabled",
    userSkillResource(skillId),
    async () => {

      const record = await getUserSkill(skillId);
      if (record.enabled === enabled) {
        return { idempotent: true, skill: summarizeRegistry(record) };
      }
      record.enabled = enabled;
      await writeUserSkillRegistry(record);
      return { idempotent: false, skill: summarizeRegistry(record) };
    },
  );
}

export async function activateUserSkillVersion(input: {
  skillId: string;
  version: string;
}) {
  return await withSkillGovernanceResources(
    "user-skill.activate-version",
    userSkillResource(input.skillId),
    async () => {

      const record = await getUserSkill(input.skillId);
      const version = record.versions[input.version];
      if (!version || version.uninstalledAt) {
        throw new Error(
          "USER_SKILL_VERSION_NOT_AVAILABLE: " +
            input.skillId +
            "@" +
            input.version,
        );
      }
      if (record.activeVersion === input.version) {
        return { idempotent: true, skill: summarizeRegistry(record) };
      }
      record.activeVersion = input.version;
      record.activationHistory.push({
        at: new Date().toISOString(),
        version: input.version,
        reason: "activate",
      });
      await writeUserSkillRegistry(record);
      return { idempotent: false, skill: summarizeRegistry(record) };
    },
  );
}

export async function rollbackUserSkill(input: {
  skillId: string;
  version?: string;
}) {
  return await withSkillGovernanceResources(
    "user-skill.rollback",
    userSkillResource(input.skillId),
    async () => {

      const record = await getUserSkill(input.skillId);
      let target = input.version;
      if (!target) {
        const history = [...record.activationHistory].reverse();
        target = history.find(
          (entry) =>
            entry.version &&
            entry.version !== record.activeVersion &&
            record.versions[entry.version] &&
            !record.versions[entry.version]?.uninstalledAt,
        )?.version ?? undefined;
      }
      if (!target) throw new Error("USER_SKILL_ROLLBACK_TARGET_NOT_FOUND");
      const version = record.versions[target];
      if (!version || version.uninstalledAt) {
        throw new Error("USER_SKILL_ROLLBACK_TARGET_NOT_AVAILABLE");
      }
      if (record.activeVersion === target) {
        return { idempotent: true, skill: summarizeRegistry(record) };
      }
      record.activeVersion = target;
      record.activationHistory.push({
        at: new Date().toISOString(),
        version: target,
        reason: "rollback",
      });
      await writeUserSkillRegistry(record);
      return { idempotent: false, skill: summarizeRegistry(record) };
    },
  );
}

export async function uninstallUserSkill(input: {
  skillId: string;
  version?: string;
}) {
  return await withSkillGovernanceResources(
    "user-skill.uninstall",
    userSkillResource(input.skillId),
    async () => {

      const record = await getUserSkill(input.skillId);
      const targets = input.version
        ? [input.version]
        : Object.keys(record.versions);
      const now = new Date().toISOString();
      let changed = false;
      for (const versionName of targets) {
        const version = record.versions[versionName];
        if (!version) {
          if (input.version) throw new Error("USER_SKILL_VERSION_NOT_FOUND");
          continue;
        }
        if (!version.uninstalledAt) {
          version.uninstalledAt = now;
          changed = true;
        }
      }
      if (
        record.activeVersion &&
        record.versions[record.activeVersion]?.uninstalledAt
      ) {
        record.activeVersion = null;
        record.enabled = false;
        record.activationHistory.push({
          at: now,
          version: null,
          reason: "uninstall",
        });
      }
      if (changed) await writeUserSkillRegistry(record);
      return { idempotent: !changed, skill: summarizeRegistry(record) };
    },
  );
}

export async function getUserSkillCatalogEntries() {
  const records = await listUserSkillRegistries();
  return records
    .filter(
      (record) =>
        record.activeVersion &&
        record.versions[record.activeVersion] &&
        !record.versions[record.activeVersion]?.uninstalledAt,
    )
    .map((record) => {
      const installed = record.versions[record.activeVersion!]!;
      const manifest = installed.manifest;
      const integrityOk = userSkillDigest(manifest) === installed.candidateDigest;
      const compatibility = validateUserSkillManifest(
        installed.candidateId,
        installed.candidateDigest,
        manifest,
      );
      const runnable = integrityOk && compatibility.report.valid;
      return {
        id: manifest.id,
        domain: "user",
        description: manifest.description,
        title: manifest.title,
        source: "user",
        enabled: record.enabled,
        activeVersion: manifest.version,
        digest: installed.candidateDigest,
        contract: compatibility.report.effectiveContract ?? manifest.contract,
        availability: !record.enabled
          ? "disabled"
          : integrityOk
            ? compatibility.report.valid
              ? "ready"
              : "incompatible"
            : "integrity_failed",
        validationErrors: compatibility.report.errors.map((error) => error.code),
        inputs: Object.fromEntries(
          Object.entries(manifest.inputs).map(([name, spec]) => [
            name,
            spec.description ?? spec.type,
          ]),
        ),
        skillVersion: manifest.version,
        requiredPrimitiveAbi: manifest.requiredPrimitiveAbi,
        requiredPrimitives: manifest.requiredPrimitives,
        executionMode: manifest.executionMode,
        memoryPolicy: {
          working: "runtime",
          staging: "available_when_durable",
          episodic: "task_events_when_durable",
          semanticPromotion: "manual",
        },
      };
    });
}

export async function executeUserSkill(
  skillId: string,
  args: Record<string, unknown> = {},
  dryRun = false,
) {
  return await withSkillGovernanceResources(
    "user-skill.execute",
    userSkillResource(skillId, "shared"),
    async () => {

      const registry = await readUserSkillRegistry(skillId);
      if (!registry || !registry.activeVersion) {
        throw new Error("Unknown skill \"" + skillId + "\".");
      }
      if (!registry.enabled) {
        throw new Error("USER_SKILL_DISABLED: " + skillId);
      }
      const installed = registry.versions[registry.activeVersion];
      if (!installed || installed.uninstalledAt) {
        throw new Error("USER_SKILL_ACTIVE_VERSION_UNAVAILABLE: " + skillId);
      }
      const manifest = installed.manifest;
      if (userSkillDigest(manifest) !== installed.candidateDigest) {
        throw new Error("USER_SKILL_INTEGRITY_FAILED: installed manifest digest mismatch.");
      }
      const compatibility = validateUserSkillManifest(
        installed.candidateId,
        installed.candidateDigest,
        manifest,
      );
      if (!compatibility.report.valid || !compatibility.report.effectiveContract) {
        throw new Error(
          "USER_SKILL_RUNTIME_INCOMPATIBLE: " +
            compatibility.report.errors.map((error) => error.code).join(","),
        );
      }
      const runtimeContract = compatibility.report.effectiveContract;
      const inputValidation = validateInputs(manifest.inputs, args);
      if (inputValidation.errors.length > 0) {
        return {
          skill: skillId,
          validInputs: false,
          inputErrors: inputValidation.errors,
        };
      }
      const steps = materializeSteps(manifest, inputValidation.values);
      try {
        validatePrimitiveTaskSteps(steps);
      } catch (error) {
        throw new Error(
          "USER_SKILL_RUNTIME_COMPILE_FAILED: " +
            (error instanceof Error ? error.message : String(error)),
        );
      }

      if (dryRun) {
        return {
          dryRun: true,
          skill: skillId,
          source: "user",
          skillVersion: manifest.version,
          digest: installed.candidateDigest,
          contract: runtimeContract,
          plan: {
            durable: true,
            steps,
          },
        };
      }

      const approval = await authorizeSkill(skillId, args, runtimeContract);
      const task = await createPersistentPrimitiveTask(
        manifest.title,
        steps,
        {
          provenance: {
            kind: "user_skill",
            skillId,
            skillVersion: manifest.version,
            skillDigest: installed.candidateDigest,
          },
        },
      );
      return {
        skill: skillId,
        source: "user",
        skillVersion: manifest.version,
        digest: installed.candidateDigest,
        contract: runtimeContract,
        approval,
        result: task,
      };
    },
  );
}