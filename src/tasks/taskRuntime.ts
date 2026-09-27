import { randomUUID } from "node:crypto";
import {
  executeRoutedAction,
  validateRoutedAction,
} from "../router/actionRouter.js";
import {
  executePrimitive,
  resolvePrimitive,
  routePrimitive,
} from "../primitives/primitiveRuntime.js";
import {
  planActionGraph,
  type GraphStep,
} from "../router/graphRouter.js";
import {
  ensureTaskStage,
  stageArtifactsFromResult,
} from "./taskStaging.js";
import { indexTaskEpisode } from "../runtime/episodicIndex.js";
import {
  currentExecutionContext,
  withChildExecutionContext,
} from "../runtime/executionContext.js";
import { releaseWorkspaceLeasesForTask } from "../runtime/workspaceLeaseManager.js";
import { runtimeLifecycle } from "../runtime/runtimeLifecycle.js";
import {
  appendTaskEvent,
  deletePersistentTaskRecord,
  getTaskStorageInfo,
  listPersistentTaskRecords,
  readPersistentTask,
  writePersistentTask,
  type PersistentTask,
  type PersistentTaskStep,
} from "./taskStore.js";

const INSTANCE_ID = randomUUID();
const activeRuns = new Set<string>();
const controlSignals = new Map<
  string,
  { pauseRequested?: boolean; cancelRequested?: boolean }
>();

function newTaskId(): string {
  return `task_${Date.now().toString(36)}_${randomUUID()
    .replaceAll("-", "")
    .slice(0, 12)}`;
}

function collectReferences(value: unknown, refs = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectReferences(item, refs);
    return refs;
  }

  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    if (Object.keys(object).length === 1 && typeof object.$ref === "string") {
      const [stepId] = object.$ref.split(".");
      if (stepId) refs.add(stepId);
      return refs;
    }
    for (const child of Object.values(object)) collectReferences(child, refs);
  }

  return refs;
}

function resolvePath(root: unknown, path: string): unknown {
  const segments = path.split(".").filter(Boolean);
  let current = root;
  for (const segment of segments) {
    if (current == null || typeof current !== "object") {
      throw new Error(`Cannot resolve task reference path "${path}".`);
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function resolveReferences(
  value: unknown,
  outputs: Record<string, unknown>,
): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => resolveReferences(item, outputs));
  }

  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    if (Object.keys(object).length === 1 && typeof object.$ref === "string") {
      const [stepId, ...path] = object.$ref.split(".");
      if (!stepId || !(stepId in outputs)) {
        throw new Error(`Unknown task reference "${object.$ref}".`);
      }
      return path.length
        ? resolvePath(outputs[stepId], path.join("."))
        : outputs[stepId];
    }

    const resolved: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(object)) {
      resolved[key] = resolveReferences(child, outputs);
    }
    return resolved;
  }

  return value;
}

