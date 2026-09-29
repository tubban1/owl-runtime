import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { InProcessRuntimeClient } from "../src/public/runtimeClient.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "owl-public-dto-"));
process.env.AGENTOS_STATE_ROOT = root;
process.env.ALLOWED_DIRECTORIES = root;
process.env.ALLOW_DELETE = "true";

const client = new InProcessRuntimeClient();

try {
  const capabilities = await client.getCapabilities("typed public dto");
  assert.equal(capabilities.extensions.typedPublicDto.version, 1);

  const target = path.join(root, "dto.txt");
  const task = await client.createTask({
    label: "public dto conformance",
    steps: [
      {
        id: "write",
        action: "fs.write",
        args: { path: target, content: "dto" },
      },
    ],
  });
  assert.equal(task.schemaVersion, 1);
  assert.equal(task.executionRevision?.version, 1);

  const summaries = await client.listTasks();
  assert.equal(summaries[0]?.schemaVersion, 1);
  assert.equal(typeof summaries[0]?.counts.waitingApproval, "number");

  const run = await client.runTask({
    taskId: task.id,
    expectedRevisionDigest: task.executionRevision!.digest,
  });
  assert.equal(run.schemaVersion, 1);
  assert.equal(run.summary.schemaVersion, 1);
  assert.equal(run.summary.steps[0]?.observation?.schemaVersion, 1);
  if (run.summary.steps[0]?.verification) {
    assert.equal(run.summary.steps[0].verification.schemaVersion, 1);
  }

  const reread = await client.getTask(task.id);
  assert.equal(reread.schemaVersion, 1);

  const schedule = await client.createSchedule({
    label: "dto schedule",
    trigger: {
      kind: "once",
      at: new Date(Date.now() + 60_000).toISOString(),
    },
    steps: [
      {
        id: "read",
        primitive: "fs.read",
        op: "one",
        args: { path: target },
      },
    ],
  });
  assert.equal(schedule.schemaVersion, 1);
  assert.equal(typeof schedule.createdAt, "string");
  assert.equal(typeof schedule.updatedAt, "string");
  assert.equal((await client.getSchedule(schedule.id)).schemaVersion, 1);

  process.env.OWL_APPROVAL_MODE = "enforce";
  process.env.OWL_APPROVAL_ACTIONS = "fs.delete";
  const deleteTarget = path.join(root, "approval.txt");
  await fs.writeFile(deleteTarget, "approval\n");
  const approvalTask = await client.createTask({
    label: "dto approval",
    steps: [
      {
        id: "delete",
        action: "fs.delete",
        args: { path: deleteTarget },
      },
    ],
  });
  const waiting = await client.runTask({
    taskId: approvalTask.id,
    expectedRevisionDigest: approvalTask.executionRevision!.digest,
  });
  assert.equal(waiting.status, "waiting_approval");

  const approvals = await client.listApprovals("pending");
  assert.equal(approvals[0]?.schemaVersion, 1);
  const denied = await client.deny(approvals[0]!.id, true);
  assert.equal(denied.schemaVersion, 1);
  assert.equal(denied.approval.schemaVersion, 1);

  console.log(
    JSON.stringify(
      {
        ok: true,
        publicDtoVersion: 1,
        taskSummaryTyped: true,
        taskDetailTyped: true,
        runReceiptTyped: true,
        observationTyped: true,
        verificationTyped: true,
        approvalTyped: true,
        scheduleTyped: true,
      },
      null,
      2,
    ),
  );
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
