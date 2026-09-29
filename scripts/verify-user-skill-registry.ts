import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

process.env.OWL_RUNTIME_MODE = "test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratch = path.join(root, ".tmp-verify-user-skill-registry");
const testOutput = path.join(scratch, "side-effect.txt");

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
process.env.RUNTIME_PUBLIC_EVENT_DIR = path.join(scratch, "public-events");
process.env.RUNTIME_PUBLIC_EVENT_KEY_PATH = path.join(scratch, "public-events.key");

const {
  submitSkillCandidate,
  getSkillCandidate,
  reviseSkillCandidate,
  validateSkillCandidate,
  validateUserSkillManifest,
  userSkillDigest,
  compileSkillCandidateTest,
  inspectSkillCandidate,
  promoteSkillCandidate,
  rollbackUserSkill,
  activateUserSkillVersion,
  setUserSkillEnabled,
  uninstallUserSkill,
  getUserSkill,
} = await import("../src/skills/userSkillRuntime.js");
const { runPersistentTask } = await import("../src/tasks/taskRuntime.js");
const { executeSkill, getSkillCatalog } = await import(
  "../src/skills/skillRuntime.js"
);
const { InProcessRuntimeClient } = await import(
  "../src/public/runtimeClient.js"
);
const { invokeRuntimeRpc } = await import(
  "../src/public/runtimeRpc.js"
);
const { semanticMemoryStatus } = await import(
  "../src/runtime/memoryPromotion.js"
);

function repoHealthManifest(version = "1.0.0") {
  return {
    schemaVersion: 1,
    skillAbiVersion: 1,
    id: "user.repo_health_check",
    version,
    title: "Repository health check",
    description:
      "Inspect Git repository status and recent commits through the governed Primitive ABI.",
    requiredPrimitiveAbi: 1,
    requiredPrimitives: ["git.query"],
    executionMode: "durable",
    inputs: {
      cwd: {
        type: "string",
        required: true,
        description: "Repository working directory",
      },
    },
    contract: {
      riskLevel: "low",
      idempotent: true,
      sideEffects: [],
      retryPolicy: "automatic",
      requiresVerification: false,
      resources: [],
    },
    steps: [
      {
        id: "status",
        primitive: "git.query",
        op: "status",
        args: { cwd: { $input: "cwd" } },
      },
      {
        id: "log",
        primitive: "git.query",
        op: "log",
        args: { cwd: { $input: "cwd" }, max_count: 5 },
        dependsOn: ["status"],
      },
    ],
    provenance: { origin: "workflow" },
  };
}

function failingReadManifest() {
  return {
    schemaVersion: 1,
    skillAbiVersion: 1,
    id: "user.missing_file_check",
    version: "1.0.0",
    title: "Missing file check",
    description:
      "A test-only governed workflow that intentionally reads a missing file to verify failed test tasks block promotion.",
    requiredPrimitiveAbi: 1,
    requiredPrimitives: ["fs.read"],
    executionMode: "durable",
    inputs: {},
    contract: {
      riskLevel: "low",
      idempotent: true,
      sideEffects: [],
      retryPolicy: "automatic",
      requiresVerification: false,
      resources: [],
    },
    steps: [
      {
        id: "read",
        primitive: "fs.read",
        op: "one",
        args: { path: path.join(scratch, "definitely-does-not-exist.txt") },
      },
    ],
  };
}

function unresolvedSideEffectManifest() {
  return {
    schemaVersion: 1,
    skillAbiVersion: 1,
    id: "user.side_effect_review",
    version: "1.0.0",
    title: "Side effect review",
    description:
      "A test-only write whose explicit postcondition intentionally fails so promotion must remain blocked.",
    requiredPrimitiveAbi: 1,
    requiredPrimitives: ["fs.write"],
    executionMode: "durable",
    inputs: {},
    contract: {
      riskLevel: "medium",
      idempotent: false,
      sideEffects: ["filesystem_write"],
      retryPolicy: "manual",
      requiresVerification: true,
      resources: [],
    },
    steps: [
      {
        id: "write",
        primitive: "fs.write",
        op: "write",
        args: {
          path: testOutput,
          content: "side effect evidence\n",
          overwrite: true,
          create_parents: true,
        },
        verify: {
          id: "intentional-failure",
          expectations: [
            {
              path: "data.exists",
              operator: "equals",
              expected: false,
            },
          ],
        },
      },
    ],
  };
}

