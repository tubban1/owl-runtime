import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

process.env.OWL_RUNTIME_MODE = "test";

const scratch = process.env.PUBLIC_EVENT_CRASH_SCRATCH;
if (!scratch) throw new Error("PUBLIC_EVENT_CRASH_SCRATCH is required.");

process.env.SKILL_CANDIDATE_DIR = path.join(scratch, "skill-candidates");
process.env.USER_SKILL_DIR = path.join(scratch, "user-skills");
process.env.USER_SKILL_KEY_PATH = path.join(scratch, "user-skills.key");
process.env.RUNTIME_PUBLIC_EVENT_DIR = path.join(scratch, "public-events");
process.env.RUNTIME_PUBLIC_EVENT_KEY_PATH = path.join(scratch, "public-events.key");

const phase = process.argv[2];
const fault = process.argv[3];

const {
  submitSkillCandidate,
  validateSkillCandidate,
  getSkillCandidates,
} = await import("../src/skills/userSkillRuntime.js");
const { InProcessRuntimeClient } = await import("../src/public/runtimeClient.js");

function semanticFailureManifest() {
  return {
    schemaVersion: 1,
    skillAbiVersion: 1,
    id: "user.crash_boundary",
    version: "1.0.0",
    title: "Crash boundary candidate",
    description: "Test-only candidate for AgentRequest outbox recovery.",
    requiredPrimitiveAbi: 999,
    requiredPrimitives: ["git.query"],
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
        id: "status",
        primitive: "git.query",
        op: "status",
        args: { cwd: scratch },
      },
    ],
  };
}

if (phase === "phase1") {
  await fs.mkdir(scratch, { recursive: true });
  if (!fault) throw new Error("phase1 requires a fault point.");
  process.env.AGENTOS_FAULT_INJECTION = fault;

  const submitted = (await submitSkillCandidate(
    semanticFailureManifest(),
  )) as any;
  await assert.rejects(
    () =>
      validateSkillCandidate({
        candidateId: submitted.candidate.id,
        expectedDigest: submitted.candidate.currentDigest,
      }),
    new RegExp("AGENTOS_FAULT_INJECTED: " + fault),
  );

  const candidates = (await getSkillCandidates()) as any[];
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].validation.valid, false);
  assert.equal(candidates[0].publicEventOutbox.length, 1);
  assert.equal(candidates[0].publicEventOutbox[0].state, "pending");
  console.log("FAULT_OBSERVED " + fault);
} else if (phase === "phase2") {
  delete process.env.AGENTOS_FAULT_INJECTION;

  const client = new InProcessRuntimeClient();
  const listed = await client.listEvents({
    afterCursor: "runtime-events:0",
    limit: 20,
    types: ["agent_request.proposed", "agent_request.withdrawn"],
  });
  assert.equal(listed.events.length, 1);
  assert.equal(listed.events[0].eventType, "agent_request.proposed");
  assert.equal(listed.events[0].sequence, 1);
  assert.equal(listed.events[0].cursor, "runtime-events:1");

  const candidates = (await getSkillCandidates()) as any[];
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].publicEventOutbox.length, 1);
  assert.equal(candidates[0].publicEventOutbox[0].state, "published");
  assert.equal(candidates[0].publicEventOutbox[0].publishedSequence, 1);
  console.log("RECOVERY_PASS");
} else {
  throw new Error("usage: worker <phase1|phase2> [fault]");
}
