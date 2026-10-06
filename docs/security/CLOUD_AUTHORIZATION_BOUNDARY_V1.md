# Cloud Authorization Boundary v1

Status: **Normative Runtime boundary**
Date: 2026-10-06

## Purpose

OWL Cloud and OWL Runtime answer different authorization questions.

Cloud authorizes access to control-plane operations.
Runtime authorizes exact local execution.

Neither layer may silently impersonate the other.

## Cloud authority

Cloud may determine whether an authenticated user may:

- view an organization/device projection;
- create or inspect a RemoteCommand;
- create schedule/worker intent;
- submit a remote approval decision;
- obtain a bounded signed Runtime access lease where the current protocol
  requires one.

Cloud evaluates account, organization, entitlement, DeviceGrant and
control-plane policy.

## Runtime authority

Runtime determines whether the exact local capability/action may execute.

Runtime continues to enforce:

- Runtime access state;
- capability gates;
- filesystem/workspace scope;
- resource admission;
- ExecutionTarget policy;
- Provider permissions;
- exact-action approval policy;
- one-time approval receipts;
- side-effect verification;
- idempotency/replay rules.

## Critical rule

The following are **not exact Runtime action approvals**:

- Cloud role `owner`;
- Cloud role `admin`;
- DeviceGrant `run`;
- DeviceGrant `approve`;
- successful Cloud login;
- paid subscription or entitlement;
- possession of a valid device credential;
- possession of a valid signed Runtime access lease.

A signed access lease proves bounded Cloud/Device authority to enter the
Runtime control boundary. It does not grant arbitrary local side effects.

A Cloud-authorized RemoteCommand may still be denied, queued, paused,
approval-blocked, resource-blocked, or rejected by Runtime.

## Signed access lease

Where the signed lease protocol is used, Runtime must verify the lease before
accepting protected Cloud-origin control operations.

The lease should remain bounded by its signed claims such as:

- issuer;
- subject/device;
- audience;
- validity window;
- scope/capability;
- nonce/request correlation where defined.

Lease verification is an access-boundary check, not a replacement for Runtime
policy or exact-action approval.

## Remote approval

A Cloud-transported ApprovalDecision must bind to the exact Runtime approval
subject and argument fingerprint required by the Runtime approval contract.

Cloud cannot mint a generic approval token that authorizes arbitrary local
actions.

## Forbidden implementation

Runtime must not contain role shortcuts such as:

    if cloudRole == "admin":
        allow shell.execute

Cloud account roles must not change Primitive semantics.

Cloud provenance may be recorded for audit/correlation.

## Offline behavior

Runtime remains authoritative while Cloud is disconnected.

Loss of Cloud connectivity or authorization does not silently kill
already-running local work.

Cancellation must enter through explicit Runtime cancellation semantics.

## Resource and capability boundary

Cloud may project device/worker CapabilityInventory and ResourceInventory for
placement.

That projection does not authorize execution.

Placement answers "where can this run?"
Runtime admission and policy answer "may it run now?"
Runtime approval answers "is this exact side effect authorized?"

These decisions remain distinct.
