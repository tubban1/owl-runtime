import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratch = path.join(root, ".tmp-verify-fault-recovery");
const state = path.join(scratch, "state");
const repo = path.join(scratch, "repo");
const handoffRepo = path.join(scratch, "handoff-repo");
const txRepo = path.join(scratch, "tx-repo");
const filePath = path.join(repo, "atomic.txt");
const schedulerOutput = path.join(repo, "scheduler.txt");
const loopOutput = path.join(repo, "loop.txt");
const semanticSource = path.join(repo, "semantic.txt");

await fs.rm(scratch, { recursive: true, force: true });
for (const dir of [repo, handoffRepo, txRepo]) {
  await fs.mkdir(dir, { recursive: true });
}

process.env.AGENTOS_RUNTIME_MODE = "test";
process.env.AGENTOS_STATE_ROOT = state;
process.env.ALLOWED_DIRECTORIES = scratch;
process.env.ALLOW_WRITE = "true";
process.env.ALLOW_DELETE = "true";
process.env.ALLOW_SHELL = "true";
process.env.ALLOW_ROLLBACK = "true";
process.env.TASK_DIR = path.join(state, "tasks");
process.env.TASK_KEY_PATH = path.join(state, "task.key");
process.env.TASK_STAGING_DIR = path.join(state, "staging");
process.env.TASK_STAGING_EXPOSE_TO_FS = "true";
process.env.EPISODIC_INDEX_DIR = path.join(state, "episodes");
process.env.EPISODIC_INDEX_KEY_PATH = path.join(state, "episode.key");
process.env.SCHEDULER_DIR = path.join(state, "schedules");
process.env.SCHEDULER_KEY_PATH = path.join(state, "schedule.key");
process.env.LOOP_DIR = path.join(state, "loops");
process.env.LOOP_KEY_PATH = path.join(state, "loop.key");
process.env.SEMANTIC_MEMORY_DIR = path.join(state, "semantic");
process.env.SEMANTIC_MEMORY_KEY_PATH = path.join(state, "semantic.key");
process.env.WORKSPACE_LEASE_DIR = path.join(state, "workspace-leases");
process.env.WORKSPACE_HANDOFF_DIR = path.join(state, "workspace-handoffs");
process.env.TRANSACTION_DIR = path.join(state, "transactions");

const setFault = (point?: string) => {
  if (point) process.env.AGENTOS_FAULT_INJECTION = point;
  else delete process.env.AGENTOS_FAULT_INJECTION;
};

const { writeFile } = await import("../src/tools/fileOps.js");
const {
  createPrimitiveSchedule,
  deletePersistentSchedule,
  getPersistentSchedule,
  runSchedulerTick,
} = await import("../src/runtime/scheduler.js");
const {
  createPersistentLoop,
  deletePersistentLoop,
  getPersistentLoop,
  runLoopControllerTick,
} = await import("../src/runtime/loopController.js");
const {
  createPersistentPrimitiveTask,
  deletePersistentTask,
  getPersistentTaskStatus,
  runPersistentTask,
} = await import("../src/tasks/taskRuntime.js");
const {
  promoteSemanticMemory,
  removeSemanticMemory,
  semanticMemoryStatus,
} = await import("../src/runtime/memoryPromotion.js");
const { withExecutionContext } = await import(
  "../src/runtime/executionContext.js"
);
const {
  ensureWorkspaceWriteLease,
  releaseWorkspaceLease,
  workspaceLeaseStatus,
} = await import("../src/runtime/workspaceLeaseManager.js");
const {
  approveWorkspaceHandoff,
  completeWorkspaceTakeover,
  readWorkspaceHandoff,
  requestWorkspaceTakeover,
} = await import("../src/runtime/workspaceHandoffStore.js");
const {
  beginTransaction,
  completeTransaction,
  getTransactionStatus,
  rollbackTransaction,
} = await import("../src/tools/transactionOps.js");

