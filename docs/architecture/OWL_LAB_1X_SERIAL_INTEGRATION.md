# OWL LAB 1.x Serial Integration Program

Status: **Normative for 1.x integration work**

## Brand and product topology

**OWL LAB** is the umbrella brand.

```text
OWL LAB
├── OWL Runtime
├── OWL Desktop
└── OWL Cloud
    └── Worker product surface
```

"OWL Platform" may remain as the name of the integrated ecosystem, but product UI, documentation headers and release language use **OWL LAB** as the brand.

Ownership is not flat:

```text
Product UX          OWL Desktop / Worker
Control plane       OWL Cloud
Execution authority OWL Runtime
```

Worker is not a second execution authority. Worker product capability converges into OWL Cloud and delegates execution semantics to Runtime.

## Why integration is serial

1.x integration is **not** developed as three independent product lines racing toward main.

Every downstream layer consumes a frozen, tested upstream contract.

```text
Runtime
  ↓ freeze
Desktop
  ↓ freeze
Cloud
  ↓
Platform E2E release
```

A downstream repo may prepare mocks or contract fixtures while waiting, but it must not invent missing upstream semantics.

## Canonical sequence

### Phase R — Runtime

R1 Request Replay — complete on stacked 1.x line  
R2 Execution Revision — complete  
R3 Tested Activation — complete  
R4 Approval Resume — complete  
R5 Typed Public DTO — complete  
R6 Schedule Pause/Resume — green on exact head `17c2b5ecc68d7d042b9309b88b86e653a3a4e35f`  
R7 Storage Foundation v1 — current phase  
R8 Retention + GC v1  
R9 Legacy migration (.computer-mcp / .agentos)  
R10 Runtime integration freeze

Runtime exit gate:

- complete 1.x public DTO surface;
- all durable state has explicit ownership;
- no permanent API exposes physical filesystem paths;
- storage migration and reconciliation are tested;
- CI green on exact integration head;
- release candidate soak remains isolated from mutable 1.x work.

### Phase D — Desktop

Desktop work starts only after Runtime Integration Freeze.

Required closure:

- consume frozen Runtime DTOs, events and ArtifactRef;
- mandatory OWL LAB Cloud login + device enrollment;
- Agent Inbox / Skill repair / approvals use public Runtime APIs only;
- Storage Manager is UX/policy only; Runtime remains deletion authority;
- explicit needs-attention / reconciliation for retention gaps and storage corruption;
- production packaging, signing, updater, crash recovery and local E2E;
- branding normalized to OWL LAB / OWL Desktop.

Desktop exit gate:

- exact Runtime provider SHA pinned;
- clean install → login → enrollment → Runtime ready;
- restart/reconnect/reconciliation tested;
- no direct parsing of Runtime private files;
- release artifact built and smoke-tested.

### Phase C — Cloud

Cloud work starts only after Desktop Integration Freeze.

Required closure:

- identity and organization authority;
- Cognito/login bootstrap;
- device enrollment and grants;
- RemoteCommand durable control plane;
- presence, audit and health projection;
- Worker UX/state migrated into Cloud without duplicating Runtime execution semantics;
- cloud artifact provider implements the same ArtifactRef contract;
- Frankfurt end-to-end path verified.

Cloud exit gate:

```text
User login
→ Cloud bootstrap
→ Desktop enrolls device
→ credential stored in OS vault
→ Cloud RemoteCommand
→ Desktop
→ OWL Runtime
→ runtimeTaskId
→ Cloud accept
→ event / telemetry
→ disconnect
→ reconnect
→ reconciliation
```

## Cross-repo invariants

1. **Runtime owns execution semantics.**
2. **Desktop owns local product UX, never canonical execution state.**
3. **Cloud owns identity/control-plane state, never local Task/Schedule truth.**
4. **Worker is a Cloud product surface, not a second scheduler/executor.**
5. **Contracts flow downstream; downstream repos do not patch around missing upstream contracts.**
6. **All durable artifacts use ArtifactRef, never permanent filesystem paths.**
7. **Secrets belong in an OS/cloud secret provider, not general state storage.**
8. **Reconciliation is explicit; consumers never skip gaps by jumping to newest state.**

## Branch and PR discipline

The 1.x Runtime closure remains a stacked chain until the integration branch is intentionally flattened or retargeted.

Do not fold downstream commits backwards into evidence-pinned earlier PR heads.

For each phase:

1. freeze exact upstream SHA;
2. run repository-level gates;
3. record consumer evidence;
4. promote/merge in sequence;
5. only then start the next repository's mutable integration phase.

## Current decision

The next mutable development target is **OWL Runtime R7: Storage Foundation v1**.

OWL Desktop and OWL Cloud remain integration consumers until Runtime R10 is frozen. Existing open PRs may be reviewed and rebased for compatibility, but new cross-boundary semantics must not be invented there.
