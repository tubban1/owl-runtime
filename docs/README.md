# AgentOS Runtime Documentation

This directory is organized by document purpose rather than release chronology.

## Start here

- [Architecture overview](architecture/overview.md)
- [Layer model](architecture/layers.md)
- [v1.0 roadmap](roadmap/v1.0.md)
- [Production Runtime](operations/production-runtime.md)
- [Concurrency and ownership](architecture/concurrency-and-ownership.md)

## Architecture

Long-lived system design and boundaries.

- [Overview](architecture/overview.md)
- [Layers](architecture/layers.md)
- [Concurrency and ownership](architecture/concurrency-and-ownership.md)
- [Runtime identity](architecture/runtime-identity.md)

## Specifications

Contracts intended to remain stable across implementations.

- [Primitive ABI](specifications/primitive-abi.md)
- [Skill ABI](specifications/skill-abi.md)
- [Embedding Provider Contract](specifications/embedding-provider.md)
- [Session Adapter Contract](specifications/session-adapter.md)
- [Workspace Lease Contract](specifications/workspace-lease.md)
- [Runtime Durable State Schema](specifications/state-schema.md)

## Runtime subsystems

- [Tasks and staging](runtime/tasks-and-staging.md)
- [Scheduler and wake](runtime/scheduler-and-wake.md)
- [Loop controller](runtime/loop-controller.md)
- [Memory overview](runtime/memory/overview.md)
- [Episodic recall](runtime/memory/episodic-recall.md)
- [Semantic memory](runtime/memory/semantic-memory.md)

## Adapters

- [Browser agents](adapters/browser-agents.md)
- [WeChat](adapters/wechat.md)

## Operations

- [Production Runtime](operations/production-runtime.md)
- [Production upgrades](operations/production-upgrades.md)
- [Graceful drain and workspace handoff](operations/graceful-drain-and-handoff.md)
- [Multi-agent soak testing](operations/soak-testing.md)
- [Configuration](operations/configuration.md)
- [Recovery](operations/recovery.md)
- [Fault recovery matrix](operations/fault-recovery.md)
- [Troubleshooting](operations/troubleshooting.md)

## Security

- [Permissions](security/permissions.md)
- [Audit](security/audit.md)
- [Privacy and secrets](security/privacy-and-secrets.md)

## Roadmap

- [v1.0](roadmap/v1.0.md)
- [Post-1.0](roadmap/post-1.0.md)
- [Release checklist](roadmap/release-checklist.md)

## Architecture Decision Records

ADRs explain why important design choices were made, not just what the current code does.

- [ADR index](adr/README.md)
- [ADR-0001: Primitive ISA](adr/0001-primitive-isa.md)
- [ADR-0002: Memory model](adr/0002-memory-model.md)
- [ADR-0003: Durable workspace ownership](adr/0003-workspace-ownership.md)
- [ADR-0004: Immutable production Runtime](adr/0004-production-runtime.md)
- [ADR-0005: Graceful drain and explicit handoff](adr/0005-graceful-drain-handoff.md)
- [ADR-0006: Production upgrade protocol](adr/0006-production-upgrade-protocol.md)
- [ADR-0007: Versioned durable state](adr/0007-versioned-durable-state.md)
- [ADR-0008: Durable side-effect replay](adr/0008-durable-side-effect-replay.md)

## Archive

Historical reviews and superseded design notes live under [archive/](archive/). They remain useful context but are not normative specifications.
