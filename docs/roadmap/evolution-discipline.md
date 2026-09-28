# Post-1.0 Evolution Discipline

Status: **Normative roadmap discipline**.

This document converts Owl Lab's Evolution philosophy into a bounded rule for OWL Runtime development.

## 1. Owl Lab is a research source; Runtime is a productized kernel

Use the relationship:

```text
Owl Lab
experiments / failures / protocols / architecture research
        ↓ distill
generic invariant?
        ↓ yes
OWL Runtime contract + conformance
```

Do not mirror Owl Lab's feature count or module structure.

A useful Owl Lab idea may instead belong to `owl-worker`, `computer-mcp`, a Skill/plugin, a provider, or research backlog.

## 2. Evolution must start from evidence

Accepted triggers:

- repeated dogfood failure;
- duplicated workaround across consumers;
- correctness/security invariant;
- recovery/cancellation failure;
- measurable latency/resource bottleneck;
- public-contract ambiguity found by a consumer;
- provider behavior that cannot be represented generically.

Rejected trigger: “this architecture would be interesting to add.”## 3. Protocolization ladder

Do not jump from failure directly to a new subsystem.

```text
evidence
  ↓
failure class / invariant
  ↓
small receipt or state field
  ↓
contract
  ↓
conformance test
  ↓
dogfood
  ↓
subsystem only if still necessary
```

Prefer a field over a manager, and a manager over a new orchestration layer.

## 4. Version budget

### 1.0.x

Bug, security, recovery and contract-correctness fixes only. No new architecture surface.

### 1.1

At most **three** new generic protocol surfaces may be promoted:

1. **GroundedState v1** — fresh execution truth token.
2. **RemediationReceipt v1** — normalized failure/recovery language.
3. **Governed Capability Manifest v1** — policy/availability/context-shaped discovery.

These are proposals, not commitments. Each still requires consumer evidence.

### Later 1.x

Candidates only after evidence: Run/Handoff Receipt, stronger Stage/ArtifactRef flow, event-driven wake signals, provider fallback policy, staging retention/compaction, richer memory conflict/consolidation.

### 2.0+

Potentially breaking architecture: production sandbox backend, remote/federated Runtime, multi-user organization policy, preemptive priority scheduling, redesigned public API major version.

## 5. Grounding direction

Grounding should be execution-scoped and minimal.

Bad: dump the whole machine into a planner prompt.

Good:

```text
action contract
+ relevant target/workspace
+ fresh provider facts
+ fresh time/identity facts when material
= GroundedState token
```

Facts should carry capture time and provenance.

## 6. Manifest-governance direction

Capability discovery should evolve from “what exists?” to:

> What is currently valid for this consumer, task context, target, policy and physical state?

Runtime still does not choose the business plan.

Phase-specific shaping may be accepted as a filtering input, but phase decomposition remains a planner/product responsibility.

## 7. Remediation direction

Runtime should make the next safe execution move obvious without pretending to know business intent.

Examples:

```text
provider permission missing
→ class: auth_required / permission_required
→ safe action: pause
→ automatic replay: false

HTTP 503 before side effect
→ class: retriable
→ safe action: bounded retry
→ automatic replay: true

browser click returned, postcondition unknown
→ class: uncertain_side_effect
→ safe action: reobserve / explicit verify
→ automatic replay: false
```## 8. Repair direction

Self-repair is not a Runtime kernel feature by default.

If developed, use a separate repair agent/service:

```text
diagnostic package
      ↓
repair proposal
      ↓
isolated worktree / sandbox
      ↓
targeted tests + RC gates
      ↓
human review for kernel/driver
      ↓
candidate upgrade
      ↓
first-run monitoring / rollback
```

This reuses Runtime diagnostics, ExecutionTarget, approval, verification and upgrade machinery without making the trusted kernel self-modifying.

## 9. Task/Stage boundary direction

Do not force Owl Lab's logical ConversationTask into Runtime merely because Worker needs it.

Preferred ownership:

```text
OWL Worker
  business Worker / logical goal
       ↓
OWL Runtime
  durable Task / Run / staged assets / physical receipts
```

Runtime may expose explicit execution-attempt/stage identities if consumers need them. Business-goal aggregation remains product-level.

## 10. Architecture review questions

Before accepting a proposal, ask:

1. Which real failure or duplicated workaround does this solve?
2. Is the invariant generic across Computer MCP and Worker?
3. Could a consumer solve it without violating Runtime ownership?
4. Can this be a receipt/field/contract instead of a subsystem?
5. Does it preserve provider independence?
6. What happens on cancellation, restart, reconnect and uncertainty?
7. Is the behavior observable and auditable?
8. Can it fail closed?
9. Does it create a new planner inside Runtime?
10. Can it wait for the next minor/major version?

If questions 1–3 do not justify Runtime ownership, do not add it.


## 11. Implementation-level borrowing rules

Code-level ideas from Owl Lab may improve OWL Runtime without becoming new public surfaces. Prefer internal hardening when possible:

- keep Runtime control metadata out of provider/business payloads;
- preserve native value types across exact Task references;
- expose capability health/integrity through existing discovery/health surfaces;
- require accumulated evidence before escalating remediation;
- separate locator/executor/verifier/event-source/gateway responsibilities in app adapters;
- carry coordinate-frame provenance for model-assisted visual actions;
- use cooperative cancellation before any future resource preemption;
- persist benchmark/release evidence with version/SHA provenance.

These implementation improvements do **not** expand the three-surface 1.1 protocol budget. A new public contract still requires independent consumer evidence and architecture review.
