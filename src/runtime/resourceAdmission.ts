import os from "node:os";
import { performance } from "node:perf_hooks";

export type AdmissionMode =
  | "normal"
  | "constrained"
  | "protective"
  | "drain-only";

export type ResourceClass =
  | "compute"
  | "memory"
  | "accelerator"
  | "accelerator-memory"
  | "process-slot"
  | "browser-slot"
  | "disk-io"
  | "network-io"
  | "custom";

export type AcceleratorKind =
  | "gpu"
  | "tpu"
  | "npu"
  | "ipu"
  | "lpu"
  | "asic"
  | "other";

export type ResourceDescriptor = {
  id: string;
  class: ResourceClass;
  kind?: string;
  unit: "count" | "bytes" | "credits" | "ratio";
  capacity: number;
  available: number;
  capabilities: string[];
  metadata?: Record<string, string | number | boolean | null>;
};

export type ResourceInventory = {
  version: 1;
  targetId: string;
  observedAt: string;
  resources: ResourceDescriptor[];
  pressure: {
    mode: AdmissionMode;
    cpuLoadPerParallelism: number | null;
    memoryFreeRatio: number | null;
    eventLoopUtilization: number | null;
    reasons: string[];
  };
};

export type ResourceRequirement = {
  class: ResourceClass;
  kind?: string;
  units: number;
  capabilities?: string[];
};

export type ResourceDemand = {
  class: "light" | "medium" | "heavy";
  processSlots: number;
  computeCredits: number;
  requirements: ResourceRequirement[];
};

export type ResourcePlacementDecision = {
  runnable: boolean;
  targetId: string;
  missing: ResourceRequirement[];
};

export type ShellAdmissionBudget = {
  mode: AdmissionMode;
  globalSlots: number;
  perWorkspaceSlots: number;
  globalComputeCredits: number;
  perWorkspaceComputeCredits: number;
};

type EventLoopUtilization = ReturnType<typeof performance.eventLoopUtilization>;

let previousElu: EventLoopUtilization | undefined;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

function acceleratorResourcesFromEnv(): ResourceDescriptor[] {
  const raw = process.env.OWL_ACCELERATOR_INVENTORY_JSON?.trim();
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    return parsed.flatMap((entry, index): ResourceDescriptor[] => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
      const object = entry as Record<string, unknown>;
      const capacity = Number(object.capacity ?? 1);
      const available = Number(object.available ?? capacity);
      const kind =
        typeof object.kind === "string" && object.kind.trim()
          ? object.kind.trim().toLowerCase()
          : "other";
      const capabilities = Array.isArray(object.capabilities)
        ? object.capabilities
            .filter((item): item is string => typeof item === "string")
            .map((item) => item.trim().toLowerCase())
            .filter(Boolean)
        : [];

      if (!Number.isFinite(capacity) || capacity <= 0) return [];
      if (!Number.isFinite(available) || available < 0) return [];

      const resources: ResourceDescriptor[] = [
        {
          id:
            typeof object.id === "string" && object.id.trim()
              ? object.id.trim()
              : `accelerator-${index + 1}`,
          class: "accelerator",
          kind,
          unit: "count",
          capacity,
          available: Math.min(available, capacity),
          capabilities,
        },
      ];

      const memoryBytes = Number(object.memoryBytes);
      const availableMemoryBytes = Number(
        object.availableMemoryBytes ?? memoryBytes,
      );
      if (Number.isFinite(memoryBytes) && memoryBytes > 0) {
        resources.push({
          id: `${resources[0]!.id}:memory`,
          class: "accelerator-memory",
          kind,
          unit: "bytes",
          capacity: memoryBytes,
          available:
            Number.isFinite(availableMemoryBytes) && availableMemoryBytes >= 0
              ? Math.min(availableMemoryBytes, memoryBytes)
              : memoryBytes,
          capabilities,
        });
      }

      return resources;
    });
  } catch {
    return [];
  }
}

