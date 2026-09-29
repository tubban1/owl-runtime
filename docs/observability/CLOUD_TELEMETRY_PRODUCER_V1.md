# Runtime → Cloud Telemetry Producer v1

Status: **Normative for OWL 1.0 integration**.

Canonical provider contract: `owl-cloud/docs/contracts/PROVIDER_OBSERVABILITY_V1.md`.

Runtime owns execution truth. It emits privacy-bounded operational telemetry; telemetry never replaces Task/Run/Process state.

## Required producer responsibilities

Runtime should emit durable or best-effort telemetry for:

- task/run started and terminal outcomes;
- primitive/provider failures;
- resource waits/timeouts;
- retries and recovery;
- approval requested/approved/denied outcomes;
- Runtime crash/restart/recovery;
- health transitions;
- latency summaries for important operations.

Use Cloud's common fields:

- eventId, eventType, eventVersion, occurredAt;
- producer=`owl-runtime`;
- severity;
- component/componentVersion;
- operation;
- errorCode/errorFingerprint;
- durationMs/retryCount/recoverable;
- correlationId/taskId/runId;
- bounded scalar attributes.

## Privacy

Never emit user content, file contents, prompts, chat bodies, clipboard/screen contents, passwords, tokens, cookies, authorization headers, or raw secrets.

Error fingerprints must be symbolic/stable, not raw exception text.

## Delivery boundary

Runtime does not talk directly to customer Cloud identity APIs.

Runtime may hand telemetry to Desktop/Cloud Bridge for authenticated batched delivery to:

`POST /device/v1/telemetry`

Telemetry delivery is at-least-once, deduped by eventId, and must never block local execution.

## Volume policy

Always retain failures, crashes, health transitions, retries/resource waits, and terminal task/run outcomes.

High-frequency successful primitives should be locally aggregated or sampled rather than sending every low-level action.

## Authority

Cloud/provider dashboards may aggregate telemetry, but Runtime remains the sole authority for execution state.
