# ADR-0005: Drain Before Replacement and Never Silently Steal Workspace Ownership

Status: Accepted

## Context

Production Runtime upgrades and cross-Chat workspace contention require more than locks. A Runtime needs a way to stop admitting new side effects while existing work reaches a safe boundary. Competing agents also need a visible ownership-transfer protocol.

## Decision

Introduce an in-process Runtime lifecycle with RUNNING and DRAINING states.

During DRAINING, new side-effecting work is rejected while already admitted Task runs may finish. Scheduler and Loop Controller stop launching new work.

Workspace takeover uses an explicit protocol:

1. request takeover
2. current ownership snapshot is recorded
3. handoff requires explicit confirmation
4. handoff refuses leases pinned by managed processes
5. takeover requires a second explicit confirmation

There is no normal silent lease stealing.

## Alternatives

- immediately terminate the Runtime during upgrade
- allow new work until process exit
- force-release workspace ownership on request
- treat MCP transport disconnect as automatic authorization to steal ownership

## Consequences

- maintenance can distinguish new work from in-flight work
- upgrade orchestration has a stable drain primitive
- cross-Chat takeover becomes reviewable and durable
- long-running processes remain visible blockers
- future blue-green switching can build on the same lifecycle instead of inventing a separate mechanism