function derivePressure(input: {
  cpuLoadPerParallelism: number | null;
  memoryFreeRatio: number | null;
  eventLoopUtilization: number | null;
}): { mode: AdmissionMode; reasons: string[] } {
  const reasons: string[] = [];
  let mode: AdmissionMode = "normal";

  const raise = (next: AdmissionMode, reason: string) => {
    const order: AdmissionMode[] = [
      "normal",
      "constrained",
      "protective",
      "drain-only",
    ];
    if (order.indexOf(next) > order.indexOf(mode)) mode = next;
    reasons.push(reason);
  };

  if (input.cpuLoadPerParallelism !== null) {
    if (input.cpuLoadPerParallelism >= 3) {
      raise("drain-only", "host load is critically above available CPU parallelism");
    } else if (input.cpuLoadPerParallelism >= 1.75) {
      raise("protective", "host load is high");
    } else if (input.cpuLoadPerParallelism >= 1) {
      raise("constrained", "host load is elevated");
    }
  }

  if (input.memoryFreeRatio !== null) {
    if (input.memoryFreeRatio <= 0.03) {
      raise("drain-only", "system memory is critically low");
    } else if (input.memoryFreeRatio <= 0.08) {
      raise("protective", "system memory pressure is high");
    } else if (input.memoryFreeRatio <= 0.15) {
      raise("constrained", "system memory headroom is low");
    }
  }

  if (input.eventLoopUtilization !== null) {
    if (input.eventLoopUtilization >= 0.99) {
      raise("drain-only", "Runtime event loop is saturated");
    } else if (input.eventLoopUtilization >= 0.95) {
      raise("protective", "Runtime event loop is heavily utilized");
    } else if (input.eventLoopUtilization >= 0.85) {
      raise("constrained", "Runtime event loop utilization is elevated");
    }
  }

  return { mode, reasons };
}

export function detectHostResourceInventory(
  targetId = "host",
): ResourceInventory {
  const detectedParallelism =
    typeof os.availableParallelism === "function"
      ? os.availableParallelism()
      : Math.max(os.cpus().length, 1);
  const testParallelism =
    process.env.OWL_RUNTIME_MODE === "test"
      ? Number(process.env.OWL_RESOURCE_TEST_PARALLELISM)
      : Number.NaN;
  const availableParallelism =
    Number.isFinite(testParallelism) && testParallelism > 0
      ? Math.trunc(testParallelism)
      : detectedParallelism;
  const totalMemory = os.totalmem();
  const freeMemory = os.freemem();
  const cpuLoadPerParallelism =
    availableParallelism > 0
      ? Math.max(os.loadavg()[0] ?? 0, 0) / availableParallelism
      : null;
  const memoryFreeRatio =
    totalMemory > 0 ? clamp(freeMemory / totalMemory, 0, 1) : null;

  const currentElu = performance.eventLoopUtilization();
  const deltaElu = previousElu
    ? performance.eventLoopUtilization(currentElu, previousElu)
    : null;
  previousElu = currentElu;
  const eventLoopUtilization =
    deltaElu && Number.isFinite(deltaElu.utilization)
      ? clamp(deltaElu.utilization, 0, 1)
      : null;

  const pressure = derivePressure({
    cpuLoadPerParallelism,
    memoryFreeRatio,
    eventLoopUtilization,
  });
  const pressureOverride =
    process.env.OWL_RUNTIME_MODE === "test"
      ? process.env.OWL_RESOURCE_TEST_PRESSURE_MODE?.trim()
      : undefined;
  if (
    pressureOverride === "normal" ||
    pressureOverride === "constrained" ||
    pressureOverride === "protective" ||
    pressureOverride === "drain-only"
  ) {
    pressure.mode = pressureOverride;
    pressure.reasons = [`test override: ${pressureOverride}`];
  }

  return {
    version: 1,
    targetId,
    observedAt: new Date().toISOString(),
    resources: [
      {
        id: "host:cpu",
        class: "compute",
        kind: "cpu",
        unit: "count",
        capacity: availableParallelism,
        available: availableParallelism,
        capabilities: ["general-purpose"],
      },
      {
        id: "host:memory",
        class: "memory",
        kind: "system",
        unit: "bytes",
        capacity: totalMemory,
        available: freeMemory,
        capabilities: ["system-memory"],
      },
      ...acceleratorResourcesFromEnv(),
    ],
    pressure: {
      ...pressure,
      cpuLoadPerParallelism,
      memoryFreeRatio,
      eventLoopUtilization,
    },
  };
}

function matchesRequirement(
  resource: ResourceDescriptor,
  requirement: ResourceRequirement,
): boolean {
  if (resource.class !== requirement.class) return false;
  if (
    requirement.kind &&
    resource.kind?.toLowerCase() !== requirement.kind.toLowerCase()
  ) {
    return false;
  }
  const capabilities = new Set(resource.capabilities.map((item) => item.toLowerCase()));
  if (
    requirement.capabilities?.some(
      (capability) => !capabilities.has(capability.toLowerCase()),
    )
  ) {
    return false;
  }
  return resource.available >= requirement.units;
}

