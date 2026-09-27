# AgentOS Runtime Scheduler & Wake Model

Status: **v0.9.6 foundation**

AgentOS Runtime v0.9.6 adds a persistent local scheduler so durable work can continue after the MCP request that created it has returned.

This is deliberately a Runtime capability, not a new L1 Primitive.

```text
L3 Planner / ChatGPT
        |
        v
L2 runtime.schedule
        |
        v
Persistent Schedule Store
        |
        +---- wake ----+
                     |
                     v
             Primitive Task
                     |
                     v
               L1 ISA
                     |
                     v
            Actions / Providers
```

## Why scheduler is above L1

Time, recurrence, wake-up, and lifecycle are orchestration concerns. A Primitive should describe what operation can be performed, not own a multi-hour clock.

Therefore v0.9.6 does **not** add `scheduler.cron` or `wait` to the frozen core Primitive ISA candidate.

The scheduler creates and resumes ordinary Persistent Primitive Tasks.

## Persistent storage

Schedule records are stored by default under:

```text
~/.computer-mcp/schedules/
~/.computer-mcp/schedule.key
```

Records are AES-256-GCM encrypted at rest and files/directories are created with private permissions.

These internal scheduler paths are not added to the general filesystem allowlist.

## Trigger types

### once

Run once at an ISO timestamp:

```json
{
  "kind": "once",
  "at": "2026-09-26T18:00:00+02:00"
}
```

### interval

Wake repeatedly:

```json
{
  "kind": "interval",
  "every_ms": 60000,
  "start_at": "2026-09-26T14:00:00+02:00"
}
```

If `start_at` is omitted, the first wake is one interval after creation. The `runtime.schedule` Skill also accepts `start_immediately=true`.

### daily

Run every day at computer-local time:

```json
{
  "kind": "daily",
  "time": "08:00"
}
```

v0.9.6 intentionally uses the host computer timezone for daily schedules. Explicit IANA timezone scheduling can be added later without changing the Primitive ABI.

## Schedule lifecycle

Each occurrence creates a fresh Persistent Primitive Task from the stored template.

```text
schedule due
    |
    v
create Primitive Task
    |
    v
task_run
    |
    +--> completed/failed/blocked/cancelled
    |        |
    |        v
    |   record occurrence
    |        |
    |        +--> stop_when?
    |        +--> max_runs?
    |        +--> end_at?
    |        +--> calculate next wake
    |
    +--> paused/yielded
             |
             v
       preserve activeTaskId
             |
             v
       wake and resume
```

The existing task runtime still caps one execution slice at 10 minutes. This is not a total schedule duration limit. A yielded task keeps its encrypted state and is resumed by a later wake.

## Long-running monitoring

A CI/deployment monitor should use short polling occurrences rather than one multi-hour HTTP request.

Example concept:

```text
every 30 s
  -> query deployment state
  -> store result in task episodic history
  -> stop_when check.status == "READY"
  -> otherwise schedule next wake
```

The schedule can continue for 30 minutes, 3 hours, days, or longer while the host Runtime is available.

If the MCP request or ChatGPT conversation ends, the schedule remains.

If computer-mcp restarts, persisted schedules are reloaded and due work resumes. If the Mac is powered off, no execution occurs while it is off; overdue schedules are picked up after Runtime startup.

## Recurring collection

Daily/interval Primitive graphs can collect from sources reachable by existing providers, for example:

- web pages through `web.open / web.query / web.session`
- local Git repositories through `git.query`
- authenticated browser sessions where the target site permits it
- shell/API clients through privileged `sys.exec` when explicitly enabled

A daily information collector can write each run's result into task staging, a workspace file, database, or another explicitly configured sink.

## Stop conditions

A schedule can stop when a completed task result matches a declarative condition:

```json
{
  "stop_when": {
    "ref": "check.status",
    "equals": "READY"
  }
}
```

or:

```json
{
  "stop_when": {
    "ref": "check.done",
    "truthy": true
  }
}
```

The reference starts with a task step id followed by an optional result path.

Other termination guards:

```text
max_runs
end_at
manual cancel
one-time completion
blocked/cancelled task safety stop
```

If an occurrence becomes `blocked` because an interrupted state-changing step requires manual review, recurrence is frozen instead of starting a fresh occurrence. This prevents automatic replay of uncertain external side effects.

## Control through the existing Skill tool

No new top-level MCP tool is required.

```text
skill_run("runtime.schedule", { op: "create", ... })
skill_run("runtime.schedule", { op: "list" })
skill_run("runtime.schedule", { op: "status", schedule_id: "..." })
skill_run("runtime.schedule", { op: "cancel", schedule_id: "..." })
skill_run("runtime.schedule", { op: "delete", schedule_id: "..." })
```

This means adding the scheduler does not require a ChatGPT **Refresh Tools** operation when `skill_run` is already connected.

## What v0.9.6 does not claim yet

The scheduler is not an embedded general-purpose LLM planner and does not itself wake a ChatGPT model session.

It also does not yet provide a full stateful automation-loop DSL with:

- branching between graph steps
- cross-occurrence carry variables
- wait-until predicates over arbitrary UI state
- deduplication of already-relayed messages
- model-to-model conversation turn management

Those belong to the next orchestration layer above Persistent Wake.

A ChatGPT ↔ another-agent UI relay is technically reachable with the current desktop/browser/clipboard Primitives, but a robust autonomous relay should use a dedicated stateful Loop Controller rather than repeatedly replaying a static schedule graph.

## Verification

```bash
npm run verify:scheduler
```

The verifier uses isolated encrypted schedule/task stores, creates an interval schedule, executes a real Primitive graph, verifies a result-based stop condition, verifies the generated task, and removes all test state.
