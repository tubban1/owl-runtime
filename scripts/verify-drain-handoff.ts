import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratch = path.join(root, ".tmp-verify-drain-handoff");
const repo = path.join(scratch, "repo");
const file = path.join(repo, "state.txt");

await fs.rm(scratch, { recursive: true, force: true });
await fs.mkdir(path.join(repo, ".git"), { recursive: true });

process.env.AGENTOS_RUNTIME_MODE = "test";
process.env.AGENTOS_STATE_ROOT = path.join(scratch, "state");
process.env.ALLOWED_DIRECTORIES = scratch;
process.env.ALLOW_WRITE = "true";
process.env.ALLOW_DELETE = "true";
process.env.ALLOW_SHELL = "true";
process.env.PROCESS_STATE_DIR = path.join(scratch, "state", "processes");
process.env.PROCESS_STATE_KEY_PATH = path.join(
  scratch,
  "state",
  "process.key",
);
process.env.PROCESS_LOG_DIR = path.join(
  scratch,
  "state",
  "processes",
  "logs",
);
process.env.WORKSPACE_LEASE_DIR = path.join(
  scratch,
  "state",
  "workspace-leases",
);
process.env.WORKSPACE_HANDOFF_DIR = path.join(
  scratch,
  "state",
  "workspace-handoffs",
);

const { withExecutionContext } = await import(
  "../src/runtime/executionContext.js"
);
const { runtimeLifecycle } = await import(
  "../src/runtime/runtimeLifecycle.js"
);
const { executeRoutedAction } = await import(
  "../src/router/actionRouter.js"
);
const { executeSkill } = await import(
  "../src/skills/skillRuntime.js"
);
const {
  createPersistentPrimitiveTask,
  runPersistentTask,
} = await import("../src/tasks/taskRuntime.js");
const { runSchedulerTick } = await import(
  "../src/runtime/scheduler.js"
);
const { runLoopControllerTick } = await import(
  "../src/runtime/loopController.js"
);
const {
  ensureWorkspaceWriteLease,
  releaseWorkspaceLease,
  waitForWorkspaceAvailable,
  workspaceLeaseStatus,
} = await import("../src/runtime/workspaceLeaseManager.js");
const {
  approveWorkspaceHandoff,
  completeWorkspaceTakeover,
  readWorkspaceHandoff,
  requestWorkspaceTakeover,
} = await import("../src/runtime/workspaceHandoffStore.js");

const sessionA = {
  sessionId: "session-drain-A",
  requestId: "request-drain-A",
  origin: "mcp" as const,
};
const sessionB = {
  sessionId: "session-drain-B",
  requestId: "request-drain-B",
  origin: "mcp" as const,
};

