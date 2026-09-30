import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { InProcessRuntimeClient } from "../src/public/runtimeClient.js";
import { createPersistentPrimitiveTask } from "../src/tasks/taskRuntime.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "owl-execution-activation-"));
process.env.AGENTOS_STATE_ROOT = root;
process.env.ALLOWED_DIRECTORIES = root;

const client = new InProcessRuntimeClient();
const target = path.join(root, "activated.txt");
const request = {
  label: "tested activation conformance",
  steps: [
    {
      id: "write",
      action: "fs.write",
      args: {
        path: target,
        content: "exact tested revision",
      },
    },
  ],
};

try {
  const capabilities = await client.getCapabilities("tested activation");
  assert.equal(capabilities.extensions.executionActivation.version, 1);

  const testTask = await client.createTask(request);
  const digest = testTask.executionRevision.digest;
  assert.match(digest, /^[a-f0-9]{64}$/);

  await client.runTask({
    taskId: testTask.id,
    expectedRevisionDigest: digest,
  });

  await assert.rejects(
    () =>
      client.activateExecutionRevision({
        testTaskId: testTask.id,
        expectedRevisionDigest: "0".repeat(64),
        confirm: true,
      }),
    (error) => error?.code === "EXECUTION_REVISION_DIGEST_MISMATCH",
  );

  const activated = await client.activateExecutionRevision({
    testTaskId: testTask.id,
    expectedRevisionDigest: digest,
    confirm: true,
  });
  assert.equal(activated.idempotent, false);
  assert.equal(activated.activation.revisionDigest, digest);
  assert.equal(activated.activation.testTaskId, testTask.id);
  assert.match(activated.activation.evidenceDigest, /^[a-f0-9]{64}$/);

  const replay = await client.activateExecutionRevision({
    testTaskId: testTask.id,
    expectedRevisionDigest: digest,
    confirm: true,
  });
  assert.equal(replay.idempotent, true);
  assert.equal(replay.activation.id, activated.activation.id);

  await assert.rejects(
    () => client.deleteTask(testTask.id),
    /EXECUTION_ACTIVATION_DELETE_BLOCKED/,
  );

  await assert.rejects(
    () =>
      client.createTaskFromActivation({
        testTaskId: testTask.id,
        expectedRevisionDigest: "f".repeat(64),
      }),
    /STALE_TEST_EVIDENCE/,
  );

  const productionTask = await client.createTaskFromActivation({
    testTaskId: testTask.id,
    expectedRevisionDigest: digest,
  });
  assert.equal(productionTask.executionRevision.digest, digest);
  assert.equal(productionTask.provenance.kind, "activated_revision");
  assert.equal(productionTask.provenance.activationId, activated.activation.id);

  const productionResult = await client.runTask({
    taskId: productionTask.id,
    expectedRevisionDigest: digest,
  });
  assert.equal(productionResult.status, "completed");
  assert.equal(
    await fs.readFile(target, "utf8"),
    "exact tested revision",
  );

  const primitiveTask = await createPersistentPrimitiveTask(
    "primitive revision coverage",
    [
      {
        id: "read",
        primitive: "fs.read",
        op: "one",
        args: { path: target },
      },
    ],
  );
  assert.equal(primitiveTask.executionRevision.version, 1);
  assert.match(primitiveTask.executionRevision.digest, /^[a-f0-9]{64}$/);

  console.log(
    JSON.stringify(
      {
        ok: true,
        executionActivationVersion: 1,
        exactRevisionEvidenceBinding: true,
        atomicActivationReceipt: true,
        idempotentActivation: true,
        staleEvidenceRejected: true,
        activatedTaskDigestPreserved: true,
        primitiveTaskRevisionCovered: true,
      },
      null,
      2,
    ),
  );
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
