import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

process.env.OWL_RUNTIME_MODE = "test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratch = path.join(root, ".tmp-verify-public-event-journal");
process.env.ALLOWED_DIRECTORIES = root;
process.env.SKILL_CANDIDATE_DIR = path.join(scratch, "skill-candidates");
process.env.USER_SKILL_DIR = path.join(scratch, "user-skills");
process.env.USER_SKILL_KEY_PATH = path.join(scratch, "user-skills.key");
process.env.RUNTIME_PUBLIC_EVENT_DIR = path.join(scratch, "public-events");
process.env.RUNTIME_PUBLIC_EVENT_KEY_PATH = path.join(scratch, "public-events.key");
process.env.RUNTIME_PUBLIC_EVENT_RETENTION_MAX = "10000";

const {
  submitSkillCandidate,
  reviseSkillCandidate,
  validateSkillCandidate,
  dismissSkillCandidate,
  getSkillCandidate,
} = await import("../src/skills/userSkillRuntime.js");
const {
  appendPublicRuntimeEvent,
  listPublicRuntimeEvents,
} = await import("../src/runtime/publicEventJournal.js");
const {
  InProcessRuntimeClient,
} = await import("../src/public/runtimeClient.js");
const { invokeRuntimeRpc } = await import("../src/public/runtimeRpc.js");

function semanticFailureManifest(version = "1.0.0") {
  return {
    schemaVersion: 1,
    skillAbiVersion: 1,
    id: "user.agent_request_test",
    version,
    title: "AgentRequest producer test",
    description: "Test-only semantic repair candidate.",
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
        args: { cwd: root },
      },
    ],
  };
}

