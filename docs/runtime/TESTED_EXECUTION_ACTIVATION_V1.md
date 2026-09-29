# Tested Execution Activation v1

Status: **OWL Runtime 1.x Integration Closure R3 candidate**

## Purpose

R3 closes the gap between "this plan was tested" and "this exact plan is allowed to become the production executable revision."

```text
Planner / Worker proposal
-> Runtime Task + immutable Execution Revision digest
-> test Task executes exact digest
-> Observation / Verification evidence becomes terminal
-> explicit confirm
-> Runtime atomically records ExecutionActivation on the encrypted test Task
-> production Task is instantiated only from that activated canonical revision
```

Runtime does not interpret natural language and does not own Worker product state.

## Activation authority

The canonical activation receipt is persisted inside the encrypted durable test Task record:

```json
{
  "version": 1,
  "id": "execact_...",
  "revisionDigest": "<sha256>",
  "testTaskId": "task_...",
  "evidenceDigest": "<sha256>",
  "activatedAt": "..."
}
```

The Task file is the atomic authority boundary. Candidate/UI/Cloud projections are not activation truth.

An activated evidence Task cannot be deleted.

## Preconditions

`execution-revisions.activate` fails closed unless:

- `confirm=true`;
- the test Task has Execution Revision v1;
- `expectedRevisionDigest` exactly matches the stored revision;
- the test Task is terminal `completed`;
- all selected Task steps succeeded;
- every required verification is `verified`;
- no side-effect step remains unresolved.

A mismatch is rejected before activation. Evidence from another revision cannot be reused.

## Production instantiation

`execution-revisions.create-task` accepts:

```json
{
  "testTaskId": "task_...",
  "expectedRevisionDigest": "<sha256>"
}
```

Runtime reads the activated canonical revision and creates a new durable Task with:

- the exact canonical label/steps/args/dependencies/verification;
- the exact normalized concurrency/fail-fast values;
- the exact ExecutionTarget;
- the same revision digest;
- provenance pointing to the activation receipt and test Task.

Runtime recomputes and checks the digest before the production Task is persisted.

## Primitive Task closure

R3 also closes an R2 omission: Persistent Primitive Tasks now receive Execution Revision v1 at creation. This is required because User Skill compile-tests use the Primitive Task path.

## Evidence identity

R3 does **not** change the pre-existing Task/M2 evidence digest algorithm. The activation receipt references that existing evidence digest rather than redefining it.

## Relationship to approvals

Activation is not approval.

R3 proves "this exact revision passed test evidence." R4 separately proves "a consequential step waiting for authority resumes the same execution after approval."

Creating or running an activated Task does not bypass Runtime approval, capability, OS-permission, provider, observation, or verification enforcement.

## Capability

```text
extensions.executionActivation.version = 1
```

Public methods:

- `execution-revisions.activate`
- `execution-revisions.create-task`

## Conformance

`npm run verify:execution-activation` proves:

- exact digest required for activation;
- completed verified evidence required;
- activation receipt is durable/idempotent;
- activated evidence cannot be deleted;
- stale revision evidence is rejected;
- production Task preserves the activated digest;
- production Task carries activation provenance;
- Primitive Task creation is revision-bound.
