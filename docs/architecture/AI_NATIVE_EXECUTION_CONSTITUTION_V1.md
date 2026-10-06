# OWL Runtime AI-Native Execution Constitution v1

Status: **Normative for Runtime 1.x evolution**
Date: 2026-10-06

## Purpose

OWL Runtime is the trusted execution kernel beneath OWL LAB.

It is not a second general-purpose planner, not a product UI, and not an
application-specific automation catalog.

The Runtime converts semantic capability requests into governed, observable,
recoverable execution.

## 1. Highest Semantic Level Wins

Execution should use the highest semantic interface that can satisfy the
requested capability safely and truthfully.

Preferred order:

1. native API / protocol;
2. typed OWL capability / Primitive ABI;
3. typed Skill composition;
4. structured CLI / system interface;
5. semantic browser adapter;
6. Playwright / DOM automation;
7. Computer Use / vision / mouse-keyboard fallback.

Playwright and Computer Use are compatibility Providers. They are not the
planner architecture.

A Planner should express intent and capability requirements, not selectors,
screen coordinates, GPU model names, or provider-specific implementation
steps unless the task explicitly requires them.

## 2. Planner and execution are separate

Planner / product / MCP clients decide what should be achieved.

Runtime decides whether and how an approved capability may execute.

Runtime may expose:

- governed capability facts;
- policy decisions;
- resource availability;
- execution receipts;
- observations;
- verification;
- health;
- deterministic remediation signals.

Runtime must not grow a second opaque LLM planner.

## 3. Stable semantics above replaceable Providers

Public Runtime and Primitive semantics should outlive:

- browser engines;
- OS APIs;
- helpers;
- cloud vendors;
- GPU/TPU/NPU runtimes;
- transport implementations.

Provider quirks remain below semantic contracts unless they are genuine
capability facts.

Do not expand the Primitive ABI merely because a Provider has another method.

## 4. Capability visibility is part of governance

Capability discovery is not a flat tool directory.

A governed capability view may be shaped by:

- availability;
- Runtime policy;
- authorization;
- ExecutionTarget;
- resource inventory;
- Provider health;
- task/workspace state;
- ownership;
- consumer contract.

Visible capability does not imply permission.
Hidden capability is not authorization.

## 5. Physical truth outranks model belief

Facts that can be grounded in the execution environment must not rely only on
prompt state or model memory.

Ground relevant facts close to execution:

- workspace/path scope;
- ownership and leases;
- target availability;
- Provider readiness;
- browser/UI identity when needed;
- time/timezone when material;
- resource pressure;
- approval state.

Bind late to physical truth.

## 6. Observe → Act → Verify is the execution law

A side effect is not complete merely because a Provider returned without
throwing.

Execution is:

    precondition / grounding
            ↓
           ACT
            ↓
       Observation
            ↓
        Verification
            ↓
    verified | failed | uncertain

Machine-verifiable postconditions should be checked automatically.

`uncertain` is first-class.
An uncertain non-idempotent side effect must never authorize automatic replay.

## 7. Durable identity outranks transport identity

MCP, HTTP, WebSocket, Tunnel, and UI transports are transient.

Durable work is owned by durable Runtime identity such as:

- Task;
- Process;
- Schedule;
- Loop;
- Workspace lease;
- logical workstream/session;
- mutation/request identity.

Reconnect must not silently create a new execution owner.
Transport loss does not imply cancellation.

## 8. Resource Admission and Placement are Runtime responsibilities

Concurrency is not equivalent to CPU core count.

Execution targets may expose heterogeneous resources:

- CPU;
- system memory;
- GPU;
- TPU;
- NPU;
- IPU;
- LPU;
- ASIC;
- accelerator memory;
- browser/process slots;
- disk/network IO;
- Provider-defined resources.

A target may be valid even when it does not advertise general-purpose CPU
capacity, provided the requested ResourceDemand is satisfied.

Runtime owns:

- **Admission** — may this work start now?
- **Placement** — which target can satisfy the demand?
- **Scheduling** — when should queued work run?
- **Provider selection** — which implementation performs the capability?

The LLM must not act as the resource scheduler.

See `AI_NATIVE_RESOURCE_ADMISSION_PLACEMENT_V1.md`.

