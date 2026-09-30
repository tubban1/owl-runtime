# Schedule Pause / Resume v1

Status: **OWL Runtime 1.x Integration Closure R6 candidate**

## Purpose

Pause is not cancel.

R6 gives Desktop/Worker a durable way to temporarily stop recurrence while preserving the Schedule identity, trigger, run history, Task template and policy.

## Pause

`schedules.pause`:

- preserves the Schedule ID;
- records `pausedAt`;
- checkpoints the prior `nextRunAt` as `pausedNextRunAt`;
- sets `enabled=false`;
- clears live `nextRunAt`;
- does not delete history or the Task template;
- is idempotent.

Runtime rejects pause while a scheduler occurrence/active Task is still being reconciled. This prevents a concurrent scheduler write from silently overwriting the pause checkpoint.

## Resume

`schedules.resume` accepts:

```json
{
  "scheduleId": "schedule_...",
  "missedRunPolicy": "skip"
}
```

`missedRunPolicy` defaults to `skip`.

If the checkpoint is still in the future, Runtime preserves it.

If the checkpoint elapsed while paused:

- `skip` computes the next future recurrence;
- `catch_up` is explicit and schedules an immediate occurrence.

For an elapsed one-time Schedule, `skip` fails with `SCHEDULE_RESUME_NO_FUTURE_OCCURRENCE`; the caller must explicitly request `catch_up` or create a new Schedule.

Resume still enforces `maxRuns` and `endAt`.

## Cancel remains terminal

`schedules.cancel` clears pause metadata and remains distinct from pause. A cancelled/completed Schedule cannot be revived through `schedules.resume`.

## Public DTO

`PublicScheduleV1` adds:

- `pausedAt`;
- `pausedNextRunAt`.

## Capability

```text
extensions.schedulePauseResume.version = 1
extensions.schedulePauseResume.defaultMissedRunPolicy = "skip"
extensions.schedulePauseResume.explicitCatchUp = true
```

## Conformance

`npm run verify:schedule-pause-resume` proves:

- identity is preserved;
- pause is idempotent;
- future checkpoint is retained;
- missed interval occurrences are skipped by default;
- catch-up requires explicit opt-in;
- elapsed one-time skip fails closed;
- cancel cannot be mistaken for pause/resume.
