# Runtime → Provider Telemetry v1

Status: **OWL 1.0 producer contract**.

Canonical Cloud contract: `owl-cloud/docs/contracts/PROVIDER_OBSERVABILITY_V1.md`.

## Ownership

Runtime owns execution truth. Runtime produces operational telemetry about its own execution, but it does **not** own Cloud transport and must not receive or persist an OWL Cloud device credential.

Transport path:

```text
OWL Runtime
  → local telemetry sink
  → OWL Desktop
  → authenticated /device/v1/telemetry
  → OWL Cloud Provider Observability
```

Telemetry delivery failure must never block or change Runtime execution semantics.

## Runtime events to emit

Always emit operational telemetry for:

- Runtime start / ready / graceful drain / crash recovery;
- task/run terminal success or failure;
- primitive/provider failures;
- resource wait, contention and timeout;
- process crash/restart/orphan recovery;
- workspace lease conflict/reclamation;
- approval requested/approved/denied/expired;
- persistence/state migration failure;
- browser/provider reconnect or terminal provider failure;
- performance regression / SLO breach.

High-volume successful primitive calls should be aggregated locally or sampled. Do not make Provider Observability an activity recorder.

## Required identity

Every telemetry event uses a stable `eventId`.

When available, include opaque:

- `correlationId`;
- `taskId`;
- `runId`.

Do not replace Runtime-owned IDs with Cloud IDs. Desktop/Cloud bind device and organization identity outside Runtime.

## Errors

Prefer:

- stable `errorCode`;
- stable symbolic `errorFingerprint`;
- `component`;
- `componentVersion`;
- `operation`;
- `durationMs`;
- `retryCount`;
- `recoverable`.

Do not use raw exception text as the fingerprint.

## Privacy

Runtime MUST NOT place the following in provider telemetry:

- prompt/chat/message content;
- clipboard content;
- file contents;
- screen/screenshot contents;
- form/input values;
- cookies;
- passwords;
- API keys/tokens/authorization headers.

Operational names such as primitive name, provider name, OS, architecture, version and symbolic error code are allowed.

## Existing Runtime telemetry

Existing local Runtime metrics/audit/performance data remain local sources. The Cloud telemetry adapter should map selected operational signals into this contract rather than creating a second instrumentation system.

In particular, existing latency telemetry, resource arbitration, lifecycle state, crash recovery and process ownership signals are candidates for the v1 producer adapter.

## Authority boundary

Provider telemetry is observation only. A telemetry event must never be consumed as proof that a task/run/process transition occurred. Canonical Task/Run/Process state remains Runtime-owned.
