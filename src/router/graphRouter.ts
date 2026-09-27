import {
  executeRoutedAction,
  getRouterCatalog,
  validateRoutedAction,
} from "./actionRouter.js";
import {
  getActionContract,
  summarizeActionContract,
} from "../runtime/actionContracts.js";

type JsonObject = Record<string, unknown>;

export type GraphStep = {
  id: string;
  action: string;
  args?: JsonObject;
  dependsOn?: string[];
};

type StepState = "pending" | "running" | "succeeded" | "failed" | "skipped";

export function isActionParallelSafe(
  action: string,
  args: JsonObject = {},
): boolean {
  return getActionContract(action, args).parallelSafe;
}

function actionExists(action: string): boolean {
  return getRouterCatalog().some((item) => item.action === action);
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

    for (const child of Object.values(object)) {
      collectReferences(child, refs);
    }
  }

  return refs;
}

function containsReference(value: unknown): boolean {
  return collectReferences(value).size > 0;
}

function resolvePath(root: unknown, path: string): unknown {
  const segments = path.split(".").filter(Boolean);
  let current = root;
  for (const segment of segments) {
    if (current == null || typeof current !== "object") {
      throw new Error(`Cannot resolve graph reference path "${path}".`);
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function resolveReferences(value: unknown, outputs: Record<string, unknown>): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => resolveReferences(item, outputs));
  }

  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    if (Object.keys(object).length === 1 && typeof object.$ref === "string") {
      const [stepId, ...path] = object.$ref.split(".");
      if (!stepId || !(stepId in outputs)) {
        throw new Error(`Unknown graph reference "${object.$ref}".`);
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

type NormalizedStep = {
  id: string;
  action: string;
  args: JsonObject;
  dependsOn: string[];
  explicitDependsOn: string[];
  referenceDependsOn: string[];
  parallelSafe: boolean;
};

function normalizeSteps(steps: GraphStep[]): NormalizedStep[] {
  if (steps.length === 0) throw new Error("computer_graph requires at least one step.");
  if (steps.length > 50) throw new Error("computer_graph accepts at most 50 steps.");

  const ids = new Set<string>();

  for (const step of steps) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(step.id)) {
      throw new Error(
        `Invalid step id "${step.id}". Use 1-64 letters, numbers, _ or -.`,
      );
    }
    if (ids.has(step.id)) throw new Error(`Duplicate step id "${step.id}".`);
    if (!actionExists(step.action)) {
      throw new Error(
        `Unknown routed action "${step.action}" in step "${step.id}". Call router_catalog for supported actions.`,
      );
    }
    ids.add(step.id);
  }

  return steps.map((step) => {
    const explicitDependsOn = [...new Set(step.dependsOn ?? [])];
    const referenceDependsOn = [...collectReferences(step.args ?? {})];

    for (const dependency of [...explicitDependsOn, ...referenceDependsOn]) {
      if (!ids.has(dependency)) {
        throw new Error(
          `Step "${step.id}" depends on unknown step "${dependency}".`,
        );
      }
      if (dependency === step.id) {
        throw new Error(`Step "${step.id}" cannot depend on itself.`);
      }
    }

    return {
      id: step.id,
      action: step.action,
      args: step.args ?? {},
      dependsOn: [...new Set([...explicitDependsOn, ...referenceDependsOn])],
      explicitDependsOn,
      referenceDependsOn,
      parallelSafe: isActionParallelSafe(step.action, step.args ?? {}),
    };
  });
}

function assertAcyclic(steps: NormalizedStep[]): void {
  const indegree = new Map<string, number>();
  const children = new Map<string, string[]>();

  for (const step of steps) {
    indegree.set(step.id, step.dependsOn.length);
    for (const dependency of step.dependsOn) {
      const list = children.get(dependency) ?? [];
      list.push(step.id);
      children.set(dependency, list);
    }
  }

  const queue = [...steps.filter((step) => step.dependsOn.length === 0).map((step) => step.id)];
  let visited = 0;

  while (queue.length > 0) {
    const id = queue.shift()!;
    visited += 1;
    for (const child of children.get(id) ?? []) {
      const next = (indegree.get(child) ?? 0) - 1;
      indegree.set(child, next);
      if (next === 0) queue.push(child);
    }
  }

  if (visited !== steps.length) {
    const cyclic = steps
      .filter((step) => (indegree.get(step.id) ?? 0) > 0)
      .map((step) => step.id);
    throw new Error(`Dependency cycle detected involving: ${cyclic.join(", ")}.`);
  }
}

export function planActionGraph(steps: GraphStep[]) {
  const normalized = normalizeSteps(steps);
  assertAcyclic(normalized);

  return normalized.map((step) => {
    let validation: "validated" | "deferred";
    let validationError: string | null = null;

    if (containsReference(step.args)) {
      validation = "deferred";
    } else {
      try {
        validateRoutedAction(step.action, step.args);
        validation = "validated";
      } catch (error) {
        validation = "validated";
        validationError = error instanceof Error ? error.message : String(error);
      }
    }

    return {
      id: step.id,
      action: step.action,
      dependsOn: step.dependsOn,
      explicitDependsOn: step.explicitDependsOn,
      referenceDependsOn: step.referenceDependsOn,
      parallelSafe: step.parallelSafe,
      contract: summarizeActionContract(getActionContract(step.action, step.args)),
      validation,
      validationError,
    };
  });
}

export async function executeActionGraph(
  steps: GraphStep[],
  options?: {
    maxConcurrency?: number;
    failFast?: boolean;
    dryRun?: boolean;
  },
) {
  const normalized = normalizeSteps(steps);
  assertAcyclic(normalized);

  const plan = planActionGraph(steps);
  const validationErrors = plan.filter((step) => step.validationError);
  if (validationErrors.length > 0) {
    throw new Error(
      validationErrors
        .map((step) => `${step.id}: ${step.validationError}`)
        .join("\n"),
    );
  }

  if (options?.dryRun) {
    return {
      ok: true,
      dryRun: true,
      maxConcurrency: Math.min(Math.max(options.maxConcurrency ?? 4, 1), 8),
      failFast: options.failFast ?? true,
      plan,
    };
  }

  const maxConcurrency = Math.min(Math.max(options?.maxConcurrency ?? 4, 1), 8);
  const failFast = options?.failFast ?? true;
  const startedAt = Date.now();

  const byId = new Map(normalized.map((step) => [step.id, step]));
  const states = new Map<string, StepState>(
    normalized.map((step) => [step.id, "pending"]),
  );
  const outputs: Record<string, unknown> = {};
  const resultById = new Map<string, Record<string, unknown>>();
  const waves: Array<Record<string, unknown>> = [];
  let failureSeen = false;

  const recordSkip = (step: NormalizedStep, reason: string) => {
    states.set(step.id, "skipped");
    resultById.set(step.id, {
      id: step.id,
      ok: false,
      skipped: true,
      action: step.action,
      provider: getRouterCatalog().find((item) => item.action === step.action)?.provider,
      reason,
      durationMs: 0,
    });
  };

  while ([...states.values()].some((state) => state === "pending")) {
    let changed = false;

    for (const step of normalized) {
      if (states.get(step.id) !== "pending") continue;
      const dependencyStates = step.dependsOn.map((id) => states.get(id));
      if (dependencyStates.some((state) => state === "failed" || state === "skipped")) {
        recordSkip(step, "dependency_failed");
        changed = true;
      }
    }

    if (failFast && failureSeen) {
      for (const step of normalized) {
        if (states.get(step.id) === "pending") {
          recordSkip(step, "fail_fast");
          changed = true;
        }
      }
      break;
    }

    const ready = normalized.filter(
      (step) =>
        states.get(step.id) === "pending" &&
        step.dependsOn.every((dependency) => states.get(dependency) === "succeeded"),
    );

    if (ready.length === 0) {
      if ([...states.values()].some((state) => state === "pending")) {
        if (changed) continue;
        throw new Error("Graph scheduler deadlock: pending steps exist but none are runnable.");
      }
      break;
    }

    const firstReady = ready[0]!;
    const wave = firstReady.parallelSafe
      ? ready.filter((step) => step.parallelSafe).slice(0, maxConcurrency)
      : [firstReady];

    const waveStartedAt = Date.now();
    for (const step of wave) states.set(step.id, "running");

    const waveResults = await Promise.all(
      wave.map(async (step) => {
        const stepStartedAt = Date.now();
        try {
          const resolvedArgs = resolveReferences(step.args, outputs);
          const executed = await executeRoutedAction(step.action, resolvedArgs);
          return {
            step,
            ok: true as const,
            durationMs: Date.now() - stepStartedAt,
            provider: executed.provider,
            result: executed.result,
          };
        } catch (error) {
          return {
            step,
            ok: false as const,
            durationMs: Date.now() - stepStartedAt,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }),
    );

    for (const entry of waveResults) {
      if (entry.ok) {
        states.set(entry.step.id, "succeeded");
        outputs[entry.step.id] = entry.result;
        resultById.set(entry.step.id, {
          id: entry.step.id,
          ok: true,
          action: entry.step.action,
          provider: entry.provider,
          parallelSafe: entry.step.parallelSafe,
          durationMs: entry.durationMs,
          result: entry.result,
        });
      } else {
        states.set(entry.step.id, "failed");
        failureSeen = true;
        resultById.set(entry.step.id, {
          id: entry.step.id,
          ok: false,
          action: entry.step.action,
          parallelSafe: entry.step.parallelSafe,
          durationMs: entry.durationMs,
          error: entry.error,
        });
      }
    }

    const waveDurationMs = Date.now() - waveStartedAt;
    waves.push({
      index: waves.length,
      stepIds: wave.map((step) => step.id),
      parallel: wave.length > 1,
      wallDurationMs: waveDurationMs,
      summedStepDurationMs: waveResults.reduce((sum, entry) => sum + entry.durationMs, 0),
    });
  }

  const orderedResults = normalized.map((step) => {
    const result = resultById.get(step.id);
    if (result) return result;
    return {
      id: step.id,
      ok: false,
      skipped: true,
      action: step.action,
      reason: "not_executed",
      durationMs: 0,
    };
  });

  const succeeded = orderedResults.filter((result) => result.ok === true).length;
  const failed = orderedResults.filter(
    (result) => result.ok === false && result.skipped !== true,
  ).length;
  const skipped = orderedResults.filter((result) => result.skipped === true).length;
  const wallDurationMs = Date.now() - startedAt;
  const summedStepDurationMs = orderedResults.reduce(
    (sum, result) => sum + Number(result.durationMs ?? 0),
    0,
  );

  return {
    ok: failed === 0 && skipped === 0,
    dryRun: false,
    maxConcurrency,
    failFast,
    requestedSteps: normalized.length,
    succeeded,
    failed,
    skipped,
    wallDurationMs,
    summedStepDurationMs,
    parallelEfficiency:
      wallDurationMs > 0
        ? Number((summedStepDurationMs / wallDurationMs).toFixed(2))
        : null,
    waves,
    results: orderedResults,
  };
}
