import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  commitArtifactFromFile,
  ensureStorageLayout,
} from "../src/storage/storageFoundation.js";
import {
  getStorageRuntimeStatus,
} from "../src/storage/storageRuntimeService.js";
import {
  listObjectRows,
  listReferenceRows,
  withStorageMetadata,
} from "../src/storage/storageMetadataStore.js";
import {
  listStorageReferences,
  registerArtifactReference,
  type StorageReference,
} from "../src/storage/storageRetention.js";

const work = await fs.mkdtemp(path.join(os.tmpdir(), "owl-sqlite-metadata-"));
const root = path.join(work, "OWL LAB");
process.env.OWL_LAB_DATA_ROOT = root;

try {
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(
    path.join(root, "storage-manifest.json"),
    JSON.stringify(
      {
        format: "owl-lab-storage",
        version: 1,
        createdAt: "2026-09-30T00:00:00.000Z",
        objectAddressing: "sha256",
      },
      null,
      2,
    ) + "\n",
  );

  const layout = await ensureStorageLayout(root);
  const manifest = JSON.parse(await fs.readFile(layout.manifest, "utf8"));
  assert.deepEqual(manifest.metadataStore, {
    provider: "sqlite",
    database: "state/owl.db",
    schemaVersion: 1,
  });
  assert.equal(JSON.stringify(manifest).includes(root), false);

  const legacySource = path.join(work, "legacy.bin");
  await fs.writeFile(legacySource, "legacy metadata object");
  const legacyArtifact = await commitArtifactFromFile({
    sourcePath: legacySource,
    mediaType: "application/octet-stream",
    retentionClass: "intermediate",
    root,
  });

  const legacyReference: StorageReference = {
    version: 1,
    artifact: legacyArtifact,
    lifecycle: "ACTIVE",
    createdAt: "2026-09-30T00:00:00.000Z",
    updatedAt: "2026-09-30T00:00:00.000Z",
    expiresAt: "2026-10-30T00:00:00.000Z",
    reclaimableAt: null,
    gcPendingAt: null,
    deletedAt: null,
    pinnedAt: null,
    holdReason: null,
  };

  const legacyIndexPath = path.join(layout.state, "storage-references.json");
  const legacyIndexBytes =
    JSON.stringify(
      {
        format: "owl-lab-storage-reference-index",
        version: 1,
        createdAt: "2026-09-30T00:00:00.000Z",
        updatedAt: "2026-09-30T00:00:00.000Z",
        references: [legacyReference],
      },
      null,
      2,
    ) + "\n";
  await fs.writeFile(legacyIndexPath, legacyIndexBytes);

  const imported = await listStorageReferences(root);
  assert.equal(imported.length, 1);
  assert.equal(imported[0]?.artifact.artifactId, legacyArtifact.artifactId);

  const dbPath = path.join(layout.state, "owl.db");
  const header = Buffer.alloc(16);
  const handle = await fs.open(dbPath, "r");
  try {
    await handle.read(header, 0, header.length, 0);
  } finally {
    await handle.close();
  }
  assert.equal(header.toString("utf8"), "SQLite format 3\u0000");

  const metadata = await withStorageMetadata((db) => {
    const migrations = db.prepare(
      `SELECT component, version
       FROM schema_migrations
       ORDER BY component, version`,
    ).all() as unknown as Array<{ component: string; version: number }>;
    return {
      references: listReferenceRows(db),
      objects: listObjectRows(db),
      migrations,
    };
  }, root);

  assert.equal(metadata.references.length, 1);
  assert.equal(metadata.objects.length, 1);
  assert.deepEqual(
    metadata.migrations.map((item) => `${item.component}:${item.version}`),
    ["storage-metadata:1", "storage-reference-json-import:1"],
  );

  assert.equal(await fs.readFile(legacyIndexPath, "utf8"), legacyIndexBytes);

  const secondSource = path.join(work, "second.bin");
  await fs.writeFile(secondSource, "sqlite native reference");
  const secondArtifact = await commitArtifactFromFile({
    sourcePath: secondSource,
    mediaType: "application/octet-stream",
    retentionClass: "saved",
    root,
  });
  await registerArtifactReference(secondArtifact, { root });

  const after = await listStorageReferences(root);
  assert.equal(after.length, 2);

  const migrationRowsAfter = await withStorageMetadata(
    (db) =>
      db.prepare(
        `SELECT COUNT(*) AS count
         FROM schema_migrations
         WHERE component = 'storage-reference-json-import' AND version = 1`,
      ).get() as { count: number },
    root,
  );
  assert.equal(Number(migrationRowsAfter.count), 1);

  const status = await getStorageRuntimeStatus();
  assert.deepEqual(status.metadataStore, {
    provider: "sqlite",
    schemaVersion: 1,
    database: "state/owl.db",
    absolutePathExposed: false,
    secretsStoredHere: false,
    encryptedAtRest: false,
    cipherProfile: null,
  });
  assert.equal(JSON.stringify(status).includes(root), false);

  console.log(
    JSON.stringify(
      {
        ok: true,
        metadataStore: "sqlite",
        schemaVersion: 1,
        canonicalDatabase: "state/owl.db",
        legacyJsonImportedOnce: true,
        legacyJsonPreserved: true,
        manifestUpgradedInPlace: true,
        absolutePathsNotPublic: true,
        secretsStoredHere: false,
      },
      null,
      2,
    ),
  );
} finally {
  await fs.rm(work, { recursive: true, force: true });
}
