import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratch = path.join(root, ".tmp-verify-scheduler");
const outputPath = path.join(root, "tmp-verify-scheduler-output.txt");

process.env.ALLOWED_DIRECTORIES = root;
process.env.SCHEDULER_DIR = path.join(scratch, "schedules");
process.env.SCHEDULER_KEY_PATH = path.join(scratch, "schedule.key");
process.env.TASK_DIR = path.join(scratch, "tasks");
process.env.TASK_KEY_PATH = path.join(scratch, "task.key");
process.env.TASK_STAGING_DIR = path.join(scratch, "staging");
process.env.TASK_STAGING_EXPOSE_TO_FS = "true";
process.env.EPISODIC_INDEX_DIR = path.join(scratch, "episodes");
process.env.EPISODIC_INDEX_KEY_PATH = path.join(scratch, "episode.key");

const {
  createPrimitiveSchedule,
  deletePersistentSchedule,
  getPersistentSchedule,
  runSchedulerTick,
} = await import("../src/runtime/scheduler.js");
const {
  deletePersistentTask,
  getPersistentTaskStatus,
} = await import("../src/tasks/taskRuntime.js");

let scheduleId = "";
let taskId = "";
let stagingRoot = "";

try {
  const content = "AgentOS persistent wake scheduler verified\n";
  const created = await createPrimitiveSchedule({
    label: "verify persistent scheduler",
    trigger: {
      kind: "interval",
      everyMs: 1_000,
      startAt: new Date(Date.now() - 1_000).toISOString(),
    },
    steps: [
      {
        id: "write",
        primitive: "fs.write",
        op: "write",
        args: {
          path: outputPath,
          content,
          overwrite: true,
          create_parents: true,
        },
      },
      {
        id: "read",
        primitive: "fs.read",
        op: "one",
        dependsOn: ["write"],
        args: { path: outputPath },
      },
    ],
    stopWhen: { ref: "read", equals: content },
    maxRuns: 5,
    timeBudgetMs: 30_000,
  });

  scheduleId = created.id;
  assert.equal(created.enabled, true);
  assert.equal(created.runCount, 0);

  const tick = await runSchedulerTick(Date.now());
  assert.equal(tick.skipped, false);
  assert.equal(tick.due, 1);

  const schedule = await getPersistentSchedule(scheduleId);
  assert.equal(schedule.enabled, false);
  assert.equal(schedule.runCount, 1);
  assert.equal(schedule.lastTaskStatus, "completed");
  assert.match(String(schedule.stoppedReason), /stopWhen matched/);
  assert.equal(typeof schedule.lastTaskId, "string");
  taskId = String(schedule.lastTaskId);

  assert.equal(await fs.readFile(outputPath, "utf8"), content);

  const task = await getPersistentTaskStatus(taskId, true);
  assert.equal(task.status, "completed");
  assert.equal(task.steps.find((step) => step.id === "read")?.result, content);
  stagingRoot = String(task.staging.root ?? "");

  console.log(
    JSON.stringify(
      {
        ok: true,
        scheduleId,
        scheduleRunCount: schedule.runCount,
        stoppedReason: schedule.stoppedReason,
        taskId,
        taskStatus: task.status,
        persistentWake: true,
        stopCondition: true,
        encryptedScheduleStore: schedule.storage.encryptedAtRest,
      },
      null,
      2,
    ),
  );
} finally {
  if (scheduleId) {
    await deletePersistentSchedule(scheduleId).catch(() => undefined);
  }
  if (taskId) {
    await deletePersistentTask(taskId).catch(() => undefined);
  }
  if (stagingRoot) {
    await fs.rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
  }
  await fs.rm(outputPath, { force: true }).catch(() => undefined);
  await fs.rm(scratch, { recursive: true, force: true }).catch(() => undefined);
}
