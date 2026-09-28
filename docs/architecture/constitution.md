# OWL Runtime Architecture Constitution

Status: **Normative for post-1.0 evolution**.

This document distills the strongest OS and Evolution lessons from Owl Lab into OWL Runtime's own boundary. It does not expand the frozen `1.0.0-rc.1` feature surface.

OWL Runtime is not a planner, not a product UI, and not an app-automation catalog. It is the reliable execution kernel beneath `computer-mcp`, `owl-worker`, and future consumers.

## 1. Document law

When sources disagree, use this order:

1. Architecture Constitution — long-lived redlines.
2. Normative Runtime specifications — API, ABI, ownership, Observation, Verifier, policy, state schema.
3. Executable contracts and conformance tests — current physical behavior.
4. Architecture notes and roadmaps.
5. Historical narratives and experiments.

Code must not silently invalidate a normative contract. A mismatch is a defect or a deliberate versioned contract change.

## 2. Runtime is an execution kernel, not a second brain

Planning and reliable execution are separate concerns.

```text
Planner / Product / MCP client
          ↓
   governed capability view
          ↓
      RuntimeClient          ↓
      OWL Runtime
          ↓
Primitive → Action → Provider
```

Runtime may expose capability facts, policy decisions, observations, receipts, health and deterministic remediation signals. It must not grow a second general-purpose LLM planner.

## 3. Capability visibility is governance

What a planner can see is part of the cognition and security boundary. A capability manifest is not just a directory listing.

A future governed manifest should be shaped by current availability, policy, ExecutionTarget, provider health, task/phase context, ownership and consumer contract.

**Rule:** discovery and authorization are related but distinct. Hidden capability is not authorization; visible capability is not permission.

## 4. Physical truth outranks model belief

Runtime facts that can be grounded in the environment must not rely only on prompts or planner memory.

Refresh relevant physical facts as close as practical to execution: time/timezone when material, workspace/path scope, active UI/browser identity, provider health/permissions, network readiness, ownership and lease state.

> Bind late to physical truth; never ask a prompt to compensate for stale execution state.

## 5. Observe → Act → Verify is the execution law

A side effect is not complete merely because the provider returned without throwing.

```text
ground / precondition
        ↓
       ACT
        ↓
   Observation
        ↓
     Verifier
verified | failed | uncertain
```
Machine-verifiable postconditions should be verified automatically. Semantic outcomes require explicit verification. `uncertain` is first-class, and uncertain non-idempotent side effects must never authorize automatic replay.

Successful input delivery is not proof of business success.

## 6. Stable semantics above replaceable providers

Public Runtime and Primitive semantics should outlive OS APIs, browser engines, helpers and cloud vendors.

- L1/public semantics are minimal and durable.
- L0.5 Action maps semantics to physical operations.
- L0 Provider/Driver is replaceable.
- Provider quirks must not leak upward unless they are genuine capability facts.

Do not expand the Primitive ABI merely because a provider has another method.

## 7. Durable identity outranks transport identity

HTTP, MCP, WebSocket and UI connections are transient. Durable work is owned by Task, Process, Schedule, transaction/mutation context, or logical Runtime session.

Reconnects must not silently change ownership. Transport loss does not imply task cancellation, and request cancellation is not proof that an external side effect was rolled back.

## 8. Resources are leased, not assumed

Concurrent agents share finite physical resources. Runtime makes ownership explicit through resource declarations, workspace leases, process ownership, serialization where physical state is global, bounded wait, release and recovery.

Future priority/preemption must be a separate auditable policy, not hidden provider behavior.

## 9. Task, Stage, Memory and Trace are different

- **Task:** durable execution lifecycle and recovery.
- **Stage:** task-scoped physical working set and intermediate assets.
- **Memory:** reusable experience/knowledge beyond the task.
- **Trace:** audit evidence of attempts, observations, verification, approvals and recovery.

Memory is not the asset store. Stage is not global. Side-effect workflows should consume explicit staged artifacts instead of guessing paths. Long-term memory promotion requires evidence and provenance.
## 10. Handoff and remediation are contracts

Planner → Runtime and Runtime → consumer handoff should use compact structured receipts rather than free-form narrative.

Failures should progressively normalize into stable classes such as `fatal`, `auth_required`, `retriable`, `ambiguous`, `approval_required`, `conflict`, `uncertain_side_effect`, and `needs_replan`.

Runtime may recommend the next safe execution move, but must not invent business intent.

## 11. HITL is authority transfer

Human approval is not a chat convention.

```text
PROPOSE → REVIEW → RELEASE / DENY / EXPIRE
```

Approval receipts should be argument-scoped, time-bounded, auditable and one-time consumable where appropriate. Worker owns approval UX; Runtime owns enforcement.

## 12. No silent execution fallback

Execution location/provider changes can alter security and data exposure. `host`, `sandbox`, and `remote` are explicit ExecutionTargets. Unavailable targets fail closed.

Future provider fallback/ranking requires explicit policy and a durable fallback-reason receipt.

## 13. Long-running work is a state machine

Opaque infinite loops are not durable orchestration. Long-running work must expose persistent states for running, waiting, approval/input, pause/suspend, resume, completion, failure, cancellation and block/replan.

Schedulers and external signals wake durable state; they do not replace it.

## 14. Evolution comes from evidence

Repeated real-world failure should become a protocol, contract, verifier, state transition or policy — not another prompt instruction.

```text
real failure → evidence → invariant → smallest contract → conformance → dogfood → promotion
```

One successful trajectory is not a Skill. One failure is not a reason to rewrite the kernel.
## 15. Self-repair stays outside the trusted kernel

Runtime may expose diagnostics, candidate install/upgrade, rollback, isolated targets and conformance hooks. It must not silently rewrite its own production kernel.

A future repair system belongs above Runtime and requires evidence thresholds, dirty-worktree protection, isolation, targeted validation, human review for kernel/driver changes, atomic promotion, rollback and circuit breaking.

## 16. Lifecycle closure

Anything acquired or started needs an explicit closure path: process, browser/session, lease, approval, task and staged artifact.

Hidden immortal resources are architecture defects.

## 17. Freeze conditions

A Runtime subsystem may be called frozen only when:

1. metadata for ownership, policy, verification, audit and recovery reaches execution;
2. the subsystem enforces its own invariants rather than trusting callers;
3. normative docs, public types, implementation and conformance tests agree;
4. cancellation, timeout, restart, reconnect and partial-side-effect behavior are defined;
5. degraded behavior is explicit and observable.

## 18. Repository consequence

```text
computer-mcp ─┐
              ├── RuntimeClient → OWL Runtime
owl-worker  ──┘
```

OWL Runtime owns execution truth. Computer MCP owns MCP compatibility. OWL Worker owns product state, UX and business orchestration. Consumers may request contracts; they must not reimplement Runtime subsystems.