export function evaluateResourcePlacement(
  demand: ResourceDemand,
  inventory: ResourceInventory,
): ResourcePlacementDecision {
  const missing = demand.requirements.filter(
    (requirement) =>
      !inventory.resources.some((resource) =>
        matchesRequirement(resource, requirement),
      ),
  );
  return {
    runnable: missing.length === 0,
    targetId: inventory.targetId,
    missing,
  };
}

function baseShellSlots(availableParallelism: number): number {
  if (availableParallelism <= 2) return 1;
  if (availableParallelism <= 4) return 2;
  if (availableParallelism <= 8) return 4;
  if (availableParallelism <= 12) return 6;
  if (availableParallelism <= 16) return 8;
  return clamp(Math.floor(availableParallelism * 0.6), 8, 16);
}

export function deriveShellAdmissionBudget(
  inventory: ResourceInventory,
  hardCeilings: {
    globalSlots?: number;
    perWorkspaceSlots?: number;
  } = {},
): ShellAdmissionBudget {
  const cpu = inventory.resources.find(
    (resource) => resource.class === "compute" && resource.kind === "cpu",
  );
  const parallelism = cpu ? Math.max(Math.trunc(cpu.available), 1) : 1;
  const baseGlobal = baseShellSlots(parallelism);

  const modeMultiplier: Record<AdmissionMode, number> = {
    normal: 1,
    constrained: 0.75,
    protective: 0.5,
    "drain-only": 0.25,
  };
  const multiplier = modeMultiplier[inventory.pressure.mode];

  const globalSlots = Math.max(
    1,
    Math.min(
      hardCeilings.globalSlots ?? 32,
      Math.floor(baseGlobal * multiplier),
    ),
  );
  const baseWorkspace = Math.max(1, Math.ceil(baseGlobal / 2));
  const perWorkspaceSlots = Math.max(
    1,
    Math.min(
      hardCeilings.perWorkspaceSlots ?? 16,
      globalSlots,
      Math.floor(baseWorkspace * multiplier) || 1,
    ),
  );

  // NORMAL and CONSTRAINED must still admit one heavy workload.
  // PROTECTIVE/DRAIN_ONLY intentionally block new heavy work by keeping the
  // available compute-credit budget below the heavy demand (4 credits).
  const heavySingleTaskFloor =
    inventory.pressure.mode === "normal" ||
    inventory.pressure.mode === "constrained"
      ? 4
      : 0;
  const globalComputeCredits = Math.max(
    globalSlots * 2,
    heavySingleTaskFloor,
  );
  const perWorkspaceComputeCredits = Math.max(
    perWorkspaceSlots * 2,
    heavySingleTaskFloor,
  );

  return {
    mode: inventory.pressure.mode,
    globalSlots,
    perWorkspaceSlots,
    globalComputeCredits,
    perWorkspaceComputeCredits,
  };
}

const HEAVY_SHELL_PATTERN =
  /(?:^|[;&|]\s*)(?:npm\s+(?:test|run\s+(?:build|typecheck|test))|pnpm\s+(?:test|build)|yarn\s+(?:test|build)|npx\s+(?:vitest|tsc|eslint)|vitest\b|tsc\b|eslint\b|vite\s+build\b|next\s+build\b|webpack\b|rollup\b|cargo\s+(?:build|test)\b|pytest\b|go\s+test\b|gradle\b|mvn\b|ffmpeg\b)/i;

const LIGHT_SHELL_PATTERN =
  /^\s*(?:pwd|whoami|git\s+(?:status|rev-parse|branch)(?:\s|$)|ls(?:\s|$)|cat\s+[^;&|]+|sed\s+-n\s+[^;&|]+|printf\s+[^;&|]+|echo\s+[^;&|]+|sleep\s+[0-9.]+)\s*$/i;

export function classifyShellResourceDemand(command: string): ResourceDemand {
  const normalized = command.trim();
  const workloadClass = HEAVY_SHELL_PATTERN.test(normalized)
    ? "heavy"
    : LIGHT_SHELL_PATTERN.test(normalized)
      ? "light"
      : "medium";
  const computeCredits =
    workloadClass === "heavy" ? 4 : workloadClass === "medium" ? 2 : 1;

  return {
    class: workloadClass,
    processSlots: 1,
    computeCredits,
    requirements: [
      {
        class: "compute",
        kind: "cpu",
        units: 1,
        capabilities: ["general-purpose"],
      },
    ],
  };
}
