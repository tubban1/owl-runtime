import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.OWL_RUNTIME_MODE = "test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratch = path.join(root, ".tmp-verify-workflow-skill-discovery");

process.env.ALLOWED_DIRECTORIES = root;
process.env.TASK_DIR = path.join(scratch, "tasks");
process.env.TASK_KEY_PATH = path.join(scratch, "task.key");
process.env.TASK_STAGING_DIR = path.join(scratch, "staging");
process.env.TASK_STAGING_EXPOSE_TO_FS = "true";
process.env.EPISODIC_INDEX_DIR = path.join(scratch, "episodes");
process.env.EPISODIC_INDEX_KEY_PATH = path.join(scratch, "episode.key");
process.env.SEMANTIC_MEMORY_DIR = path.join(scratch, "semantic");
process.env.SEMANTIC_MEMORY_KEY_PATH = path.join(scratch, "semantic.key");
process.env.SKILL_CANDIDATE_DIR = path.join(scratch, "skill-candidates");
process.env.USER_SKILL_DIR = path.join(scratch, "user-skills");
process.env.USER_SKILL_KEY_PATH = path.join(scratch, "user-skills.key");

const {
  createPersistentPrimitiveTask,
  runPersistentTask,
} = await import("../src/tasks/taskRuntime.js");
const {
  discoverWorkflowSkillCandidates,
} = await import("../src/skills/workflowSkillDiscovery.js");
const {
  getSkillCandidates,
  submitSkillCandidate,
  userSkillDigest,
  validateUserSkillManifest,
} = await import("../src/skills/userSkillRuntime.js");
const { InProcessRuntimeClient } = await import(
  "../src/public/runtimeClient.js"
);
const { invokeRuntimeRpc } = await import(
  "../src/public/runtimeRpc.js"
);

async function createRepeatedRun(index: number, derived = false) {
  const statusId = `status_${index}`;
  const logId = `log_${index}`;
  const created = await createPersistentPrimitiveTask(
    "Repository repeated health workflow",
    [
      {
        id: statusId,
        primitive: "git.query",
        op: "status",
        args: { cwd: root },
      },
      {
        id: logId,
        primitive: "git.query",
        op: "log",
        args: { cwd: root, max_count: index + 2 },
        dependsOn: [statusId],
      },
    ],
    derived
      ? {
          provenance: {
            kind: "skill_candidate_test",
            candidateId: "candidate_test_only",
            candidateDigest: "digest_test_only",
            inputDigest: "input_test_only",
          },
        }
      : undefined,
  );

  const ran = await runPersistentTask(created.id, {
    maxConcurrency: 2,
    failFast: true,
  });
  assert.equal(ran.status, "completed");
  return created.id;
}

try {
  await fs.rm(scratch, { recursive: true, force: true });

  await createRepeatedRun(1);
  await createRepeatedRun(2);

  const tooEarly = (await discoverWorkflowSkillCandidates()) as any;
  assert.equal(tooEarly.policy.oneRunNeverEnough, true);
  assert.equal(tooEarly.proposalCount, 0);

  await createRepeatedRun(3);

  const discovered = (await discoverWorkflowSkillCandidates()) as any;
  assert.equal(discovered.policy.minSuccessfulRuns, 3);
  assert.equal(discovered.policy.writesCandidateStore, false);
  assert.equal(discovered.policy.autoPromotes, false);
  assert.equal(discovered.proposalCount, 1);

  const proposal = discovered.proposals[0];
  assert.equal(proposal.source, "m2_episodic_evidence");
  assert.equal(proposal.support.successfulRuns, 3);
  assert.equal(proposal.support.distinctArgumentSets, 3);
  assert.equal(proposal.support.recoveryFreeRuns, 3);
  assert.equal(proposal.validation.valid, true);
  assert.equal(proposal.readyForSubmit, true);
  assert.equal(proposal.requiresExplicitSubmit, true);
  assert.equal(proposal.requiresTestBeforePromotion, true);
  assert.equal(proposal.autoPromoted, false);
  assert.deepEqual(proposal.parameterization.inputNames, ["step2_max_count"]);
  assert.equal(
    proposal.manifest.steps[1].args.max_count.$input,
    "step2_max_count",
  );
  assert.equal(proposal.manifest.provenance.origin, "workflow");
  assert.equal(proposal.manifest.provenance.sourceTaskIds.length, 3);
  assert.equal(proposal.manifest.provenance.sourceMemoryIds.length, 3);

  const candidatesBefore = (await getSkillCandidates()) as any[];
  assert.equal(candidatesBefore.length, 0);

  await createRepeatedRun(4, true);
  const excludesDerived = (await discoverWorkflowSkillCandidates()) as any;
  assert.equal(excludesDerived.proposals[0].support.successfulRuns, 3);

  const client = new InProcessRuntimeClient();
  const viaClient = (await client.discoverWorkflowSkillCandidates()) as any;
  assert.equal(viaClient.proposalCount, 1);

  const viaRpc = (await invokeRuntimeRpc(
    client,
    "skill-candidates.discover-workflows",
    {},
  )) as any;
  assert.equal(viaRpc.proposalCount, 1);

  const explicit = (await submitSkillCandidate(proposal.manifest)) as any;
  assert.equal(explicit.candidate.status, "active");
  const candidatesAfter = (await getSkillCandidates()) as any[];
  assert.equal(candidatesAfter.length, 1);

  const secretManifest = structuredClone(proposal.manifest);
  secretManifest.id = "user.workflow.secret-regression";
  secretManifest.steps[0].args.cwd =
    "api_key=abcdefghijklmnopqrstuvwx12345678";
  const secretDigest = userSkillDigest(secretManifest);
  const secretValidation = validateUserSkillManifest(
    "candidate_secret_regression",
    secretDigest,
    secretManifest,
  ).report;
  assert.equal(secretValidation.valid, false);
  assert.ok(
    secretValidation.errors.some(
      (error: any) => error.code === "USER_SKILL_EMBEDDED_SECRET_BLOCKED",
    ),
  );

  console.log(
    JSON.stringify(
      {
        ok: true,
        repeatedWorkflowThreshold: 3,
        proposalReadOnly: true,
        normalizedStepIds: true,
        scalarParameterization: true,
        historicalM2EvidenceBound: true,
        excludesDerivedSkillRuns: true,
        publicRuntimeApi: true,
        explicitCandidateSubmit: true,
        embeddedSecretBlocked: true,
      },
      null,
      2,
    ),
  );
} finally {
  await fs.rm(scratch, { recursive: true, force: true }).catch(() => undefined);
}
