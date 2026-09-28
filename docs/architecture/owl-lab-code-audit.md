# Owl Lab Code Audit → OWL Runtime

Status: **Post-1.0 architecture research**.

This audit inspects Owl Lab implementation code, not only its design documents. It records implementation patterns worth borrowing, patterns that need evidence first, and patterns that OWL Runtime should explicitly reject.

## Executive findings

The strongest code-level ideas are:

1. **Contract-driven audit plans**: per-op preconditions, expected evidence, checks and failure policy.
2. **Zero-trust control/data envelopes**: runtime metadata is separated from business payload before execution.
3. **Type-preserving runtime references**: exact references keep native types instead of stringifying everything.
4. **Capability health in discovery**: planner-visible capability payload includes integrity/health state.
5. **Semantic recall + physical inhibition**: capability discovery can retrieve broadly but suppress conflicting capabilities before the planner sees them.
6. **Failure-threshold escalation**: expensive repair paths are only considered after repeated evidence, not after one failure.
7. **Adapter role separation**: Locator / Executor / Verifier / Watcher / Gateway are distinct responsibilities.
8. **Ticketed cooperative resource control**: cancellation/preemption should revoke a holder cooperatively, never force-unlock underneath it.

These are more valuable than copying Owl Lab's exact modules.

## 1. Contract-driven audit plans

Owl Lab's `TaskAuditEngine` consumes per-operation audit metadata and builds a generic checklist containing:

- preconditions;
- expected evidence;
- declarative checks;
- failure policy.

This is stronger than embedding business checks inside workflow code.### Runtime interpretation

OWL Runtime already has:

- ActionContract;
- Observation ABI;
- Verifier ABI;
- provider default postconditions;
- explicit Task verification specs.

The missing abstraction is not another verifier. It is a **verification plan** around the verifier:

```text
preconditions
   ↓
action
   ↓
expected evidence
   ↓
verification checks
   ↓
failure policy
```

This should remain a later-1.x candidate unless Worker/Computer MCP repeatedly duplicate this logic. It should not displace the current Verifier ABI.

## 2. Zero-trust control/data envelope

Owl Lab's WorkflowAdapter and SkillBody distinguish:

- business payload;
- linkage metadata;
- runtime control fields;
- reserved keys.

Unknown/control fields are filtered before reaching business logic.

This is a strong generic invariant.

### Runtime interpretation

Public Runtime requests should increasingly treat control metadata as a typed envelope rather than allowing it to mix with action args.

Examples of control-plane fields:

- logical session / request id;
- Task/Run identity;
- ExecutionTarget;
- approval/verification policy;
- cancellation context;
- provenance / trace metadata.

Provider/action args remain the data plane.

This reduces accidental argument pollution and makes signatures more stable.## 3. Type-preserving runtime references

Owl Lab's WorkflowResolver preserves the native value when a string is an exact reference, while interpolation intentionally converts values to text. It also supports nested maps, arrays and projections.

This distinction is important:

```text
exact ref       → preserve type
embedded ref    → stringify intentionally
```

### Runtime interpretation

OWL Runtime's existing `$ref` model is deliberately smaller and safer. The useful lesson is:

> Never silently stringify a durable Task value merely because it crossed a reference boundary.

Future reference improvements should prioritize:

- type preservation;
- explicit missing-reference failure;
- deterministic array/index traversal;
- schema-aware validation.

Do not add many syntaxes unless real consumers need them.

## 4. Capability integrity belongs in capability discovery

Owl Lab's SkillHealthService audits whether a Skill's physical implementation matches the advertised operations and exposes an integrity status in the manifest.

This is a strong idea.

### Runtime interpretation

A governed capability manifest should not expose only:

> capability exists

It should expose:

> capability exists, is currently available, has required permissions, satisfies its contract, and is safe to present in this context.

This fits directly into the proposed Governed Capability Manifest v1.## 5. Semantic recall plus inhibition

Owl Lab retrieves candidate Skills semantically, then applies routing policy that can:

- choose a primary capability;
- suppress incompatible capabilities;
- raise affinity-linked supporting capabilities;
- return routing reasons.

The valuable principle is **retrieve broadly, expose narrowly**.

The business-specific hardcoded intent tables are not reusable Runtime design.

### Runtime interpretation

Runtime may shape a manifest from:

```text
registered
→ semantically/contextually relevant
→ available
→ healthy
→ policy-valid
→ target-valid
→ consumer-visible
```

It should return reasons for suppression.

It should **not** decide which business Skill should accomplish a user's goal. Final business selection remains with the consumer Planner.

## 6. Structured policy decisions

Owl Lab's PolicyAssessor returns more than allow/deny. It emits:

- decision;
- security mode;
- risk;
- idempotency;
- side effects;
- reason;
- auto-approval semantics.

This is substantially easier for callers to reason about than a boolean.

### Runtime interpretation

OWL Runtime's ApprovalRecord is already stronger in persistence and exact-args binding. The useful addition is a compact **PolicyDecisionReceipt** shape internally, likely folded into future RemediationReceipt / manifest shaping rather than becoming a fourth 1.1 public surface.## 7. Failure-threshold escalation

Owl Lab counts repeated action failures and only enters heavy repair after a threshold.

The important principle is not the exact number three. It is:

> expensive or architecture-changing remediation requires accumulated evidence.

### Runtime interpretation

Use incident windows/counters before escalating from:

```text
deterministic retry
→ reobserve
→ known recovery
→ needs_replan
→ external repair workflow
```

Do not launch self-repair from a single provider exception.

This complements Runtime diagnostics and prevents repair thrashing.

## 8. Deterministic-first recovery ladder

Owl Lab attempts:

