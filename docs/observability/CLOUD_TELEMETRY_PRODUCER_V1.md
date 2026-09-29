# Cloud Telemetry Producer v1 — Runtime Adaptation

Status: **Proposed Runtime-side adaptation contract**  
Upstream contract: `owl-cloud/docs/contracts/PROVIDER_OBSERVABILITY_V1.md`

## Decision

OWL Runtime may be the **logical producer** of execution telemetry, but it MUST NOT become a Cloud client.

The canonical path is:

```text
OWL Runtime
  ↓ local execution facts
OWL Desktop / Cloud Bridge
  ↓ authenticated transport
OWL Cloud /device/v1/telemetry
```

Runtime therefore does not own:

- Cloud endpoint URLs;
- device credentials;
- organization identity;
- account/session identity;
- retry queues for Cloud delivery;
- Cloud backoff/rate-limit policy.

Those are control-plane / Desktop Bridge responsibilities.

Cloud binds `deviceId` and `organizationId` from the authenticated device. Runtime must not invent or persist those identities.

## Why this boundary matters

Direct Runtime → Cloud coupling would make the execution kernel depend on:

- network availability;
- Cloud authentication;
- account/device lifecycle;
- Cloud API compatibility.

That violates the frozen platform boundary:

```text
OWL Cloud   = identity/control authority
OWL Desktop = local integration host
OWL Runtime = execution authority
```

Telemetry delivery failure must never block local execution.

## 1.0 decision

**Do not change the frozen OWL Runtime 1.0 execution surface for Cloud telemetry.**

Runtime 1.0 already exposes enough privacy-aware operational evidence for an initial Desktop-side producer adapter:

- `diagnostics.get` / Support Package v1;
- Runtime Health model;
- provider status;
- Task / Process / Workspace summaries;
- privacy-aware audit summaries;
- Runtime version / state schema / lifecycle.

OWL Desktop may transform those facts into Cloud Provider Observability events.

Limitations of the 1.0 bridge must be explicit:

- diagnostics are snapshots, not a guaranteed real-time event stream;
- current audit logging is not a canonical record of every Runtime execution path;
- absence of a telemetry event is not proof that an execution did not occur;
- Cloud telemetry is operational observability, never execution authority.

## Logical producer versus transporter

The event may still declare:

```json
{
  "producer": "owl-runtime"
}
```

when the underlying fact originated from Runtime.

OWL Desktop is the **transporter/adapter**, not the semantic producer.

Desktop-generated facts use producer `owl-desktop`. Tunnel facts use `owl-tunnel`.

## Runtime-origin facts suitable for Cloud v1

### Always useful

- Runtime start / stop / restart;
- Runtime version;
- Runtime lifecycle health transition;
- provider health transition;
- provider permission missing;
- Task terminal outcome;
- Process terminal/lost/timed-out outcome;
- Approval outcome;
- workspace/resource contention or timeout;
- state-schema incompatibility / migration required;
- recovery/reconnect anomalies;
- cancellation anomalies;
- execution latency aggregates.

### Sample or aggregate

Do not emit every successful low-level action.

Examples that should normally be sampled or aggregated:

- every file read;
- every pointer click;
- every UI query;
- every scheduler poll;
- every successful primitive with no operational significance.

## Privacy boundary

Runtime-origin telemetry MUST NOT expose user content.

Forbidden:

- command text;
- file contents;
- clipboard text;
- prompts/chat bodies;
- URLs containing secrets;
- cookies/tokens/authorization headers;
- screenshots/images;
- form input;
- email/message bodies;
- raw stdout/stderr by default.

Use symbolic fields:

- stable error code;
- stable error fingerprint;
- component;
- operation;
- duration;
- retry count;
- recoverable flag;
- opaque/hash identifiers where appropriate.

Never use a raw exception message or stack trace as `errorFingerprint`.

## Cloud schema mapping

The Cloud v1 envelope is acceptable:

```text
eventId
eventType
eventVersion
occurredAt
producer
severity
component
componentVersion

operation?
errorCode?
errorFingerprint?
durationMs?
retryCount?
recoverable?
correlationId?
taskId?
runId?
attributes?
```

Runtime-specific guidance:

- `componentVersion` = exact Runtime version;
- `component` should use stable names such as `runtime`, `primitive.fs`, `provider.desktop`, `scheduler`;
- `operation` must be symbolic, never raw command/user input;
- `errorCode` should reuse stable Runtime codes when available;
- `errorFingerprint` should be low-cardinality and content-free;
- `correlationId` should follow the logical request/task chain, not a transient transport session;
- `attributes` remain bounded scalars.

## Delivery semantics

Cloud requires at-least-once delivery and dedupe by `eventId`.

The Desktop Bridge owns:

- batching 1–100 events;
- retry/backoff;
- local telemetry spool if desired;
- device authentication;
- Cloud response handling;
- event dedupe identity during retransmission.

Runtime execution must continue even if the telemetry queue is unavailable or full.

## Future 1.x Runtime enrichment

Do not create a fourth large public protocol solely for telemetry.

Prefer incremental enrichment of existing operational surfaces:

1. stable symbolic error codes/fingerprints;
2. correlation/causation metadata where already available;
3. explicit generatedAt/freshness;
4. terminal outcome receipts suitable for projection;
5. additional privacy-safe diagnostics aggregates.

Only if real Desktop/Cloud evidence proves snapshots are insufficient should a dedicated local Runtime telemetry/event subscription be proposed through the normal Contract Request process.

## Acceptance criteria

The Runtime/Cloud integration is conformant when:

1. Runtime works normally with Cloud completely unavailable;
2. Runtime never stores Cloud device credentials;
3. Desktop can derive useful health/error/version telemetry from public Runtime surfaces;
4. no user content is uploaded in Provider Observability;
5. repeated delivery is idempotent in Cloud;
6. telemetry cannot mutate Task/Process/Schedule state;
7. Cloud never treats telemetry as proof of execution;
8. producer attribution remains semantically correct.

## Summary

Cloud's `PROVIDER_OBSERVABILITY_V1` contract is architecturally sound.

The required correction is **transport ownership**:

> Runtime produces facts; Desktop Cloud Bridge transports them; Cloud stores/aggregates them.

This keeps OWL Runtime independently runnable, offline-safe, and free of control-plane coupling.
