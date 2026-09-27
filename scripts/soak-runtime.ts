import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

type SoakProfile = "smoke" | "2h" | "6h" | "24h" | "custom";

type ProfileConfig = {
  durationMs: number;
  foregroundStepMs: number;
  backgroundIntervalMs: number;
  contentionEvery: number;
  processEvery: number;
  adapterEveryMs: number;
  heartbeatMs: number;
};

const profiles: Record<Exclude<SoakProfile, "custom">, ProfileConfig> = {
  smoke: {
    durationMs: 30_000,
    foregroundStepMs: 500,
    backgroundIntervalMs: 1_000,
    contentionEvery: 5,
    processEvery: 10,
    adapterEveryMs: 0,
    heartbeatMs: 5_000,
  },
  "2h": {
    durationMs: 2 * 60 * 60_000,
    foregroundStepMs: 2_000,
    backgroundIntervalMs: 5_000,
    contentionEvery: 10,
    processEvery: 30,
    adapterEveryMs: 15 * 60_000,
    heartbeatMs: 30_000,
  },
  "6h": {
    durationMs: 6 * 60 * 60_000,
    foregroundStepMs: 3_000,
    backgroundIntervalMs: 10_000,
    contentionEvery: 10,
    processEvery: 40,
    adapterEveryMs: 30 * 60_000,
    heartbeatMs: 60_000,
  },
  "24h": {
    durationMs: 24 * 60 * 60_000,
    foregroundStepMs: 5_000,
    backgroundIntervalMs: 30_000,
    contentionEvery: 12,
    processEvery: 60,
    adapterEveryMs: 60 * 60_000,
    heartbeatMs: 60_000,
  },
};

function finiteInt(
  raw: string | undefined,
  fallback: number,
  minimum: number,
): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(Math.trunc(value), minimum);
}

const requestedProfile = (process.env.SOAK_PROFILE?.trim() ||
  "smoke") as SoakProfile;
const base =
  requestedProfile === "custom"
    ? profiles.smoke
    : profiles[requestedProfile] ?? profiles.smoke;

const config: ProfileConfig = {
  durationMs: finiteInt(process.env.SOAK_DURATION_MS, base.durationMs, 5_000),
  foregroundStepMs: finiteInt(
    process.env.SOAK_FOREGROUND_STEP_MS,
    base.foregroundStepMs,
    100,
  ),
  backgroundIntervalMs: finiteInt(
    process.env.SOAK_BACKGROUND_INTERVAL_MS,
    base.backgroundIntervalMs,
    1_000,
  ),
  contentionEvery: finiteInt(
    process.env.SOAK_CONTENTION_EVERY,
    base.contentionEvery,
    1,
  ),
  processEvery: finiteInt(
    process.env.SOAK_PROCESS_EVERY,
    base.processEvery,
    1,
  ),
  adapterEveryMs: Number.isFinite(Number(process.env.SOAK_ADAPTER_EVERY_MS))
    ? Math.max(Math.trunc(Number(process.env.SOAK_ADAPTER_EVERY_MS)), 0)
    : base.adapterEveryMs,
  heartbeatMs: finiteInt(
    process.env.SOAK_HEARTBEAT_MS,
    base.heartbeatMs,
    1_000,
  ),
};

const skipAdapters =
  process.env.SOAK_SKIP_ADAPTERS?.trim().toLowerCase() === "true";
const keepScratch =
  process.env.SOAK_KEEP_SCRATCH?.trim().toLowerCase() === "true";

const runId = `soak_${new Date()
  .toISOString()
  .replaceAll(/[:.]/g, "-")}_${process.pid}`;
const reportDir =
  process.env.SOAK_REPORT_DIR?.trim() || path.join(root, ".soak-results");
const reportPath =
  process.env.SOAK_REPORT_PATH?.trim() ||
  path.join(reportDir, `${runId}.json`);
const latestPath = path.join(reportDir, "latest.json");
const scratch =
  process.env.SOAK_SCRATCH_DIR?.trim() ||
  path.join(os.tmpdir(), "agentos-soak", runId);
