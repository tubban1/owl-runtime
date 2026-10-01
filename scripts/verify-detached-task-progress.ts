import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "owl-detached-task-"));
process.env.OWL_RUNTIME_MODE = "test";
process.env.OWL_STATE_ROOT = path.join(root, "state");
process.env.ALLOWED_DIRECTORIES = root;
process.env.ALLOW_SHELL = "true";
process.env.ALLOW_WRITE = "true";
process.env.ALLOW_DELETE = "true";
process.env.OWL_APPROVAL_MODE = "compat";

const { InProcessRuntimeClient } = await import("../src/public/runtimeClient.js");
const client = new InProcessRuntimeClient();

try {
  const task = await client.createTask({
    label: "detached long-task progress verification",
    steps: [
      {
        id: "slow",
        action: "shell.exec",
        args: {
          command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(
            "setTimeout(() => process.stdout.write('done\\n'), 2200)",
          )}`,
          cwd: root,
          timeout_ms: 10_000,
          workspace_mode: "read",
        },
        verify: {
          id: "detached-shell-completed",
          description:
            "The detached verification command must finish and emit its expected completion marker.",
          expectations: [
            {
              path: "state",
              operator: "equals",
              expected: "finished",
            },
            {
              path: "data.stdout",
              operator: "contains",
              expected: "done",
            },
          ],
        },
      },
    ],
  });

  const createdRevision = task.progress.revision;
  const startedAt = Date.now();
  const starts = await Promise.all([
    client.startTask({
      taskId: task.id,
      expectedRevisionDigest: task.executionRevision?.digest,
    }),
    client.startTask({
      taskId: task.id,
      expectedRevisionDigest: task.executionRevision?.digest,
    }),
  ]);
  const acceptanceMs = Date.now() - startedAt;
  const primary = starts.find((result) => result.alreadyRunning === false);
  const racedDuplicate = starts.find((result) => result.alreadyRunning === true);

  assert.ok(primary, "Exactly one concurrent start should create the detached runner.");
  assert.ok(racedDuplicate, "The racing start should join the existing Task lifecycle.");
  assert.equal(primary.accepted, true);
  assert.equal(racedDuplicate.accepted, true);
  assert.ok(
    acceptanceMs < 1_500,
    `Detached start should return promptly; observed ${acceptanceMs} ms.`,
  );

  const duplicate = await client.startTask({ taskId: task.id });
  assert.equal(duplicate.accepted, true);
  assert.equal(duplicate.alreadyRunning, true);

  let observedActive = false;
  let observedRevisionAdvance = false;
  let lastRevision = createdRevision;
  let final = await client.getTask(task.id);

  const deadline = Date.now() + 12_000;
  while (!final.progress.terminal && Date.now() < deadline) {
    const progress = final.progress;
    assert.ok(
      progress.revision >= lastRevision,
      "Progress revision must be monotonic.",
    );
    lastRevision = progress.revision;
    if (progress.revision > createdRevision) observedRevisionAdvance = true;
    if (
      progress.phase === "executing" &&
      progress.activeSteps.some((step) => step.id === "slow")
    ) {
      observedActive = true;
      assert.ok(
        progress.activeSteps[0]?.activeForMs === null ||
          progress.activeSteps[0]!.activeForMs! >= 0,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    final = await client.getTask(task.id);
  }

  assert.equal(final.status, "completed");
  assert.equal(final.progress.terminal, true);
  assert.equal(final.progress.counts.succeeded, 1);
  assert.equal(final.progress.recommendedPollAfterMs, 0);
  assert.ok(observedActive, "Status polling should observe the active step.");
  assert.ok(
    observedRevisionAdvance,
    "Real task lifecycle events should advance progress revision.",
  );

  console.log(
    JSON.stringify(
      {
        ok: true,
        taskId: task.id,
        detachedStart: true,
        acceptanceMs,
        concurrentStartRaceDeduped: true,
        duplicateStartDeduped: true,
        observedActiveProgress: true,
        createdRevision,
        finalRevision: final.progress.revision,
        finalStatus: final.status,
      },
      null,
      2,
    ),
  );
} finally {
  const tasks = await client.listTasks().catch(() => []);
  for (const task of tasks) {
    await client.deleteTask(task.id).catch(() => undefined);
  }
  await fs.rm(root, { recursive: true, force: true });
}
