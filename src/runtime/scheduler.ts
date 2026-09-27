import { createHash } from "node:crypto";
import {
  createPersistentPrimitiveTask,
  getPersistentTaskStatus,
  runPersistentTask,
  validatePrimitiveTaskSteps,
  type PrimitiveTaskStep,
} from "../tasks/taskRuntime.js";
import {
  deleteScheduleRecord,
  getScheduleStorageInfo,
  listSchedules as listScheduleRecords,
  newScheduleId,
  readSchedule,
  writeSchedule,
  type PersistentSchedule,
  type ScheduleStopWhen,
  type ScheduleTrigger,
} from "./schedulerStore.js";
import { runtimeLifecycle } from "./runtimeLifecycle.js";
import { injectTestFault } from "./faultInjection.js";

type CreateScheduleInput = {
  label: string;
  trigger: ScheduleTrigger;
  steps: PrimitiveTaskStep[];
  taskLabel?: string;
  maxConcurrency?: number;
  failFast?: boolean;
  maxWaves?: number;
  timeBudgetMs?: number;
  stopWhen?: ScheduleStopWhen;
  maxRuns?: number;
  endAt?: string;
};

const activeSchedules = new Set<string>();
let schedulerTimer: NodeJS.Timeout | undefined;
let tickRunning = false;

function parseIso(value: string, field: string): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new Error(`Invalid ISO date/time for ${field}: "${value}".`);
  }
  return timestamp;
}

function parseDailyTime(value: string): { hour: number; minute: number } {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new Error('Daily schedule time must use local "HH:MM".');
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) {
    throw new Error('Daily schedule time must use local "HH:MM".');
  }
  return { hour, minute };
}

function normalizeTrigger(trigger: ScheduleTrigger): ScheduleTrigger {
  if (trigger.kind === "once") {
    parseIso(trigger.at, "trigger.at");
    return { kind: "once", at: new Date(trigger.at).toISOString() };
  }

  if (trigger.kind === "interval") {
    const everyMs = Math.trunc(trigger.everyMs);
    if (!Number.isFinite(everyMs) || everyMs < 1_000) {
      throw new Error("Interval schedules require everyMs >= 1000.");
    }
    if (trigger.startAt) parseIso(trigger.startAt, "trigger.startAt");
    return {
      kind: "interval",
      everyMs,
      ...(trigger.startAt
        ? { startAt: new Date(trigger.startAt).toISOString() }
        : {}),
    };
  }

  parseDailyTime(trigger.time);
  return { kind: "daily", time: trigger.time };
}

function nextDailyAt(time: string, fromMs: number): string {
  const { hour, minute } = parseDailyTime(time);
  const next = new Date(fromMs);
  next.setHours(hour, minute, 0, 0);
  if (next.getTime() <= fromMs) next.setDate(next.getDate() + 1);
  return next.toISOString();
}

function initialNextRunAt(trigger: ScheduleTrigger, nowMs: number): string {
  if (trigger.kind === "once") return new Date(trigger.at).toISOString();
  if (trigger.kind === "interval") {
    return trigger.startAt
      ? new Date(trigger.startAt).toISOString()
      : new Date(nowMs + trigger.everyMs).toISOString();
  }
  return nextDailyAt(trigger.time, nowMs);
}

function nextRunAfter(
  trigger: ScheduleTrigger,
  completedAtMs: number,
): string | null {
  if (trigger.kind === "once") return null;
  if (trigger.kind === "interval") {
    return new Date(completedAtMs + trigger.everyMs).toISOString();
  }
  return nextDailyAt(trigger.time, completedAtMs);
}

function terminalTaskStatus(status: string): boolean {
  return ["completed", "failed", "blocked", "cancelled"].includes(status);
}

