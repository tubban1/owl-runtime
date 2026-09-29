import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

const phase = process.argv[2];
process.env.OWL_RUNTIME_MODE = "test";

const root = process.env.USER_SKILL_CRASH_ROOT;
const scratch = process.env.USER_SKILL_CRASH_SCRATCH;
if (!root || !scratch) {
  throw new Error("USER_SKILL_CRASH_ROOT and USER_SKILL_CRASH_SCRATCH are required.");
}
const contextPath = path.join(scratch, "context.json");

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
  submitSkillCandidate,
  validateSkillCandidate,
  compileSkillCandidateTest,
  promoteSkillCandidate,
  getSkillCandidate,
  getUserSkill,
} = await import("../src/skills/userSkillRuntime.js");
const { runPersistentTask } = await import("../src/tasks/taskRuntime.js");

function manifest() {
  return {
    schemaVersion: 1,
    skillAbiVersion: 1,
    id: "user.crash_recovery_health",
    version: "1.0.0",
    title: "Crash recovery health",
    description:
      "Verify that a half-committed User Skill promotion is recovered idempotently after a real Runtime process restart.",
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
    ],
  };
}

if (phase === "phase1") {
  await fs.rm(scratch, { recursive: true, force: true });
  await fs.mkdir(scratch, { recursive: true });

  const submitted = (await submitSkillCandidate(manifest())) as any;
  const candidate = submitted.candidate;
  const validation = (await validateSkillCandidate({
    candidateId: candidate.id,
    expectedDigest: candidate.currentDigest,
  })) as any;
  assert.equal(validation.valid, true);

  const compiled = (await compileSkillCandidateTest({
    candidateId: candidate.id,
    expectedDigest: candidate.currentDigest,
    inputs: { cwd: root },
  })) as any;
  assert.equal(compiled.compiled, true);
  const ran = (await runPersistentTask(compiled.task.id, {
    failFast: true,
  })) as any;
  assert.equal(ran.status, "completed");

  await fs.writeFile(
    contextPath,
    JSON.stringify({
      candidateId: candidate.id,
      digest: candidate.currentDigest,
      taskId: compiled.task.id,
    }),
    "utf8",
  );

  process.env.AGENTOS_FAULT_INJECTION =
    "user_skill.after_registry_write_before_candidate";
  let faultObserved = false;
  try {
    await promoteSkillCandidate({
      candidateId: candidate.id,
      expectedDigest: candidate.currentDigest,
      testTaskId: compiled.task.id,
      confirm: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assert.match(
      message,
      /AGENTOS_FAULT_INJECTED: user_skill\.after_registry_write_before_candidate/,
    );
    faultObserved = true;
  }
  assert.equal(faultObserved, true);

  const after = (await getSkillCandidate(candidate.id)) as any;
  assert.equal(after.status, "active");
  const registry = (await getUserSkill("user.crash_recovery_health")) as any;
  assert.equal(registry.activeVersion, "1.0.0");

  console.log("FAULT_OBSERVED");
} else if (phase === "phase2") {
  delete process.env.AGENTOS_FAULT_INJECTION;
  const context = JSON.parse(await fs.readFile(contextPath, "utf8"));
  const recovered = (await promoteSkillCandidate({
    candidateId: context.candidateId,
    expectedDigest: context.digest,
    testTaskId: context.taskId,
    confirm: true,
  })) as any;
  assert.equal(recovered.promoted, true);
  assert.equal(recovered.idempotent, true);

  const candidate = (await getSkillCandidate(context.candidateId)) as any;
  assert.equal(candidate.status, "promoted");
  const registry = (await getUserSkill("user.crash_recovery_health")) as any;
  assert.equal(registry.activeVersion, "1.0.0");
  assert.equal(
    registry.versions["1.0.0"].candidateDigest,
    context.digest,
  );
  assert.equal(
    candidate.promotion.id,
    registry.versions["1.0.0"].promotion.id,
  );

  console.log("RECOVERY_PASS");
} else {
  throw new Error("Expected phase1 or phase2.");
}