## 9. Control plane has priority over workload

When pressure rises, Runtime must preserve the ability to:

- report health;
- inspect status;
- read process/task output;
- cancel work;
- reconcile state;
- recover ownership.

Heavy work should be queued or rejected before the control plane becomes
unresponsive.

Protective and drain-only modes are valid product states, not failures.

## 10. Resources are leased, not assumed

Concurrent agents share finite resources.

Runtime makes contention explicit through:

- resource declarations;
- workspace leases;
- process ownership;
- bounded admission;
- queues;
- release;
- recovery.

Priority/preemption, if added later, must be explicit and auditable.

## 11. Task, Stage, Memory, Trace, and Resource are distinct

- **Task** — durable execution lifecycle.
- **Stage** — task-scoped working set and intermediate assets.
- **Memory** — reusable evidence/knowledge beyond one task.
- **Trace** — audit evidence of attempts, observations, approvals and recovery.
- **Resource** — finite execution capacity required by work.

Do not use Memory as an asset store.
Do not treat Stage as global.
Do not infer resource availability from model belief.

## 12. Human approval is authority transfer

Human approval is not a chat convention.

Approval must be:

- subject/argument scoped;
- time bounded where appropriate;
- auditable;
- one-time consumable where required.

Product UI owns approval UX.
Runtime owns enforcement.

## 13. No silent execution fallback

Changing Provider or ExecutionTarget can change:

- data exposure;
- security boundary;
- cost;
- locality;
- performance;
- verification quality.

Fallback must be policy-governed and observable.

A future resolver may select another Provider or target, but must emit the
reason and never silently weaken security or verification.

## 14. Long-running work is a state machine

Opaque infinite loops are not durable orchestration.

Long-running work must expose persistent states such as:

- running;
- queued/waiting;
- approval/input required;
- paused/suspended;
- resumed;
- completed;
- failed;
- cancelled;
- blocked/needs-replan.

Schedulers and external events wake durable state; they do not replace it.

## 15. Evolution comes from evidence

Repeated real-world failure should become:

- a protocol;
- a contract;
- a verifier;
- a state transition;
- a resource rule;
- a policy.

It should not become another prompt instruction when Runtime can enforce it.

    real failure
      → evidence
      → invariant
      → smallest contract
      → conformance
      → dogfood
      → promotion

One successful trajectory is not a Skill.
One failure is not a reason to rewrite the kernel.

## 16. Self-repair stays outside the trusted kernel

Runtime may expose diagnostics, isolated test targets, rollback and conformance
hooks.

Runtime must not silently rewrite its own production kernel.

Repair belongs to a governed external maintenance agent with:

- evidence thresholds;
- dirty-worktree protection;
- isolation;
- targeted validation;
- rollback;
- circuit breaking.

## 17. Lifecycle closure is mandatory

Anything acquired or started needs a closure path:

- Process;
- browser/session;
- lease;
- approval;
- Task;
- staged artifact;
- resource permit.

Hidden immortal resources are architecture defects.

## 18. Freeze conditions

A Runtime subsystem is frozen only when:

1. ownership, policy, verification, audit and recovery metadata reaches
   execution;
2. the subsystem enforces its own invariants;
3. docs, public types, implementation and conformance tests agree;
4. cancellation, timeout, restart, reconnect and partial-side-effect behavior
   are defined;
5. degraded behavior is explicit and observable.

## 19. Repository boundary

    OWL Desktop / MCP / Cloud / Worker
                 ↓
            RuntimeClient
                 ↓
             OWL Runtime
                 ↓
       Capability / Primitive
                 ↓
              Provider
                 ↓
          ExecutionTarget

Runtime owns execution truth.

Desktop owns local product UX and integration.
Cloud owns account/control-plane state and remote ingress.
Worker owns business orchestration.
Consumers must not reimplement Runtime execution subsystems.

## 20. Adoption rule

A new mechanism belongs in Runtime only when it:

1. strengthens a stable execution invariant;
2. removes duplicated execution logic from multiple consumers;
3. converts repeated real failure into a generic contract;
4. improves recovery/security/verification/resource governance without planner
   coupling;
5. preserves Provider and target independence.

Otherwise it belongs in a consumer, Skill, Provider, adapter, or research
backlog.
