# Public Runtime DTO v1

Status: **OWL Runtime 1.x Integration Closure R5 candidate**

## Purpose

Cross-repo consumers must not infer Runtime truth from `unknown` response shapes.

R5 defines versioned DTO v1 contracts for the platform-critical execution surfaces while deliberately keeping implementation details opaque.

## Typed surfaces

```text
PublicTaskSummaryV1
PublicTaskDetailV1
PublicRunReceiptV1
PublicObservationV1
PublicVerificationReceiptV1
PublicApprovalV1
PublicScheduleV1
PublicDeleteReceiptV1
```

Every DTO carries:

```json
{ "schemaVersion": 1 }
```

Execution Revision and Activation keep their own protocol `version: 1` identities and are referenced from Task DTOs.

## Stable fields

The public contract freezes the fields consumers need for reconciliation:

- durable IDs;
- task/schedule/approval state;
- timestamps;
- run count;
- Execution Revision digest;
- Execution Activation receipt;
- Task provenance;
- step state/attempt count/error;
- Observation identity/channel/provider/state;
- Verification identity/spec/status/time;
- exact approval owner task/step;
- schedule recurrence state and last/active Task IDs.

## Intentionally opaque

R5 does not freeze internal implementation structures for:

- encrypted storage metadata;
- staging internals;
- memory internals;
- full provider payloads;
- raw evidence payloads.

Those may evolve without forcing every Desktop/Cloud/Worker consumer to rev.

## Run receipt normalization

`tasks.run` now returns one stable `PublicRunReceiptV1` shape even when the Task was already completed. Consumers no longer need to branch on two unrelated response schemas.

## Public TypeScript API

Core RuntimeClient methods for Tasks, Schedules and Approvals no longer return `Promise<unknown>`.

HTTP RuntimeClient exposes the same typed DTOs as the in-process client.

## Capability

```text
extensions.typedPublicDto.version = 1
```

## Conformance

`npm run verify:public-dto` validates runtime schema markers across Task summary/detail, run receipt, Observation, Verification, Approval and Schedule surfaces.

`npm run build:types` proves these contracts are present in the packaged public declaration surface.
