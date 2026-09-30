import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  ensureStorageLayout,
  owlLabDataRoot,
  storageLayout,
  type ArtifactRef,
} from "./storageFoundation.js";
import type {
  StorageReference,
  StorageReferenceLifecycle,
} from "./storageRetention.js";

export const STORAGE_METADATA_SCHEMA_VERSION = 1 as const;

export type StorageObjectState = "ACTIVE" | "GC_PENDING" | "DELETED";

export type StorageObjectRecord = {
  objectId: string;
  digest: string;
  sizeBytes: number;
  state: StorageObjectState;
  createdAt: string;
  updatedAt: string;
};

type LegacyStorageReferenceIndex = {
  format: "owl-lab-storage-reference-index";
  version: 1;
  createdAt: string;
  updatedAt: string;
  references: StorageReference[];
};

type ReferenceRow = {
  artifact_id: string;
  object_id: string;
  artifact_json: string;
  lifecycle: string;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
  reclaimable_at: string | null;
  gc_pending_at: string | null;
  deleted_at: string | null;
  pinned_at: string | null;
  hold_reason: string | null;
};

type ObjectRow = {
  object_id: string;
  digest: string;
  size_bytes: number;
  state: string;
  created_at: string;
  updated_at: string;
};

function metadataDbPath(root: string): string {
  return path.join(storageLayout(root).state, "owl.db");
}

function assertLifecycle(value: string): StorageReferenceLifecycle {
  const allowed: StorageReferenceLifecycle[] = [
    "ACTIVE",
    "EXPIRED",
    "RECLAIMABLE",
    "GC_PENDING",
    "PINNED",
    "AUDIT_HOLD",
    "DELETED",
  ];
  if (!allowed.includes(value as StorageReferenceLifecycle)) {
    throw new Error(
      `STORAGE_METADATA_INVALID: unknown reference lifecycle "${value}".`,
    );
  }
  return value as StorageReferenceLifecycle;
}

function assertObjectState(value: string): StorageObjectState {
  if (!["ACTIVE", "GC_PENDING", "DELETED"].includes(value)) {
    throw new Error(
      `STORAGE_METADATA_INVALID: unknown object state "${value}".`,
    );
  }
  return value as StorageObjectState;
}

function safeSize(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("STORAGE_METADATA_INVALID: object size is not a safe integer.");
  }
  return value;
}

function rowToReference(row: ReferenceRow): StorageReference {
  const artifact = JSON.parse(row.artifact_json) as ArtifactRef;
  if (artifact.artifactId !== row.artifact_id) {
    throw new Error(
      "STORAGE_METADATA_INVALID: artifact row identity does not match payload.",
    );
  }
  if (artifact.objectId !== row.object_id) {
    throw new Error(
      "STORAGE_METADATA_INVALID: object row identity does not match payload.",
    );
  }
  return {
    version: 1,
    artifact,
    lifecycle: assertLifecycle(row.lifecycle),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
    reclaimableAt: row.reclaimable_at,
    gcPendingAt: row.gc_pending_at,
    deletedAt: row.deleted_at,
    pinnedAt: row.pinned_at,
    holdReason: row.hold_reason,
  };
}

