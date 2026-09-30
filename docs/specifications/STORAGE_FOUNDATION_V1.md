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

- MetadataStore → SQLite
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

Runtime 1.x requires Node.js **22.13.0 or newer** so the built-in `node:sqlite` provider can be used without a native third-party database dependency. Compatibility is gated on the minimum baseline and current Node 24.

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

Storage v1 defines provider abstractions, not a mandatory SQLCipher dependency.

- credentials/secrets → Keychain or cloud secret provider;
- SQLite → structured non-secret metadata by default;
- ObjectStore → optional provider-level/per-object encryption;
- encryption metadata may include KeyRef/key version identifiers.

Do not call SQLite "encrypted" unless an actual database-encryption provider is active.

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

Only after S1–S11 and Runtime public-contract freeze may Desktop Storage Manager become a mutable product implementation target.
