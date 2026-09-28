# Owl Lab → OWL Runtime Philosophy Alignment

Status: **Architecture audit / post-1.0 adoption map**.

This audit answers which Owl Lab OS/Evolution ideas are already embodied in OWL Runtime, which are partial, and which should remain outside the Runtime boundary.

The goal is not code reuse. The goal is to preserve proven design laws while keeping OWL Runtime smaller, more deterministic and more product-neutral than Owl Lab.

## Executive assessment

OWL Runtime already absorbed much of Owl Lab's execution-kernel DNA:

- L3/L2/L1/L0.5/L0 separation;
- stable semantic Primitive layer;
- Resource Arbiter and leases;
- durable Task/Scheduler/Loop;
- staging and layered memory;
- Observation → Verification;
- approval enforcement;
- durable ownership independent of transport;
- crash recovery and production lifecycle;
- explicit ExecutionTarget with no silent fallback.

The major gaps are governance/evolution contracts rather than raw execution features.

## Alignment matrix

| Owl Lab principle | OWL Runtime today | Alignment | Decision |
| --- | --- | --- | --- |
| L3 Planner → L2 Skill → L1 ISA → L0.5 Action → L0 Driver | Same layer model; Planner intentionally external | Strong | Keep Planner outside Runtime |
| Stable semantic ISA above replaceable drivers | Primitive ABI + Action Router + Provider registry | Strong | Preserve; resist Primitive proliferation |
| Policy before physical execution | path guards, capability flags, approval, ExecutionTarget checks | Strong | Keep moving invariants downward |
| Resource Arbiter / leases | Resource Arbiter, workspace leases, ownership, contention tests | Strong | Priority/preemption remains post-1.0 || Observe → Act → Verify | Observation ABI, Verifier ABI, provider postconditions | Strong | Core execution law |
| HITL as tokenized authority handoff | one-time Approval receipts, TTL, fingerprint, consume | Strong | Runtime enforcement; Worker UI |
| Durable orchestration state | Tasks, Scheduler, Loop, Process state, crash recovery | Strong | Avoid opaque long loops |
| Stage distinct from Memory | task staging + M0/M1/M2/M3 | Strong | Improve artifact-flow semantics later |
| Explicit execution backend | ExecutionTarget host/sandbox/remote, fail closed | Strong contract | Implement sandbox/remote only after 1.0 |
| Runtime Grounding Protocol | observations, health, workspace/execution context | Partial | Add small GroundedState contract post-1.0 |
| Capability Manifest as cognition boundary | manifest exists but uses simple ranking and broad catalogs | Partial | Add governed/phase-aware shaping |
| Planner/Executor structured Handoff | Tasks/events/receipts exist; no canonical run receipt | Partial | Add compact Handoff/Run Receipt |
| Deterministic Remediation Protocol | retry policy, blocked/needs_review, recovery notes, Health | Partial | Normalize failure/remediation classes |
| Task vs ExecutionStage dual model | Runtime Task + staging exist; no explicit ConversationTask/ExecutionStage split | Partial | Logical ConversationTask belongs mainly to Worker |
| Phase-specific Manifest | no first-class phase context in discovery | Missing | Runtime can filter; Planner owns phases |
| Ref-only large asset flow | staging references exist but are not universal public contract | Partial | Strengthen only with consumer evidence |
| Driver observability/idempotency/resource signaling | provider status, contracts, observation, resource metadata | Partial-strong | Continue standardization |
| Self-repair FSM / hot reload | diagnostics, gates, upgrade, rollback; no autonomous repair | Intentionally absent | Keep repair outside trusted kernel |
| Dynamic sandbox routing by risk | target contract only | Intentionally absent in 1.0 | Future policy may recommend target, never silently fallback |
| StateGraph Planner | not in Runtime | Correctly absent | Belongs to Worker/planner |
| Neural/Physical dual bus | no explicit neural bus abstraction | Not required | Add only if a concrete consumer contract proves need |
| Hot-swappable Skills | no verified hot-reload system | Optional | Post-1.0 only if real plugin demand appears |
| Priority preemption | leases/serialization exist | Optional | Add only with measured need |

## Highest-value post-1.0 gaps

### 1. GroundedState

Today Runtime can observe and verify physical state, but there is no single pre-execution truth token containing the minimal relevant facts: capture time, timezone/time anchor when material, workspace, ExecutionTarget, provider readiness, UI/browser identity when needed, and ownership/lease state.

It should be purpose-bound, not a giant environment dump.

### 2. Governed Capability Manifest

Current `getCapabilityManifest()` is useful discovery, but still closer to ranking/catalog output than a hard cognition boundary.

Target direction:

```text
registered capabilities
        ↓
availability
        ↓
policy / target / permissions
        ↓
task or phase context
        ↓
consumer contract
        ↓
SHAPED MANIFEST
```

Runtime shapes what is currently valid; the consumer Planner chooses among that shaped set.

### 3. Normalized Remediation Receipt

Raw exceptions should progressively collapse into a stable execution language:

```text
fatal
auth_required
retriable
ambiguous
approval_required
conflict
uncertain_side_effect
needs_replan
```

This lets Worker and Computer MCP react consistently without duplicating error parsers.

### 4. Handoff / Run Receipt

A consumer should not reconstruct task truth from many internal fields. A compact receipt should summarize run identity, status, artifacts, verification, approval, remediation, health and provenance.

This is especially valuable for OWL Worker.

## Owl Lab ideas that should NOT be copied literally

### Planner in the kernel
OWL Runtime deliberately keeps the general planner outside. This is a feature, not a gap.

### Autonomous kernel self-rewrite
Diagnostics and rollback are good. A kernel that silently patches itself is not. Repair belongs to a governed external maintenance agent.

### Fixed Primitive counts
A small, mutually exclusive ISA is valuable. A magic fixed number is not an invariant.

### Prompt-level governance
If Runtime can enforce an invariant physically, it should not rely on planner instructions.

### Product-specific app sovereignty in the kernel
App-specific routing belongs to Skills/plugins/consumer manifests unless it becomes a generic execution invariant.## Adoption policy

An Owl Lab idea enters OWL Runtime only when it does one of the following:

1. strengthens a stable execution invariant;
2. removes duplicated logic from multiple consumers;
3. converts repeated real-world failure into a generic contract;
4. improves recovery/security/verification without planner coupling;
5. preserves provider independence.

Otherwise the idea belongs to Worker, Computer MCP, a Skill/plugin, provider, or research backlog.

## Conclusion

OWL Runtime already contains the **execution-system DNA** of Owl Lab, but had not yet formalized its full **governance constitution and evolution discipline**.

The correct relationship is:

```text
Owl Lab
architecture research / experiments / protocols
        ↓ distill proven invariants
OWL Runtime
small stable execution contracts
        ↓
Computer MCP / OWL Worker
real product pressure and evidence
```

Owl Lab should remain the architecture laboratory. OWL Runtime should absorb only generic, proven contract-level lessons.


## Source families reviewed

The audit was distilled from Owl Lab's OS Constitution/Whitepaper, L0/L0.5/L1/L2/L2.5/L3 layer specifications, Runtime Resource Arbiter/Policy/Primitive Executor/State/Memory specifications, and Evolution protocols covering Runtime Grounding, Task Stage, Handoff, Remediation, Skill I/O, HITL, Action normalization, Kernel refactoring, Skill self-repair, orchestration state machines, sandbox direction and Task/Stage management.

Historical or pending Owl Lab documents are treated as research evidence, not automatically normative for OWL Runtime.