function summarizeTask(task: PersistentTask, includeResults = false) {
  return {
    id: task.id,
    label: task.label,
    status: task.status,
    ownerSessionId: task.ownerSessionId ?? null,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    runCount: task.runCount,
    lastRunAt: task.lastRunAt ?? null,
    completedAt: task.completedAt ?? null,
    pausedAt: task.pausedAt ?? null,
    blockedAt: task.blockedAt ?? null,
    cancelledAt: task.cancelledAt ?? null,
    pauseRequested: task.pauseRequested,
    cancelRequested: task.cancelRequested,
    runnerInstanceId: task.runnerInstanceId ?? null,
    runnerPid: task.runnerPid ?? null,
    defaults: {
      maxConcurrency: task.defaultMaxConcurrency,
      failFast: task.defaultFailFast,
    },
    storage: getTaskStorageInfo(),
    memoryLayers: {
      working: {
        description:
          "Durable task working memory: succeeded step outputs are addressable through $ref.",
        succeededOutputs: task.steps.filter((step) => step.state === "succeeded").length,
      },
      staging: {
        description:
          "File-backed intermediate asset staging for task artifacts.",
        root: task.stagingRoot ?? null,
        manifestPath: task.stagingManifestPath ?? null,
        artifactCount: task.stagedArtifacts?.length ?? 0,
        bytes:
          task.stagedArtifacts?.reduce((sum, artifact) => sum + artifact.bytes, 0) ??
          0,
      },
      episodic: {
        description:
          "Task execution history, lifecycle events, retries, and recovery notes.",
        eventCount: task.events.length,
        runCount: task.runCount,
      },
      semantic: {
        description:
          "Long-term M3 semantic memory is available through explicit, gated promotion from completed task evidence.",
        available: true,
        promotionMode: "explicit",
      },
    },
    staging: {
      root: task.stagingRoot ?? null,
      manifestPath: task.stagingManifestPath ?? null,
      artifactCount: task.stagedArtifacts?.length ?? 0,
      artifacts: task.stagedArtifacts ?? [],
    },
    steps: task.steps.map((step) => ({
      id: step.id,
      action: step.action,
      executionKind: step.executionKind ?? "action",
      primitive: step.primitive ?? null,
      op: step.op ?? null,
      dependsOn: step.dependsOn,
      parallelSafe: step.parallelSafe,
      retryPolicy: step.retryPolicy ?? (step.parallelSafe ? "automatic" : "manual"),
      riskLevel: step.riskLevel ?? null,
      sideEffects: step.sideEffects ?? [],
      requiresVerification: step.requiresVerification ?? false,
      resources: step.resources ?? [],
      state: step.state,
      attempts: step.attempts,
      durationMs: step.durationMs ?? null,
      startedAt: step.startedAt ?? null,
      completedAt: step.completedAt ?? null,
      error: step.error ?? null,
      recoveryNote: step.recoveryNote ?? null,
      ...(includeResults ? { result: step.result ?? null } : {}),
    })),
    events: task.events.slice(-100),
  };
}

function taskOutputs(task: PersistentTask): Record<string, unknown> {
  const outputs: Record<string, unknown> = {};
  for (const step of task.steps) {
    if (step.state === "succeeded") outputs[step.id] = step.result;
  }
  return outputs;
}

async function recoverInterruptedTask(task: PersistentTask): Promise<PersistentTask> {
  const isOtherRuntime =
    task.status === "running" &&
    task.runnerInstanceId &&
    task.runnerInstanceId !== INSTANCE_ID;

  if (!isOtherRuntime) return task;

  let needsReview = false;
  let recovered = false;

  for (const step of task.steps) {
    if (step.state !== "running") continue;

    recovered = true;
    const retryPolicy =
      step.retryPolicy ?? (step.parallelSafe ? "automatic" : "manual");

    if (retryPolicy === "automatic") {
      step.state = "pending";
      step.recoveryNote =
        "Previous server instance stopped while this automatically retryable step was running; it was reset to pending.";
      appendTaskEvent(task, {
        type: "step_recovered",
        stepId: step.id,
        message: `Reset interrupted auto-retry step ${step.id} to pending.`,
      });
    } else {
      step.state = "needs_review";
      needsReview = true;
      step.recoveryNote =
        `Previous server instance stopped during a ${retryPolicy}-retry step. Explicitly retry or mark it succeeded after checking side effects.`;
      appendTaskEvent(task, {
        type: "step_needs_review",
        stepId: step.id,
        message: `Interrupted ${retryPolicy}-retry step ${step.id} requires review.`,
      });
    }
  }

  if (recovered) {
    task.status = needsReview ? "blocked" : "paused";
    task.runnerInstanceId = undefined;
    task.runnerPid = undefined;
    task.pauseRequested = false;
    task.cancelRequested = false;
    if (needsReview) task.blockedAt = new Date().toISOString();
    else task.pausedAt = new Date().toISOString();

    appendTaskEvent(task, {
      type: "runtime_recovery",
      message: needsReview
        ? "Recovered after server restart; at least one interrupted state-changing step needs review."
        : "Recovered after server restart; interrupted parallel-safe work can be resumed.",
    });

    await writePersistentTask(task);
  }

  return task;
}

