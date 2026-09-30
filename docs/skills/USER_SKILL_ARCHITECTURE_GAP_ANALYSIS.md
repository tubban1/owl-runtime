# User Skill Registry 1.x — Architecture Gap Analysis

Status: **Implementation baseline**  
Branch: `feature/1.x-user-skill-registry`  
Does not modify OWL Runtime 1.0 / rc.4.

## A. Existing architecture readout

The current Runtime already provides most of the execution and evidence machinery needed for User Skills:

- Primitive ABI v1 and canonical Primitive catalog;
- `runtime.compile_task` / Primitive Task compilation;
- encrypted Persistent Tasks;
- Working Memory through step outputs / `$ref`;
- Staging for intermediate artifacts;
- M2 Episodic indexing for terminal Tasks;
- explicit M2→M3 Semantic promotion with quality/privacy gates;
- Approval policy and exact-args receipts;
- ResourceArbiter and Workspace ownership;
- Observation / Verifier ABI;
- state-schema / atomic persistence conventions;
- crash recovery for interrupted Tasks;
- digest-based integrity patterns.

Current gap:

- Skill catalog is static and compiled into `skillRuntime.ts`;
- there is no persistent User Skill Candidate store;
- there is no persistent User Skill Registry;
- there is no digest-bound Candidate revision lifecycle;
- there is no promotion gate from tested Candidate evidence into an installed executable Skill;
- there is no version activation / rollback lifecycle for User Skills.

Important invariant confirmed by real production experiment:

```text
M3 Semantic Memory != User Skill Registry
```

M3 stores reusable knowledge/procedures.

A User Skill is a governed executable capability.

## B. Architecture gap analysis

### Already solved by existing Runtime

| Need | Existing owner |
| --- | --- |
| deterministic low-level capability set | Primitive ABI |
| Task graph execution | Persistent Task |
| dependency references | Working Memory / $ref |
| intermediate assets | Staging |
| real execution evidence | Persistent Task + M2 |
| quality/privacy gates | memoryPromotion |
| action authorization | Approval Policy |
| resource ownership | ResourceArbiter / Workspace Lease |
| postcondition evidence | Observation / Verifier |
| interrupted execution recovery | Persistent Task recovery |
| atomic state writes | Runtime state stores |
| semantic procedure memory | M3 Semantic Memory |

### Missing governance layer

The minimum new layer is:

```text
Skill Candidate Store
        ↓
deterministic validation
        ↓
Persistent Test Task binding
        ↓
existing Task execution
        ↓
existing M2 + Verifier evidence
        ↓
Skill Promotion Gate
        ↓
immutable User Skill Registry
```

No second execution engine and no second evidence engine are required.

## C. Existing modules reused directly

### Primitive ABI

User Skills are defined as declarative Primitive graphs.

Phase 1 explicitly forbids:

- direct provider imports;
- direct L0 provider calls;
- direct L0.5 Action definitions;
- arbitrary JS/Python execution as Skill package code.

A User Skill can only reference allowed canonical core Primitives.

### Persistent Task

Candidate tests compile into a normal Persistent Primitive Task.

The test lifecycle remains:

```text
candidate.compile-test
→ taskId
→ tasks.run
→ tasks.get / tasks.resolve
```

There is intentionally no separate Candidate Test executor.

### Working Memory / Staging

Candidate graphs use the existing Task reference model and staging lifecycle.

### M2 Episodic

Terminal test Tasks are indexed by the existing M2 mechanism.

M2 now stores the canonical evidence digest captured at episode creation.

Promotion binds to that M2 evidence digest.

### M3 Semantic

M3 is not an executable Registry.

The existing quality/privacy gate implementation is reused as a promotion-readiness input.

M3 promotion itself remains independent and optional.

### Approval / ResourceArbiter / Verifier

Promoted User Skills create normal Persistent Primitive Tasks.

Every Primitive still executes through:

```text
executePrimitive
→ executeRoutedAction
→ Approval
→ Workspace ownership
→ ResourceArbiter
→ Provider
→ Observation
→ Verifier
```

Promotion never grants a bypass.

## D. Minimum new data model / public API

### Skill Candidate

Persistent fields:

- candidateId
- immutable revision history
- currentDigest
- lifecycle status
- deterministic validation report
- test Task bindings
- optional promotion receipt

Revision is optimistic-concurrency controlled by `expectedDigest`.

### Validation report

Machine-readable fields include:

- error code
- target Skill ABI
- Runtime / required Primitive ABI
- field/path
- required value
- allowed values
- required/allowed Primitives
- contract mismatch
- candidate digest

Runtime decides PASS/FAIL deterministically.

ChatGPT / Worker may revise Candidate content, but cannot mark validation PASS.

### Test binding

```text
candidateDigest
+ normalized inputDigest
→ deterministic Persistent Task id
```

The Task stores provenance:

- candidateId
- candidateDigest
- inputDigest

This proves which exact Candidate revision was tested.

### Promotion Receipt

Promotion binds:

- candidate digest
- test Task id
- M2 evidence digest
- quality gate receipt
- privacy gate receipt
- verification summary
- installed Skill id/version