const state = path.join(scratch, "state");

const repoA = path.join(scratch, "repos", "a");
const repoB = path.join(scratch, "repos", "b");
const repoC = path.join(scratch, "repos", "c");
const sharedRepo = path.join(scratch, "repos", "shared");
const processRepo = path.join(scratch, "repos", "process");
const schedulerRepo = path.join(scratch, "repos", "scheduler");
const loopRepo = path.join(scratch, "repos", "loop");
const repoDirs = [
  repoA,
  repoB,
  repoC,
  sharedRepo,
  processRepo,
  schedulerRepo,
  loopRepo,
];

const independentLogs = [
  path.join(repoA, "session-a.log"),
  path.join(repoB, "session-b.log"),
  path.join(repoC, "session-c.log"),
];
const schedulerLog = path.join(schedulerRepo, "scheduler.log");
const loopLog = path.join(loopRepo, "loop.log");

await fs.rm(scratch, { recursive: true, force: true });
for (const dir of repoDirs) {
  await fs.mkdir(path.join(dir, ".git"), { recursive: true });
}
await fs.mkdir(reportDir, { recursive: true });

process.env.AGENTOS_RUNTIME_MODE = "test";
process.env.AGENTOS_STATE_ROOT = state;
process.env.ALLOWED_DIRECTORIES = scratch;
process.env.ALLOW_WRITE = "true";
process.env.ALLOW_DELETE = "true";
process.env.ALLOW_SHELL = "true";
process.env.TASK_DIR = path.join(state, "tasks");
process.env.TASK_KEY_PATH = path.join(state, "task.key");
process.env.TASK_STAGING_DIR = path.join(state, "staging");
process.env.EPISODIC_INDEX_DIR = path.join(state, "episodes");
process.env.EPISODIC_INDEX_KEY_PATH = path.join(state, "episode.key");
process.env.SCHEDULER_DIR = path.join(state, "schedules");
process.env.SCHEDULER_KEY_PATH = path.join(state, "schedule.key");
process.env.SCHEDULER_POLL_MS = String(config.backgroundIntervalMs);
process.env.LOOP_DIR = path.join(state, "loops");
process.env.LOOP_KEY_PATH = path.join(state, "loop.key");
process.env.LOOP_CONTROLLER_POLL_MS = String(config.backgroundIntervalMs);
process.env.PROCESS_STATE_DIR = path.join(state, "processes");
process.env.PROCESS_STATE_KEY_PATH = path.join(state, "process.key");
process.env.PROCESS_LOG_DIR = path.join(state, "processes", "logs");
process.env.PROCESS_MONITOR_POLL_MS = String(
  Math.max(config.backgroundIntervalMs, 1_000),
);
process.env.WORKSPACE_LEASE_DIR = path.join(state, "workspace-leases");
process.env.WORKSPACE_HANDOFF_DIR = path.join(state, "workspace-handoffs");
process.env.WORKSPACE_SESSION_RECLAIM_GRACE_MS = "250";
process.env.WORKSPACE_SESSION_IDLE_RECLAIM_MS = "60000";
process.env.SEMANTIC_MEMORY_DIR = path.join(state, "semantic");
process.env.SEMANTIC_MEMORY_KEY_PATH = path.join(state, "semantic.key");
process.env.SESSION_ADAPTER_DIR = path.join(state, "sessions");
process.env.SESSION_ADAPTER_KEY_PATH = path.join(state, "session.key");
process.env.WECHAT_SESSION_DIR = path.join(state, "wechat-sessions");
process.env.WECHAT_SESSION_KEY_PATH = path.join(state, "wechat-session.key");
process.env.AUDIT_LOG_ENABLED = "false";

