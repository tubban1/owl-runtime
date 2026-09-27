# Multi-Agent Soak Testing

AgentOS Runtime uses long-duration soak tests to validate behavior that short unit and integration tests cannot reliably expose:

- deadlocks
- workspace lease leaks
- managed process leaks
- duplicate Scheduler/Loop side effects
- task replay duplication
- resource-wait regressions
- event-loop stalls
- sustained memory growth
- adapter instability under concurrent Runtime activity

The soak harness is intentionally isolated from real production state.

## Profiles

```bash
npm run soak:smoke
npm run soak:2h
npm run soak:6h
npm run soak:24h
```

Profiles differ only in duration and cadence. They use the same correctness checks.

A profile being available does **not** mean it has passed. A roadmap item should only be checked after a real run finishes with:

```json
{
  "success": true,
  "status": "passed"
}
```

## What one soak run exercises

The harness creates isolated workspaces:

```text
session A  → repo A
session B  → repo B
session C  → repo C

Scheduler  → dedicated scheduler repo
Loop       → dedicated loop repo
contention → shared repo
process    → managed-process repo
```

This separation is deliberate.

Independent-session throughput must not be polluted by expected Scheduler/Loop workspace contention. Same-workspace contention is tested separately and must produce `WORKSPACE_BUSY`.

The run also periodically executes:

- managed write processes
- browser Session Adapter fixtures
- WeChat Session Adapter fixtures

Long profiles repeat adapter fixtures periodically.

## Correctness gates

A run fails if any of these are observed:

- an independent repository action fails
- a competing write unexpectedly bypasses workspace ownership
- Scheduler side-effect count differs from Scheduler `runCount`
- Loop side-effect count differs from the expected phase/cycle count
- duplicate durable Task IDs appear
- non-terminal Tasks remain after settling
- managed processes remain running
- workspace leases remain leaked
- a managed process fails to exit
- an adapter fixture fails or never completes
- RSS growth exceeds the configured profile limit

This means "the process stayed alive" is not enough to pass.

## Metrics

The report records:

- foreground iterations
- independent action count/errors
- resource wait max/p95
- contention attempts/rejections
- managed process starts/exit failures
- adapter fixture runs
- event-loop lag max/p95
- RSS baseline/current/max
- Task/process/lease counts
- Scheduler and Loop side-effect counts

## Reports

Reports are written under:

```text
.soak-results/
```

The latest heartbeat/final result is also written to:

```text
.soak-results/latest.json
```

The directory is ignored by Git.

Inspect the latest run with:

```bash
npm run soak:status
npm run soak:status -- --json
```

The harness writes periodic heartbeats, so a long run can be inspected without attaching to its stdout stream.

## Custom short runs

For development of the harness itself:

```bash
SOAK_PROFILE=custom \
SOAK_DURATION_MS=120000 \
SOAK_FOREGROUND_STEP_MS=500 \
npm run soak:smoke
```

The named release-gate profiles should not be replaced by a shorter custom run when recording 2h/6h/24h completion.

## Adapter behavior

The smoke profile starts one adapter fixture suite.

Long profiles periodically run:

```text
verify:session-adapters
verify:wechat-session
```

The Session Adapter verifier prefers isolated Chrome for Testing when available, preventing normal Chrome profile state and macOS App-management prompts from contaminating the soak result.

Use `SOAK_SKIP_ADAPTERS=true` only while debugging the harness. An official long-duration pass should include adapters.

## Memory threshold

The harness checks RSS growth, not absolute RSS.

Default allowed growth:

- smoke: 512 MiB
- long profiles: 1024 MiB

Override for diagnostic experiments with:

```text
SOAK_MAX_RSS_GROWTH_MB
```

A raised threshold should not be used to hide an unexplained monotonic leak.

## Session lease recovery

A ChatGPT network/stream recovery can leave an MCP transport session appearing alive after the visible chat has already moved to a new transport.

Session-only workspace leases therefore support both:

- known-disconnected session reclamation
- conservative same-Runtime idle-session reclamation

Durable Task, Process, and Transaction leases are never reclaimed merely because the owning MCP transport is idle.

Long workflows should use durable Task/Process/Transaction ownership rather than relying on a raw transport-session lease.

## 1.0 release use

Before AgentOS Runtime 1.0:

1. smoke must pass on every release candidate
2. 2-hour soak must pass
3. 6-hour soak must pass
4. 24-hour soak must pass
5. final reports must show no leaked Tasks/processes/leases and no duplicate side effects

A long-duration run is evidence for a release gate, not a replacement for the focused conformance/recovery verifier suite.