async function compileAndRun(candidateId: string, digest: string, inputs = {}) {
  const compiled = (await compileSkillCandidateTest({
    candidateId,
    expectedDigest: digest,
    inputs,
  })) as any;
  assert.equal(compiled.compiled, true);
  const ran = await runPersistentTask(compiled.task.id, {
    maxConcurrency: 2,
    failFast: true,
  });
  return { compiled, ran };
}

async function promoteValidManifest(manifest: any) {
  const submitted = (await submitSkillCandidate(manifest)) as any;
  const candidate = submitted.candidate;
  const validation = (await validateSkillCandidate({
    candidateId: candidate.id,
    expectedDigest: candidate.currentDigest,
  })) as any;
  assert.equal(validation.valid, true);
  const { compiled, ran } = await compileAndRun(
    candidate.id,
    candidate.currentDigest,
    { cwd: root },
  );
  assert.equal((ran as any).status, "completed");
  const inspection = (await inspectSkillCandidate({
    candidateId: candidate.id,
    testTaskId: compiled.task.id,
  })) as any;
  assert.equal(inspection.readiness.promotable, true);
  const promotion = (await promoteSkillCandidate({
    candidateId: candidate.id,
    expectedDigest: candidate.currentDigest,
    testTaskId: compiled.task.id,
    confirm: true,
  })) as any;
  assert.equal(promotion.promoted, true);
  return { candidate, compiled, inspection, promotion };
}