const { withExecutionContext } = await import(
  "../src/runtime/executionContext.js"
);
const { runtimeSessionManager } = await import(
  "../src/runtime/runtimeSessionManager.js"
);
const { executeRoutedAction } = await import(
  "../src/router/actionRouter.js"
);
const {
  createPrimitiveSchedule,
  getPersistentSchedule,
  cancelPersistentSchedule,
  deletePersistentSchedule,
  startPersistentScheduler,
  stopPersistentScheduler,
} = await import("../src/runtime/scheduler.js");
const {
  createPersistentLoop,
  getPersistentLoop,
  cancelPersistentLoop,
  deletePersistentLoop,
  startPersistentLoopController,
  stopPersistentLoopController,
} = await import("../src/runtime/loopController.js");
const { listPersistentTasks } = await import("../src/tasks/taskRuntime.js");
const {
  ensureWorkspaceWriteLease,
  listWorkspaceLeases,
  releaseWorkspaceLease,
} = await import("../src/runtime/workspaceLeaseManager.js");
const {
  getProcessOutput,
  listProcesses,
  startPersistentProcessMonitor,
} = await import("../src/tools/shellOps.js");

const sessionA = {
  sessionId: "soak-session-A",
  requestId: "soak-request-A",
  origin: "mcp" as const,
};
const sessionB = {
  sessionId: "soak-session-B",
  requestId: "soak-request-B",
  origin: "mcp" as const,
};
const sessionC = {
  sessionId: "soak-session-C",
  requestId: "soak-request-C",
  origin: "mcp" as const,
};
for (const session of [sessionA, sessionB, sessionC]) {
  runtimeSessionManager.register(session.sessionId);
}

type AdapterRun = {
  id: number;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  exitCode?: number | null;
  ok?: boolean;
  tail?: string;
};

const metrics = {
  foregroundIterations: 0,
  independentActions: 0,
  independentErrors: 0,
  resourceWaitMs: [] as number[],
  contentionAttempts: 0,
  contentionBusyRejects: 0,
  processStarts: 0,
  processExitFailures: 0,
  adapterRuns: [] as AdapterRun[],
  eventLoopLagMs: [] as number[],
  rssBaselineBytes: process.memoryUsage().rss,
  rssMaxBytes: process.memoryUsage().rss,
  errors: [] as string[],
};

let scheduleId = "";
let loopId = "";
let stopRequested = false;
let activeAdapter:
  | {
      child: ChildProcess;
      promise: Promise<void>;
    }
  | undefined;

const startedAtMs = Date.now();
const startedAt = new Date(startedAtMs).toISOString();
const deadline = startedAtMs + config.durationMs;

process.on("SIGINT", () => {
  stopRequested = true;
});
process.on("SIGTERM", () => {
  stopRequested = true;
});

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function lineCount(filePath: string): Promise<number> {
  try {
    const text = await fs.readFile(filePath, "utf8");
    if (!text) return 0;
    return text.split("\n").filter(Boolean).length;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.floor((sorted.length - 1) * fraction),
  );
  return sorted[index] ?? 0;
}