async function loadTask(id: string): Promise<PersistentTask> {
  const task = await recoverInterruptedTask(await readPersistentTask(id));
  const stage = await ensureTaskStage(task.id);
  let changed = false;

  if (!task.stagingRoot) {
    task.stagingRoot = stage.root;
    appendTaskEvent(task, {
      type: "staging_initialized",
      message: `Initialized task staging at ${stage.root}.`,
    });
    changed = true;
  }

  if (!task.stagingManifestPath) {
    task.stagingManifestPath = stage.manifestPath;
    changed = true;
  }

  if (!task.stagedArtifacts) {
    task.stagedArtifacts = stage.artifacts ?? [];
    changed = true;
  } else if (stage.artifacts.length > task.stagedArtifacts.length) {
    const known = new Set(task.stagedArtifacts.map((artifact) => artifact.id));
    task.stagedArtifacts = [
      ...task.stagedArtifacts,
      ...stage.artifacts.filter((artifact) => !known.has(artifact.id)),
    ];
    changed = true;
  }

  if (changed) await writePersistentTask(task);
  return task;
}

export type PrimitiveTaskStep = {
  id: string;
  primitive: string;
  op: string;
  args?: Record<string, unknown>;
  dependsOn?: string[];
};

export async function createPersistentTask(
  label: string,
  steps: GraphStep[],
  options?: { maxConcurrency?: number; failFast?: boolean },
) {
  const plan = planActionGraph(steps);
  const validationErrors = plan.filter((step) => step.validationError);
  if (validationErrors.length > 0) {
    throw new Error(
      validationErrors
        .map((step) => `${step.id}: ${step.validationError}`)
        .join("\n"),
    );
  }

  const now = new Date().toISOString();
  const id = newTaskId();
  const stage = await ensureTaskStage(id);

  const task: PersistentTask = {
    version: 1,
    id,
    label,
    ownerSessionId: currentExecutionContext().sessionId,
    createdAt: now,
    updatedAt: now,
    status: "pending",
    defaultMaxConcurrency: Math.min(
      Math.max(options?.maxConcurrency ?? 4, 1),
      8,
    ),
    defaultFailFast: options?.failFast ?? true,
    runCount: 0,
    pauseRequested: false,
    cancelRequested: false,
    stagingRoot: stage.root,
    stagingManifestPath: stage.manifestPath,
    stagedArtifacts: [],
    steps: steps.map((step) => {
      const planned = plan.find((item) => item.id === step.id);
      if (!planned) throw new Error(`Missing plan entry for ${step.id}.`);

      return {
        id: step.id,
        action: step.action,
        executionKind: "action",
        args: step.args ?? {},
        dependsOn: planned.dependsOn,
        parallelSafe: planned.parallelSafe,
        retryPolicy: planned.contract.retryPolicy,
        riskLevel: planned.contract.riskLevel,
        sideEffects: planned.contract.sideEffects,
        requiresVerification: planned.contract.requiresVerification,
        resources: planned.contract.resources,
        state: "pending",
        attempts: 0,
      } satisfies PersistentTaskStep;
    }),
    events: [],
  };

  appendTaskEvent(task, {
    type: "task_created",
    message: `Created persistent task with ${task.steps.length} steps.`,
  });
  appendTaskEvent(task, {
    type: "staging_initialized",
    message: `Initialized task staging at ${stage.root}.`,
  });

  await writePersistentTask(task);
  return summarizeTask(task, false);
}

export function validatePrimitiveTaskSteps(
  steps: PrimitiveTaskStep[],
): ReturnType<typeof planActionGraph> {
  if (steps.length === 0) {
    throw new Error("Persistent Primitive task requires at least one step.");
  }
  if (steps.length > 50) {
    throw new Error("Persistent Primitive task accepts at most 50 steps.");
  }

  const seen = new Set<string>();
  const routedSteps: GraphStep[] = steps.map((step) => {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(step.id)) {
      throw new Error(`Invalid Primitive task step id "${step.id}".`);
    }
    if (seen.has(step.id)) {
      throw new Error(`Duplicate Primitive task step id "${step.id}".`);
    }
    seen.add(step.id);

    const routed = routePrimitive(step.primitive, step.op, step.args ?? {});
    return {
      id: step.id,
      action: routed.routedAction,
      args: step.args ?? {},
      dependsOn: step.dependsOn,
    };
  });

  const plan = planActionGraph(routedSteps);
  const validationErrors = plan.filter((step) => step.validationError);
  if (validationErrors.length > 0) {
    throw new Error(
      validationErrors
        .map((step) => `${step.id}: ${step.validationError}`)
        .join("\n"),
    );
  }
  return plan;
}

