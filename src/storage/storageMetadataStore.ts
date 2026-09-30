import fs from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3-multiple-ciphers";
import type { Database as CipherDatabase } from "better-sqlite3-multiple-ciphers";
export type StorageMetadataDatabase = CipherDatabase;
import {
  productionStorageKeyProvider,
  type RotatableStorageKeyProvider,
  type StorageKeyProvider,
} from "../security/storageKeyProvider.js";
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
export const STORAGE_METADATA_CIPHER_VERSION = 1 as const;

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

function initializeSchema(db: CipherDatabase): void {
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
  db: CipherDatabase,
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
  db: CipherDatabase,
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

function insertReference(db: CipherDatabase, reference: StorageReference): void {
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
  db: CipherDatabase,
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

export type StorageMetadataOpenOptions = {
  keyProvider?: StorageKeyProvider;
  production?: boolean;
};

export const STORAGE_METADATA_CIPHER_PROFILE = "sqlcipher-legacy4" as const;
const SQLITE_PLAINTEXT_HEADER = Buffer.from("SQLite format 3\0", "utf8");

type ExistingDatabaseKind = "missing" | "plaintext" | "encrypted";

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function databaseKind(target: string): Promise<ExistingDatabaseKind> {
  if (!(await pathExists(target))) return "missing";
  const handle = await fs.open(target, "r");
  try {
    const header = Buffer.alloc(SQLITE_PLAINTEXT_HEADER.length);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (
      bytesRead === SQLITE_PLAINTEXT_HEADER.length &&
      header.equals(SQLITE_PLAINTEXT_HEADER)
    ) {
      return "plaintext";
    }
    return "encrypted";
  } finally {
    await handle.close();
  }
}

function validateKeyHex(keyHex: string): Buffer {
  if (!/^[a-f0-9]{64}$/.test(keyHex)) {
    throw new Error(
      "STORAGE_KEY_INVALID: metadata key must be 256-bit lowercase hex.",
    );
  }
  return Buffer.from(keyHex, "hex");
}

function configureSqlCipherCompatibleDatabase(
  db: CipherDatabase,
  keyHex: string,
): void {
  // SQLite3MultipleCiphers' sqlcipher + legacy=4 profile produces/opens the
  // SQLCipher-compatible format documented by the binding. The key is passed
  // as raw bytes and is never interpolated into SQL or persisted in metadata.
  db.pragma("cipher='sqlcipher'");
  db.pragma("legacy=4");
  const result = db.key(validateKeyHex(keyHex));
  if (result !== 0) {
    throw new Error(`STORAGE_CIPHER_KEY_FAILED: sqlite3_key returned ${result}.`);
  }
  // Force page authentication now so a wrong key cannot fall through to schema
  // initialization and accidentally create or mutate anything.
  db.prepare("SELECT count(*) AS count FROM sqlite_master").get();
}

function assertDatabaseIntegrity(db: CipherDatabase): void {
  const rows = db.pragma("integrity_check") as Array<Record<string, unknown>>;
  const values = rows.flatMap((row) => Object.values(row));
  if (values.length !== 1 || values[0] !== "ok") {
    throw new Error(
      `STORAGE_METADATA_INTEGRITY_FAILED: ${JSON.stringify(values)}`,
    );
  }
  const foreignKeyViolations = db.pragma("foreign_key_check") as Array<
    Record<string, unknown>
  >;
  if (foreignKeyViolations.length > 0) {
    throw new Error(
      `STORAGE_METADATA_REFERENCE_INTEGRITY_FAILED: ${foreignKeyViolations.length} foreign-key violation(s).`,
    );
  }
}

async function protectMetadataFiles(root: string): Promise<void> {
  const state = storageLayout(root).state;
  await fs.chmod(state, 0o700).catch(() => undefined);
  const dbPath = metadataDbPath(root);
  for (const target of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    await fs.chmod(target, 0o600).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  }
}

async function syncFile(target: string): Promise<void> {
  const handle = await fs.open(target, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function recoverInterruptedEncryptedMigration(dbPath: string): Promise<void> {
  const recoveryPath = `${dbPath}.plaintext-migration-source`;
  const targetPath = `${dbPath}.encrypted-migration`;
  const activeExists = await pathExists(dbPath);
  const recoveryExists = await pathExists(recoveryPath);

  if (!activeExists && recoveryExists) {
    await fs.rename(recoveryPath, dbPath);
    await fs.rm(targetPath, { force: true });
    return;
  }

  if (activeExists) {
    // A target left beside an active database never has authority. If a
    // recovery source also exists we retain it until the active encrypted DB
    // authenticates successfully below.
    await fs.rm(targetPath, { force: true });
  }
}

function copyMetadataRows(source: CipherDatabase, target: CipherDatabase): void {
  const objects = source
    .prepare(
      `SELECT object_id, digest, size_bytes, state, created_at, updated_at
       FROM storage_objects ORDER BY object_id`,
    )
    .all() as ObjectRow[];
  const references = source
    .prepare(
      `SELECT artifact_id, object_id, artifact_json, lifecycle,
              created_at, updated_at, expires_at, reclaimable_at,
              gc_pending_at, deleted_at, pinned_at, hold_reason
       FROM storage_references ORDER BY artifact_id`,
    )
    .all() as ReferenceRow[];
  const settings = source
    .prepare(`SELECT key, value_json, updated_at FROM storage_settings ORDER BY key`)
    .all() as Array<{ key: string; value_json: string; updated_at: string }>;
  const migrations = source
    .prepare(
      `SELECT component, version, applied_at
       FROM schema_migrations ORDER BY component, version`,
    )
    .all() as Array<{ component: string; version: number; applied_at: string }>;

  target.exec("BEGIN IMMEDIATE");
  try {
    for (const object of objects) {
      insertObject(target, {
        objectId: object.object_id,
        digest: object.digest,
        sizeBytes: Number(object.size_bytes),
        state: assertObjectState(object.state),
        createdAt: object.created_at,
        updatedAt: object.updated_at,
      });
    }
    for (const reference of references) {
      insertReference(target, rowToReference(reference));
    }
    for (const setting of settings) {
      target
        .prepare(
          `INSERT OR REPLACE INTO storage_settings(key, value_json, updated_at)
           VALUES (?, ?, ?)`,
        )
        .run(setting.key, setting.value_json, setting.updated_at);
    }
    for (const migration of migrations) {
      target
        .prepare(
          `INSERT OR REPLACE INTO schema_migrations(component, version, applied_at)
           VALUES (?, ?, ?)`,
        )
        .run(migration.component, migration.version, migration.applied_at);
    }
    target.exec("COMMIT");
  } catch (error) {
    target.exec("ROLLBACK");
    throw error;
  }

  const sourceCounts = {
    objects: objects.length,
    references: references.length,
    settings: settings.length,
    migrations: migrations.length,
  };
  const targetCounts = {
    objects: Number(
      (target.prepare("SELECT COUNT(*) AS count FROM storage_objects").get() as {
        count: number;
      }).count,
    ),
    references: Number(
      (target.prepare("SELECT COUNT(*) AS count FROM storage_references").get() as {
        count: number;
      }).count,
    ),
    settings: Number(
      (target.prepare("SELECT COUNT(*) AS count FROM storage_settings").get() as {
        count: number;
      }).count,
    ),
    migrations: Number(
      (target.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get() as {
        count: number;
      }).count,
    ),
  };
  if (JSON.stringify(sourceCounts) !== JSON.stringify(targetCounts)) {
    throw new Error(
      `STORAGE_METADATA_MIGRATION_COUNT_MISMATCH: source=${JSON.stringify(sourceCounts)} target=${JSON.stringify(targetCounts)}`,
    );
  }
}

async function migratePlaintextDatabase(
  root: string,
  keyHex: string,
): Promise<void> {
  const dbPath = metadataDbPath(root);
  const targetPath = `${dbPath}.encrypted-migration`;
  const recoveryPath = `${dbPath}.plaintext-migration-source`;
  await fs.rm(targetPath, { force: true });

  const source = new Database(dbPath, { fileMustExist: true });
  let target: CipherDatabase | null = null;
  let sourceLocked = false;
  try {
    source.pragma("wal_checkpoint(TRUNCATE)");
    assertDatabaseIntegrity(source);
    source.exec("BEGIN EXCLUSIVE");
    sourceLocked = true;

    target = new Database(targetPath);
    configureSqlCipherCompatibleDatabase(target, keyHex);
    initializeSchema(target);
    copyMetadataRows(source, target);
    assertDatabaseIntegrity(target);

    source.exec("ROLLBACK");
    sourceLocked = false;
    target.close();
    target = null;
    source.close();

    await fs.rm(`${dbPath}-wal`, { force: true });
    await fs.rm(`${dbPath}-shm`, { force: true });
    await syncFile(targetPath);
    await fs.chmod(targetPath, 0o600);

    await fs.rm(recoveryPath, { force: true });
    await fs.rename(dbPath, recoveryPath);
    try {
      await fs.rename(targetPath, dbPath);
      const verification = new Database(dbPath, { fileMustExist: true });
      try {
        configureSqlCipherCompatibleDatabase(verification, keyHex);
        assertDatabaseIntegrity(verification);
      } finally {
        verification.close();
      }
      await fs.rm(recoveryPath, { force: true });
    } catch (error) {
      await fs.rm(dbPath, { force: true });
      if (await pathExists(recoveryPath)) {
        await fs.rename(recoveryPath, dbPath);
      }
      throw error;
    }
  } catch (error) {
    if (sourceLocked) source.exec("ROLLBACK");
    throw error;
  } finally {
    if (target) target.close();
    try {
      source.close();
    } catch {
      // Already closed after a successful copy.
    }
    await fs.rm(targetPath, { force: true });
  }
}

function isRotatableKeyProvider(
  provider: StorageKeyProvider,
): provider is RotatableStorageKeyProvider {
  const candidate = provider as Partial<RotatableStorageKeyProvider>;
  return (
    typeof candidate.prepareRotation === "function" &&
    typeof candidate.activateRotation === "function" &&
    typeof candidate.finalizeRotation === "function" &&
    typeof candidate.rollbackRotation === "function"
  );
}

function keyRotationPaths(dbPath: string) {
  return {
    marker: `${dbPath}.key-rotation.json`,
    recovery: `${dbPath}.key-rotation-source`,
    target: `${dbPath}.key-rotation-target`,
  };
}

async function verifyEncryptedGeneration(
  target: string,
  keyHex: string,
): Promise<void> {
  const db = new Database(target, { fileMustExist: true });
  try {
    configureSqlCipherCompatibleDatabase(db, keyHex);
    assertDatabaseIntegrity(db);
  } finally {
    db.close();
  }
}

async function recoverInterruptedKeyRotation(
  dbPath: string,
  keyProvider: StorageKeyProvider,
): Promise<void> {
  const paths = keyRotationPaths(dbPath);
  const markerExists = await pathExists(paths.marker);
  const recoveryExists = await pathExists(paths.recovery);
  const activeExists = await pathExists(dbPath);

  if (!markerExists) {
    if (!activeExists && recoveryExists) {
      await fs.rename(paths.recovery, dbPath);
      await fs.rm(paths.target, { force: true });
    } else if (activeExists && !recoveryExists) {
      await fs.rm(paths.target, { force: true });
    } else if (activeExists && recoveryExists) {
      throw new Error(
        "STORAGE_KEY_ROTATION_RECOVERY_REQUIRED: rotation recovery source exists without its marker.",
      );
    }
    return;
  }

  if (!isRotatableKeyProvider(keyProvider)) {
    throw new Error(
      "STORAGE_KEY_ROTATION_PROVIDER_REQUIRED: interrupted key rotation requires a rotatable key provider.",
    );
  }

  const marker = JSON.parse(await fs.readFile(paths.marker, "utf8")) as {
    format?: string;
    version?: number;
    rotationId?: string;
  };
  if (
    marker.format !== "owl-storage-key-rotation" ||
    marker.version !== 1 ||
    typeof marker.rotationId !== "string"
  ) {
    throw new Error("STORAGE_KEY_ROTATION_MARKER_INVALID: rotation marker is malformed.");
  }

  const rotationId = marker.rotationId;
  if (!activeExists && recoveryExists) {
    await fs.rename(paths.recovery, dbPath);
    await keyProvider.rollbackRotation(rotationId);
    await fs.rm(paths.target, { force: true });
    await fs.rm(paths.marker, { force: true });
    return;
  }

  if (activeExists && recoveryExists) {
    const current = await keyProvider.get();
    try {
      await verifyEncryptedGeneration(dbPath, current.keyHex);
      await fs.rm(paths.recovery, { force: true });
      await fs.rm(paths.target, { force: true });
      await keyProvider.finalizeRotation(rotationId);
      await fs.rm(paths.marker, { force: true });
      return;
    } catch {
      try {
        await verifyEncryptedGeneration(paths.recovery, current.keyHex);
      } catch (recoveryError) {
        throw new Error(
          "STORAGE_KEY_ROTATION_RECOVERY_FAILED: neither active nor recovery generation authenticates with the current key.",
          { cause: recoveryError },
        );
      }
      await fs.rm(dbPath, { force: true });
      await fs.rename(paths.recovery, dbPath);
      await keyProvider.rollbackRotation(rotationId);
      await fs.rm(paths.target, { force: true });
      await fs.rm(paths.marker, { force: true });
      return;
    }
  }

  if (activeExists && !recoveryExists) {
    // The crash happened before generation activation. The active database is
    // still authoritative; discard the staged key and partial target.
    await keyProvider.rollbackRotation(rotationId);
    await fs.rm(paths.target, { force: true });
    await fs.rm(paths.marker, { force: true });
    return;
  }

  throw new Error(
    "STORAGE_KEY_ROTATION_RECOVERY_FAILED: no authoritative metadata generation remains.",
  );
}

export async function rotateStorageMetadataKey(
  root = owlLabDataRoot(),
  keyProvider: RotatableStorageKeyProvider = productionStorageKeyProvider(),
): Promise<{ rotationId: string; cipherProfile: typeof STORAGE_METADATA_CIPHER_PROFILE }> {
  await ensureStorageLayout(root);
  const dbPath = metadataDbPath(root);
  await recoverInterruptedKeyRotation(dbPath, keyProvider);
  if ((await databaseKind(dbPath)) !== "encrypted") {
    throw new Error(
      "STORAGE_KEY_ROTATION_REQUIRES_ENCRYPTED_DB: production metadata must already be encrypted.",
    );
  }

  const current = await keyProvider.get();
  await verifyEncryptedGeneration(dbPath, current.keyHex);
  const rotation = await keyProvider.prepareRotation();
  const paths = keyRotationPaths(dbPath);
  await fs.writeFile(
    paths.marker,
    JSON.stringify(
      {
        format: "owl-storage-key-rotation",
        version: 1,
        rotationId: rotation.rotationId,
        cipherProfile: STORAGE_METADATA_CIPHER_PROFILE,
      },
      null,
      2,
    ) + "\n",
    { encoding: "utf8", mode: 0o600, flag: "wx" },
  );

  let source: CipherDatabase | null = null;
  let target: CipherDatabase | null = null;
  let sourceLocked = false;
  try {
    source = new Database(dbPath, { fileMustExist: true });
    configureSqlCipherCompatibleDatabase(source, current.keyHex);
    source.pragma("wal_checkpoint(TRUNCATE)");
    assertDatabaseIntegrity(source);
    source.exec("BEGIN EXCLUSIVE");
    sourceLocked = true;

    await fs.rm(paths.target, { force: true });
    target = new Database(paths.target);
    configureSqlCipherCompatibleDatabase(target, rotation.next.keyHex);
    initializeSchema(target);
    copyMetadataRows(source, target);
    assertDatabaseIntegrity(target);

    source.exec("ROLLBACK");
    sourceLocked = false;
    target.close();
    target = null;
    source.close();
    source = null;

    await fs.rm(`${dbPath}-wal`, { force: true });
    await fs.rm(`${dbPath}-shm`, { force: true });
    await syncFile(paths.target);
    await fs.chmod(paths.target, 0o600);

    await fs.rm(paths.recovery, { force: true });
    await fs.rename(dbPath, paths.recovery);
    await fs.rename(paths.target, dbPath);
    await verifyEncryptedGeneration(dbPath, rotation.next.keyHex);

    await keyProvider.activateRotation(rotation);
    const activated = await keyProvider.get();
    await verifyEncryptedGeneration(dbPath, activated.keyHex);

    await fs.rm(paths.recovery, { force: true });
    await keyProvider.finalizeRotation(rotation.rotationId);
    await fs.rm(paths.marker, { force: true });
    await protectMetadataFiles(root);
    return {
      rotationId: rotation.rotationId,
      cipherProfile: STORAGE_METADATA_CIPHER_PROFILE,
    };
  } catch (error) {
    if (sourceLocked && source) source.exec("ROLLBACK");
    if (target) target.close();
    if (source) source.close();

    if (await pathExists(paths.recovery)) {
      await fs.rm(dbPath, { force: true });
      await fs.rename(paths.recovery, dbPath);
    }
    await keyProvider.rollbackRotation(rotation.rotationId).catch(() => undefined);
    await fs.rm(paths.target, { force: true });
    await fs.rm(paths.marker, { force: true });
    throw new Error(
      "STORAGE_KEY_ROTATION_FAILED: encrypted metadata rotation rolled back to the known-good generation.",
      { cause: error },
    );
  }
}

async function openProductionMetadataDatabase(
  root: string,
  keyProvider: StorageKeyProvider,
): Promise<CipherDatabase> {
  const dbPath = metadataDbPath(root);
  await recoverInterruptedKeyRotation(dbPath, keyProvider);
  await recoverInterruptedEncryptedMigration(dbPath);
  const kind = await databaseKind(dbPath);

  if (kind === "plaintext") {
    const key = await keyProvider.getOrCreate();
    await migratePlaintextDatabase(root, key.keyHex);
  }

  if (kind === "missing") {
    const key = await keyProvider.getOrCreate();
    const db = new Database(dbPath);
    try {
      configureSqlCipherCompatibleDatabase(db, key.keyHex);
      initializeSchema(db);
      assertDatabaseIntegrity(db);
      return db;
    } catch (error) {
      db.close();
      await fs.rm(dbPath, { force: true });
      throw error;
    }
  }

  const key = await keyProvider.get();
  const db = new Database(dbPath, { fileMustExist: true });
  try {
    configureSqlCipherCompatibleDatabase(db, key.keyHex);
    assertDatabaseIntegrity(db);
    const recoveryPath = `${dbPath}.plaintext-migration-source`;
    await fs.rm(recoveryPath, { force: true });
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export async function withStorageMetadata<T>(
  operation: (db: CipherDatabase) => Promise<T> | T,
  root = owlLabDataRoot(),
  options: StorageMetadataOpenOptions = {},
): Promise<T> {
  await ensureStorageLayout(root);
  const production =
    options.production ?? process.env.OWL_RUNTIME_MODE === "production";
  let db: CipherDatabase | null = null;
  try {
    db = production
      ? await openProductionMetadataDatabase(
          root,
          options.keyProvider ?? productionStorageKeyProvider(),
        )
      : new Database(metadataDbPath(root));
    initializeSchema(db);
    await importLegacyReferenceIndex(db, root);
    return await operation(db);
  } catch (error) {
    if (production) {
      throw new Error(
        "STORAGE_METADATA_ENCRYPTED_OPEN_FAILED: production metadata authentication or migration failed; plaintext fallback is forbidden.",
        { cause: error },
      );
    }
    throw error;
  } finally {
    if (db) db.close();
    if (production) await protectMetadataFiles(root);
  }
}

export function listReferenceRows(db: CipherDatabase): StorageReference[] {
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
  db: CipherDatabase,
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
  db: CipherDatabase,
  reference: StorageReference,
): void {
  insertReference(db, reference);
}

export function getObjectRow(
  db: CipherDatabase,
  objectId: string,
): StorageObjectRecord | null {
  const row = db.prepare(
    `SELECT object_id, digest, size_bytes, state, created_at, updated_at
     FROM storage_objects
     WHERE object_id = ?`,
  ).get(objectId) as ObjectRow | undefined;
  return row ? rowToObject(row) : null;
}

export function listObjectRows(db: CipherDatabase): StorageObjectRecord[] {
  return (
    db.prepare(
      `SELECT object_id, digest, size_bytes, state, created_at, updated_at
       FROM storage_objects
       ORDER BY object_id`,
    ).all() as unknown as ObjectRow[]
  ).map(rowToObject);
}

export function putObjectRow(
  db: CipherDatabase,
  object: StorageObjectRecord,
): void {
  insertObject(db, object);
}

export function storageMetadataInfo() {
  const production = process.env.OWL_RUNTIME_MODE === "production";
  return {
    schemaVersion: STORAGE_METADATA_SCHEMA_VERSION,
    provider: "sqlite-multiple-ciphers" as const,
    encryptedAtRest: production,
    cipherVersion: production ? STORAGE_METADATA_CIPHER_VERSION : null,
    cipherProfile: production ? STORAGE_METADATA_CIPHER_PROFILE : null,
    database: "state/owl.db" as const,
    absolutePathExposed: false as const,
    secretsStoredHere: false as const,
  };
}
