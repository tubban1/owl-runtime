# Encrypted Metadata Store v1

Status: normative implementation gate for OWL LAB 1.x local production storage.

## Decision
Production local metadata MUST use SQLCipher-backed SQLite. Plain node:sqlite is allowed only for tests/development fixtures explicitly marked non-production. The public Storage Runtime contract does not change.

## Key boundary
- Generate a cryptographically random 256-bit database key on first production initialization.
- Persist key material only in macOS Keychain under the stable OWL Runtime application identity; never in owl.db, manifests, environment snapshots, logs, diagnostics, or source control.
- Persist only non-secret key metadata: provider, keyId, keyVersion, cipher schema version.
- Database and object-encryption keys are independent.
- Missing, unavailable, or invalid Keychain material is fail-closed. There is no plaintext fallback.

## Database boundary
- state/owl.db, WAL, SHM and backups are encrypted at rest.
- A production database MUST NOT begin with the plaintext SQLite format 3 header.
- Cipher parameters are explicit and versioned.
- Integrity is checked before accepting a database generation as authoritative.
- File permissions remain 0600; parent directories remain 0700.

## Migration
Existing plaintext state/owl.db is migrated by copy, never encrypted destructively in place: acquire migration authority; validate source read-only; create a new SQLCipher database with the Keychain-backed key; copy transactionally; validate schema, row counts, reference/object invariants and integrity; fsync; atomically activate; reopen through the encrypted provider and verify again; retain the plaintext source only for the governed rollback/grace window and then make it reclaimable through Runtime GC. An interrupted migration MUST leave a known-good generation recoverable and MUST NOT silently initialize an empty database.

## Key rotation
Rotation creates and verifies a new encrypted generation under a new Keychain key/version before atomic activation. The old generation remains recoverable for the bounded rollback window and is then retired through governed cleanup.

## Required conformance
Production release gates MUST prove encrypted header, correct-key open, wrong/missing-key fail-closed, no plaintext fallback, restart persistence through Keychain retrieval, lossless plaintext migration, interrupted-migration recovery, safe key rotation, and no key material or absolute database path in public DTOs.

## Desktop boundary
Desktop is a Storage Manager client, not deletion authority. It may display usage, artifact metadata, retention state, reclaimable bytes, legacy inventory and health; request dry-run cleanup; request confirmed Runtime GC; pin/unpin artifacts; and initiate governed legacy migration. Desktop MUST NOT directly unlink Runtime storage files or modify owl.db.
