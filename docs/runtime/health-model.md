# Execution Health Model

Status: **v1 candidate**.

OWL Runtime exposes stable health signals that OWL Worker can render without reverse-engineering Task or Process internals. Runtime reports execution facts; the commercial Worker owns notifications, business labels, time-saved metrics, and end-user presentation.

## States

- `healthy` — execution is ready/running/completed normally
- `degraded` — still operating, but state is transitional or uncertain
- `needs_attention` — a human or external fix is required
- `paused` — intentionally not progressing
- `broken` — execution has failed or a managed dependency was lost

## Sources

The v1 candidate maps:

- Persistent Tasks: running/pending/completed → healthy; blocked → needs_attention; failed → broken; paused/cancelled → paused
- Managed Processes: waiting_input → needs_attention; terminating/waiting_network/unknown → degraded; failed/lost/timed_out → broken
- Approval receipts: pending/expired → needs_attention; denied → paused; consumed → healthy

## Runtime Skill

`runtime.health` supports:

- `status` — health model contract
- `task` — health signal for a task id
- `process` — health signal based on a fresh Process Observation
- `approval` — health signal for an approval id

There is deliberately no `Worker` persistence model in OWL Runtime. A Worker product may combine Task, Schedule, Process, Provider, Auth, and Approval signals and use the same health vocabulary.