try {
  await withExecutionContext(sessionA, async () => {
    await executeRoutedAction("fs.write", {
      path: file,
      content: "before drain\n",
      overwrite: true,
      create_parents: true,
    });
  });

  const task = await withExecutionContext(sessionA, async () =>
    await createPersistentPrimitiveTask(
      "drain verifier task",
      [
        {
          id: "write",
          primitive: "fs.write",
          op: "write",
          args: {
            path: file,
            content: "task completed after resume\n",
            overwrite: true,
            create_parents: true,
          },
          dependsOn: [],
        },
      ],
      { maxConcurrency: 1, failFast: true },
    ),
  );

  const existingMutation = runtimeLifecycle.beginMutation(
    "verifier-existing-mutation",
    { context: sessionA },
  );

  const drainedRequested = await withExecutionContext(sessionA, async () =>
    await executeSkill("runtime.control", {
      op: "drain",
      reason: "verify graceful drain",
    }),
  );
  assert.equal(
    (drainedRequested.result as any).lifecycle.state,
    "draining",
  );

  await assert.rejects(
    () =>
      withExecutionContext(sessionB, async () =>
        await executeRoutedAction("fs.write", {
          path: file,
          content: "must be blocked\n",
          overwrite: true,
          create_parents: true,
        }),
      ),
    /RUNTIME_DRAINING/,
  );

  const readDuringDrain = await withExecutionContext(sessionB, async () =>
    await executeRoutedAction("fs.read", { path: file }),
  );
  assert.match(String(readDuringDrain.result), /before drain/);

  await assert.rejects(
    () =>
      withExecutionContext(sessionB, async () =>
        await runPersistentTask(task.id, {
          maxConcurrency: 1,
          maxWaves: 5,
          timeBudgetMs: 10_000,
        }),
      ),
    /RUNTIME_DRAINING/,
  );

  const schedulerSkip = await runSchedulerTick();
  assert.equal(schedulerSkip.skipped, true);
  assert.equal(schedulerSkip.reason, "runtime_draining");

  const loopSkip = await runLoopControllerTick();
  assert.equal(loopSkip.skipped, true);
  assert.equal(loopSkip.reason, "runtime_draining");

  setTimeout(() => runtimeLifecycle.endMutation(existingMutation.id), 150);
  const waitResult = await withExecutionContext(sessionA, async () =>
    await executeSkill("runtime.control", {
      op: "wait",
      timeout_ms: 2_000,
    }),
  );
  assert.equal((waitResult.result as any).drained, true);
  assert.equal((waitResult.result as any).timedOut, false);
  assert.ok((waitResult.result as any).waitedMs >= 100);

  await withExecutionContext(sessionA, async () =>
    await executeSkill("runtime.control", { op: "resume" }),
  );
  assert.equal(runtimeLifecycle.status().state, "running");

  const taskRun = await withExecutionContext(sessionA, async () =>
    await runPersistentTask(task.id, {
      maxConcurrency: 1,
      maxWaves: 5,
      timeBudgetMs: 10_000,
    }),
  );
  assert.equal(taskRun.status, "completed");

  const ownerA = {
    ...sessionA,
    taskId: "task-workspace-owner-A",
  };
  await withExecutionContext(ownerA, async () =>
    await ensureWorkspaceWriteLease(repo, {
      purpose: "workspace wait verifier",
    }),
  );

  const waitStarted = Date.now();
  const waiter = withExecutionContext(sessionB, async () =>
    await waitForWorkspaceAvailable(repo, {
      timeoutMs: 2_000,
      pollMs: 50,
    }),
  );
  setTimeout(() => {
    void withExecutionContext(ownerA, async () => {
      await releaseWorkspaceLease(repo);
    });
  }, 150);
  const available = await waiter;
  assert.equal(available.available, true);
  assert.equal(available.timedOut, false);
  assert.ok(Date.now() - waitStarted >= 100);

  const handoffOwner = {
    ...sessionA,
    taskId: "task-handoff-owner-A",
  };
  await withExecutionContext(handoffOwner, async () =>
    await ensureWorkspaceWriteLease(repo, {
      purpose: "handoff verifier owner",
    }),
  );

  const requested = await withExecutionContext(sessionB, async () =>
    await requestWorkspaceTakeover(repo, "take over verifier workspace"),
  );
  assert.equal((requested as any).requested, true);
  const requestId = (requested as any).request.id as string;

  await assert.rejects(
    () => approveWorkspaceHandoff(requestId, false),
    /confirm=true/,
  );
  assert.equal((await workspaceLeaseStatus(repo)).busy, true);

  await assert.rejects(
    () =>
      withExecutionContext(sessionB, async () =>
        await approveWorkspaceHandoff(requestId, true),
      ),
    /HANDOFF_NOT_OWNER/,
  );
  assert.equal((await workspaceLeaseStatus(repo)).busy, true);

  const released = await withExecutionContext(handoffOwner, async () =>
    await approveWorkspaceHandoff(requestId, true),
  );
  assert.equal(released.released, true);
  assert.equal((await workspaceLeaseStatus(repo)).busy, false);
  assert.equal(
    (await readWorkspaceHandoff(requestId)).status,
    "released",
  );

  await assert.rejects(
    () =>
      withExecutionContext(sessionB, async () =>
        await completeWorkspaceTakeover(requestId, false),
      ),
    /confirm=true/,
  );

  await assert.rejects(
    () =>
      withExecutionContext(handoffOwner, async () =>
        await completeWorkspaceTakeover(requestId, true),
      ),
    /TAKEOVER_NOT_REQUESTER/,
  );

  const completed = await withExecutionContext(sessionB, async () =>
    await completeWorkspaceTakeover(requestId, true),
  );
  assert.equal(completed.completed, true);
  assert.equal(
    (await readWorkspaceHandoff(requestId)).status,
    "completed",
  );
  assert.equal((await workspaceLeaseStatus(repo)).busy, true);

  await withExecutionContext(sessionB, async () => {
    await releaseWorkspaceLease(repo);
  });
  assert.equal((await workspaceLeaseStatus(repo)).busy, false);

  console.log(
    JSON.stringify(
      {
        ok: true,
        drainBlocksNewMutations: true,
        readsContinueDuringDrain: true,
        persistentTaskStartBlockedDuringDrain: true,
        schedulerPausesDuringDrain: true,
        loopPausesDuringDrain: true,
        gracefulWaitForExistingMutation: true,
        resumeRestoresMutationAdmission: true,
        workspaceWait: true,
        silentTakeoverBlocked: true,
        handoffRequiresCurrentOwner: true,
        takeoverRequiresOriginalRequester: true,
        explicitHandoff: true,
        explicitTakeover: true,
      },
      null,
      2,
    ),
  );
} finally {
  runtimeLifecycle.resume();
  await fs.rm(scratch, { recursive: true, force: true }).catch(
    () => undefined,
  );
}