let scheduleId = "";
let loopId = "";
let semanticTaskId = "";
let semanticMemoryId = "";

const sessionA = {
  sessionId: "fault-session-A",
  requestId: "fault-request-A",
  origin: "mcp" as const,
};
const sessionB = {
  sessionId: "fault-session-B",
  requestId: "fault-request-B",
  origin: "mcp" as const,
};

try {
  // Filesystem: temp write must never replace the original before commit.
  await writeFile(filePath, "baseline\n", true, true);
  setFault("filesystem.after_temp_before_commit");
  await assert.rejects(
    () => writeFile(filePath, "corrupt-me\n", true, true),
    /AGENTOS_FAULT_INJECTED/,
  );
  assert.equal(await fs.readFile(filePath, "utf8"), "baseline\n");
  assert.deepEqual(
    (await fs.readdir(repo)).filter((name) => name.includes(".tmp")),
    [],
  );
  setFault();
  await writeFile(filePath, "committed\n", true, true);
  assert.equal(await fs.readFile(filePath, "utf8"), "committed\n");

  // Scheduler: occurrence receipt is persisted before Task creation.
  const schedule = await createPrimitiveSchedule({
    label: "fault recovery scheduler",
    trigger: {
      kind: "interval",
      everyMs: 1_000,
      startAt: new Date(Date.now() - 2_000).toISOString(),
    },
    steps: [
      {
        id: "write",
        primitive: "fs.write",
        op: "write",
        args: {
          path: schedulerOutput,
          content: "scheduler-once\n",
          overwrite: true,
          create_parents: true,
        },
      },
    ],
    maxRuns: 1,
    timeBudgetMs: 10_000,
  });
  scheduleId = schedule.id;
  setFault("scheduler.after_occurrence_receipt_before_task");
  await assert.rejects(
    () => runSchedulerTick(Date.now()),
    /AGENTOS_FAULT_INJECTED/,
  );
  const scheduleAfterFault = await getPersistentSchedule(scheduleId);
  const scheduledTaskId = String(scheduleAfterFault.activeTaskId);
  assert.match(scheduledTaskId, /^task_schedule_/);
  await assert.rejects(
    () => getPersistentTaskStatus(scheduledTaskId, false),
    /ENOENT/,
  );
  setFault();
  await runSchedulerTick(Date.now() + 5_000);
  const scheduleRecovered = await getPersistentSchedule(scheduleId);
  assert.equal(scheduleRecovered.lastTaskId, scheduledTaskId);
  assert.equal(scheduleRecovered.runCount, 1);
  assert.equal(await fs.readFile(schedulerOutput, "utf8"), "scheduler-once\n");

  // Loop: phase occurrence uses the same deterministic Task after restart.
  const loop = await createPersistentLoop({
    label: "fault recovery loop",
    pollIntervalMs: 1_000,
    maxCycles: 1,
    phases: [
      {
        id: "first",
        steps: [
          {
            id: "write",
            primitive: "fs.write",
            op: "write",
            args: {
              path: loopOutput,
              content: "loop-once\n",
              overwrite: true,
              create_parents: true,
            },
          },
        ],
      },
      {
        id: "second",
        steps: [
          {
            id: "read",
            primitive: "fs.read",
            op: "one",
            args: { path: loopOutput },
          },
        ],
        outputRef: "read",
      },
    ],
  });
  loopId = loop.id;
  setFault("loop.after_phase_receipt_before_task");
  await assert.rejects(
    () => runLoopControllerTick(Date.now() + 100),
    /AGENTOS_FAULT_INJECTED/,
  );
  const loopAfterFault = await getPersistentLoop(loopId);
  const loopTaskId = String(loopAfterFault.activeTaskId);
  assert.match(loopTaskId, /^task_loop_/);
  await assert.rejects(
    () => getPersistentTaskStatus(loopTaskId, false),
    /ENOENT/,
  );
  setFault();
  await runLoopControllerTick(Date.now() + 5_000);
  const loopRecovered = await getPersistentLoop(loopId);
  assert.equal(loopRecovered.lastTaskId, loopTaskId);
  assert.equal(loopRecovered.phase, "second");
  assert.equal(await fs.readFile(loopOutput, "utf8"), "loop-once\n");

  // Semantic promotion: memory write may commit before provenance backlink.
  const semanticTask = await createPersistentPrimitiveTask(
    "fault recovery semantic promotion",
    [
      {
        id: "write",
        primitive: "fs.write",
        op: "write",
        args: {
          path: semanticSource,
          content: "semantic evidence\n",
          overwrite: true,
          create_parents: true,
        },
      },
      {
        id: "read",
        primitive: "fs.read",
        op: "one",
        args: { path: semanticSource },
        dependsOn: ["write"],
      },
    ],
    { maxConcurrency: 1, failFast: true },
  );
  semanticTaskId = semanticTask.id;
  assert.equal(
    (await runPersistentTask(semanticTaskId, { maxConcurrency: 1 })).status,
    "completed",
  );
  const candidate = {
    taskId: semanticTaskId,
    kind: "procedure" as const,
    title: "Fault recovery semantic procedure",
    content:
      "A durable semantic promotion retry must return the same memory record and repair provenance instead of creating a duplicate.",
    tags: ["recovery", "semantic"],
    sensitivity: "internal" as const,
    evidenceStepIds: ["write", "read"],
  };
  setFault("semantic.after_memory_write_before_backlink");
  await assert.rejects(
    () => promoteSemanticMemory({ ...candidate, confirm: true }),
    /AGENTOS_FAULT_INJECTED/,
  );
  setFault();
  const semanticRecovered = await promoteSemanticMemory({
    ...candidate,
    confirm: true,
  });
  semanticMemoryId = semanticRecovered.id;
  assert.equal((await semanticMemoryStatus()).recordCount, 1);
  const semanticTaskStatus = await getPersistentTaskStatus(
    semanticTaskId,
    true,
  );
  assert.equal(
    semanticTaskStatus.events.filter(
      (event) => event.type === "semantic_promoted",
    ).length,
    1,
  );

  // Workspace handoff: persisted releasing receipt survives both release and
  // takeover crash windows without silent lease stealing.
  const ownerA = { ...sessionA, taskId: "fault-handoff-owner" };
  await withExecutionContext(ownerA, async () =>
    await ensureWorkspaceWriteLease(handoffRepo, {
      purpose: "fault handoff source",
    }),
  );
  const requested = await withExecutionContext(sessionB, async () =>
    await requestWorkspaceTakeover(handoffRepo, "fault takeover"),
  );
  assert.equal((requested as any).requested, true);
  const requestId = (requested as any).request.id as string;

  setFault("handoff.after_releasing_receipt_before_release");
  await assert.rejects(
    () =>
      withExecutionContext(ownerA, async () =>
        await approveWorkspaceHandoff(requestId, true),
      ),
    /AGENTOS_FAULT_INJECTED/,
  );
  assert.equal((await readWorkspaceHandoff(requestId)).status, "releasing");
  assert.equal((await workspaceLeaseStatus(handoffRepo)).busy, true);

  setFault();
  await withExecutionContext(ownerA, async () =>
    await approveWorkspaceHandoff(requestId, true),
  );
  assert.equal((await readWorkspaceHandoff(requestId)).status, "released");
  assert.equal((await workspaceLeaseStatus(handoffRepo)).busy, false);

  setFault("handoff.after_takeover_lease_before_completed_receipt");
  await assert.rejects(
    () =>
      withExecutionContext(sessionB, async () =>
        await completeWorkspaceTakeover(requestId, true),
      ),
    /AGENTOS_FAULT_INJECTED/,
  );
  const leaseAfterTakeoverFault = (await workspaceLeaseStatus(handoffRepo)).lease;
  assert.ok(leaseAfterTakeoverFault);
  setFault();
  const takeoverRecovered = await withExecutionContext(sessionB, async () =>
    await completeWorkspaceTakeover(requestId, true),
  );
  assert.equal(takeoverRecovered.lease?.id, leaseAfterTakeoverFault?.id);
  assert.equal((await readWorkspaceHandoff(requestId)).status, "completed");
  await withExecutionContext(sessionB, async () =>
    await releaseWorkspaceLease(handoffRepo),
  );

  // Git completion receipt commits before checkpoint cleanup; retry finishes
  // cleanup and lease release without replaying the transaction.
  execFileSync("git", ["init", "-q", txRepo]);
  execFileSync("git", ["-C", txRepo, "config", "user.email", "fault@example.test"]);
  execFileSync("git", ["-C", txRepo, "config", "user.name", "Fault Verifier"]);
  await fs.writeFile(path.join(txRepo, "tracked.txt"), "baseline\n");
  execFileSync("git", ["-C", txRepo, "add", "tracked.txt"]);
  execFileSync("git", ["-C", txRepo, "commit", "-qm", "baseline"]);

  const tx = await withExecutionContext(sessionA, async () =>
    await beginTransaction(txRepo, "fault complete"),
  );
  setFault("git.transaction.after_complete_receipt_before_ref_cleanup");
  await assert.rejects(
    () =>
      withExecutionContext(sessionB, async () =>
        await completeTransaction(tx.id, false),
      ),
    /AGENTOS_FAULT_INJECTED/,
  );
  assert.equal((await getTransactionStatus(tx.id)).state, "completed");
  setFault();
  const completeRecovered = await withExecutionContext(sessionB, async () =>
    await completeTransaction(tx.id, false),
  );
  assert.equal(completeRecovered.recovered, true);
  assert.equal((await workspaceLeaseStatus(txRepo)).busy, false);

  const txRollback = await withExecutionContext(sessionA, async () =>
    await beginTransaction(txRepo, "fault rollback"),
  );
  await fs.writeFile(path.join(txRepo, "tracked.txt"), "changed\n");
  setFault("git.transaction.after_rollback_receipt_before_lease_release");
  await assert.rejects(
    () =>
      withExecutionContext(sessionB, async () =>
        await rollbackTransaction(txRollback.id),
      ),
    /AGENTOS_FAULT_INJECTED/,
  );
  assert.equal((await getTransactionStatus(txRollback.id)).state, "rolled_back");
  setFault();
  const rollbackRecovered = await withExecutionContext(sessionB, async () =>
    await rollbackTransaction(txRollback.id),
  );
  assert.equal(rollbackRecovered.recovered, true);
  assert.equal((await workspaceLeaseStatus(txRepo)).busy, false);

  console.log(
    JSON.stringify(
      {
        ok: true,
        atomicFilesystemMutation: true,
        schedulerOccurrenceReplay: true,
        loopPhaseReplay: true,
        semanticPromotionReplay: true,
        workspaceHandoffReplay: true,
        gitCompletionReplay: true,
        gitRollbackReplay: true,
        deterministicTaskIds: true,
        noDuplicateSemanticMemory: true,
      },
      null,
      2,
    ),
  );
} finally {
  setFault();
  if (semanticMemoryId) {
    await removeSemanticMemory(semanticMemoryId).catch(() => undefined);
  }
  if (semanticTaskId) {
    await deletePersistentTask(semanticTaskId).catch(() => undefined);
  }
  if (scheduleId) {
    await deletePersistentSchedule(scheduleId).catch(() => undefined);
  }
  if (loopId) {
    await deletePersistentLoop(loopId).catch(() => undefined);
  }
  await releaseWorkspaceLease(handoffRepo, { force: true }).catch(
    () => undefined,
  );
  await releaseWorkspaceLease(txRepo, { force: true }).catch(() => undefined);
  await fs.rm(scratch, { recursive: true, force: true }).catch(
    () => undefined,
  );
}