function resolveResultReference(
  status: Awaited<ReturnType<typeof getPersistentTaskStatus>>,
  ref: string,
): unknown {
  const [stepId, ...segments] = ref.split(".").filter(Boolean);
  if (!stepId) throw new Error("stopWhen.ref must start with a task step id.");
  const step = status.steps.find((item) => item.id === stepId);
  if (!step) throw new Error(`stopWhen.ref references unknown step "${stepId}".`);

  let current: unknown = step.result;
  for (const segment of segments) {
    if (current == null || typeof current !== "object") return undefined;
    if (Array.isArray(current) && /^\d+$/.test(segment)) {
      current = current[Number(segment)];
    } else {
      current = (current as Record<string, unknown>)[segment];
    }
  }
  return current;
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function stopConditionMatched(
  status: Awaited<ReturnType<typeof getPersistentTaskStatus>>,
  stopWhen?: ScheduleStopWhen,
): boolean {
  if (!stopWhen) return false;
  const value = resolveResultReference(status, stopWhen.ref);
  if (Object.prototype.hasOwnProperty.call(stopWhen, "equals")) {
    return deepEqual(value, stopWhen.equals);
  }
  if (typeof stopWhen.truthy === "boolean") {
    return Boolean(value) === stopWhen.truthy;
  }
  return false;
}

function summarize(schedule: PersistentSchedule) {
  return {
    id: schedule.id,
    label: schedule.label,
    enabled: schedule.enabled,
    trigger: schedule.trigger,
    runCount: schedule.runCount,
    maxRuns: schedule.maxRuns ?? null,
    endAt: schedule.endAt ?? null,
    nextRunAt: schedule.nextRunAt,
    lastRunAt: schedule.lastRunAt ?? null,
    lastCompletedAt: schedule.lastCompletedAt ?? null,
    lastTaskId: schedule.lastTaskId ?? null,
    activeTaskId: schedule.activeTaskId ?? null,
    lastTaskStatus: schedule.lastTaskStatus ?? null,
    lastError: schedule.lastError ?? null,
    stoppedReason: schedule.stoppedReason ?? null,
    stopWhen: schedule.stopWhen ?? null,
    taskTemplate: {
      label: schedule.taskTemplate.label,
      stepCount: schedule.taskTemplate.steps.length,
      maxConcurrency: schedule.taskTemplate.maxConcurrency,
      failFast: schedule.taskTemplate.failFast,
      maxWaves: schedule.taskTemplate.maxWaves,
      timeBudgetMs: schedule.taskTemplate.timeBudgetMs,
    },
    storage: getScheduleStorageInfo(),
  };
}

export async function createPrimitiveSchedule(
  input: CreateScheduleInput,
) {
  const label = input.label.trim();
  if (!label) throw new Error("Schedule label is required.");
  validatePrimitiveTaskSteps(input.steps);

  const trigger = normalizeTrigger(input.trigger);
  const now = Date.now();
  const maxConcurrency = Math.min(
    Math.max(Math.trunc(input.maxConcurrency ?? 4), 1),
    8,
  );
  const maxWaves = Math.min(
    Math.max(Math.trunc(input.maxWaves ?? 100), 1),
    1000,
  );
  const timeBudgetMs = Math.min(
    Math.max(Math.trunc(input.timeBudgetMs ?? 60_000), 1_000),
    10 * 60_000,
  );

  let endAt: string | undefined;
  if (input.endAt) {
    const endMs = parseIso(input.endAt, "endAt");
    if (endMs <= now) throw new Error("endAt must be in the future.");
    endAt = new Date(endMs).toISOString();
  }

  let maxRuns: number | undefined;
  if (input.maxRuns !== undefined) {
    maxRuns = Math.trunc(input.maxRuns);
    if (!Number.isFinite(maxRuns) || maxRuns < 1) {
      throw new Error("maxRuns must be >= 1.");
    }
  }

  if (input.stopWhen) {
    if (!input.stopWhen.ref?.trim()) {
      throw new Error("stopWhen.ref is required.");
    }
    const hasEquals = Object.prototype.hasOwnProperty.call(
      input.stopWhen,
      "equals",
    );
    if (!hasEquals && typeof input.stopWhen.truthy !== "boolean") {
      throw new Error("stopWhen requires equals or truthy.");
    }
  }

  const nextRunAt = initialNextRunAt(trigger, now);
  if (endAt && Date.parse(nextRunAt) > Date.parse(endAt)) {
    throw new Error("The first scheduled run occurs after endAt.");
  }

  const createdAt = new Date(now).toISOString();
  const schedule: PersistentSchedule = {
    version: 1,
    id: newScheduleId(),
    label,
    createdAt,
    updatedAt: createdAt,
    enabled: true,
    trigger,
    taskTemplate: {
      label: input.taskLabel?.trim() || label,
      steps: input.steps,
      maxConcurrency,
      failFast: input.failFast ?? true,
      maxWaves,
      timeBudgetMs,
    },
    ...(input.stopWhen ? { stopWhen: input.stopWhen } : {}),
    ...(maxRuns ? { maxRuns } : {}),
    ...(endAt ? { endAt } : {}),
    runCount: 0,
    nextRunAt,
  };

  await writeSchedule(schedule);
  return summarize(schedule);
}

async function completeOccurrence(
  schedule: PersistentSchedule,
  taskId: string,
  taskStatus: Awaited<ReturnType<typeof getPersistentTaskStatus>>,
) {
  const now = Date.now();
  schedule.runCount += 1;
  schedule.lastCompletedAt = new Date(now).toISOString();
  schedule.lastTaskId = taskId;
  schedule.activeTaskId = undefined;
  schedule.lastTaskStatus = taskStatus.status;
  schedule.lastError =
    taskStatus.status === "completed"
      ? undefined
      : `Scheduled task ended with status ${taskStatus.status}.`;

  if (taskStatus.status === "blocked") {
    schedule.enabled = false;
    schedule.nextRunAt = null;
    schedule.stoppedReason =
      `Scheduled task ${taskId} is blocked and requires manual review before recurrence can continue.`;
    return;
  }

  if (taskStatus.status === "cancelled") {
    schedule.enabled = false;
    schedule.nextRunAt = null;
    schedule.stoppedReason =
      `Scheduled task ${taskId} was cancelled; recurrence stopped.`;
    return;
  }

  if (
    taskStatus.status === "completed" &&
    stopConditionMatched(taskStatus, schedule.stopWhen)
  ) {
    schedule.enabled = false;
    schedule.nextRunAt = null;
    schedule.stoppedReason = `stopWhen matched: ${schedule.stopWhen?.ref}`;
    return;
  }

  if (schedule.maxRuns && schedule.runCount >= schedule.maxRuns) {
    schedule.enabled = false;
    schedule.nextRunAt = null;
    schedule.stoppedReason = `Reached maxRuns=${schedule.maxRuns}.`;
    return;
  }

  const next = nextRunAfter(schedule.trigger, now);
  if (!next) {
    schedule.enabled = false;
    schedule.nextRunAt = null;
    schedule.stoppedReason = "One-time schedule completed.";
    return;
  }

  if (schedule.endAt && Date.parse(next) > Date.parse(schedule.endAt)) {
    schedule.enabled = false;
    schedule.nextRunAt = null;
    schedule.stoppedReason = "Reached schedule endAt.";
    return;
  }

  schedule.nextRunAt = next;
}

function scheduledTaskId(schedule: PersistentSchedule): string {
  const occurrence = [
    schedule.id,
    schedule.nextRunAt ?? "no-next-run",
    String(schedule.runCount),
  ].join("\n");
  const digest = createHash("sha256").update(occurrence).digest("hex").slice(0, 32);
  return `task_schedule_${digest}`;
}

async function ensureScheduledTask(
  schedule: PersistentSchedule,
  taskId: string,
): Promise<void> {
  try {
    await getPersistentTaskStatus(taskId, false);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  await createPersistentPrimitiveTask(
    schedule.taskTemplate.label,
    schedule.taskTemplate.steps,
    {
      maxConcurrency: schedule.taskTemplate.maxConcurrency,
      failFast: schedule.taskTemplate.failFast,
      taskId,
    },
  );
}

async function executeSchedule(scheduleId: string): Promise<void> {
  if (activeSchedules.has(scheduleId)) return;
  activeSchedules.add(scheduleId);

  try {
    const schedule = await readSchedule(scheduleId);
    if (!schedule.enabled) return;

    const now = Date.now();
    if (
      !schedule.activeTaskId &&
      schedule.endAt &&
      now > Date.parse(schedule.endAt)
    ) {
      schedule.enabled = false;
      schedule.nextRunAt = null;
      schedule.stoppedReason = "Reached schedule endAt.";
      await writeSchedule(schedule);
      return;
    }

    let taskId = schedule.activeTaskId;
    if (!taskId) {
      taskId = scheduledTaskId(schedule);
      schedule.activeTaskId = taskId;
      schedule.lastTaskId = taskId;
      schedule.lastRunAt = new Date().toISOString();
      schedule.lastTaskStatus = "pending";
      schedule.lastError = undefined;

      // Persist the occurrence identity before creating/executing its Task.
      // After a crash, the same wake always converges on the same Task id.
      await writeSchedule(schedule);
      injectTestFault("scheduler.after_occurrence_receipt_before_task");
    }

    await ensureScheduledTask(schedule, taskId);

    try {
      const run = await runPersistentTask(taskId, {
        maxConcurrency: schedule.taskTemplate.maxConcurrency,
        failFast: schedule.taskTemplate.failFast,
        maxWaves: schedule.taskTemplate.maxWaves,
        timeBudgetMs: schedule.taskTemplate.timeBudgetMs,
      });
      schedule.lastTaskStatus = run.status;
    } catch (error) {
      schedule.lastError = error instanceof Error ? error.message : String(error);
    }

    const status = await getPersistentTaskStatus(taskId, true);
    schedule.lastTaskStatus = status.status;

    if (terminalTaskStatus(status.status)) {
      await completeOccurrence(schedule, taskId, status);
    } else {
      // The task yielded because of its time/wave budget. Wake it again without
      // waiting for the normal recurrence interval.
      schedule.nextRunAt = new Date(
        Date.now() + Math.max(schedulerPollMs(), 1_000),
      ).toISOString();
    }

    await writeSchedule(schedule);
  } finally {
    activeSchedules.delete(scheduleId);
  }
}

function schedulerPollMs(): number {
  const raw = Number(process.env.SCHEDULER_POLL_MS);
  if (Number.isFinite(raw)) {
    return Math.min(Math.max(Math.trunc(raw), 1_000), 60_000);
  }
  return 5_000;
}

export async function runSchedulerTick(nowMs = Date.now()) {
  if (runtimeLifecycle.isDraining()) {
    return { skipped: true, reason: "runtime_draining" };
  }
  if (tickRunning) return { skipped: true, reason: "tick_already_running" };
  tickRunning = true;
  try {
    const schedules = await listScheduleRecords();
    const due = schedules.filter(
      (schedule) =>
        schedule.enabled &&
        schedule.nextRunAt !== null &&
        Date.parse(schedule.nextRunAt) <= nowMs,
    );

    // Run sequentially by default so two scheduled desktop/browser workflows do
    // not unexpectedly fight over global UI state. Primitive resource leases
    // still protect individual execution inside each task.
    for (const schedule of due) {
      await executeSchedule(schedule.id);
    }

    return {
      skipped: false,
      checked: schedules.length,
      due: due.length,
      ran: due.map((item) => item.id),
    };
  } finally {
    tickRunning = false;
  }
}

export function startPersistentScheduler() {
  if (schedulerTimer) {
    return { started: false, pollMs: schedulerPollMs() };
  }

  const pollMs = schedulerPollMs();
  void runSchedulerTick().catch((error) => {
    console.error(
      "AgentOS scheduler initial tick failed:",
      error instanceof Error ? error.message : String(error),
    );
  });

  schedulerTimer = setInterval(() => {
    void runSchedulerTick().catch((error) => {
      console.error(
        "AgentOS scheduler tick failed:",
        error instanceof Error ? error.message : String(error),
      );
    });
  }, pollMs);
  schedulerTimer.unref();

  return { started: true, pollMs };
}

export function stopPersistentScheduler() {
  if (!schedulerTimer) return { stopped: false };
  clearInterval(schedulerTimer);
  schedulerTimer = undefined;
  return { stopped: true };
}

export async function listPersistentSchedules() {
  return (await listScheduleRecords()).map(summarize);
}

export async function getPersistentSchedule(id: string) {
  return summarize(await readSchedule(id));
}

export async function cancelPersistentSchedule(id: string) {
  const schedule = await readSchedule(id);
  schedule.enabled = false;
  schedule.nextRunAt = null;
  schedule.stoppedReason = "Cancelled.";
  await writeSchedule(schedule);
  return summarize(schedule);
}

export async function deletePersistentSchedule(id: string) {
  if (activeSchedules.has(id)) {
    throw new Error("Cannot delete a schedule while it is executing.");
  }
  const schedule = await readSchedule(id);
  await deleteScheduleRecord(id);
  return {
    id,
    deleted: true,
    lastTaskId: schedule.lastTaskId ?? null,
  };
}