function permissionEscalationManifest() {
  return {
    schemaVersion: 1,
    skillAbiVersion: 1,
    id: "user.permission_escalation",
    version: "1.0.0",
    title: "Permission escalation",
    description: "Must remain a deterministic policy rejection.",
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
}

function assertSafeEventShape(event: Record<string, unknown>) {
  const forbidden = [
    "prompt",
    "instructions",
    "payload",
    "secret",
    "password",
    "token",
    "sourceCode",
    "rawUserMessage",
    "permissionGrant",
    "remoteCommand",
  ];
  for (const key of forbidden) {
    assert.equal(key in event, false, "forbidden event field: " + key);
  }
}

async function runCrashCase(name: string, fault: string) {
  const caseScratch = path.join(scratch, "crash-" + name);
  await fs.rm(caseScratch, { recursive: true, force: true });
  const worker = path.join(root, "scripts", "verify-public-event-crash-worker.ts");
  const tsx = path.join(root, "node_modules", ".bin", "tsx");
  const env = {
    ...process.env,
    PUBLIC_EVENT_CRASH_SCRATCH: caseScratch,
  };

  const phase1 = spawnSync(tsx, [worker, "phase1", fault], {
    cwd: root,
    env,
    encoding: "utf8",
  });
  assert.equal(
    phase1.status,
    0,
    "crash phase1 failed: " + phase1.stdout + phase1.stderr,
  );
  assert.match(phase1.stdout, /FAULT_OBSERVED/);

  const cleanEnv = { ...env };
  delete cleanEnv.AGENTOS_FAULT_INJECTION;
  const phase2 = spawnSync(tsx, [worker, "phase2"], {
    cwd: root,
    env: cleanEnv,
    encoding: "utf8",
  });
  assert.equal(
    phase2.status,
    0,
    "crash phase2 failed: " + phase2.stdout + phase2.stderr,
  );
  assert.match(phase2.stdout, /RECOVERY_PASS/);
}

try {
  await fs.rm(scratch, { recursive: true, force: true });
  await fs.mkdir(scratch, { recursive: true });

  const client = new InProcessRuntimeClient();
  const capabilities = (await client.getCapabilities("agent request")) as any;
  assert.equal(capabilities.extensions.publicEventJournal.version, 1);
  assert.equal(capabilities.extensions.agentRequestProducer.version, 1);
  assert.equal(capabilities.extensions.agentRequestProducer.embeddedLlm, false);

  const submitted = (await submitSkillCandidate(
    semanticFailureManifest(),
  )) as any;
  const candidateId = submitted.candidate.id;
  const r1Digest = submitted.candidate.currentDigest;

  const report1 = (await validateSkillCandidate({
    candidateId,
    expectedDigest: r1Digest,
  })) as any;
  assert.equal(report1.valid, false);
  assert.ok(
    report1.errors.some(
      (error: any) =>
        error.code === "USER_SKILL_PRIMITIVE_ABI_UNSUPPORTED",
    ),
  );

  const first = await client.listEvents({
    afterCursor: "runtime-events:0",
    limit: 100,
    types: ["agent_request.proposed", "agent_request.withdrawn"],
  });
  assert.equal(first.events.length, 1);
  const proposal1 = first.events[0] as any;
  assert.equal(proposal1.eventType, "agent_request.proposed");
  assert.equal(proposal1.sequence, 1);
  assert.equal(proposal1.cursor, "runtime-events:1");
  assert.equal(proposal1.requestType, "skill.repair");
  assert.equal(proposal1.subject.kind, "skill_candidate");
  assert.equal(proposal1.subject.id, candidateId);
  assert.equal(proposal1.subject.revision, "1");
  assert.equal(proposal1.reasonCode, "VALIDATION_FAILED");
  assert.deepEqual(
    proposal1.errorCodes,
    ["USER_SKILL_PRIMITIVE_ABI_UNSUPPORTED"],
  );
  assert.deepEqual(proposal1.allowedActions, [
    "candidate.inspect",
    "candidate.revise",
    "candidate.validate",
  ]);
  assert.equal(proposal1.requiresUserConfirmation, true);
  assert.match(proposal1.proposalId, /^proposal_skill_[a-f0-9]{24}$/);
  assert.match(
    proposal1.dedupeKey,
    new RegExp(
      "^runtime:agent_request_v1:skill_candidate:" +
        candidateId +
        ":r1:" +
        r1Digest.slice(0, 12) +
        ":validation_failed$",
    ),
  );
  assertSafeEventShape(proposal1);

  // Repeated validation is producer-idempotent.
  await validateSkillCandidate({
    candidateId,
    expectedDigest: r1Digest,
  });
  const duplicateCheck = await client.listEvents({
    afterCursor: "runtime-events:0",
    limit: 100,
  });
  assert.equal(duplicateCheck.events.length, 1);
  assert.equal(duplicateCheck.events[0].eventId, proposal1.eventId);

  // Cursor replay / fresh client instance preserve the same event identity.
  const freshClient = new InProcessRuntimeClient();
  const replay = await freshClient.listEvents({
    afterCursor: "runtime-events:0",
    limit: 100,
  });
  assert.equal(replay.events.length, 1);
  assert.equal(replay.events[0].eventId, proposal1.eventId);
  assert.equal(replay.events[0].proposalId, proposal1.proposalId);

  const rpcReplay = (await invokeRuntimeRpc(
    freshClient,
    "events.list",
    {
      afterCursor: "runtime-events:0",
      limit: 100,
      types: ["agent_request.proposed", "agent_request.withdrawn"],
    },
  )) as any;
  assert.equal(rpcReplay.events[0].eventId, proposal1.eventId);

  // Revision change resolves the old issue and emits exactly one withdrawal.
  const revised = (await reviseSkillCandidate({
    candidateId,
    expectedDigest: r1Digest,
    manifest: semanticFailureManifest("1.0.1"),
  })) as any;
  assert.equal(revised.candidate.revision, 2);
  const r2Digest = revised.candidate.currentDigest;
  assert.notEqual(r2Digest, r1Digest);

  const afterRevise = await client.listEvents({
    afterCursor: "runtime-events:0",
    limit: 100,
  });
  assert.equal(afterRevise.events.length, 2);
  const withdrawal = afterRevise.events[1] as any;
  assert.equal(withdrawal.eventType, "agent_request.withdrawn");
  assert.equal(withdrawal.sequence, 2);
  assert.equal(withdrawal.proposalId, proposal1.proposalId);
  assert.equal(withdrawal.dedupeKey, proposal1.dedupeKey);
  assert.equal(withdrawal.reasonCode, "ISSUE_RESOLVED");
  assertSafeEventShape(withdrawal);

  // Stale revision/digest may not create a new proposal.
  await assert.rejects(
    () =>
      validateSkillCandidate({
        candidateId,
        expectedDigest: r1Digest,
      }),
    /USER_SKILL_CANDIDATE_DIGEST_MISMATCH/,
  );
  assert.equal(
    (await client.listEvents({ afterCursor: "runtime-events:0" })).events.length,
    2,
  );

  // New invalid revision creates a distinct stable proposal.
  await validateSkillCandidate({
    candidateId,
    expectedDigest: r2Digest,
  });
  const afterR2Validate = await client.listEvents({
    afterCursor: "runtime-events:0",
    limit: 100,
  });
  assert.deepEqual(
    afterR2Validate.events.map((event) => event.sequence),
    [1, 2, 3],
  );
  const proposal2 = afterR2Validate.events[2] as any;
  assert.equal(proposal2.eventType, "agent_request.proposed");
  assert.equal(proposal2.subject.revision, "2");
  assert.notEqual(proposal2.proposalId, proposal1.proposalId);
  assert.notEqual(proposal2.dedupeKey, proposal1.dedupeKey);

  // Replaying dismissal/withdrawal remains idempotent.
  await dismissSkillCandidate({
    candidateId,
    expectedDigest: r2Digest,
  });
  const afterDismiss = await client.listEvents({
    afterCursor: "runtime-events:0",
    limit: 100,
  });
  assert.deepEqual(
    afterDismiss.events.map((event) => event.sequence),
    [1, 2, 3, 4],
  );
  await dismissSkillCandidate({
    candidateId,
    expectedDigest: r2Digest,
  });
  assert.equal(
    (await client.listEvents({ afterCursor: "runtime-events:0" })).events.length,
    4,
  );

  // Permission escalation is a deterministic policy rejection, not an LLM job.
  const escalation = (await submitSkillCandidate(
    permissionEscalationManifest(),
  )) as any;
  const escalationReport = (await validateSkillCandidate({
    candidateId: escalation.candidate.id,
    expectedDigest: escalation.candidate.currentDigest,
  })) as any;
  assert.equal(escalationReport.valid, false);
  assert.ok(
    escalationReport.errors.some(
      (error: any) =>
        error.code === "USER_SKILL_PRIMITIVE_NOT_ALLOWED" ||
        error.code === "USER_SKILL_REQUIRED_PRIMITIVE_NOT_ALLOWED",
    ),
  );
  assert.equal(
    (await client.listEvents({ afterCursor: "runtime-events:0" })).events.length,
    4,
  );

  // Strict public schema rejects prompt/payload/secret/permission channels.
  const safeDraft: any = {
    eventType: "agent_request.proposed",
    eventId: "evt_strict_1",
    proposalId: "proposal_strict_1",
    requestType: "skill.repair",
    priority: "normal",
    subject: { kind: "skill_candidate", id: "candidate_strict", revision: "1" },
    reasonCode: "VALIDATION_FAILED",
    errorCodes: ["SEMANTIC_REPAIR_REQUIRED"],
    contextRefs: [],
    allowedActions: ["candidate.inspect"],
    requiresUserConfirmation: true,
    dedupeKey: "runtime:strict:1",
    occurredAt: new Date().toISOString(),
  };
  for (const forbidden of [
    "prompt",
    "instructions",
    "payload",
    "secret",
    "permissionGrant",
  ]) {
    await assert.rejects(
      () => appendPublicRuntimeEvent({ ...safeDraft, [forbidden]: "blocked" }),
    );
  }

  // Retention gap is explicit and never silently jumps to the newest cursor.
  const retentionScratch = path.join(scratch, "retention");
  process.env.RUNTIME_PUBLIC_EVENT_DIR = path.join(retentionScratch, "events");
  process.env.RUNTIME_PUBLIC_EVENT_KEY_PATH = path.join(retentionScratch, "events.key");
  process.env.RUNTIME_PUBLIC_EVENT_RETENTION_MAX = "3";
  let firstRetentionOccurredAt = "";
  for (let index = 1; index <= 5; index += 1) {
    const occurredAt = new Date(Date.now() + index).toISOString();
    if (index === 1) firstRetentionOccurredAt = occurredAt;
    await appendPublicRuntimeEvent({
      ...safeDraft,
      eventId: "evt_retention_" + index,
      proposalId: "proposal_retention_" + index,
      dedupeKey: "runtime:retention:" + index,
      occurredAt,
    });
  }
  await assert.rejects(
    () => listPublicRuntimeEvents({ afterCursor: "runtime-events:1" }),
    /CURSOR_EXPIRED: RETENTION_GAP/,
  );
  const retained = await listPublicRuntimeEvents({
    afterCursor: "runtime-events:2",
    limit: 10,
  });
  assert.deepEqual(
    retained.events.map((event) => event.sequence),
    [3, 4, 5],
  );
  assert.equal(retained.retention.oldestSequence, 3);
  assert.equal(retained.retention.newestSequence, 5);

  // Replaying an event whose payload aged out of retention must keep its
  // original sequence. Desktop treats same-eventId delivery as a no-op and
  // would otherwise fail the next event as a sequence gap.
  const expiredReplay = await appendPublicRuntimeEvent({
    ...safeDraft,
    eventId: "evt_retention_1",
    proposalId: "proposal_retention_1",
    dedupeKey: "runtime:retention:1",
    occurredAt: firstRetentionOccurredAt,
  });
  assert.equal(expiredReplay.sequence, 1);
  assert.equal(expiredReplay.cursor, "runtime-events:1");
  const afterExpiredReplay = await listPublicRuntimeEvents({
    afterCursor: "runtime-events:2",
    limit: 10,
  });
  assert.deepEqual(
    afterExpiredReplay.events.map((event) => event.sequence),
    [3, 4, 5],
  );
  assert.equal(afterExpiredReplay.retention.newestSequence, 5);

  // Corruption is fail-closed, never treated as an empty journal.
  await fs.writeFile(
    path.join(retentionScratch, "events", "journal.state"),
    "{not-json\n",
    "utf8",
  );
  await assert.rejects(
    () => listPublicRuntimeEvents({ afterCursor: "runtime-events:2" }),
    /PUBLIC_EVENT_JOURNAL_CORRUPT/,
  );

  // Real process restart recovery at both state/journal crash boundaries.
  process.env.RUNTIME_PUBLIC_EVENT_RETENTION_MAX = "10000";
  await runCrashCase(
    "after-state",
    "user_skill_agent_request_after_state_commit",
  );
  await runCrashCase(
    "after-journal",
    "user_skill_agent_request_after_journal_append",
  );

  // Canonical candidate state remains separately readable from coordination events.
  process.env.RUNTIME_PUBLIC_EVENT_DIR = path.join(scratch, "public-events");
  process.env.RUNTIME_PUBLIC_EVENT_KEY_PATH = path.join(scratch, "public-events.key");
  const canonical = (await getSkillCandidate(candidateId)) as any;
  assert.equal(canonical.status, "dismissed");
  assert.equal(canonical.revision, 2);
  assert.equal(canonical.currentDigest, r2Digest);

  console.log(
    JSON.stringify(
      {
        ok: true,
        durableGlobalSequence: true,
        cursorReplay: true,
        runtimeRestartRecovery: true,
        duplicateProposalSuppressed: true,
        withdrawReplaySuppressed: true,
        staleRevisionRejected: true,
        revisionDigestIdentity: true,
        cursorExpirationExplicit: true,
        expiredEventIdKeepsOriginalSequence: true,
        journalCorruptionFailClosed: true,
        promptInjectionRejected: true,
        secretFieldRejected: true,
        permissionEscalationNotProposed: true,
        stateEventCrashBoundaryRecovered: true,
        publicRpcEventsList: true,
      },
      null,
      2,
    ),
  );
} finally {
  await fs.rm(scratch, { recursive: true, force: true }).catch(() => undefined);
}
