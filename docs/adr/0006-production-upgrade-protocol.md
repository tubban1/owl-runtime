# ADR-0006: Preflight Candidate, Then Drain Before Production Replacement

Status: Accepted

## Context

An immutable release alone does not make upgrades safe. Replacing a running Runtime can interrupt side effects, start incompatible code against persistent state, or leave the `current` symlink pointing at a release that never became healthy.

A second full Runtime using the same state can also be dangerous if it starts Scheduler, Loop, or Process Monitor concurrently.

## Decision

Production upgrades use four explicit phases:

1. build an immutable candidate release
2. start the candidate on an alternate loopback port in DRAINING mode with background controllers disabled
3. use the active Runtime's existing MCP `runtime.control` Skill to drain and wait
4. switch `current`, restart launchd, and verify production health

If post-cutover health fails, switch back to the previous immutable release and verify rollback health.

Each release's `run.sh` resolves its own code directory rather than executing through the `current` symlink.

## Why MCP control

The old Runtime already exposes a governed Skill contract for lifecycle control. Reusing it avoids adding a second unauthenticated local administration surface and keeps upgrade control inside the same audit/contract architecture.

## Why candidate background controllers are disabled

The candidate shares production state only to verify compatibility. It must not become a second executor.

Therefore candidate mode does not start:

- Persistent Scheduler
- Persistent Loop Controller
- Process Monitor

It also starts in DRAINING so ad-hoc side effects are rejected.

## Alternatives

- stop the old Runtime before testing the new code
- run old and candidate fully active against the same state
- add an ad-hoc admin HTTP endpoint
- update `current` first and hope health succeeds
- let release `run.sh` resolve code through `current`

## Consequences

- bad candidates fail before disturbing the active Runtime
- existing side effects reach a safe drain boundary
- rollback has a known immutable target
- the upgrade path remains compatible with v0.9.12 because drain is invoked through MCP
- there is still a short transport reconnection window during launchd replacement
- incompatible persistent-state migrations require a separate schema/migration protocol