export async function createPersistentPrimitiveTask(
  label: string,
  steps: PrimitiveTaskStep[],
  options?: {
    maxConcurrency?: number;
    failFast?: boolean;
    taskId?: string;
  },
) {
  const plan = validatePrimitiveTaskSteps(steps);

  const now = new Date().toISOString();
  const id = options?.taskId ?? newTaskId();
  const stage = await ensureTaskStage(id);

  const task: PersistentTask = {
    version: 1,
    id,
    label,
    ownerSessionId: currentExecutionContext().sessionId,
    createdAt: now,
    updatedAt: now,
    status: "pending",
    defaultMaxConcurrency: Math.min(
      Math.max(options?.maxConcurrency ?? 4, 1),
      8,
    ),
    defaultFailFast: options?.failFast ?? true,
    runCount: 0,
    pauseRequested: false,
    cancelRequested: false,
    stagingRoot: stage.root,
    stagingManifestPath: stage.manifestPath,
    stagedArtifacts: [],
    steps: steps.map((step) => {
      const routed = routePrimitive(step.primitive, step.op, step.args ?? {});
      const planned = plan.find((item) => item.id === step.id);
      if (!planned) throw new Error(`Missing plan entry for ${step.id}.`);

      return {
        id: step.id,
        action: routed.routedAction,
        executionKind: "primitive",
        primitive: routed.canonicalPrimitive,
        op: step.op,
        args: step.args ?? {},
        dependsOn: planned.dependsOn,
        parallelSafe: planned.parallelSafe,
        retryPolicy: planned.contract.retryPolicy,
        riskLevel: planned.contract.riskLevel,
        sideEffects: planned.contract.sideEffects,
        requiresVerification: planned.contract.requiresVerification,
        resources: planned.contract.resources,
        state: "pending",
        attempts: 0,
      } satisfies PersistentTaskStep;
    }),
    events: [],
  };

  appendTaskEvent(task, {
    type: "task_created",
    message: `Created persistent Primitive task with ${task.steps.length} steps.`,
  });
  appendTaskEvent(task, {
    type: "staging_initialized",
    message: `Initialized task staging at ${stage.root}.`,
  });

  await writePersistentTask(task);
  return summarizeTask(task, false);
}

export async function listPersistentTasks() {
  const tasks = await listPersistentTaskRecords();
  const recovered: PersistentTask[] = [];
  for (const task of tasks) recovered.push(await recoverInterruptedTask(task));

  return recovered.map((task) => ({
    id: task.id,
    label: task.label,
    status: task.status,
    ownerSessionId: task.ownerSessionId ?? null,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    runCount: task.runCount,
    counts: {
      total: task.steps.length,
      pending: task.steps.filter((step) => step.state === "pending").length,
      running: task.steps.filter((step) => step.state === "running").length,
      succeeded: task.steps.filter((step) => step.state === "succeeded").length,
      failed: task.steps.filter((step) => step.state === "failed").length,
      needsReview: task.steps.filter((step) => step.state === "needs_review").length,
    },
    staging: {
      root: task.stagingRoot ?? null,
      manifestPath: task.stagingManifestPath ?? null,
      artifactCount: task.stagedArtifacts?.length ?? 0,
      bytes:
        task.stagedArtifacts?.reduce((sum, artifact) => sum + artifact.bytes, 0) ??
        0,
    },
  }));
}

export async function deletePersistentTask(id: string) {
  if (activeRuns.has(id)) {
    throw new Error("Cannot delete a persistent task while it is actively running.");
  }

  const task = await loadTask(id);
  if (task.status === "running") {
    throw new Error("Cannot delete a task that is still marked running.");
  }

  await deletePersistentTaskRecord(id);
  controlSignals.delete(id);
  return {
    id,
    label: task.label,
    previousStatus: task.status,
    deleted: true,
    stagingPreserved: true,
    stagingRoot: task.stagingRoot ?? null,
    stagedArtifactCount: task.stagedArtifacts?.length ?? 0,
  };
}