1. deterministic recovery;
2. perception/model-assisted correction;
3. source-level repair.

The ordering is useful. The implementation is too permissive for Runtime.

### Runtime interpretation

Safe Runtime ladder:

```text
deterministic safe retry
→ reobserve
→ known provider recovery
→ alternate already-authorized deterministic path
→ needs_replan / human attention
```

Model-based coordinate improvisation and source-code repair belong outside the trusted Runtime kernel.

## 9. Adapter decomposition

The specialized WeChat driver separates:

- Locator — identify/focus target;
- Executor — perform physical action;
- Verifier — establish postcondition;
- Watcher — detect asynchronous external events;
- Gateway — external protocol translation.

This is an excellent generic App Adapter pattern.### Runtime interpretation

Future app/provider packages should prefer:

```text
Adapter
├─ Locator / Resolver
├─ Executor
├─ Observer / Verifier
├─ Event Source / Watcher
└─ Protocol Gateway (optional)
```

Important boundary:

- Watcher should emit events/signals into Scheduler/Task state, not own an infinite business loop.
- Verifier failure must yield `failed` or `uncertain`, never implicit success.
- Gateway translates protocols; it does not become a second executor.

This pattern is useful for WeChat, ERP, Office apps, browser SaaS and future enterprise adapters.

## 10. Window-relative visual grounding

Owl Lab's WeChat Locator first gets the target window bounds, captures the relevant region, asks vision for normalized coordinates, then maps them back to global screen coordinates.

The valuable principle is:

> Ground perception in a stable local coordinate frame before issuing global physical actions.

This reduces multi-monitor/window-position sensitivity.

### Runtime interpretation

If Desktop/Vision providers later support model-assisted localization, observations should carry:

- source window identity;
- capture bounds;
- coordinate frame;
- capture timestamp;
- normalized target;
- mapping receipt.

This belongs in provider/Observation evolution, not Planner prompts.

## 11. Cooperative preemption, never force unlock

Owl Lab's Arbiter issues cancellation to a lower-priority holder and relies on the holder's `finally` block to release the lock. It explicitly avoids forcibly releasing a lock owned by running code.

This is the correct safety principle.

OWL Runtime already has ticketed resource leases and cancellation infrastructure. If priority/preemption is ever added, it should follow:

```text
request revocation
→ holder observes cancellation
→ holder closes/rolls forward safely
→ holder releases its own lease
→ next owner acquires
```

Never mutate another task's lock state underneath it.## 12. Rich attachment ingestion as Stage normalization

Owl Lab normalizes attachments into Stage, records provenance, derives percepts, and creates secondary assets such as text extraction/transcripts.

The useful principle is:

> External rich inputs should become durable, provenance-carrying ArtifactRefs before complex execution depends on them.

### Runtime interpretation

This is probably not a 1.1 Runtime core feature. Worker or adapter code can perform ingestion, while Runtime should eventually support a generic ArtifactRef/provenance contract if multiple consumers need it.

## 13. Evaluation as persisted evidence

Owl Lab's execution repository stores evaluation runs/scenarios with success rate, recovery rate, attempts, duration, stage and trace linkage.

This is a useful operational idea.

### Runtime interpretation

Release evidence and consumer benchmarks should be machine-readable and attributable to:

- Runtime version/SHA;
- scenario;
- attempts/recovery;
- duration;
- terminal status;
- duplicate side effects;
- leaked processes/leases.

OWL Runtime already started this with RC/soak evidence. The code audit reinforces making evidence a first-class engineering artifact.

## Patterns to explicitly reject

### A. Trust-on-sensor-failure

The WeChat verifier can return success when visual verification errors.

OWL Runtime must do the opposite:

```text
sensor unavailable → uncertain / needs_attention
not verified success
```

This is a hard redline.

### B. Automatic pixel-force recovery inside the kernel

A model guessing coordinates and retrying a side effect can amplify mistakes. Keep such recovery in a higher-level governed consumer and require re-observation/verification.### C. Autonomous source modification by Runtime

Trace-triggered patch generation is useful research, but production Runtime must not rewrite itself.

Reuse diagnostics + isolated repair agent + candidate gate + human review instead.

### D. Aggressive planner-output salvage in Runtime

Planner JSON repair/salvage is a planner/client concern. Runtime should accept typed requests and reject malformed contracts rather than guessing intent.

### E. Infinite watcher loops inside providers

Watchers should emit events into durable orchestration. Provider-owned infinite loops make lifecycle, recovery and cancellation opaque.

### F. Automatic memory promotion from one successful result

A successful publish/read is evidence, not durable truth. OWL Runtime's gated M2→M3 promotion is safer and should remain stricter than Owl Lab's automatic promotion examples.

## Adoption ranking

### High-value, low-scope

- zero-trust control/data envelope;
- type-preserving Task refs;
- capability integrity/health in governed manifests;
- structured policy decision reasons;
- failure-threshold escalation;
- adapter role decomposition;
- explicit coordinate-frame metadata for visual actions.

### High-value, needs consumer evidence

- verification plan around Verifier ABI;
- phase/context-aware manifest inhibition;
- ArtifactRef ingestion contract;
- cooperative priority preemption;
- persisted benchmark/evidence ledger.

### Keep outside Runtime

- Planner salvage;
- trace-to-Skill automatic promotion;
- model-driven pixel correction;
- autonomous source repair;
- product-specific routing heuristics.

## Bottom line

Owl Lab code contains useful architectural experiments, but OWL Runtime should borrow **invariants and boundaries**, not implementation exuberance.

The most important new code-level lesson is:

> Runtime should make every transition between cognition and physical execution explicit: typed envelope, capability health, grounded state, contract, evidence, verification, remediation, and durable receipt.
