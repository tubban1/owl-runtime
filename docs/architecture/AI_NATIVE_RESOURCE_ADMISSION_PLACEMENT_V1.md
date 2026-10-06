# OWL LAB AI-Native Resource Admission & Placement V1

Status: Runtime 1.x internal architecture foundation
Date: 2026-10-06

## Purpose

OWL LAB must not equate concurrency with CPU core count.

Execution targets may be:
- general-purpose CPU hosts;
- GPU-dominant workers;
- TPU / NPU / IPU / LPU / ASIC accelerators;
- hybrid machines;
- remote targets whose control plane is separate from the execution plane.

The Runtime therefore models **resource capability**, **admission**, and
**placement** independently.

## Core rule

Planner expresses semantic work.

Runtime decides:
1. whether the work is runnable now (**Admission**);
2. where it should run (**Placement**);
3. when it should run (**Scheduling**);
4. which implementation performs it (**Provider**).

Planner must not infer machine capacity from CPU count, GPU model names, or
screen/UI state.

## Terminology

### ResourceInventory

A target advertises resources as typed descriptors:

- class: compute / memory / accelerator / accelerator-memory / IO / custom;
- kind: cpu / gpu / tpu / npu / ipu / lpu / asic / provider-defined;
- capacity and currently available quantity;
- unit;
- semantic capabilities, for example tensor, bf16, fp16, xla.

A valid execution target may advertise no CPU resource at all. An accelerator
task can still be placed there when its ResourceDemand is satisfied.

### ResourceDemand

A capability/provider declares what it needs.

Examples:

- repository status:
  general-purpose CPU + one lightweight process slot;
- video upscale:
  accelerator with tensor capability + accelerator memory;
- TPU inference:
  TPU/XLA capability;
- browser automation:
  browser slot + system memory + limited compute;
- local build:
  general-purpose compute + process slot + workspace budget.

ResourceDemand is semantic. It should not encode a specific device model unless
the capability genuinely requires one.

### Admission

Admission answers:

> May this work start now on this target?

It considers:
- current resource availability;
- control-plane health;
- host/accelerator pressure;
- active leases;
- workspace contention;
- hard safety ceilings.

Admission can return:
- normal;
- constrained;
- protective;
- drain-only.

### Placement

Placement answers:

> Which target can satisfy this demand?

Placement is separate from Provider selection.

Example:

    capability: image.generate
    provider: cuda-image-provider
    placement: gpu-worker-07

or:

    capability: browser.navigate
    provider: chromium
    placement: local-mac

### Scheduling

Scheduling decides when queued work is retried or launched. A task can be
runnable in principle but temporarily rejected by Admission.

### Provider

Provider implements the operation. Playwright / Computer Use / CUDA / XLA are
provider details beneath the capability layer.

## Highest Semantic Level Wins

Execution preference remains:

1. Native API / protocol
2. Typed OWL capability / Primitive ABI
3. Typed Skill composition
4. Structured CLI / system interface
5. Semantic browser adapter
6. Playwright / DOM automation
7. Computer Use / vision / mouse-keyboard fallback

Resource placement is orthogonal to this hierarchy.

## Current implementation

Runtime 1.0 public ABI remains unchanged.

Runtime 1.x internal foundation now contains:
- generic ResourceInventory;
- generic ResourceDemand;
- accelerator descriptors;
- placement matching;
- pressure-aware host admission;
- dynamic shell budgets;
- per-workspace and global hard ceilings;
- workload classes and compute credits.

The existing shell concurrency gate is the first consumer.

For an 8-parallelism host under normal pressure, the default shell envelope is:

    global slots: 4
    per-workspace slots: 2
    global compute credits: 8
    per-workspace compute credits: 4

This is not a permanent CPU formula. It is a host-provider policy.

As pressure rises, the Runtime downshifts:
- normal -> full dynamic budget;
- constrained -> ~75%;
- protective -> ~50%;
- drain-only -> ~25%, preserving control/recovery paths.

Hard environment ceilings remain available as safety caps:
- OWL_SHELL_MAX_CONCURRENCY
- OWL_SHELL_MAX_CONCURRENCY_PER_WORKSPACE

## Shell workload weights

Shell commands are classified conservatively:

- light: status/probe/read-like commands;
- medium: unknown/general commands;
- heavy: builds, typecheck, lint/test suites, video rendering, compilers.

Admission checks both process slots and compute credits.

This prevents two failure modes:
1. unlimited read-mode processes in one workspace;
2. treating a build/test like a cheap status query.

## Control plane priority

OWL must remain controllable when execution pressure is high.

Health/status/cancellation/output/recovery operations must be favored over new
heavy workload admission.

Longer term the Resource Admission Controller should expose a reserved
control-plane budget so that PROTECTIVE/DRAIN_ONLY mode still supports:

- health;
- task status;
- process output;
- cancellation;
- reconciliation;
- recovery.

## Accelerator inventory

Local or remote providers can advertise accelerators without changing the
planner contract.

Current internal configuration accepts accelerator inventory through:

    OWL_ACCELERATOR_INVENTORY_JSON

This is a bootstrap mechanism, not the final cloud/device protocol.

Future Device Enrollment / Worker telemetry should publish the same semantic
inventory shape.

Example:

    [
      {
        "id": "gpu-0",
        "kind": "gpu",
        "capacity": 1,
        "available": 1,
        "memoryBytes": 85899345920,
        "availableMemoryBytes": 77309411328,
        "capabilities": ["tensor", "bf16", "fp16"]
      }
    ]

A TPU-only remote execution target is valid as long as its advertised resources
satisfy the requested capability.

## Cloud / Worker direction

Cloud should eventually maintain:

    Device / Worker
      -> ResourceInventory
      -> CapabilityInventory
      -> pressure / availability

Then placement can choose:

    local host
    remote device
    cloud worker
    accelerator pool

without changing the user-level capability request.

Worker definitions should remain declarative:

    goal
    required capabilities
    resource requirements
    trigger
    approval policy
    verification policy

They should not encode raw Playwright or device-specific execution steps.

## Monitor direction

Desktop Monitor should eventually show:

    Execution Capacity
    Admission Mode
    Resource Inventory
    Active / Queued demand
    Per-workspace saturation
    Selected target
    Selected provider
    Fallback reason

Example:

    Mode: PROTECTIVE
    Workspace bloomroom: saturated
    New heavy build: queued
    Local GPU: insufficient memory
    Remote GPU worker: available

This makes backpressure observable instead of appearing as a hang.

## Non-goals for this foundation

Not yet implemented:
- automatic GPU/TPU discovery across every vendor;
- cross-device scheduling;
- remote accelerator dispatch;
- billing-aware placement;
- thermal/power scheduling;
- provider quality/cost ranking;
- public ABI exposure.

Those are additive Runtime 1.x / Cloud Worker work.

## Invariant

**Resource scheduling belongs to Runtime, not the LLM.**

The model asks for capability execution. The Runtime owns placement, admission,
backpressure, recovery, and evidence.
