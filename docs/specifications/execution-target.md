# ExecutionTarget and Provider Affinity v1

Status: **candidate contract for OWL Runtime 1.0**.

ExecutionTarget answers one question before a side effect begins: **where is this work allowed to run?**

## Contract

```ts
type ExecutionTarget = {
  kind: "host" | "sandbox" | "remote";
  targetId?: string;
  providerAffinity?: string[];
  allowFallback?: false;
};
```

### `host`

Available in OWL Runtime 1.0. Actions execute against providers on the local host.

### `sandbox`

Reserved by the 1.0 contract but **not implemented as a production target**. Requests fail with `EXECUTION_TARGET_UNAVAILABLE`.

### `remote`

Reserved by the 1.0 contract but **not implemented as a production target**. Requests fail with `EXECUTION_TARGET_UNAVAILABLE`.

1.0 intentionally defines the contract without expanding scope into a sandbox product or remote fleet.

## No silent fallback

`allowFallback: true` is rejected with `EXECUTION_TARGET_FALLBACK_FORBIDDEN`.

A request for sandbox or remote must never silently execute on the host. This rule applies even when the requested action would otherwise succeed locally.

## Provider affinity

`providerAffinity` is an optional allow-list of provider ids for the execution.

Example:

```json
{ "kind": "host", "providerAffinity": ["filesystem"] }
```

If an action resolves to another provider, Runtime rejects it with `PROVIDER_AFFINITY_MISMATCH` before approval or side effects.

Provider affinity is a constraint, not a fallback/ranking system in 1.0.

## Persistence

ExecutionTarget is durable for:

- Persistent Tasks;
- scheduled Task templates.

A background Task therefore keeps the target selected when it was created instead of inheriting whichever transport/session happens to wake it later.

Legacy Task/Schedule records without a target normalize to `host` for backward compatibility.

## Public Runtime API

`RuntimeClient.getExecutionTargets()` returns the target manifest.

The following public requests may carry `executionTarget`:

- `PrimitiveCallRequest`;
- `SkillRunRequest`;
- `CreateTaskRequest`;
- `CreateScheduleRequest`;
- `ProcessRequest`.

Task runs use the target persisted at Task creation. A later caller cannot silently retarget an existing Task.

## Current 1.0 provider support

Filesystem, Shell, Git, Transaction, Browser, and Desktop providers advertise `host` support only.

## 1.0 conformance

The verifier proves:

- host actions execute;
- sandbox and remote fail closed;
- failed target checks leave filesystem side effects absent;
- provider affinity mismatches fail before side effects;
- silent fallback is forbidden;
- Task target survives persistence/run;
- Schedule target survives persistence and is inherited by its Task template.