export async function getPersistentTaskStatus(
  id: string,
  includeResults = false,
) {
  return summarizeTask(await loadTask(id), includeResults);
}

export async function requestTaskPause(id: string) {
  const task = await loadTask(id);
  if (["completed", "cancelled"].includes(task.status)) {
    throw new Error(`Cannot pause a ${task.status} task.`);
  }

  task.pauseRequested = true;
  controlSignals.set(id, {
    ...(controlSignals.get(id) ?? {}),
    pauseRequested: true,
  });

  if (task.status !== "running") {
    task.status = "paused";
    task.pausedAt = new Date().toISOString();
  }

  appendTaskEvent(task, {
    type: "pause_requested",
    message:
      task.status === "running"
        ? "Pause requested; execution will stop after the current wave."
        : "Task paused.",
  });

  await writePersistentTask(task);
  return summarizeTask(task, false);
}

export async function cancelPersistentTask(id: string) {
  const task = await loadTask(id);
  if (task.status === "completed") {
    throw new Error("Cannot cancel a completed task.");
  }

  task.cancelRequested = true;
  controlSignals.set(id, {
    ...(controlSignals.get(id) ?? {}),
    cancelRequested: true,
  });

  if (task.status !== "running") {
    task.status = "cancelled";
    task.cancelledAt = new Date().toISOString();
  }

  appendTaskEvent(task, {
    type: "cancel_requested",
    message:
      task.status === "running"
        ? "Cancellation requested; execution will stop after the current wave."
        : "Task cancelled.",
  });

  await writePersistentTask(task);
  return summarizeTask(task, false);
}

export async function resolvePersistentTaskStep(
  id: string,
  stepId: string,
  resolution: "retry" | "mark_succeeded",
  result?: unknown,
) {
  if (activeRuns.has(id)) {
    throw new Error("Cannot resolve a step while this task is actively running.");
  }

  const task = await loadTask(id);
  const step = task.steps.find((item) => item.id === stepId);
  if (!step) throw new Error(`Unknown task step "${stepId}".`);

  if (!["failed", "needs_review"].includes(step.state)) {
    throw new Error(
      `Step ${stepId} is ${step.state}; only failed or needs_review steps can be resolved.`,
    );
  }

  if (resolution === "retry") {
    step.state = "pending";
    step.startedAt = undefined;
    step.completedAt = undefined;
    step.durationMs = undefined;
    step.error = undefined;
    step.result = undefined;
    step.recoveryNote = undefined;
    appendTaskEvent(task, {
      type: "step_retry",
      stepId,
      message: `Step ${stepId} was explicitly reset to pending.`,
    });
  } else {
    step.state = "succeeded";
    step.completedAt = new Date().toISOString();
    step.error = undefined;
    step.result = result;
    step.recoveryNote = "Manually marked succeeded after review.";
    appendTaskEvent(task, {
      type: "step_marked_succeeded",
      stepId,
      message: `Step ${stepId} was explicitly marked succeeded.`,
    });
  }

  task.status = "paused";
  task.pausedAt = new Date().toISOString();
  task.blockedAt = undefined;
  task.pauseRequested = false;
  task.cancelRequested = false;
  task.runnerInstanceId = undefined;
  task.runnerPid = undefined;

  await writePersistentTask(task);
  return summarizeTask(task, true);
}

function chooseStatusAfterRun(task: PersistentTask): PersistentTask["status"] {
  if (task.cancelRequested) return "cancelled";
  if (task.steps.every((step) => step.state === "succeeded")) return "completed";
  if (task.steps.some((step) => step.state === "needs_review")) return "blocked";
  if (task.steps.some((step) => step.state === "failed")) return "failed";
  return "paused";
}

