# Same-Execution Approval Resume v1

Status: **OWL Runtime 1.x Integration Closure R4 candidate**

## Purpose

Approval is an execution boundary, not an error that forces the caller to reconstruct work.

```text
Task R42 / step 7
-> exact action + args reaches approval policy
-> Runtime persists Approval A9 bound to task R42 + step 7 + args fingerprint
-> Task R42 becomes waiting_approval
-> no side effect executes
-> approvals.approve(A9)
-> Runtime resets only step 7 to pending
-> SAME Task R42 resumes
-> approval A9 is consumed exactly once
-> step 7 executes
-> Task R42 continues
```

No replacement Task and no caller-side action reconstruction are required.

## Ownership binding

Approval v1 remains bound to the exact canonical action/Skill args fingerprint.

R4 additionally binds Task approvals to:

- `ownerTaskId`;
- `ownerStepId`.

Two Tasks requesting the same action with identical args receive separate approval receipts. A receipt from one execution cannot authorize the other.

Non-Task direct approvals remain bound to their logical Runtime session.

## Durable states

Task status adds:

```text
waiting_approval
```

Task step state adds:

```text
waiting_approval
```

The step persists:

- approvalId;
- approvalFingerprint;
- approvalRequestedAt.

The action has not crossed its side-effect boundary while in this state.

## Approve

`approvals.approve`:

1. persists the Approval as approved;
2. verifies owner Task + owner Step + fingerprint;
3. restores that exact waiting step to pending;
4. calls the normal durable Task runner on the same Task and same Execution Revision;
5. the normal approval policy consumes the one-time receipt;
6. execution continues.

All normal capability, provider, Observation and Verification checks remain active.

## Deny

`approvals.deny` terminates the waiting step/Task as failed without executing the denied side effect.

## Crash recovery

If Runtime crashes after persisting the Approval request but before persisting the Task's waiting state, Task recovery reconciles running steps against durable pending/approved Approval records.

A matching task+step approval is recovered as `waiting_approval`, not replayed as an interrupted side effect.

## Capability

```text
extensions.approvalResume.version = 1
```

## Conformance

`npm run verify:approval-resume` proves:

- side effect does not occur before approval;
- approval is bound to exact task + step + args fingerprint;
- identical fingerprints in two Tasks do not share authority;
- approve resumes the same taskId and stepId;
- no replacement Task is created;
- approval becomes consumed after resumed execution;
- denial terminates without the side effect.