async function currentSnapshot() {
  const schedule = scheduleId
    ? await getPersistentSchedule(scheduleId).catch(() => null)
    : null;
  const loop = loopId
    ? await getPersistentLoop(loopId).catch(() => null)
    : null;
  const tasks = await listPersistentTasks();
  const processes = await listProcesses();
  const leases = await listWorkspaceLeases();
  const rss = process.memoryUsage().rss;
  metrics.rssMaxBytes = Math.max(metrics.rssMaxBytes, rss);

  return {
    runId,
    profile: requestedProfile,
    pid: process.pid,
    status: stopRequested ? "stopping" : "running",
    startedAt,
    heartbeatAt: new Date().toISOString(),
    elapsedMs: Date.now() - startedAtMs,
    remainingMs: Math.max(0, deadline - Date.now()),
    config,
    skipAdapters,
    scratch,
    reportPath,
    metrics: {
      foregroundIterations: metrics.foregroundIterations,
      independentActions: metrics.independentActions,
      independentErrors: metrics.independentErrors,
      maxResourceWaitMs: Math.max(0, ...metrics.resourceWaitMs),
      p95ResourceWaitMs: percentile(metrics.resourceWaitMs, 0.95),
      contentionAttempts: metrics.contentionAttempts,
      contentionBusyRejects: metrics.contentionBusyRejects,
      processStarts: metrics.processStarts,
      processExitFailures: metrics.processExitFailures,
      adapterRuns: metrics.adapterRuns,
      eventLoopLagMaxMs: Math.max(0, ...metrics.eventLoopLagMs),
      eventLoopLagP95Ms: percentile(metrics.eventLoopLagMs, 0.95),
      rssBaselineBytes: metrics.rssBaselineBytes,
      rssCurrentBytes: rss,
      rssMaxBytes: metrics.rssMaxBytes,
      errors: metrics.errors,
    },
    runtimeState: {
      schedule,
      loop,
      taskCount: tasks.length,
      nonTerminalTaskCount: tasks.filter(
        (task) =>
          !["completed", "failed", "blocked", "cancelled"].includes(
            task.status,
          ),
      ).length,
      processCount: processes.length,
      runningProcessCount: processes.filter((item) => item.running).length,
      workspaceLeaseCount: leases.length,
    },
  };
}

async function writeReport(value: unknown) {
  const json = JSON.stringify(value, null, 2) + "\n";
  await fs.writeFile(reportPath, json, "utf8");
  await fs.writeFile(latestPath, json, "utf8");
}