export async function runPersistentTask(
  id: string,
  options?: {
    maxConcurrency?: number;
    failFast?: boolean;
    maxWaves?: number;
    timeBudgetMs?: number;
  },
) {
  if (activeRuns.has(id)) {
    throw new Error("This task is already running in the current server instance.");
  }

  let task = await loadTask(id);
  if (task.status === "completed") {
    await indexTaskEpisode(task).catch(() => undefined);
    return {
      alreadyCompleted: true,
      ...summarizeTask(task, true),
    };
  }
  if (task.status === "cancelled") {
    throw new Error("Cancelled tasks cannot be resumed.");
  }

  const unresolved = task.steps.filter((step) => step.state === "needs_review");
  if (unresolved.length > 0) {
    throw new Error(
      `Task is blocked by interrupted state-changing step(s): ${unresolved
        .map((step) => step.id)
        .join(", ")}. Use task_resolve_step first.`,
    );
  }

  const maxConcurrency = Math.min(
    Math.max(options?.maxConcurrency ?? task.defaultMaxConcurrency, 1),
    8,
  );
  const failFast = options?.failFast ?? task.defaultFailFast;
  const maxWaves = Math.min(Math.max(options?.maxWaves ?? 100, 1), 1000);
  const timeBudgetMs = Math.min(
    Math.max(options?.timeBudgetMs ?? 60_000, 1_000),
    10 * 60_000,
  );

  const taskLifecycleMutation = runtimeLifecycle.beginMutation(
    `task:${id}`,
    {
      context: {
        ...currentExecutionContext(),
        sessionId:
          task.ownerSessionId ?? currentExecutionContext().sessionId,
        taskId: task.id,
        origin: "task",
      },
    },
  );

  activeRuns.add(id);
  controlSignals.delete(id);

  const runStartedAt = Date.now();
  const runResults: Array<Record<string, unknown>> = [];
  let wavesExecuted = 0;

  try {
    task.status = "running";
    task.runCount += 1;
    task.lastRunAt = new Date().toISOString();
    task.runnerInstanceId = INSTANCE_ID;
    task.runnerPid = process.pid;
    task.pauseRequested = false;
    task.cancelRequested = false;
    appendTaskEvent(task, {
      type: "run_started",
      message: `Run ${task.runCount} started with maxConcurrency=${maxConcurrency}, failFast=${failFast}.`,
    });
    await writePersistentTask(task);

    while (true) {
      if (wavesExecuted >= maxWaves) {
        task.status = "paused";
        task.pausedAt = new Date().toISOString();
        appendTaskEvent(task, {
          type: "run_paused",
          message: `Paused after reaching maxWaves=${maxWaves}.`,
        });
        break;
      }

      if (
        wavesExecuted > 0 &&
        Date.now() - runStartedAt >= timeBudgetMs
      ) {
        task.status = "paused";
        task.pausedAt = new Date().toISOString();
        appendTaskEvent(task, {
          type: "run_paused",
          message: `Paused after reaching time budget of ${timeBudgetMs} ms.`,
        });
        break;
      }

      const signal = controlSignals.get(id) ?? {};
      if (signal.cancelRequested || task.cancelRequested) {
        task.cancelRequested = true;
        task.status = "cancelled";
        task.cancelledAt = new Date().toISOString();
        appendTaskEvent(task, {
          type: "run_cancelled",
          message: "Task stopped after cancellation request.",
        });
        break;
      }
      if (signal.pauseRequested || task.pauseRequested) {
        task.pauseRequested = true;
        task.status = "paused";
        task.pausedAt = new Date().toISOString();
        appendTaskEvent(task, {
          type: "run_paused",
          message: "Task stopped after pause request.",
        });
        break;
      }

      if (task.steps.every((step) => step.state === "succeeded")) {
        task.status = "completed";
        task.completedAt = new Date().toISOString();
        appendTaskEvent(task, {
          type: "task_completed",
          message: "All task steps succeeded.",
        });
        break;
      }

      if (
        failFast &&
        task.steps.some((step) => step.state === "failed")
      ) {
        task.status = "failed";
        appendTaskEvent(task, {
          type: "run_failed",
          message: "Fail-fast stopped execution after a step failure.",
        });
        break;
      }

      const ready = task.steps.filter(
        (step) =>
          step.state === "pending" &&
          step.dependsOn.every(
            (dependency) =>
              task.steps.find((item) => item.id === dependency)?.state ===
              "succeeded",
          ),
      );

      if (ready.length === 0) {
        task.status = chooseStatusAfterRun(task);
        if (task.status === "paused") {
          task.status = "blocked";
          task.blockedAt = new Date().toISOString();
          appendTaskEvent(task, {
            type: "task_blocked",
            message: "No runnable steps remain; unresolved dependencies are blocking progress.",
          });
        }
        break;
      }

      const firstReady = ready[0]!;
      const wave = firstReady.parallelSafe
        ? ready
            .filter((step) => step.parallelSafe)
            .slice(0, maxConcurrency)
        : [firstReady];

      const outputs = taskOutputs(task);
      const waveStartedAt = Date.now();

      for (const step of wave) {
        step.state = "running";
        step.attempts += 1;
        step.startedAt = new Date().toISOString();
        step.completedAt = undefined;
        step.error = undefined;
        step.recoveryNote = undefined;
        appendTaskEvent(task, {
          type: "step_started",
          stepId: step.id,
          message: `Started ${step.action} (attempt ${step.attempts}).`,
        });
      }

      await writePersistentTask(task);

      const results = await Promise.all(
        wave.map(async (step) =>
          await withChildExecutionContext(
            {
              sessionId:
                task.ownerSessionId ?? currentExecutionContext().sessionId,
              origin: "task",
              taskId: task.id,
            },
            async () => {
              const stepStartedAt = Date.now();
              try {
                const resolvedArgs = resolveReferences(
                  step.args,
                  outputs,
                ) as Record<string, unknown>;

                if (
                  step.executionKind === "primitive" &&
                  step.primitive &&
                  step.op
                ) {
                  const resolved = resolvePrimitive(
                    step.primitive,
                    step.op,
                    resolvedArgs,
                  );
                  const executed = await executePrimitive(
                    step.primitive,
                    step.op,
                    resolved.validation.args,
                  );
                  return {
                    id: step.id,
                    ok: true as const,
                    provider: executed.provider,
                    durationMs: Date.now() - stepStartedAt,
                    result: executed.result,
                  };
                }

                validateRoutedAction(step.action, resolvedArgs);
                const executed = await executeRoutedAction(
                  step.action,
                  resolvedArgs,
                );
                return {
                  id: step.id,
                  ok: true as const,
                  provider: executed.provider,
                  durationMs: Date.now() - stepStartedAt,
                  result: executed.result,
                };
              } catch (error) {
                return {
                  id: step.id,
                  ok: false as const,
                  durationMs: Date.now() - stepStartedAt,
                  error:
                    error instanceof Error ? error.message : String(error),
                };
              }
            },
          ),
        ),
      );

      const latest = await readPersistentTask(id);
      task.pauseRequested =
        latest.pauseRequested ||
        (controlSignals.get(id)?.pauseRequested ?? false);
      task.cancelRequested =
        latest.cancelRequested ||
        (controlSignals.get(id)?.cancelRequested ?? false);

      const existingEventKeys = new Set(
        task.events.map(
          (event) =>
            `${event.at}|${event.type}|${event.stepId ?? ""}|${event.message}`,
        ),
      );
      for (const event of latest.events) {
        const key = `${event.at}|${event.type}|${event.stepId ?? ""}|${event.message}`;
        if (!existingEventKeys.has(key)) {
          task.events.push(event);
          existingEventKeys.add(key);
        }
      }
      task.events.sort((a, b) => a.at.localeCompare(b.at));
      if (task.events.length > 1000) {
        task.events.splice(0, task.events.length - 1000);
      }

      for (const result of results) {
        const step = task.steps.find((item) => item.id === result.id)!;
        step.durationMs = result.durationMs;
        step.completedAt = new Date().toISOString();

        if (result.ok) {
          step.state = "succeeded";
          step.result = result.result;
          step.error = undefined;
          appendTaskEvent(task, {
            type: "step_succeeded",
            stepId: step.id,
            message: `${step.action} succeeded in ${result.durationMs} ms.`,
          });

          try {
            const staged = await stageArtifactsFromResult(
              task.id,
              step.id,
              result.result,
              task.stagedArtifacts ?? [],
            );
            if (staged.length > 0) {
              task.stagedArtifacts = [...(task.stagedArtifacts ?? []), ...staged];
              if (
                step.result &&
                typeof step.result === "object" &&
                !Array.isArray(step.result)
              ) {
                step.result = {
                  ...(step.result as Record<string, unknown>),
                  staging: {
                    artifacts: staged,
                  },
                };
              }
              for (const artifact of staged) {
                appendTaskEvent(task, {
                  type: "artifact_staged",
                  stepId: step.id,
                  message: `Staged ${artifact.filename} (${artifact.bytes} bytes).`,
                });
              }
            }
          } catch (error) {
            appendTaskEvent(task, {
              type: "staging_warning",
              stepId: step.id,
              message:
                "Step succeeded, but artifact staging failed: " +
                (error instanceof Error ? error.message : String(error)),
            });
          }
        } else {
          step.state = "failed";
          step.error = result.error;
          step.result = undefined;
          appendTaskEvent(task, {
            type: "step_failed",
            stepId: step.id,
            message: `${step.action} failed: ${result.error}`,
          });
        }

        runResults.push({
          id: step.id,
          action: step.action,
          ok: result.ok,
          durationMs: result.durationMs,
          ...(result.ok
            ? { result: result.result }
            : { error: result.error }),
        });
      }

      wavesExecuted += 1;
      appendTaskEvent(task, {
        type: "wave_completed",
        message: `Wave ${wavesExecuted} completed in ${Date.now() - waveStartedAt} ms with steps: ${wave
          .map((step) => step.id)
          .join(", ")}.`,
      });

      await writePersistentTask(task);

      if (
        failFast &&
        results.some((result) => !result.ok)
      ) {
        task.status = "failed";
        appendTaskEvent(task, {
          type: "run_failed",
          message: "Fail-fast stopped execution after the current wave.",
        });
        break;
      }
    }

    task.runnerInstanceId = undefined;
    task.runnerPid = undefined;

    if (task.status === "completed") {
      task.completedAt ??= new Date().toISOString();
    } else if (task.status === "paused") {
      task.pausedAt ??= new Date().toISOString();
    } else if (task.status === "blocked") {
      task.blockedAt ??= new Date().toISOString();
    } else if (task.status === "cancelled") {
      task.cancelledAt ??= new Date().toISOString();
    }

    if (["completed", "failed", "blocked", "cancelled"].includes(task.status)) {
      try {
        const indexed = await indexTaskEpisode(task);
        if (indexed.indexed) {
          appendTaskEvent(task, {
            type: "global_episode_indexed",
            message: `Indexed terminal task in global episodic memory as ${indexed.episodeId}.`,
          });
        }
      } catch (error) {
        appendTaskEvent(task, {
          type: "episodic_index_warning",
          message:
            "Task reached a terminal state, but global episodic indexing failed: " +
            (error instanceof Error ? error.message : String(error)),
        });
      }
    }

    if (["completed", "failed", "blocked", "cancelled"].includes(task.status)) {
      try {
        const released = await releaseWorkspaceLeasesForTask(task.id);
        if (released > 0) {
          appendTaskEvent(task, {
            type: "workspace_leases_released",
            message: `Released ${released} task-owned workspace lease(s) after terminal state.`,
          });
        }
      } catch (error) {
        appendTaskEvent(task, {
          type: "workspace_lease_warning",
          message:
            "Task reached a terminal state, but workspace lease cleanup failed: " +
            (error instanceof Error ? error.message : String(error)),
        });
      }
    }

    await writePersistentTask(task);

    return {
      id: task.id,
      label: task.label,
      status: task.status,
      runCount: task.runCount,
      wavesExecuted,
      runDurationMs: Date.now() - runStartedAt,
      runResults,
      summary: summarizeTask(task, false),
    };
  } finally {
    activeRuns.delete(id);
    controlSignals.delete(id);
    runtimeLifecycle.endMutation(taskLifecycleMutation.id);
  }
}
