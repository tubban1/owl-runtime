# Cloud Authorization Boundary

Status: **Normative Runtime boundary for OWL 1.0**.

OWL Cloud and OWL Runtime answer different authorization questions.

## Cloud answers

Cloud determines whether an authenticated user may request control-plane actions such as:

- view a device projection;
- send a RemoteCommand;
- create ScheduleIntent;
- submit a remote approval decision.

Cloud uses organization membership and DeviceGrant.

## Runtime answers

Runtime determines whether the exact local capability/action may execute.

Runtime continues to enforce:

- capability gates;
- filesystem/workspace scope;
- provider permissions;
- exact-action approval policy;
- one-time approval receipts;
- execution target policy;
- side-effect verification.

## Critical rule

The following are **not Runtime approvals**:

- Cloud role `owner`;
- Cloud role `admin`;
- DeviceGrant `run`;
- DeviceGrant `approve`;
- a successful Cloud login;
- a paid subscription/entitlement.

A Cloud-authorized RemoteCommand may still be denied or paused by Runtime.

## Remote approval

When Cloud later transports a human ApprovalDecision, Runtime must bind it to the exact local approval request/subject/args fingerprint according to the Runtime approval contract.

Cloud cannot mint a generic approval token that authorizes arbitrary local actions.

## Runtime implementation rule

Runtime must not add role-aware primitive checks such as:

```text
if cloudRole == "admin": allow shell.execute
```

That is forbidden.

Runtime may record Cloud provenance for audit/correlation, but Cloud account roles must not change primitive semantics.

## Offline behavior

Runtime remains authoritative while Cloud is disconnected.

Loss of Cloud authorization does not silently kill already-running local work. Any cancellation must enter through explicit Runtime cancellation semantics.
