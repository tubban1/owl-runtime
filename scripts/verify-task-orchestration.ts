import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratch = path.join(root, ".tmp-verify-task-orchestration");
const stateRoot = path.join(scratch, "state");
const sourcePath = path.join(scratch, "source.txt");

process.env.OWL_RUNTIME_MODE = "test";
process.env.OWL_STATE_ROOT = stateRoot;
process.env.ALLOWED_DIRECTORIES = root;
process.env.ALLOW_WRITE = "true";
process.env.ALLOW_DELETE = "true";
process.env.OWL_APPROVAL_MODE = "compat";
process.env.TASK_DIR = path.join(stateRoot, "tasks");
process.env.TASK_KEY_PATH = path.join(stateRoot, "task.key");
process.env.TASK_STAGING_DIR = path.join(stateRoot, "staging");
process.env.TASK_STAGING_EXPOSE_TO_FS = "true";
process.env.EPISODIC_INDEX_DIR = path.join(stateRoot, "episodes");
process.env.EPISODIC_INDEX_KEY_PATH = path.join(stateRoot, "episode.key");
process.env.SCHEDULER_DIR = path.join(stateRoot, "schedules");
process.env.SCHEDULER_KEY_PATH = path.join(stateRoot, "schedule.key");
process.env.LOOP_DIR = path.join(stateRoot, "loops");
process.env.LOOP_KEY_PATH = path.join(stateRoot, "loop.key");

await fs.rm(scratch, { recursive: true, force: true });
await fs.mkdir(scratch, { recursive: true });
await fs.writeFile(sourcePath, "orchestration-source\n", "utf8");

const {
  InProcessRuntimeClient,
} = await import("../src/public/index.js");
const { executeSkill } = await import("../src/skills/skillRuntime.js");
const {
  deletePersistentTask,
  getPersistentTaskStatus,
  listPersistentTasks,
} = await import("../src/tasks/taskRuntime.js");
const {
  deletePersistentSchedule,
  getPersistentSchedule,
  runSchedulerTick,
} = await import("../src/runtime/scheduler.js");
const {
  cancelPersistentLoop,
  deletePersistentLoop,
  getPersistentLoop,
  runLoopControllerTick,
} = await import("../src/runtime/loopController.js");

const client = new InProcessRuntimeClient();
const orchestrationId = "orch_verify_release_20261001";
const orchestrationLabel = "Verify OWL LAB release orchestration";
const taskIds = new Set<string>();
let scheduleId = "";
let loopId = "";

function readStep(id: string) {
  return {
    id,
    action: "fs.read",
    args: { path: sourcePath },
  };
}

function primitiveReadStep(id: string) {
  return {
    id,
    primitive: "fs.read",
    op: "one",
    args: { path: sourcePath },
  };
}