try {
  await fs.rm(scratch, { recursive: true, force: true });
  await fs.mkdir(scratch, { recursive: true });

  // Discovery must remain read-only when no User Skill state exists yet.
  const initialCatalog = (await getSkillCatalog()) as any[];
  assert.ok(initialCatalog.length > 0);
  await assert.rejects(
    () => fs.stat(path.join(scratch, "user-skills")),
    (error: any) => error?.code === "ENOENT",
  );
  await assert.rejects(
    () => fs.stat(path.join(scratch, "user-skills.key")),
    (error: any) => error?.code === "ENOENT",
  );

  // 1. Invalid candidate -> machine-readable report.
  const invalid = (await submitSkillCandidate({
    schemaVersion: 1,
    id: "user.repo_health_check",
  })) as any;
  const invalidReport = (await validateSkillCandidate({
    candidateId: invalid.candidate.id,
    expectedDigest: invalid.candidate.currentDigest,
  })) as any;
  assert.equal(invalidReport.valid, false);
  assert.ok(
    invalidReport.errors.some(
      (error: any) => error.code === "USER_SKILL_SCHEMA_INVALID",
    ),
  );
  assert.equal(invalidReport.candidateDigest, invalid.candidate.currentDigest);
  assert.equal(invalidReport.targetSkillAbi, 1);
  assert.equal(invalidReport.primitiveAbi.runtime, 1);

  // 2. Repair revision -> deterministic PASS.
  const repaired = (await reviseSkillCandidate({
    candidateId: invalid.candidate.id,
    expectedDigest: invalid.candidate.currentDigest,
    manifest: repoHealthManifest("1.0.0"),
  })) as any;
  assert.equal(repaired.idempotent, false);
  const repairedReport = (await validateSkillCandidate({
    candidateId: repaired.candidate.id,
    expectedDigest: repaired.candidate.currentDigest,
  })) as any;
  assert.equal(repairedReport.valid, true);

  // 3. Digest mismatch blocks concurrent/stale repair.
  await assert.rejects(
    () =>
      reviseSkillCandidate({
        candidateId: repaired.candidate.id,
        expectedDigest: "0".repeat(64),
        manifest: repoHealthManifest("1.0.1"),
      }),
    /USER_SKILL_CANDIDATE_DIGEST_MISMATCH/,
  );

  // 3b. Concurrent revision is a real digest-bound CAS: only one wins.
  const concurrentManifest = {
    ...repoHealthManifest("2.0.0"),
    id: "user.concurrent_revision",
  };
  const concurrent = (await submitSkillCandidate(concurrentManifest)) as any;
  const concurrentDigest = concurrent.candidate.currentDigest;
  const concurrentResults = await Promise.allSettled([
    reviseSkillCandidate({
      candidateId: concurrent.candidate.id,
      expectedDigest: concurrentDigest,
      manifest: {
        ...repoHealthManifest("2.0.1"),
        id: "user.concurrent_revision",
      },
    }),
    reviseSkillCandidate({
      candidateId: concurrent.candidate.id,
      expectedDigest: concurrentDigest,
      manifest: {
        ...repoHealthManifest("2.0.2"),
        id: "user.concurrent_revision",
      },
    }),
  ]);
  assert.equal(
    concurrentResults.filter((result) => result.status === "fulfilled").length,
    1,
  );
  assert.equal(
    concurrentResults.filter((result) => result.status === "rejected").length,
    1,
  );
  const concurrentRejection = concurrentResults.find(
    (result) => result.status === "rejected",
  ) as PromiseRejectedResult;
  assert.match(
    String(concurrentRejection.reason),
    /USER_SKILL_CANDIDATE_DIGEST_MISMATCH/,
  );

  // 3c. Candidate size is one invariant across draft validation, submit and revision.
  const oversizedManifest = repoHealthManifest("3.0.0") as any;
  oversizedManifest.id = "user.oversized_candidate";
  oversizedManifest.steps[0].args.cwd = "x".repeat(300 * 1024);
  const oversizedDigest = userSkillDigest(oversizedManifest);
  const oversizedReport = validateUserSkillManifest(
    "candidate_oversized_preview",
    oversizedDigest,
    oversizedManifest,
  ).report;
  assert.equal(oversizedReport.valid, false);
  assert.ok(
    oversizedReport.errors.some(
      (error: any) => error.code === "USER_SKILL_CANDIDATE_TOO_LARGE",
    ),
  );
  await assert.rejects(
    () => submitSkillCandidate(oversizedManifest),
    /USER_SKILL_CANDIDATE_TOO_LARGE/,
  );
  await assert.rejects(
    () =>
      reviseSkillCandidate({
        candidateId: repaired.candidate.id,
        expectedDigest: repaired.candidate.currentDigest,
        manifest: oversizedManifest,
      }),
    /USER_SKILL_CANDIDATE_TOO_LARGE/,
  );
  const afterOversizedRevision = (await getSkillCandidate(
    repaired.candidate.id,
  )) as any;
  assert.equal(
    afterOversizedRevision.currentDigest,
    repaired.candidate.currentDigest,
  );

  // 4. Primitive ABI mismatch.
  const abiManifest = {
    ...repoHealthManifest("9.0.0"),
    id: "user.future_abi",
    requiredPrimitiveAbi: 999,
  };
  const abi = (await submitSkillCandidate(abiManifest)) as any;
  const abiReport = (await validateSkillCandidate({
    candidateId: abi.candidate.id,
    expectedDigest: abi.candidate.currentDigest,
  })) as any;
  assert.equal(abiReport.valid, false);
  assert.ok(
    abiReport.errors.some(
      (error: any) =>
        error.code === "USER_SKILL_PRIMITIVE_ABI_UNSUPPORTED",
    ),
  );

  // 4b. Arbitrary shell escape hatch is not a User Skill capability.
  const shellEscapeManifest = {
    schemaVersion: 1,
    skillAbiVersion: 1,
    id: "user.shell_escape",
    version: "1.0.0",
    title: "Shell escape",
    description: "Must be rejected from declarative User Skills.",
    requiredPrimitiveAbi: 1,
    requiredPrimitives: ["sys.exec"],
    executionMode: "durable",
    inputs: {},
    contract: {
      riskLevel: "high",
      idempotent: false,
      sideEffects: ["process_execution"],
      retryPolicy: "manual",
      requiresVerification: true,
      resources: [],
    },
    steps: [
      {
        id: "shell",
        primitive: "sys.exec",
        op: "run",
        args: { command: "echo blocked", cwd: root },
      },
    ],
  };
  const shellEscape = (await submitSkillCandidate(shellEscapeManifest)) as any;
  const shellEscapeReport = (await validateSkillCandidate({
    candidateId: shellEscape.candidate.id,
    expectedDigest: shellEscape.candidate.currentDigest,
  })) as any;
  assert.equal(shellEscapeReport.valid, false);
  assert.ok(
    shellEscapeReport.errors.some(
      (error: any) =>
        error.code === "USER_SKILL_PRIMITIVE_NOT_ALLOWED" ||
        error.code === "USER_SKILL_REQUIRED_PRIMITIVE_NOT_ALLOWED",
    ),
  );

  // 5. Test Task failure blocks promotion.
  const failing = (await submitSkillCandidate(failingReadManifest())) as any;
  const failingReport = (await validateSkillCandidate({
    candidateId: failing.candidate.id,
    expectedDigest: failing.candidate.currentDigest,
  })) as any;
  assert.equal(failingReport.valid, true);
  const failingCompiled = (await compileSkillCandidateTest({
    candidateId: failing.candidate.id,
    expectedDigest: failing.candidate.currentDigest,
  })) as any;
  assert.equal(failingCompiled.compiled, true);
  const failingRun = (await runPersistentTask(failingCompiled.task.id, {
    failFast: true,
  })) as any;
  assert.notEqual(failingRun.status, "completed");
  const failingInspection = (await inspectSkillCandidate({
    candidateId: failing.candidate.id,
    testTaskId: failingCompiled.task.id,
  })) as any;
  assert.equal(failingInspection.readiness.promotable, false);
  assert.ok(
    failingInspection.readiness.reasons.includes("TEST_TASK_NOT_COMPLETED") ||
      failingInspection.readiness.reasons.includes("TEST_STEPS_UNRESOLVED"),
  );

  // 6. Consequential side effect + failed verification remains unresolved.
  const side = (await submitSkillCandidate(
    unresolvedSideEffectManifest(),
  )) as any;
  const sideReport = (await validateSkillCandidate({
    candidateId: side.candidate.id,
    expectedDigest: side.candidate.currentDigest,
  })) as any;
  assert.equal(sideReport.valid, true);
  const sideCompiled = (await compileSkillCandidateTest({
    candidateId: side.candidate.id,
    expectedDigest: side.candidate.currentDigest,
  })) as any;
  assert.equal(sideCompiled.compiled, true);
  const sideRun = (await runPersistentTask(sideCompiled.task.id, {
    failFast: true,
  })) as any;
  assert.ok(["blocked", "failed"].includes(sideRun.status));
  const sideInspection = (await inspectSkillCandidate({
    candidateId: side.candidate.id,
    testTaskId: sideCompiled.task.id,
  })) as any;
  assert.equal(sideInspection.readiness.promotable, false);
  assert.ok(
    sideInspection.readiness.reasons.includes("SIDE_EFFECT_UNRESOLVED"),
  );
  assert.ok(
    sideInspection.readiness.reasons.includes("VERIFICATION_UNRESOLVED"),
  );

  // 7. Promotion success: exact tested digest + M2 + gates + verification.
  const v1 = await promoteValidManifest(repoHealthManifest("1.0.0"));
  assert.equal(v1.promotion.receipt.candidateDigest, v1.candidate.currentDigest);
  assert.equal(v1.promotion.receipt.testTaskId, v1.compiled.task.id);
  assert.equal(typeof v1.promotion.receipt.m2EvidenceDigest, "string");
  assert.equal(v1.promotion.receipt.qualityGate.passed, true);
  assert.equal(v1.promotion.receipt.privacyGate.passed, true);
  assert.equal(v1.promotion.receipt.effectiveContract.riskLevel, "low");
  assert.equal(v1.promotion.receipt.effectiveContract.idempotent, true);

  // Candidate promotion does not create M3 automatically.
  const promotedCandidate = (await getSkillCandidate(v1.candidate.id)) as any;
  assert.equal(promotedCandidate.status, "promoted");
  const semanticStatus = (await semanticMemoryStatus()) as any;
  assert.equal(semanticStatus.recordCount, 0);

  // Dynamic catalog + Skill execution route through the new Registry.
  const catalog = (await getSkillCatalog()) as any[];
  const catalogEntry = catalog.find(
    (skill) => skill.id === "user.repo_health_check",
  );
  assert.ok(catalogEntry);
  assert.equal(catalogEntry.source, "user");
  assert.equal(catalogEntry.activeVersion, "1.0.0");
  assert.equal(catalogEntry.availability, "ready");
  assert.equal(catalogEntry.contract.riskLevel, "low");

  const disabled = (await setUserSkillEnabled(
    "user.repo_health_check",
    false,
  )) as any;
  assert.equal(disabled.skill.enabled, false);
  await assert.rejects(
    () =>
      executeSkill(
        "user.repo_health_check",
        { cwd: root },
        false,
      ),
    /USER_SKILL_DISABLED/,
  );
  const reenabled = (await setUserSkillEnabled(
    "user.repo_health_check",
    true,
  )) as any;
  assert.equal(reenabled.skill.enabled, true);

  const skillExecution = (await executeSkill(
    "user.repo_health_check",
    { cwd: root },
    false,
  )) as any;
  assert.equal(skillExecution.source, "user");
  assert.equal(skillExecution.skillVersion, "1.0.0");
  assert.equal(skillExecution.result.provenance.kind, "user_skill");

  // Public RuntimeClient/RPC surfaces expose canonical Registry truth.
  const publicClient = new InProcessRuntimeClient();
  const capabilities = (await publicClient.getCapabilities("user skill")) as any;
  assert.equal(capabilities.extensions.userSkillRegistry.version, 1);
  assert.equal(capabilities.extensions.userSkillRegistry.status, "candidate");
  assert.equal(typeof publicClient.submitSkillCandidate, "function");
  const publicSkill = (await publicClient.getUserSkill(
    "user.repo_health_check",
  )) as any;
  assert.equal(publicSkill.activeVersion, "1.0.0");
  const rpcSkills = (await invokeRuntimeRpc(
    publicClient,
    "user-skills.list",
    {},
  )) as any;
  assert.ok(
    rpcSkills.skills.some(
      (skill: any) => skill.skillId === "user.repo_health_check",
    ),
  );
  const rpcCandidate = (await invokeRuntimeRpc(
    publicClient,
    "skill-candidates.get",
    { candidateId: v1.candidate.id },
  )) as any;
  assert.equal(rpcCandidate.currentDigest, v1.candidate.currentDigest);

  // 8. Duplicate promotion is idempotent and returns same receipt.
  const duplicate = (await promoteSkillCandidate({
    candidateId: v1.candidate.id,
    expectedDigest: v1.candidate.currentDigest,
    testTaskId: v1.compiled.task.id,
    confirm: true,
  })) as any;
  assert.equal(duplicate.idempotent, true);
  assert.equal(duplicate.receipt.id, v1.promotion.receipt.id);

  // 9. Update = new immutable version; rollback reactivates old version.
  const v2 = await promoteValidManifest(repoHealthManifest("1.1.0"));
  let registry = (await getUserSkill("user.repo_health_check")) as any;
  assert.equal(registry.activeVersion, "1.1.0");
  assert.ok(registry.versions["1.0.0"]);
  assert.ok(registry.versions["1.1.0"]);
  assert.notEqual(
    registry.versions["1.0.0"].candidateDigest,
    registry.versions["1.1.0"].candidateDigest,
  );

  const rolledBack = (await rollbackUserSkill({
    skillId: "user.repo_health_check",
    version: "1.0.0",
  })) as any;
  assert.equal(rolledBack.skill.activeVersion, "1.0.0");
  registry = (await getUserSkill("user.repo_health_check")) as any;
  assert.equal(registry.activeVersion, "1.0.0");
  assert.ok(registry.versions["1.1.0"]);

  const activatedV2 = (await activateUserSkillVersion({
    skillId: "user.repo_health_check",
    version: "1.1.0",
  })) as any;
  assert.equal(activatedV2.skill.activeVersion, "1.1.0");
  const rolledBackAgain = (await rollbackUserSkill({
    skillId: "user.repo_health_check",
    version: "1.0.0",
  })) as any;
  assert.equal(rolledBackAgain.skill.activeVersion, "1.0.0");

  const disposableManifest = {
    ...repoHealthManifest("1.0.0"),
    id: "user.disposable_health",
  };
  await promoteValidManifest(disposableManifest);
  const uninstalled = (await uninstallUserSkill({
    skillId: "user.disposable_health",
  })) as any;
  assert.equal(uninstalled.skill.enabled, false);
  assert.equal(uninstalled.skill.activeVersion, null);
  await assert.rejects(
    () => executeSkill("user.disposable_health", { cwd: root }, false),
    /Unknown skill|ACTIVE_VERSION_UNAVAILABLE/,
  );

  // 10. Real process restart recovery for half-committed promotion.
  const crashScratch = path.join(scratch, "crash-recovery");
  const crashWorker = path.join(
    root,
    "scripts",
    "verify-user-skill-crash-worker.ts",
  );
  const tsx = path.join(root, "node_modules", ".bin", "tsx");
  const baseEnv = {
    ...process.env,
    USER_SKILL_CRASH_SCRATCH: crashScratch,
    USER_SKILL_CRASH_ROOT: root,
  };
  const phase1 = spawnSync(tsx, [crashWorker, "phase1"], {
    cwd: root,
    env: baseEnv,
    encoding: "utf8",
  });
  assert.equal(
    phase1.status,
    0,
    "crash phase1 failed: " + phase1.stdout + phase1.stderr,
  );
  assert.match(phase1.stdout, /FAULT_OBSERVED/);

  const phase2 = spawnSync(tsx, [crashWorker, "phase2"], {
    cwd: root,
    env: baseEnv,
    encoding: "utf8",
  });
  assert.equal(
    phase2.status,
    0,
    "crash phase2 failed: " + phase2.stdout + phase2.stderr,
  );
  assert.match(phase2.stdout, /RECOVERY_PASS/);

  console.log(
    JSON.stringify(
      {
        ok: true,
        invalidCandidate: true,
        repairRevision: true,
        digestMismatch: true,
        concurrentDigestCas: true,
        abiMismatch: true,
        arbitraryShellRejected: true,
        testTaskFailure: true,
        sideEffectUnresolved: true,
        promotionSuccess: true,
        duplicatePromotion: true,
        rollback: true,
        enableDisable: true,
        activateVersion: true,
        uninstall: true,
        crashRestartRecovery: true,
        dynamicCatalog: true,
        publicRuntimeApi: true,
        userSkillExecutionUsesPersistentTask: true,
        m3AutoPromotion: false,
      },
      null,
      2,
    ),
  );
} finally {
  await fs.rm(testOutput, { force: true }).catch(() => undefined);
  await fs.rm(scratch, { recursive: true, force: true }).catch(() => undefined);
}
