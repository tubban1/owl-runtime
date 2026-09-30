import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { InProcessRuntimeClient } from "../src/public/runtimeClient.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "owl-execution-revision-"));
process.env.AGENTOS_STATE_ROOT = root;
process.env.ALLOWED_DIRECTORIES = root;

const client = new InProcessRuntimeClient();
const request = {
  label: "execution revision conformance",
  steps: [
    {
      id: "write",
      action: "fs.write",
      args: {
        path: path.join(root, "revision.txt"),
        content: "bound revision",
      },
    },
  ],
};

try {
  console.error("[execution-revision] checkpoint=capabilities:start");
  const capabilities = await client.getCapabilities("execution revision");
  assert.equal(capabilities.extensions.executionRevision.version, 1);
  console.error("[execution-revision] checkpoint=capabilities:done");

  const created = await client.createTask(request);
  console.error("[execution-revision] checkpoint=create:first");
  assert.equal(created.status, "pending");
  assert.equal(created.executionRevision.version, 1);
  assert.match(created.executionRevision.digest, /^[a-f0-9]{64}$/);
  const digest = created.executionRevision.digest;

  const reread = await client.getTask(created.id);
  assert.equal(reread.executionRevision.digest, digest);
  console.error("[execution-revision] checkpoint=reread:first");

  await assert.rejects(
    () =>
      client.runTask({
        taskId: created.id,
        expectedRevisionDigest: "0".repeat(64),
      }),
    (error) =>
      error?.code === "EXECUTION_REVISION_DIGEST_MISMATCH",
  );

  const afterMismatch = await client.getTask(created.id);
  assert.equal(afterMismatch.status, "pending");
  assert.equal(afterMismatch.runCount, 0);
  console.error("[execution-revision] checkpoint=mismatch:rejected");

  console.error("[execution-revision] checkpoint=run:start");
  const completed = await client.runTask({
    taskId: created.id,
    expectedRevisionDigest: digest,
  });
  assert.equal(completed.status, "completed");
  assert.equal(completed.executionRevision.digest, digest);
  assert.equal(await fs.readFile(path.join(root, "revision.txt"), "utf8"), "bound revision");
  console.error("[execution-revision] checkpoint=run:completed");

  const sameSemantic = await client.createTask({
    ...request,
    steps: request.steps.map((step) => ({
      ...step,
      dependsOn: [],
    })),
  });
  assert.equal(
    sameSemantic.executionRevision.digest,
    digest,
    "normalized default fields must produce a stable digest",
  );
  console.error("[execution-revision] checkpoint=create:semantic");

  const changed = await client.createTask({
    ...request,
    steps: [
      {
        ...request.steps[0],
        args: {
          ...request.steps[0].args,
          content: "different revision",
        },
      },
    ],
  });
  assert.notEqual(changed.executionRevision.digest, digest);
  console.error("[execution-revision] checkpoint=create:changed");

  console.log(
    JSON.stringify(
      {
        ok: true,
        executionRevisionVersion: 1,
        immutableDigest: true,
        digestBoundExecution: true,
        mismatchBeforeSideEffect: true,
        stableCanonicalization: true,
      },
      null,
      2,
    ),
  );
} finally {
  console.error("[execution-revision] checkpoint=cleanup:start");
  await fs.rm(root, { recursive: true, force: true });
  console.error("[execution-revision] checkpoint=cleanup:done");
}