function rowToObject(row: ObjectRow): StorageObjectRecord {
  return {
    objectId: row.object_id,
    digest: row.digest,
    sizeBytes: safeSize(Number(row.size_bytes)),
    state: assertObjectState(row.state),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function initializeSchema(db: DatabaseSync): void {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS schema_migrations (
      component TEXT NOT NULL,
      version INTEGER NOT NULL,
      applied_at TEXT NOT NULL,
      PRIMARY KEY (component, version)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS storage_objects (
      object_id TEXT PRIMARY KEY,
      digest TEXT NOT NULL UNIQUE,
      size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
      state TEXT NOT NULL CHECK (state IN ('ACTIVE', 'GC_PENDING', 'DELETED')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS storage_references (
      artifact_id TEXT PRIMARY KEY,
      object_id TEXT NOT NULL,
      artifact_json TEXT NOT NULL,
      lifecycle TEXT NOT NULL CHECK (
        lifecycle IN (
          'ACTIVE',
          'EXPIRED',
          'RECLAIMABLE',
          'GC_PENDING',
          'PINNED',
          'AUDIT_HOLD',
          'DELETED'
        )
      ),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      expires_at TEXT,
      reclaimable_at TEXT,
      gc_pending_at TEXT,
      deleted_at TEXT,
      pinned_at TEXT,
      hold_reason TEXT,
      FOREIGN KEY (object_id) REFERENCES storage_objects(object_id)
    ) STRICT;

    CREATE INDEX IF NOT EXISTS idx_storage_references_object
      ON storage_references(object_id);

    CREATE INDEX IF NOT EXISTS idx_storage_references_lifecycle
      ON storage_references(lifecycle);

    CREATE TABLE IF NOT EXISTS storage_settings (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
  `);

  db.prepare(
    `INSERT OR IGNORE INTO schema_migrations(component, version, applied_at)
     VALUES (?, ?, ?)`,
  ).run(
    "storage-metadata",
    STORAGE_METADATA_SCHEMA_VERSION,
    new Date().toISOString(),
  );
}

function migrationApplied(
  db: DatabaseSync,
  component: string,
  version: number,
): boolean {
  const row = db
    .prepare(
      `SELECT 1 AS present
       FROM schema_migrations
       WHERE component = ? AND version = ?
       LIMIT 1`,
    )
    .get(component, version) as { present?: number } | undefined;
  return row?.present === 1;
}

function insertObject(
  db: DatabaseSync,
  input: {
    objectId: string;
    digest: string;
    sizeBytes: number;
    state: StorageObjectState;
    createdAt: string;
    updatedAt: string;
  },
): void {
  db.prepare(
    `INSERT INTO storage_objects(
       object_id, digest, size_bytes, state, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(object_id) DO UPDATE SET
       digest = excluded.digest,
       size_bytes = excluded.size_bytes,
       state = excluded.state,
       updated_at = excluded.updated_at`,
  ).run(
    input.objectId,
    input.digest,
    safeSize(input.sizeBytes),
    input.state,
    input.createdAt,
    input.updatedAt,
  );
}

function insertReference(db: DatabaseSync, reference: StorageReference): void {
  db.prepare(
    `INSERT INTO storage_references(
       artifact_id, object_id, artifact_json, lifecycle,
       created_at, updated_at, expires_at, reclaimable_at,
       gc_pending_at, deleted_at, pinned_at, hold_reason
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(artifact_id) DO UPDATE SET
       object_id = excluded.object_id,
       artifact_json = excluded.artifact_json,
       lifecycle = excluded.lifecycle,
       updated_at = excluded.updated_at,
       expires_at = excluded.expires_at,
       reclaimable_at = excluded.reclaimable_at,
       gc_pending_at = excluded.gc_pending_at,
       deleted_at = excluded.deleted_at,
       pinned_at = excluded.pinned_at,
       hold_reason = excluded.hold_reason`,
  ).run(
    reference.artifact.artifactId,
    reference.artifact.objectId,
    JSON.stringify(reference.artifact),
    reference.lifecycle,
    reference.createdAt,
    reference.updatedAt,
    reference.expiresAt,
    reference.reclaimableAt,
    reference.gcPendingAt,
    reference.deletedAt,
    reference.pinnedAt,
    reference.holdReason,
  );
}

async function importLegacyReferenceIndex(
  db: DatabaseSync,
  root: string,
): Promise<void> {
  const component = "storage-reference-json-import";
  if (migrationApplied(db, component, 1)) return;

  const legacyPath = path.join(
    storageLayout(root).state,
    "storage-references.json",
  );

  let legacy: LegacyStorageReferenceIndex | null = null;
  try {
    legacy = JSON.parse(
      await fs.readFile(legacyPath, "utf8"),
    ) as LegacyStorageReferenceIndex;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  db.exec("BEGIN IMMEDIATE");
  try {
    if (legacy) {
      if (
        legacy.format !== "owl-lab-storage-reference-index" ||
        legacy.version !== 1 ||
        !Array.isArray(legacy.references)
      ) {
        throw new Error(
          "STORAGE_METADATA_MIGRATION_INVALID: legacy reference index is unsupported.",
        );
      }

      for (const reference of legacy.references) {
        const objectState: StorageObjectState =
          reference.lifecycle === "DELETED" ? "DELETED" : "ACTIVE";
        insertObject(db, {
          objectId: reference.artifact.objectId,
          digest: reference.artifact.digest,
          sizeBytes: reference.artifact.sizeBytes,
          state: objectState,
          createdAt: reference.artifact.createdAt,
          updatedAt: reference.updatedAt,
        });
        insertReference(db, reference);
      }
    }

    db.prepare(
      `INSERT INTO schema_migrations(component, version, applied_at)
       VALUES (?, ?, ?)`,
    ).run(component, 1, new Date().toISOString());
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export async function withStorageMetadata<T>(
  operation: (db: DatabaseSync) => Promise<T> | T,
  root = owlLabDataRoot(),
): Promise<T> {
  await ensureStorageLayout(root);
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(metadataDbPath(root));
  try {
    initializeSchema(db);
    await importLegacyReferenceIndex(db, root);
    return await operation(db);
  } finally {
    db.close();
  }
}

export function listReferenceRows(db: DatabaseSync): StorageReference[] {
  return (
    db.prepare(
      `SELECT artifact_id, object_id, artifact_json, lifecycle,
              created_at, updated_at, expires_at, reclaimable_at,
              gc_pending_at, deleted_at, pinned_at, hold_reason
       FROM storage_references
       ORDER BY artifact_id`,
    ).all() as unknown as ReferenceRow[]
  ).map(rowToReference);
}

export function getReferenceRow(
  db: DatabaseSync,
  artifactId: string,
): StorageReference | null {
  const row = db.prepare(
    `SELECT artifact_id, object_id, artifact_json, lifecycle,
            created_at, updated_at, expires_at, reclaimable_at,
            gc_pending_at, deleted_at, pinned_at, hold_reason
     FROM storage_references
     WHERE artifact_id = ?`,
  ).get(artifactId) as ReferenceRow | undefined;
  return row ? rowToReference(row) : null;
}

export function putReferenceRow(
  db: DatabaseSync,
  reference: StorageReference,
): void {
  insertReference(db, reference);
}

export function getObjectRow(
  db: DatabaseSync,
  objectId: string,
): StorageObjectRecord | null {
  const row = db.prepare(
    `SELECT object_id, digest, size_bytes, state, created_at, updated_at
     FROM storage_objects
     WHERE object_id = ?`,
  ).get(objectId) as ObjectRow | undefined;
  return row ? rowToObject(row) : null;
}

export function listObjectRows(db: DatabaseSync): StorageObjectRecord[] {
  return (
    db.prepare(
      `SELECT object_id, digest, size_bytes, state, created_at, updated_at
       FROM storage_objects
       ORDER BY object_id`,
    ).all() as unknown as ObjectRow[]
  ).map(rowToObject);
}

export function putObjectRow(
  db: DatabaseSync,
  object: StorageObjectRecord,
): void {
  insertObject(db, object);
}

export function storageMetadataInfo() {
  return {
    schemaVersion: STORAGE_METADATA_SCHEMA_VERSION,
    provider: "sqlite" as const,
    database: "state/owl.db" as const,
    absolutePathExposed: false as const,
    secretsStoredHere: false as const,
  };
}
