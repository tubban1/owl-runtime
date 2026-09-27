# Runtime Durable State Schema

AgentOS Runtime v0.9.14 introduces a versioned schema contract for the durable Runtime state root.

The state root remains:

```text
production  -> ~/.computer-mcp
development -> ~/.computer-mcp-dev
test        -> ~/.computer-mcp-test
```

## Manifest

A migrated state root contains:

```text
runtime-state.json
```

with metadata similar to:

```json
{
  "format": "agentos-runtime-state",
  "schemaVersion": 1,
  "createdAt": "...",
  "updatedAt": "...",
  "migrationHistory": [
    {
      "id": "0001-bootstrap-state-manifest",
      "from": 0,
      "to": 1,
      "appliedAt": "...",
      "runtimeVersion": "0.9.14",
      "rollbackCompatible": true
    }
  ]
}
```

The manifest contains schema metadata only. It is not a generic user-data store and should not contain secrets.

## Legacy schema 0

A state root with no manifest is interpreted as **schema 0 / legacy-unversioned**.

v0.9.14 can read schema 0 and provides one migration:

```text
0001-bootstrap-state-manifest
0 → 1
```

This migration creates only the manifest. It does not rewrite Task, Memory, Scheduler, Loop, Session, Process, Browser, WeChat, or other durable data.

Therefore the migration is declared:

- auto-safe
- rollback-compatible
- idempotent

## Runtime Skill

State schema operations are exposed through the L2 Skill:

```text
runtime.state
```

Operations:

- `status`
- `plan`
- `migrate`

`status` and `plan` are read-only.

`migrate` requires:

- Runtime lifecycle is already `DRAINING`
- `confirm=true`
- every migration in the automatic path is marked auto-safe
- every migration in the automatic path is rollback-compatible

The Primitive ABI is unchanged.

## Migration registry

Each migration declares:

- stable migration ID
- source schema
- target schema
- description
- `autoSafe`
- `rollbackCompatible`
- `idempotent`

The registry must contain exactly one forward migration from every schema version that needs automatic advancement. Cycles, gaps, or multiple competing migrations are treated as registry errors.

## Crash journal

Before a migration writes the new manifest, Runtime writes:

```text
runtime-state-migration.json
```

The journal records the migration being applied.

Manifest updates use temp-file + atomic rename. The journal is removed only after the new manifest is committed.

If Runtime crashes after journal creation:

- the old manifest remains valid
- an idempotent migration may be resumed
- a non-idempotent pending migration is blocked for manual recovery

If the manifest reached the journal target but the process crashed before journal cleanup, the next migration attempt reconciles and removes the already-committed journal.

## Compatibility policy

The Runtime fails closed when the durable state schema is newer than it understands.

A candidate must report:

```text
readable = true
```

before an upgrade can proceed.

Automatic production migration additionally requires:

```text
autoMigrationSafe = true
rollbackCompatible = true
```

This matters because code rollback and state rollback are different operations.

## Code rollback vs state rollback

A release symlink rollback is safe only when migrations already applied by the candidate are compatible with the previous release.

v0.9.14 schema 0 → 1 is compatible because it adds metadata without changing existing store formats.

Future migrations that rewrite durable data must not be labeled rollback-compatible unless the previous supported release can continue to operate correctly.

The automatic upgrade coordinator refuses migrations that do not meet this condition.

## Per-store schemas

The global manifest establishes the Runtime-level contract. Individual stores may later own their own schema versions.

Per-store migration is intentionally not implied by v0.9.14.

## Verification

```bash
npm run verify:state-schema
npm run verify:upgrade-runtime
```

The state-schema verifier covers:

- legacy schema detection
- drain requirement
- explicit confirmation
- migration planning
- crash after journal creation
- idempotent recovery
- atomic manifest write
- future-schema rejection
- malformed-manifest rejection
