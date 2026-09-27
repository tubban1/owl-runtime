# ADR-0004: Production Runs Immutable Releases, Not Source Watchers

Status: Accepted

## Context

Running `tsx watch src/server.ts` while another agent edits the Runtime can restart the tool server mid-task. This couples development changes to production execution and can interrupt unrelated sessions.

## Decision

Production runs compiled `dist/server.js` from immutable release directories managed by launchd. Development uses a separate state root. New releases are health-checked and failed installs roll back to the previous release.

## Alternatives

- run production directly from the Git working tree
- keep `tsx watch` as the production process manager
- rely on users to manually restart after edits

## Consequences

- source edits no longer restart production Jarvis
- code releases and persistent Runtime state have separate lifecycles
- upgrades can evolve toward graceful drain and blue-green handoff
- production self-mutation can be blocked safely