Promotion requires explicit `confirm=true`.

### User Skill Registry

Per Skill id:

- enabled state
- activeVersion
- immutable versions
- manifest per version
- candidate digest
- promotion receipt
- activation history

Update is a new immutable version.

Rollback reactivates an old version.

### Public API shape

Existing:

- `skills.catalog`
- `skill.run`
- `tasks.*`

New 1.x namespace:

- `skill-candidates.submit`
- `skill-candidates.list`
- `skill-candidates.get`
- `skill-candidates.revise`
- `skill-candidates.validate`
- `skill-candidates.dismiss`
- `skill-candidates.compile-test`
- `skill-candidates.inspect`
- `skill-candidates.promote`

Registry management:

- `user-skills.list`
- `user-skills.get`
- `user-skills.enable`
- `user-skills.disable`
- `user-skills.activate-version`
- `user-skills.rollback`
- `user-skills.uninstall`

There is deliberately no separate `candidate.test` state machine.

`compile-test` returns a normal `taskId`; execution uses `tasks.run`.

## E. Migration / persistence / security / idempotency

### Persistence

Candidate and Registry records use Runtime-owned encrypted-at-rest stores under the Runtime state root.

Writes follow the existing atomic temp-write + rename pattern.

Candidate and Registry stores are canonical governance state, not disposable indexes. Decryption/integrity corruption therefore fails closed with a machine-readable store-corruption error; records are never silently skipped.

### State schema

Phase 1 is additive and does not mutate existing 1.0 Task/Memory formats.

The new directories are ignored by Runtime 1.0, so rolling back the binary does not corrupt existing 1.0 state.

A global state-schema bump is therefore not required for the initial additive store.

A future breaking Registry format change must use the normal Runtime state migration system.

### Security

User Skill manifests are declarative only.

Validation rejects unknown, aliased, deprecated, non-core, and explicit escape-hatch Primitive references. Phase 1 specifically forbids `sys.exec`: arbitrary shell execution is a different trust class from a declarative User Skill.

The declared Skill contract may be stricter than the derived Primitive contract, but cannot understate:

- risk;
- non-idempotency;
- side effects;
- retry restrictions;
- verification requirements.

### Idempotency

- Candidate submit is content-addressed for retry safety.
- Candidate revise requires `expectedDigest`.
- Candidate and Registry mutations are serialized through the existing ResourceArbiter; there is no second locking subsystem.
- Concurrent revisions holding the same stale digest produce exactly one winner; later contenders fail with a digest mismatch.
- Test Task id is deterministic from Candidate digest + normalized input digest.
- Duplicate test compilation returns the existing bound Task.
- Promotion receipt is deterministic from Candidate/Test/M2 evidence identity.
- Duplicate promotion of the same tested digest returns the existing installed version.
- A different digest cannot overwrite the same installed Skill version.
- Registry versions are immutable.

### Crash recovery

Promotion intentionally tolerates a crash after Registry write but before Candidate status update.

On retry:

- existing Registry version/digest is detected;
- the same promotion receipt is reused;
- Candidate state is finalized without duplicating the version.

Test Task crash/restart behavior is inherited from Persistent Task recovery.

## F. Implementation scope decision

Implementation is justified now because the missing layer is small and can reuse existing Runtime invariants.

### Implement in this branch

- Candidate persistence;
- deterministic validation / repair report;
- digest-bound revisions;
- compile to Persistent Test Task;
- promotion readiness inspection;
- M2 evidence digest binding;
- explicit promotion;
- immutable User Skill Registry;
- enable/disable;
- version activation;
- rollback;
- uninstall state;
- dynamic User Skill discovery through `skills.catalog`;
- User Skill execution through normal Persistent Tasks;
- public RuntimeClient / HTTP RPC.

### Implemented in Phase 2A follow-up

- deterministic repeated verified-work grouping;
- bounded scalar argument parameterization;
- read-only draft manifest generation;
- existing validator preview;
- explicit exclusion of derived Skill/test Tasks;
- embedded-secret rejection before Candidate promotion.

### Do not implement yet

- LLM/semantic clustering of loosely similar trajectories inside Runtime;
- automatic Candidate revision;
- automatic production activation;
- arbitrary code plugins;
- Cloud Skill Library;
- marketplace/signing infrastructure;
- provider/driver plugin loading.

Those remain separate later 1.x capabilities.

## Non-negotiable invariants

1. Candidate is not an Installed Skill.
2. M2/M3 Memory never auto-installs a Skill.
3. ChatGPT/Worker may revise Candidate content but cannot decide validation PASS.
4. Runtime contains no LLM dependency.
5. Validation is deterministic and machine-readable.
6. Candidate revision is digest-bound.
7. Candidate tests use Persistent Tasks.
8. Promotion binds the exact tested Candidate digest to M2/verification evidence.
9. Installed executable content is the same digest that passed validation/test.
10. User Skills continue through Primitive ABI, policy, Approval, ResourceArbiter and Verifier.
11. User Skills cannot access provider internals.
12. Versions are immutable.
13. Retries/install/promotion are idempotent.
14. Runtime Task/Memory remain the only execution/evidence truth.
