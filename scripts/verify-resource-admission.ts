import assert from "node:assert/strict";
import {
  classifyShellResourceDemand,
  deriveShellAdmissionBudget,
  evaluateResourcePlacement,
  type ResourceDemand,
  type ResourceInventory,
} from "../src/runtime/resourceAdmission.js";

const gpuOnly: ResourceInventory = {
  version: 1,
  targetId: "gpu-worker-01",
  observedAt: new Date().toISOString(),
  resources: [
    {
      id: "gpu-0",
      class: "accelerator",
      kind: "gpu",
      unit: "count",
      capacity: 1,
      available: 1,
      capabilities: ["tensor", "bf16", "fp16"],
    },
    {
      id: "gpu-0:memory",
      class: "accelerator-memory",
      kind: "gpu",
      unit: "bytes",
      capacity: 80 * 1024 ** 3,
      available: 72 * 1024 ** 3,
      capabilities: ["tensor", "bf16", "fp16"],
    },
  ],
  pressure: {
    mode: "normal",
    cpuLoadPerParallelism: null,
    memoryFreeRatio: null,
    eventLoopUtilization: null,
    reasons: [],
  },
};

const gpuDemand: ResourceDemand = {
  class: "heavy",
  processSlots: 0,
  computeCredits: 0,
  requirements: [
    {
      class: "accelerator",
      kind: "gpu",
      units: 1,
      capabilities: ["tensor", "bf16"],
    },
    {
      class: "accelerator-memory",
      kind: "gpu",
      units: 24 * 1024 ** 3,
      capabilities: ["bf16"],
    },
  ],
};

assert.equal(evaluateResourcePlacement(gpuDemand, gpuOnly).runnable, true);

const tpuDemand: ResourceDemand = {
  ...gpuDemand,
  requirements: [
    {
      class: "accelerator",
      kind: "tpu",
      units: 1,
      capabilities: ["tensor", "bf16"],
    },
  ],
};
assert.equal(evaluateResourcePlacement(tpuDemand, gpuOnly).runnable, false);

const eightCpuNormal: ResourceInventory = {
  version: 1,
  targetId: "host-8cpu",
  observedAt: new Date().toISOString(),
  resources: [
    {
      id: "cpu",
      class: "compute",
      kind: "cpu",
      unit: "count",
      capacity: 8,
      available: 8,
      capabilities: ["general-purpose"],
    },
  ],
  pressure: {
    mode: "normal",
    cpuLoadPerParallelism: 0.4,
    memoryFreeRatio: 0.5,
    eventLoopUtilization: 0.2,
    reasons: [],
  },
};
assert.deepEqual(deriveShellAdmissionBudget(eightCpuNormal), {
  mode: "normal",
  globalSlots: 4,
  perWorkspaceSlots: 2,
  globalComputeCredits: 8,
  perWorkspaceComputeCredits: 4,
});

const protective = structuredClone(eightCpuNormal);
protective.pressure.mode = "protective";
assert.deepEqual(deriveShellAdmissionBudget(protective), {
  mode: "protective",
  globalSlots: 2,
  perWorkspaceSlots: 1,
  globalComputeCredits: 4,
  perWorkspaceComputeCredits: 2,
});

assert.equal(classifyShellResourceDemand("git status").class, "light");
assert.equal(
  classifyShellResourceDemand("npm test && npm run build").class,
  "heavy",
);
assert.equal(
  classifyShellResourceDemand("node scripts/check-something.mjs").class,
  "medium",
);

console.log(
  JSON.stringify(
    {
      ok: true,
      gpuOnlyPlacement: "PASS",
      tpuMismatch: "PASS",
      dynamicEightCpuBudget: "PASS",
      pressureDownshift: "PASS",
      shellClassification: "PASS",
    },
    null,
    2,
  ),
);