try {
  // Public RuntimeClient camelCase contract.
  const direct = await client.createTask({
    label: "orchestration direct public task",
    steps: [readStep("read")],
    orchestration: {
      orchestrationId,
      label: orchestrationLabel,
    },
  });
  taskIds.add(direct.id);
  assert.deepEqual(direct.orchestration, {
    schemaVersion: 1,
    orchestrationId,
    label: orchestrationLabel,
    parentTaskId: null,
  });

  // Old callers remain valid and explicitly project null rather than a guessed
  // owner/session grouping.
  const legacy = await client.createTask({
    label: "legacy task without orchestration",
    steps: [readStep("read")],
  });
  taskIds.add(legacy.id);
  assert.equal(legacy.orchestration, null);

  // Parent metadata is safe projection metadata only; it does not change Task
  // execution semantics.
  const child = await client.createTask({
    label: "orchestration child public task",
    steps: [readStep("read")],
    orchestration: {
      orchestrationId,
      label: orchestrationLabel,
      parentTaskId: direct.id,
    },
  });
  taskIds.add(child.id);
  assert.equal(child.orchestration?.parentTaskId, direct.id);

  const listed = await client.listTasks();
  const grouped = listed.filter(
    (task) => task.orchestration?.orchestrationId === orchestrationId,
  );
  assert.equal(grouped.length, 2);
  assert.equal(
    listed.find((task) => task.id === legacy.id)?.orchestration,
    null,
  );

  // Skill API accepts the user-facing snake_case contract used by MCP callers.
  const compiled = (await executeSkill(
    "runtime.compile_task",
    {
      label: "orchestration skill task",
      steps: [primitiveReadStep("read")],
      orchestration: {
        orchestration_id: orchestrationId,
        label: orchestrationLabel,
        parent_task_id: direct.id,
      },
    },
    false,
  )) as any;
  const compiledTask = compiled.result;
  assert.ok(compiledTask?.id);
  taskIds.add(compiledTask.id);
  assert.deepEqual(compiledTask.orchestration, {
    schemaVersion: 1,
    orchestrationId,
    label: orchestrationLabel,
    parentTaskId: direct.id,
  });

  // Scheduled future occurrences inherit the orchestration context.
  const scheduleResult = (await executeSkill(
    "runtime.schedule",
    {
      op: "create",
      label: "orchestration scheduled work",
      trigger: {
        kind: "interval",
        every_ms: 1_000,
        start_at: new Date(Date.now() - 2_000).toISOString(),
      },
      steps: [primitiveReadStep("read")],
      max_runs: 1,
      orchestration: {
        orchestration_id: orchestrationId,
        label: orchestrationLabel,
        parent_task_id: direct.id,
      },
    },
    false,
  )) as any;
  scheduleId = String(scheduleResult.result.id);
  assert.equal(
    scheduleResult.result.taskTemplate.orchestration.orchestrationId,
    orchestrationId,
  );
  await runSchedulerTick(Date.now());
  const schedule = await getPersistentSchedule(scheduleId);
  assert.equal(typeof schedule.lastTaskId, "string");
  const scheduledTaskId = String(schedule.lastTaskId);
  taskIds.add(scheduledTaskId);
  const scheduledTask = await getPersistentTaskStatus(scheduledTaskId, false);
  assert.deepEqual(scheduledTask.orchestration, {
    schemaVersion: 1,
    orchestrationId,
    label: orchestrationLabel,
    parentTaskId: direct.id,
  });

  // Primitive-backed loop phases also inherit the same goal/workset.
  const loopResult = (await executeSkill(
    "runtime.loop",
    {
      op: "create",
      label: "orchestration loop work",
      poll_interval_ms: 1_000,
      max_cycles: 1,
      phases: [
        {
          id: "observe",
          steps: [primitiveReadStep("read")],
          output_ref: "read",
        },
        {
          id: "confirm",
          steps: [primitiveReadStep("read")],
          output_ref: "read",
        },
      ],
      orchestration: {
        orchestration_id: orchestrationId,
        label: orchestrationLabel,
        parent_task_id: direct.id,
      },
    },
    false,
  )) as any;
  loopId = String(loopResult.result.id);
  assert.equal(loopResult.result.orchestration.orchestrationId, orchestrationId);
  await runLoopControllerTick(Date.now() + 100);
  const loop = await getPersistentLoop(loopId);
  assert.equal(typeof loop.lastTaskId, "string");
  const loopTaskId = String(loop.lastTaskId);
  taskIds.add(loopTaskId);
  const loopTask = await getPersistentTaskStatus(loopTaskId, false);
  assert.deepEqual(loopTask.orchestration, {
    schemaVersion: 1,
    orchestrationId,
    label: orchestrationLabel,
    parentTaskId: direct.id,
  });

  // Validation is fail-closed before durable Task/staging side effects.
  const beforeInvalid = await listPersistentTasks();
  const beforeTaskIds = new Set(beforeInvalid.map((task) => task.id));
  await assert.rejects(
    () =>
      client.createTask({
        label: "invalid empty orchestration",
        steps: [readStep("read")],
        orchestration: { orchestrationId: "   " },
      }),
    /TASK_ORCHESTRATION_INVALID/,
  );
  await assert.rejects(
    () =>
      client.createTask({
        label: "invalid control orchestration",
        steps: [readStep("read")],
        orchestration: { orchestrationId: "orch_bad\nvalue" },
      }),
    /TASK_ORCHESTRATION_INVALID/,
  );
  await assert.rejects(
    () =>
      client.createTask({
        label: "invalid long orchestration",
        steps: [readStep("read")],
        orchestration: { orchestrationId: "x".repeat(161) },
      }),
    /TASK_ORCHESTRATION_INVALID/,
  );
  const afterInvalid = await listPersistentTasks();
  assert.deepEqual(
    new Set(afterInvalid.map((task) => task.id)),
    beforeTaskIds,
  );

  const finalGrouped = (await client.listTasks()).filter(
    (task) => task.orchestration?.orchestrationId === orchestrationId,
  );
  assert.equal(finalGrouped.length, 5);

  console.log(
    JSON.stringify(
      {
        ok: true,
        orchestrationId,
        publicClientRoundTrip: true,
        legacyNullProjection: true,
        parentTaskMetadata: true,
        skillSnakeCase: true,
        schedulerInheritance: true,
        loopInheritance: true,
        invalidMetadataFailClosed: true,
        groupedTaskCount: finalGrouped.length,
      },
      null,
      2,
    ),
  );
} finally {
  if (scheduleId) {
    await deletePersistentSchedule(scheduleId).catch(() => undefined);
  }
  if (loopId) {
    await cancelPersistentLoop(loopId).catch(() => undefined);
    await deletePersistentLoop(loopId).catch(() => undefined);
  }
  for (const taskId of taskIds) {
    await deletePersistentTask(taskId).catch(() => undefined);
  }
  await fs.rm(scratch, { recursive: true, force: true }).catch(() => undefined);
}
