# OWL LAB Storage Foundation v1

Status: **Normative 1.x storage protocol**

## Purpose

Storage Foundation v1 defines durable identity, lifecycle, portability and cleanup rules for Runtime-generated state and artifacts.

It is not a disk-cleanup feature.

The protocol must work across:

- local macOS Runtime;
- OWL Desktop;
- OWL Cloud;
- Cloud Worker;
- future object-storage providers.

## Logical data root

The macOS product data root is:

```text
~/Library/Application Support/OWL LAB/
├── state/
│   └── owl.db
├── objects/
├── staging/
├── logs/
├── cache/
├── runtime/
├── backups/
└── storage-manifest.json
```

This is an implementation detail, not a public artifact identity.

Business code must depend on storage interfaces, not absolute paths.

## Storage providers

```text
StorageRoot
├── MetadataStore
├── ObjectStore
├── StagingStore
├── LogStore
├── CacheStore
└── SecretStore
```

Default local mapping:

- MetadataStore → SQLCipher-compatible encrypted SQLite via SQLite3MultipleCiphers (production default)
- ObjectStore → content-addressed filesystem
- StagingStore → mutable filesystem workspace
- SecretStore → macOS Keychain

Future cloud mapping may use PostgreSQL + S3-compatible object storage + KMS/Secrets Manager without changing public ArtifactRef semantics.

### Local MetadataStore authority

For OWL LAB 1.x local Runtime, the authoritative storage metadata database is:

```text
state/owl.db
```

It stores Storage schema migrations, CAS object identity/state, logical Artifact references, retention lifecycle and storage settings. The legacy `state/storage-references.json` format is an import source only: it is imported idempotently into SQLite and retained until governed cleanup.

Runtime 1.x keeps the Node.js **22.13.0 or newer** baseline, gated at the minimum baseline and current Node 24. Production local metadata additionally requires the native `better-sqlite3-multiple-ciphers` binding configured for the SQLCipher-compatible `legacy=4` profile. Development/test fixtures may use plaintext SQLite semantics, but production must fail closed if the encrypted provider cannot authenticate.

SQLite metadata contains no credentials or secret tokens. Secrets remain in Keychain or a cloud secret provider. Plain SQLite must not be described as database-level encrypted.

## Core invariants

1. Durable artifact identities and Runtime-internal storage APIs never expose physical filesystem paths. Explicit user/workspace paths used by computer actions are not Artifact identity.
2. Durable objects are immutable and content-addressed.
3. Object deletion is allowed only when no live durable reference remains.
4. Runtime is the sole storage lifecycle authority for Runtime-owned data.
5. Staging is mutable working state; ObjectStore is immutable committed state.
6. Logs are operational data and are never treated as durable evidence.
7. Secrets and tokens are never stored as ordinary Runtime metadata/artifacts.

## Artifact identity

Logical artifact identity is distinct from object digest.

```ts
export type ArtifactRef = {
  artifactId: string;
  objectId: string;
  digest: `sha256:${string}`;
  mediaType: string;
  sizeBytes: number;
  createdAt: string;
  retentionClass: RetentionClass;
  provenance?: {
    taskId?: string;
    executionRevisionId?: string;
    evidenceId?: string;
  };
};
```

Multiple ArtifactRef records may point to one physical CAS object.

This permits content deduplication while preserving different owners, retention policies, ACLs and provenance.

## Content-addressed object store

Object bytes are addressed by SHA-256.

Example physical layout:

```text
objects/
└── 8a/
    └── 8ab3...
```

Once committed, an object is immutable.

Editing an artifact creates a new digest/object and a new or revised logical ArtifactRef.

## Commit protocol

Canonical local commit flow:

```text
write staging temp
→ fsync
→ calculate SHA-256
→ commit immutable object
→ persist metadata/reference transaction
→ mark staging reclaimable
```

Recovery must tolerate:

- object exists but metadata commit failed;
- metadata reference exists but object is missing;
- interrupted migration;
- stale staging;
- duplicate object writes.

## Retention classes

Recommended default policy:

| Class | Default |
|---|---:|
| cache / re-downloadable | 7 days |
| completed Task staging | 7 days |
| ordinary intermediate artifact | 30 days |
| logs | 30 days + size rotation |
| failed / needs_attention debugging payload | 30 days |
| observation raw payload | 30–90 days |
| user-saved artifact | until explicit delete |
| Task / Schedule / Approval metadata | long-lived |
| Execution Revision / Activation / audit digest | long-lived |

Retention policy belongs primarily to the **logical reference**, not the physical CAS object.

The same object may simultaneously be referenced by temporary Task output, durable evidence and a user-pinned artifact.

## Lifecycle

```text
ACTIVE
  ↓ policy/TTL
EXPIRED
  ↓ retention evaluation
RECLAIMABLE
  ↓ grace period
GC_PENDING
  ↓ final reference/hold check
DELETED
```

Overrides:

- PINNED
- AUDIT_HOLD / LEGAL_HOLD

Deletion is never based on ref_count alone without a final authoritative reference check.

## Garbage collection

A physical object is deletable only when all are true:

- no live ArtifactRef/ObjectReference exists;
- no audit/legal hold applies;
- grace period elapsed;
- object is not required by an active migration/reconciliation operation.