function startAdapterSuite(runNumber: number) {
  if (skipAdapters || activeAdapter) return;

  const record: AdapterRun = {
    id: runNumber,
    startedAt: new Date().toISOString(),
  };
  metrics.adapterRuns.push(record);

  const child = spawn(
    "/bin/zsh",
    [
      "-lc",
      "npm run verify:session-adapters && npm run verify:wechat-session",
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        AGENTOS_RUNTIME_MODE: "test",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let tail = "";
  const append = (chunk: Buffer | string) => {
    tail = (tail + String(chunk)).slice(-12_000);
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);

  const adapterStartedAt = Date.now();
  const promise = new Promise<void>((resolve) => {
    child.once("exit", (code) => {
      record.completedAt = new Date().toISOString();
      record.durationMs = Date.now() - adapterStartedAt;
      record.exitCode = code;
      record.ok = code === 0;
      record.tail = tail;
      if (code !== 0) {
        metrics.errors.push(
          `adapter suite ${runNumber} exited with code ${String(code)}`,
        );
      }
      activeAdapter = undefined;
      resolve();
    });
  });

  activeAdapter = { child, promise };
}

const lagIntervalMs = 250;
let lagExpectedAt = Date.now() + lagIntervalMs;
const lagTimer = setInterval(() => {
  const now = Date.now();
  metrics.eventLoopLagMs.push(Math.max(0, now - lagExpectedAt));
  if (metrics.eventLoopLagMs.length > 10_000) {
    metrics.eventLoopLagMs.splice(
      0,
      metrics.eventLoopLagMs.length - 10_000,
    );
  }
  lagExpectedAt = now + lagIntervalMs;
}, lagIntervalMs);

let lastHeartbeatAt = 0;
let lastAdapterAt = Number.NEGATIVE_INFINITY;
let adapterRunNumber = 0;
const processIds: string[] = [];

try {
  const schedule = await createPrimitiveSchedule({
    label: `${runId} scheduler`,
    trigger: {
      kind: "interval",
      everyMs: config.backgroundIntervalMs,
      startAt: new Date(
        Date.now() - config.backgroundIntervalMs,
      ).toISOString(),
    },
    steps: [
      {
        id: "append",
        primitive: "fs.write",
        op: "append",
        args: {
          path: schedulerLog,
          content: "scheduler\n",
        },
      },
    ],
    timeBudgetMs: Math.max(config.backgroundIntervalMs, 5_000),
  });
  scheduleId = schedule.id;

  const loop = await createPersistentLoop({
    label: `${runId} loop`,
    pollIntervalMs: config.backgroundIntervalMs,
    phases: [
      {
        id: "append",
        steps: [
          {
            id: "append",
            primitive: "fs.write",
            op: "append",
            args: {
              path: loopLog,
              content: "loop\n",
            },
          },
        ],
      },
      {
        id: "read",
        steps: [
          {
            id: "read",
            primitive: "fs.read",
            op: "one",
            args: { path: loopLog },
          },
        ],
        outputRef: "read",
      },
    ],
    timeBudgetMs: Math.max(config.backgroundIntervalMs, 5_000),
  });
  loopId = loop.id;

  startPersistentScheduler();
  startPersistentLoopController();
  startPersistentProcessMonitor();

  startAdapterSuite(++adapterRunNumber);
  lastAdapterAt = Date.now();

  while (!stopRequested && Date.now() < deadline) {
    const iteration = ++metrics.foregroundIterations;
    const line = `${iteration}\n`;

    const independent = await Promise.allSettled([
      withExecutionContext(sessionA, async () =>
        await executeRoutedAction("fs.append", {
          path: independentLogs[0],
          content: line,
        }),
      ),
      withExecutionContext(sessionB, async () =>
        await executeRoutedAction("fs.append", {
          path: independentLogs[1],
          content: line,
        }),
      ),
      withExecutionContext(sessionC, async () =>
        await executeRoutedAction("fs.append", {
          path: independentLogs[2],
          content: line,
        }),
      ),
    ]);

    for (const result of independent) {
      if (result.status === "fulfilled") {
        metrics.independentActions += 1;
        metrics.resourceWaitMs.push(result.value.resourceWaitMs);
      } else {
        metrics.independentErrors += 1;
        metrics.errors.push(
          `independent action failed: ${String(result.reason)}`,
        );
      }
    }

    if (iteration % config.contentionEvery === 0) {
      metrics.contentionAttempts += 1;
      await withExecutionContext(sessionA, async () =>
        await ensureWorkspaceWriteLease(sharedRepo, {
          purpose: `${runId} contention ${iteration}`,
          ttlMs: 10_000,
        }),
      );
      try {
        await withExecutionContext(sessionB, async () =>
          await executeRoutedAction("fs.write", {
            path: path.join(sharedRepo, "contended.txt"),
            content: `unexpected ${iteration}\n`,
            overwrite: true,
            create_parents: true,
          }),
        );
        metrics.errors.push(
          `contention iteration ${iteration} unexpectedly acquired a busy workspace`,
        );
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);
        if (/WORKSPACE_BUSY/.test(message)) {
          metrics.contentionBusyRejects += 1;
        } else {
          metrics.errors.push(
            `contention iteration ${iteration} failed unexpectedly: ${message}`,
          );
        }
      } finally {
        await withExecutionContext(sessionA, async () =>
          await releaseWorkspaceLease(sharedRepo),
        );
      }
    }

    if (iteration % config.processEvery === 0) {
      try {
        const started = await withExecutionContext(sessionC, async () =>
          await executeRoutedAction("shell.start", {
            command: "sleep 0.4",
            cwd: processRepo,
            workspace_mode: "write",
          }),
        );
        const processId = String(
          (started.result as { processId?: string })?.processId ?? "",
        );
        if (processId) {
          processIds.push(processId);
          metrics.processStarts += 1;
        } else {
          metrics.errors.push(
            "managed process start returned no processId",
          );
        }
      } catch (error) {
        metrics.errors.push(
          `managed process start failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    if (
      config.adapterEveryMs > 0 &&
      Date.now() - lastAdapterAt >= config.adapterEveryMs &&
      !activeAdapter
    ) {
      startAdapterSuite(++adapterRunNumber);
      lastAdapterAt = Date.now();
    }

    if (Date.now() - lastHeartbeatAt >= config.heartbeatMs) {
      await writeReport(await currentSnapshot());
      lastHeartbeatAt = Date.now();
    }

    await delay(config.foregroundStepMs);
  }
} catch (error) {
  metrics.errors.push(
    `soak main loop failed: ${
      error instanceof Error ? error.stack ?? error.message : String(error)
    }`,
  );
} finally {
  stopRequested = true;
  stopPersistentScheduler();
  stopPersistentLoopController();
  clearInterval(lagTimer);

  if (activeAdapter) {
    const adapter = activeAdapter;
    await Promise.race([
      adapter.promise,
      delay(60_000).then(() => {
        if (!adapter.child.killed) adapter.child.kill("SIGTERM");
      }),
    ]).catch(() => undefined);
  }

  const settleDeadline = Date.now() + 10_000;
  while (Date.now() < settleDeadline) {
    const schedule = scheduleId
      ? await getPersistentSchedule(scheduleId).catch(() => null)
      : null;
    const loop = loopId
      ? await getPersistentLoop(loopId).catch(() => null)
      : null;
    const processes = await listProcesses();
    if (
      !schedule?.activeTaskId &&
      !loop?.activeTaskId &&
      processes.every((item) => !item.running)
    ) {
      break;
    }
    await delay(100);
  }

  for (const processId of processIds) {
    const output = await getProcessOutput(processId, 2_000).catch(
      () => null,
    );
    if (output?.running) metrics.processExitFailures += 1;
  }

  const schedule = scheduleId
    ? await getPersistentSchedule(scheduleId).catch(() => null)
    : null;
  const loop = loopId
    ? await getPersistentLoop(loopId).catch(() => null)
    : null;

  const schedulerLines = await lineCount(schedulerLog);
  const loopLines = await lineCount(loopLog);
  const independentLineCounts = await Promise.all(
    independentLogs.map((file) => lineCount(file)),
  );

  const expectedLoopLines =
    (loop?.cycleCount ?? 0) + (loop?.phase === "read" ? 1 : 0);

  const tasks = await listPersistentTasks();
  const taskIds = tasks.map((task) => task.id);
  const duplicateTaskIds = taskIds.filter(
    (id, index) => taskIds.indexOf(id) !== index,
  );
  const nonTerminalTasks = tasks.filter(
    (task) =>
      !["completed", "failed", "blocked", "cancelled"].includes(
        task.status,
      ),
  );
  const processes = await listProcesses();
  const leases = await listWorkspaceLeases();

  const finalErrors = [...metrics.errors];

  if (
    independentLineCounts.some(
      (count) => count !== metrics.foregroundIterations,
    )
  ) {
    finalErrors.push(
      `independent log mismatch: iterations=${metrics.foregroundIterations} counts=${independentLineCounts.join(",")}`,
    );
  }
  if (metrics.independentErrors !== 0) {
    finalErrors.push(
      `independent action errors=${metrics.independentErrors}`,
    );
  }
  if (metrics.contentionAttempts !== metrics.contentionBusyRejects) {
    finalErrors.push(
      `contention mismatch attempts=${metrics.contentionAttempts} busyRejects=${metrics.contentionBusyRejects}`,
    );
  }
  if (schedule && schedulerLines !== schedule.runCount) {
    finalErrors.push(
      `scheduler duplicate/missing side effect: runCount=${schedule.runCount} lines=${schedulerLines}`,
    );
  }
  if (loop && loopLines !== expectedLoopLines) {
    finalErrors.push(
      `loop duplicate/missing side effect: cycles=${loop.cycleCount} phase=${loop.phase} expectedLines=${expectedLoopLines} lines=${loopLines}`,
    );
  }
  if (duplicateTaskIds.length > 0) {
    finalErrors.push(
      `duplicate task ids: ${duplicateTaskIds.join(",")}`,
    );
  }
  if (nonTerminalTasks.length > 0) {
    finalErrors.push(
      `non-terminal tasks remain: ${nonTerminalTasks
        .map((task) => `${task.id}:${task.status}`)
        .join(",")}`,
    );
  }
  if (processes.some((item) => item.running)) {
    finalErrors.push(
      `managed processes still running: ${processes
        .filter((item) => item.running)
        .map((item) => item.processId)
        .join(",")}`,
    );
  }
  if (leases.length > 0) {
    finalErrors.push(
      `workspace leases leaked: ${leases
        .map((lease) => lease.id)
        .join(",")}`,
    );
  }
  if (metrics.processExitFailures > 0) {
    finalErrors.push(
      `managed process exit failures=${metrics.processExitFailures}`,
    );
  }
  if (
    !skipAdapters &&
    (metrics.adapterRuns.length === 0 ||
      metrics.adapterRuns.some((run) => run.ok !== true))
  ) {
    finalErrors.push(
      "one or more adapter fixture suites failed or never completed",
    );
  }

  const maxRssGrowthMiB =
    (metrics.rssMaxBytes - metrics.rssBaselineBytes) / (1024 * 1024);
  const allowedRssGrowthMiB = finiteInt(
    process.env.SOAK_MAX_RSS_GROWTH_MB,
    requestedProfile === "smoke" ? 512 : 1024,
    64,
  );
  if (maxRssGrowthMiB > allowedRssGrowthMiB) {
    finalErrors.push(
      `RSS growth exceeded limit: ${maxRssGrowthMiB.toFixed(1)} MiB > ${allowedRssGrowthMiB} MiB`,
    );
  }

  const success = finalErrors.length === 0;
  const finishedAt = new Date().toISOString();
  const finalReport = {
    ...(await currentSnapshot()),
    status: success ? "passed" : "failed",
    finishedAt,
    success,
    checks: {
      independentReposConcurrent: metrics.independentErrors === 0,
      competingWriteRejected:
        metrics.contentionAttempts === metrics.contentionBusyRejects,
      schedulerSideEffectsExactlyOnce:
        Boolean(schedule) && schedulerLines === schedule?.runCount,
      loopSideEffectsExactlyOnce:
        Boolean(loop) && loopLines === expectedLoopLines,
      noDuplicateTaskIds: duplicateTaskIds.length === 0,
      noNonTerminalTasks: nonTerminalTasks.length === 0,
      noRunningManagedProcesses: processes.every(
        (item) => !item.running,
      ),
      noWorkspaceLeaseLeaks: leases.length === 0,
      adapterFixturesHealthy:
        skipAdapters ||
        (metrics.adapterRuns.length > 0 &&
          metrics.adapterRuns.every((run) => run.ok === true)),
      rssWithinLimit: maxRssGrowthMiB <= allowedRssGrowthMiB,
    },
    counts: {
      independentLineCounts,
      schedulerRunCount: schedule?.runCount ?? 0,
      schedulerLines,
      loopCycleCount: loop?.cycleCount ?? 0,
      loopPhase: loop?.phase ?? null,
      loopLines,
      expectedLoopLines,
      taskCount: tasks.length,
      processCount: processes.length,
      workspaceLeaseCount: leases.length,
    },
    memory: {
      rssBaselineBytes: metrics.rssBaselineBytes,
      rssMaxBytes: metrics.rssMaxBytes,
      rssGrowthMiB: Number(maxRssGrowthMiB.toFixed(2)),
      allowedRssGrowthMiB,
    },
    finalErrors,
  };

  await writeReport(finalReport);

  if (scheduleId) {
    await cancelPersistentSchedule(scheduleId).catch(() => undefined);
    await deletePersistentSchedule(scheduleId).catch(() => undefined);
  }
  if (loopId) {
    await cancelPersistentLoop(loopId).catch(() => undefined);
    await deletePersistentLoop(loopId).catch(() => undefined);
  }
  for (const session of [sessionA, sessionB, sessionC]) {
    runtimeSessionManager.disconnect(session.sessionId);
  }

  console.log(JSON.stringify(finalReport, null, 2));

  if (success && !keepScratch) {
    await fs.rm(scratch, { recursive: true, force: true }).catch(
      () => undefined,
    );
  }

  if (!success) process.exitCode = 1;
}
