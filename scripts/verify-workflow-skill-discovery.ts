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
  workflowDiscoveryParameterName,
} = await import("../src/skills/workflowSkillDiscovery.js");
const {
  compileSkillCandidateTest,
  dismissSkillCandidate,
  getSkillCandidates,
  inspectSkillCandidate,
  promoteSkillCandidate,
  submitSkillCandidate,
  userSkillDigest,
  validateSkillCandidate,
  validateUserSkillManifest,
} = await import("../src/skills/userSkillRuntime.js");
const { InProcessRuntimeClient } = await import(
  "../src/public/runtimeClient.js"
);
const { invokeRuntimeRpc } = await import(
  "../src/public/runtimeRpc.js"
);

async function createRepeatedRun(
  index: number,
  derived = false,
  label = "Repository repeated health workflow",
) {
  const statusId = `status_${index}`;
  const logId = `log_${index}`;
  const created = await createPersistentPrimitiveTask(
    label,
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

  assert.equal(
    workflowDiscoveryParameterName("step2", ["max_count"]),
    "step2_max_count",
  );
  assert.notEqual(
    workflowDiscoveryParameterName("step1", ["a-b"]),
    workflowDiscoveryParameterName("step1", ["a_b"]),
  );
  const longA = workflowDiscoveryParameterName(
    "step1",
    ["x".repeat(90) + "a"],
  );
  const longB = workflowDiscoveryParameterName(
    "step1",
    ["x".repeat(90) + "b"],
  );
  assert.ok(longA.length <= 64);
  assert.ok(longB.length <= 64);
  assert.notEqual(longA, longB);

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
  assert.equal(proposal.governance.state, "new");
  assert.deepEqual(proposal.governance.candidates, []);
  assert.equal(proposal.governance.installed, null);
  assert.equal(proposal.governance.evidenceRefreshAvailable, false);
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

  await createRepeatedRun(4, false, "Different intent with same Primitive graph");
  const keepsIntentBoundary = (await discoverWorkflowSkillCandidates()) as any;
  assert.equal(keepsIntentBoundary.proposals[0].support.successfulRuns, 3);

  await createRepeatedRun(5, true);
  const excludesDerived = (await discoverWorkflowSkillCandidates()) as any;
  assert.equal(excludesDerived.proposals[0].support.successfulRuns, 3);

  const client = new InProcessRuntimeClient();
  const capabilities = (await client.getCapabilities()) as any;
  assert.equal(capabilities.extensions.userSkillRegistry.version, 1);
  assert.equal(capabilities.extensions.workflowSkillDiscovery.version, 1);
  assert.equal(
    capabilities.extensions.workflowSkillDiscovery.clientInterface,
    "WorkflowDiscoveryRuntimeClient",
  );
  assert.equal(
    capabilities.extensions.workflowSkillDiscovery.writesCandidateStore,
    false,
  );
  assert.equal(capabilities.extensions.workflowSkillDiscovery.autoPromotes, false);

  const viaClient = (await client.discoverWorkflowSkillCandidates()) as any;
  assert.equal(viaClient.proposalCount, 1);

  const viaRpc = (await invokeRuntimeRpc(
    client,
    "skill-candidates.discover-workflows",
    {},
  )) as any;
  assert.equal(viaRpc.proposalCount, 1);

  const phase1OnlyClient = Object.create(client) as any;
  phase1OnlyClient.discoverWorkflowSkillCandidates = undefined;
  const phase1List = (await invokeRuntimeRpc(
    phase1OnlyClient,
    "user-skills.list",
  )) as any;
  assert.ok(Array.isArray(phase1List.skills));
  await assert.rejects(
    () =>
      invokeRuntimeRpc(
        phase1OnlyClient,
        "skill-candidates.discover-workflows",
        {},
      ),
    /workflow-discovery extension is not implemented/,
  );

  const explicit = (await submitSkillCandidate(proposal.manifest)) as any;
  assert.equal(explicit.candidate.status, "active");
  const candidatesAfter = (await getSkillCandidates()) as any[];
  assert.equal(candidatesAfter.length, 1);

  const afterSubmit = (await discoverWorkflowSkillCandidates()) as any;
  const submittedProposal = afterSubmit.proposals[0];
  assert.equal(submittedProposal.proposalId, proposal.proposalId);
  assert.equal(submittedProposal.governance.state, "candidate_exists");
  assert.equal(submittedProposal.governance.evidenceRefreshAvailable, false);
  assert.deepEqual(submittedProposal.governance.exactDigestCandidateIds, [
    explicit.candidate.id,
  ]);
  assert.equal(submittedProposal.readyForSubmit, false);

  const dismissed = (await dismissSkillCandidate({
    candidateId: explicit.candidate.id,
    expectedDigest: explicit.candidate.currentDigest,
  })) as any;
  assert.equal(dismissed.status, "dismissed");

  const afterDismiss = (await discoverWorkflowSkillCandidates()) as any;
  const dismissedProposal = afterDismiss.proposals[0];
  assert.equal(dismissedProposal.proposalId, proposal.proposalId);
  assert.equal(dismissedProposal.governance.state, "dismissed");
  assert.deepEqual(dismissedProposal.governance.exactDismissedCandidateIds, [
    explicit.candidate.id,
  ]);
  assert.equal(dismissedProposal.readyForSubmit, false);

  await createRepeatedRun(6);
  const refreshedAfterDismiss =
    (await discoverWorkflowSkillCandidates()) as any;
  const refreshedProposal = refreshedAfterDismiss.proposals[0];
  assert.equal(refreshedProposal.proposalId, proposal.proposalId);
  assert.equal(refreshedProposal.support.successfulRuns, 4);
  assert.notEqual(refreshedProposal.manifestDigest, proposal.manifestDigest);
  assert.equal(refreshedProposal.governance.state, "new");
  assert.equal(refreshedProposal.readyForSubmit, true);

  const refreshedCandidate = (await submitSkillCandidate(
    refreshedProposal.manifest,
  )) as any;
  assert.equal(refreshedCandidate.candidate.status, "active");
  assert.notEqual(refreshedCandidate.candidate.id, explicit.candidate.id);

  await createRepeatedRun(7);
  const activeRefresh = (await discoverWorkflowSkillCandidates()) as any;
  const activeRefreshProposal = activeRefresh.proposals[0];
  assert.equal(activeRefreshProposal.proposalId, proposal.proposalId);
  assert.equal(activeRefreshProposal.support.successfulRuns, 5);
  assert.equal(activeRefreshProposal.governance.state, "candidate_exists");
  assert.equal(
    activeRefreshProposal.governance.evidenceRefreshAvailable,
    true,
  );
  assert.equal(activeRefreshProposal.readyForSubmit, false);

  const validatedCandidate = (await validateSkillCandidate({
    candidateId: refreshedCandidate.candidate.id,
    expectedDigest: refreshedCandidate.candidate.currentDigest,
  })) as any;
  assert.equal(validatedCandidate.valid, true);

  const compiled = (await compileSkillCandidateTest({
    candidateId: refreshedCandidate.candidate.id,
    expectedDigest: refreshedCandidate.candidate.currentDigest,
    inputs: { step2_max_count: 5 },
  })) as any;
  const ranCandidate = await runPersistentTask(compiled.task.id, {
    maxConcurrency: 2,
    failFast: true,
  });
  assert.equal(ranCandidate.status, "completed");

  const inspection = (await inspectSkillCandidate({
    candidateId: explicit.candidate.id,
    testTaskId: compiled.task.id,
  })) as any;
  assert.equal(inspection.readiness.promotable, true);

  const promoted = (await promoteSkillCandidate({
    candidateId: refreshedCandidate.candidate.id,
    expectedDigest: refreshedCandidate.candidate.currentDigest,
    testTaskId: compiled.task.id,
    confirm: true,
  })) as any;
  assert.equal(promoted.promoted, true);

  const afterPromotion = (await discoverWorkflowSkillCandidates()) as any;
  const installedProposal = afterPromotion.proposals[0];
  assert.equal(installedProposal.proposalId, proposal.proposalId);
  assert.equal(installedProposal.governance.state, "installed");
  assert.equal(installedProposal.governance.installed.enabled, true);
  assert.equal(installedProposal.governance.installed.activeVersion, "0.1.0");
  assert.ok(installedProposal.governance.installed.versions.includes("0.1.0"));
  assert.equal(installedProposal.readyForSubmit, false);

  const secretManifest = structuredClone(proposal.manifest);
  secretManifest.id = "user.workflow.secret-regression";
  secretManifest.steps[0].args.api_key =
    "abcdefghijklmnopqrstuvwx12345678";
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
        collisionSafeParameterNames: true,
        labelBoundClustering: true,
        historicalM2EvidenceBound: true,
        excludesDerivedSkillRuns: true,
        publicRuntimeApi: true,
        capabilityFeatureDetection: true,
        phase1ExtensionCompatibility: true,
        explicitCandidateSubmit: true,
        stableProposalIdentity: true,
        candidateGovernanceDedup: true,
        dismissedDigestSuppressed: true,
        refreshedProposalAfterDismissal: true,
        evidenceRefreshDetected: true,
        installedGovernanceDetected: true,
        promotionStillUsesGovernedPath: true,
        embeddedSecretBlocked: true,
      },
      null,
      2,
    ),
  );
} finally {
  await fs.rm(scratch, { recursive: true, force: true }).catch(() => undefined);
}