Desktop may request cleanup. Desktop must not directly delete Runtime-owned objects.

## Evidence and logs

These categories are distinct:

```text
LOG
CACHE
STAGING
ARTIFACT
EVIDENCE_PAYLOAD
EVIDENCE_DIGEST
AUDIT_RECORD
```

Evidence payloads may expire according to policy.

Evidence digest + provenance + required audit metadata remain durable when the verification model requires them.

## Storage reconciliation

Runtime provides a storage reconciliation operation that detects at minimum:

- metadata reference → missing object;
- unreferenced object;
- digest mismatch/corruption;
- stale staging;
- incomplete migration;
- reference-count mismatch.

Health states:

```text
healthy
degraded
needs_attention
```

Reconciliation must fail closed for missing/corrupt durable evidence. It must never silently skip to a newer object/state.

## Encryption

See also: `ENCRYPTED_METADATA_STORE_V1.md` for the normative production encryption and migration gate.

Production local metadata uses **SQLCipher-compatible encrypted SQLite** through SQLite3MultipleCiphers with the explicit `cipher=sqlcipher`, `legacy=4` profile. This describes the on-disk compatibility mode, not a claim that OWL Runtime links the Zetetic SQLCipher library. Plain SQLite is not an accepted production backend. The storage abstraction remains provider-neutral so tests and future cloud deployments can use other implementations.

Local production requirements:

- MetadataStore → SQLite3MultipleCiphers in the SQLCipher-compatible `legacy=4` full-database encryption profile;
- database key → cryptographically random, device-scoped secret stored in macOS Keychain; never in the database, config files, environment snapshots, logs, or source control;
- key derivation / cipher parameters → explicit and versioned, without persisting key material;
- open → fail closed when the key is absent, invalid, or the database cannot be authenticated; never silently fall back to plaintext SQLite;
- new databases → encrypted from first creation; plaintext-first-then-convert is forbidden for production;
- existing plaintext metadata → migrate through a verified encrypted-copy workflow, validate integrity and record counts, atomically activate the encrypted database, retain the plaintext source only as operation-scoped recovery state during activation, then remove it immediately after successful encrypted reopen/verification;
- key rotation → stage a new Keychain key, create/verify a new encrypted generation before activation, retain old key + old generation as operation-scoped recovery state, and roll both back together on activation failure;
- credentials/secrets → Keychain or cloud secret provider, not SQLCipher merely because the database is encrypted;
- backups containing metadata → encrypted with equivalent or stronger protection;
- temporary SQLite/WAL/SHM files must remain under the protected product data root and must not create plaintext metadata spill files.

The SQLCipher-compatible encrypted database protects data at rest against offline copying/theft of the database. It does not protect data after an authorized, unlocked Runtime process has obtained the key. Runtime authorization, OS account security, Keychain access control and least-privilege file permissions remain separate required controls.

ObjectStore payload encryption is a separate concern. Sensitive durable objects should use provider-level or per-object authenticated encryption with versioned KeyRef metadata; the database key must not be reused as an object-encryption key.

## Legacy migration

Legacy roots such as:

- `~/.computer-mcp`
- `~/.agentos`

must not be deleted directly.

Migration pipeline:

```text
inventory
→ classify
→ hash
→ deduplicate
→ migrate durable objects/metadata
→ verify references
→ mark legacy bytes reclaimable
→ user-visible cleanup approval
→ delete
```

Inventory record:

```ts
type LegacyStorageInventoryItem = {
  source: "computer-mcp" | "agentos" | "owl-runtime";
  relativePath: string;
  sizeBytes: number;
  modifiedAt: string;
  inferredType: string;
  digest?: `sha256:${string}`;
  migrationDecision: "migrate" | "discardable" | "review";
  confidence: number;
};
```

Unknown content is reviewed, not automatically deleted.

## Desktop Storage Manager contract

Desktop responsibilities:

- display storage usage;
- display reclaimable data;
- configure user retention policy;
- pin/unpin artifacts;
- request cleanup;
- present migration/reconciliation needs-attention state.

Runtime responsibilities:

- classification;
- authoritative reference evaluation;
- retention eligibility;
- GC execution;
- reconciliation;
- migration safety.

Hard invariant:

> Only Runtime Storage Authority may determine or execute deletion of Runtime-owned durable objects.

## 1.x delivery order

S1 model + invariants  
S2 ArtifactRef v1  
S3 local CAS ObjectStore  
S4 reference/retention model  
S5 GC + grace period  
S6 reconciliation  
S7 legacy inventory/migration  
S8 Desktop Storage contract  
S9 migration/integration tests  
S10 SQLite MetadataStore authority + legacy JSON import  
S11 Runtime storage/public contract freeze
S12 SQLCipher-compatible production MetadataStore + Keychain key authority + encrypted migration/conformance
S13 Desktop Storage Manager product integration (OWL Desktop 1.0)

S13 starts only after S12 is green on the exact Runtime integration SHA. Desktop 1.0 release is not storage-management complete until its Storage Manager consumer passes the Runtime contract/E2E gate. The Desktop UI may perform user-visible delete/cleanup actions only by requesting Runtime dry-run/confirmed GC; it never directly unlinks Runtime-owned storage or mutates `owl.db`.
