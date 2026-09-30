# Execution Revision v1

Status: **OWL Runtime 1.x Integration Closure R2 candidate**

## Purpose

Execution Revision binds the plan that was inspected/tested to the plan that Runtime later executes.

It is deliberately not a natural-language planner and not a second Task system.

```text
ChatGPT / Worker proposes Task request
-> Runtime canonicalizes executable Task definition
-> Runtime creates immutable Execution Revision digest
-> tests / review refer to that digest
-> tasks.run supplies expectedRevisionDigest
-> Runtime executes only if the Task still represents that revision
```

## Ownership

Runtime owns:
- canonicalization;
- digest generation;
- persistence on the durable Task;
- digest comparison before execution.

ChatGPT / Worker owns:
- planning;
- deciding when a revised plan is needed;
- creating a new Task/revision rather than mutating a tested revision.

## Contract

Every newly created Persistent Task exposes:

```json
{
  "executionRevision": {
    "version": 1,
    "digest": "<sha256>"
  }
}
```

The digest covers the canonical executable request:
- label;
- ordered Task steps;
- action;
- args;
- dependencies;
- verification spec;
- max concurrency;
- fail-fast behavior;
- execution target.

Default values are normalized before hashing.

Runtime stores the canonical revision on the encrypted Persistent Task record.

## Execution binding

A consumer may run:

```json
{
  "taskId": "task_...",
  "expectedRevisionDigest": "<sha256>"
}
```

If the digest differs:

```text
EXECUTION_REVISION_DIGEST_MISMATCH
```

The Task is not started and no Task step side effect is allowed to occur.

If no expected digest is supplied, legacy 1.x Task execution remains compatible.

## Immutability

R2 does not add an endpoint that edits an existing Task's executable definition.

A changed plan creates a new Task and therefore a new Execution Revision.

This avoids a mutable plan being silently executed under evidence from an earlier plan.

## Relationship to R1

R1 answers:

```text
Did a consequential request execute once across retries?
```

R2 answers:

```text
Is the executable plan exactly the revision that the consumer expects?
```

Both are required for later atomic activation.

## Relationship to R3

R3 may add an activation object that binds:

```text
tested revision digest
+ evidence
+ approval/policy state
-> active executable revision
```

R2 intentionally does not implement activation.

## Capability

```text
extensions.executionRevision.version = 1
```

## Conformance

`npm run verify:execution-revision` proves:
- revision exists on Task creation;
- digest survives durable Task reload;
- wrong expected digest fails before execution;
- mismatch leaves runCount at zero;
- correct digest executes;
- normalized default fields hash consistently;
- changed executable args produce a different digest.
