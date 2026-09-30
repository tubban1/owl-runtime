# Encrypted Metadata Store v1

Status: normative implementation gate for OWL LAB 1.x local production storage.

## Decision
Production local metadata MUST use encrypted SQLite in the SQLCipher-compatible profile implemented by SQLite3MultipleCiphers (`cipher=sqlcipher`, `legacy=4`). This is a compatibility profile and does not claim that OWL Runtime links the Zetetic SQLCipher library. Plain SQLite is allowed only for tests/development fixtures explicitly marked non-production. The public Storage Runtime contract does not change.

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
Existing plaintext state/owl.db is migrated by copy, never encrypted destructively in place: acquire migration authority; validate and checkpoint the source; create a new SQLCipher-compatible encrypted database with the Keychain-backed key; copy transactionally; validate schema, row counts and integrity; fsync; atomically activate; reopen through the encrypted provider and verify again. The plaintext source is retained only as an operation-scoped recovery generation while activation is in progress and is removed immediately after the encrypted generation authenticates successfully. An interrupted migration MUST restore a known-good source/generation and MUST NOT silently initialize an empty database.

## Key rotation
Rotation stages a new random Keychain key, creates and verifies a new encrypted database generation under that key, atomically activates the generation, then activates the staged Keychain key. During the operation the prior database generation and prior Keychain key are retained as recovery state. Activation failure rolls both back to the known-good pair; successful post-activation authentication removes the recovery generation and staged/recovery Keychain entries.

## Required conformance
Production release gates MUST prove encrypted header, correct-key open, wrong/missing-key fail-closed, no plaintext fallback, restart persistence through Keychain retrieval, lossless plaintext migration, interrupted-migration recovery, successful key rotation, rotation rollback on activation failure, and no key material or absolute database path in public DTOs.

## Desktop boundary
Desktop is a Storage Manager client, not deletion authority. It may display usage, artifact metadata, retention state, reclaimable bytes, legacy inventory and health; request dry-run cleanup; request confirmed Runtime GC; pin/unpin artifacts; and initiate governed legacy migration. Desktop MUST NOT directly unlink Runtime storage files or modify owl.db.
