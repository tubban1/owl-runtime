import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { InProcessRuntimeClient } from "../src/public/runtimeClient.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "owl-approval-resume-"));
process.env.AGENTOS_STATE_ROOT = root;
process.env.ALLOWED_DIRECTORIES = root;
process.env.ALLOW_DELETE = "true";
process.env.OWL_APPROVAL_MODE = "enforce";
process.env.OWL_APPROVAL_ACTIONS = "fs.delete";

const client = new InProcessRuntimeClient();
const target = path.join(root, "delete-after-approval.txt");
await fs.writeFile(target, "must survive until exact approval\n");

const request = {
  label: "same execution approval resume",
  steps: [
    {
      id: "delete",
      action: "fs.delete",
      args: { path: target },
    },
  ],
};

try {
  const capabilities = await client.getCapabilities("approval resume");
  assert.equal(capabilities.extensions.approvalResume.version, 1);

  const first = await client.createTask(request);
  const second = await client.createTask(request);
  const digest = first.executionRevision.digest;
  assert.equal(second.executionRevision.digest, digest);

  const firstRun = await client.runTask({
    taskId: first.id,
    expectedRevisionDigest: digest,
  });
  assert.equal(firstRun.status, "waiting_approval");
  await fs.access(target);

  const secondRun = await client.runTask({
    taskId: second.id,
    expectedRevisionDigest: digest,
  });
  assert.equal(secondRun.status, "waiting_approval");
  await fs.access(target);

  const pending = await client.listApprovals("pending");
  assert.equal(pending.length, 2);
  const firstApproval = pending.find(
    (item: any) => item.ownerTaskId === first.id,
  );
  const secondApproval = pending.find(
    (item: any) => item.ownerTaskId === second.id,
  );
  assert.ok(firstApproval);
  assert.ok(secondApproval);
  assert.notEqual(firstApproval.id, secondApproval.id);
  assert.equal(firstApproval.ownerStepId, "delete");
  assert.equal(secondApproval.ownerStepId, "delete");
  assert.equal(firstApproval.fingerprint, secondApproval.fingerprint);

  const denied = await client.deny(secondApproval.id, true);
  assert.equal(denied.approval.state, "denied");
  assert.equal(denied.task.status, "failed");
  await fs.access(target);

  const approved = await client.approve(firstApproval.id, true);
  assert.equal(approved.approval.state, "approved");
  assert.equal(approved.resume.resumed, true);
  assert.equal(approved.resume.taskId, first.id);
  assert.equal(approved.resume.stepId, "delete");
  assert.equal(approved.resume.result.status, "completed");
  await assert.rejects(() => fs.access(target));

  const finalTask = await client.getTask(first.id);
  assert.equal(finalTask.status, "completed");
  assert.equal(finalTask.runCount, 2);
  assert.equal(finalTask.steps[0].attempts, 2);
  assert.equal(finalTask.steps[0].state, "succeeded");
  assert.equal(finalTask.steps[0].approval.id, firstApproval.id);

  const consumed = await client.getApproval(firstApproval.id);
  assert.equal(consumed.state, "consumed");
  assert.equal(consumed.ownerTaskId, first.id);
  assert.equal(consumed.ownerStepId, "delete");

  const tasks = await client.listTasks();
  assert.equal(tasks.length, 2, "approval resume must not create a replacement task");

  console.log(
    JSON.stringify(
      {
        ok: true,
        approvalResumeVersion: 1,
        sideEffectBlockedBeforeApproval: true,
        approvalBoundToTaskAndStep: true,
        sameFingerprintIsolatedAcrossTasks: true,
        sameTaskSameStepResumed: true,
        noReplacementTask: true,
        denialTerminatesWithoutSideEffect: true,
      },
      null,
      2,
    ),
  );
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
