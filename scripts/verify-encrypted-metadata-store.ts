import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  withStorageMetadata,
  rotateStorageMetadataKey,
  STORAGE_METADATA_CIPHER_PROFILE,
} from "../src/storage/storageMetadataStore.js";
import type {
  RotatableStorageKeyProvider,
  StorageDatabaseKey,
  StorageKeyProvider,
  StorageKeyRotation,
} from "../src/security/storageKeyProvider.js";

class FixedKeyProvider implements StorageKeyProvider {
  getCalls = 0;
  getOrCreateCalls = 0;
  constructor(
    private readonly keyHex: string,
    private readonly present = true,
  ) {}
  private value(): StorageDatabaseKey {
    if (!this.present) throw new Error("STORAGE_KEY_NOT_FOUND: test key missing.");
    return { keyId: "test:v1", version: 1, keyHex: this.keyHex };
  }
  async get(): Promise<StorageDatabaseKey> {
    this.getCalls += 1;
    return this.value();
  }
  async getOrCreate(): Promise<StorageDatabaseKey> {
    this.getOrCreateCalls += 1;
    return this.value();
  }
}


class MemoryRotatableProvider implements RotatableStorageKeyProvider {
  private staged = new Map<
    string,
    { next: string; recovery: string | null; activated: boolean }
  >();
  private counter = 0;
  constructor(
    public currentKeyHex: string,
    private readonly failActivation = false,
  ) {}
  private value(keyHex = this.currentKeyHex): StorageDatabaseKey {
    return { keyId: "memory:v1", version: 1, keyHex };
  }
  async get(): Promise<StorageDatabaseKey> {
    return this.value();
  }
  async getOrCreate(): Promise<StorageDatabaseKey> {
    return this.value();
  }
  async prepareRotation(): Promise<StorageKeyRotation> {
    this.counter += 1;
    const rotationId = this.counter.toString(16).padStart(32, "0");
    const next = (this.counter % 2 === 1 ? "59" : "61").repeat(32);
    this.staged.set(rotationId, { next, recovery: null, activated: false });
    return {
      rotationId,
      next: { keyId: `memory:rotation:${rotationId}`, version: 1, keyHex: next },
    };
  }
  async activateRotation(rotation: StorageKeyRotation): Promise<void> {
    const state = this.staged.get(rotation.rotationId);
    assert.ok(state);
    state.recovery = this.currentKeyHex;
    state.activated = true;
    this.currentKeyHex = state.next;
    if (this.failActivation) throw new Error("simulated activation failure");
  }
  async finalizeRotation(rotationId: string): Promise<void> {
    this.staged.delete(rotationId);
  }
  async rollbackRotation(rotationId: string): Promise<void> {
    const state = this.staged.get(rotationId);
    if (state?.activated && state.recovery) this.currentKeyHex = state.recovery;
    this.staged.delete(rotationId);
  }
}

async function headerIsPlaintext(dbPath: string): Promise<boolean> {
  const bytes = await fs.readFile(dbPath);
  return bytes.subarray(0, 16).toString("utf8") === "SQLite format 3\0";
}

async function exists(target: string): Promise<boolean> {
  return await fs.access(target).then(() => true).catch(() => false);
}

async function mode(target: string): Promise<number> {
  return (await fs.stat(target)).mode & 0o777;
}

async function seedPlaintext(root: string, marker: string): Promise<void> {
  await withStorageMetadata(
    (db) => {
      db.prepare(
        `INSERT INTO storage_settings(key, value_json, updated_at)
         VALUES (?, ?, ?)`,
      ).run("marker", JSON.stringify(marker), "2026-09-30T00:00:00.000Z");
    },
    root,
    { production: false },
  );
}

async function readMarker(
  root: string,
  provider: StorageKeyProvider,
): Promise<string> {
  return await withStorageMetadata(
    (db) => {
      const row = db
        .prepare(`SELECT value_json FROM storage_settings WHERE key = ?`)
        .get("marker") as { value_json: string } | undefined;
      assert.ok(row);
      return JSON.parse(row.value_json) as string;
    },
    root,
    { production: true, keyProvider: provider },
  );
}

const work = await fs.mkdtemp(path.join(os.tmpdir(), "owl-encrypted-metadata-"));
const keyHex = "31".repeat(32);
const wrongKeyHex = "47".repeat(32);

try {
  // New production databases are encrypted from their first durable pages.
  const freshRoot = path.join(work, "fresh");
  const freshProvider = new FixedKeyProvider(keyHex);
  await withStorageMetadata(
    (db) => {
      db.prepare(
        `INSERT INTO storage_settings(key, value_json, updated_at)
         VALUES (?, ?, ?)`,
      ).run("marker", JSON.stringify("fresh-secret"), "2026-09-30T00:00:00.000Z");
    },
    freshRoot,
    { production: true, keyProvider: freshProvider },
  );
  const freshDb = path.join(freshRoot, "state", "owl.db");
  assert.equal(await headerIsPlaintext(freshDb), false);
  assert.equal(await mode(path.join(freshRoot, "state")), 0o700);
  assert.equal(await mode(freshDb), 0o600);
  assert.equal(freshProvider.getOrCreateCalls, 1);

  // Correct-key restart succeeds without creating or replacing a key.
  const restartProvider = new FixedKeyProvider(keyHex);
  assert.equal(await readMarker(freshRoot, restartProvider), "fresh-secret");
  assert.ok(restartProvider.getCalls >= 1);
  assert.equal(restartProvider.getOrCreateCalls, 0);

  // Wrong and missing keys fail closed; neither path is allowed to create a
  // replacement key for an already encrypted database.
  const wrongProvider = new FixedKeyProvider(wrongKeyHex);
  await assert.rejects(
    () => readMarker(freshRoot, wrongProvider),
    /STORAGE_METADATA_ENCRYPTED_OPEN_FAILED/,
  );
  assert.equal(wrongProvider.getOrCreateCalls, 0);
  const missingProvider = new FixedKeyProvider(keyHex, false);
  await assert.rejects(
    () => readMarker(freshRoot, missingProvider),
    /STORAGE_METADATA_ENCRYPTED_OPEN_FAILED/,
  );
  assert.equal(missingProvider.getOrCreateCalls, 0);
  assert.equal(await readMarker(freshRoot, new FixedKeyProvider(keyHex)), "fresh-secret");

  // Existing plaintext R11 metadata is copied into a verified encrypted
  // generation and atomically activated without losing rows.
  const migrationRoot = path.join(work, "migration");
  await seedPlaintext(migrationRoot, "legacy-row");
  const migrationDb = path.join(migrationRoot, "state", "owl.db");
  assert.equal(await headerIsPlaintext(migrationDb), true);
  assert.equal(
    await readMarker(migrationRoot, new FixedKeyProvider(keyHex)),
    "legacy-row",
  );
  assert.equal(await headerIsPlaintext(migrationDb), false);
  assert.equal(await exists(`${migrationDb}.plaintext-migration-source`), false);
  assert.equal(await exists(`${migrationDb}.encrypted-migration`), false);

  // Simulate interruption after the plaintext source was renamed but before
  // encrypted activation. Startup restores the known-good source first, then
  // performs the migration normally.
  const interruptedRoot = path.join(work, "interrupted");
  await seedPlaintext(interruptedRoot, "recover-me");
  const interruptedDb = path.join(interruptedRoot, "state", "owl.db");
  await fs.rename(interruptedDb, `${interruptedDb}.plaintext-migration-source`);
  await fs.writeFile(`${interruptedDb}.encrypted-migration`, "partial-target");
  assert.equal(
    await readMarker(interruptedRoot, new FixedKeyProvider(keyHex)),
    "recover-me",
  );
  assert.equal(await headerIsPlaintext(interruptedDb), false);
  assert.equal(await exists(`${interruptedDb}.plaintext-migration-source`), false);
  assert.equal(await exists(`${interruptedDb}.encrypted-migration`), false);

  // Key rotation creates and verifies a new encrypted generation before key
  // activation, then retires the old generation. An activation failure restores
  // both the previous key and previous database generation.
  const rotationRoot = path.join(work, "rotation");
  const rotationProvider = new MemoryRotatableProvider(keyHex);
  await withStorageMetadata(
    (db) =>
      db.prepare(
        `INSERT INTO storage_settings(key, value_json, updated_at)
         VALUES (?, ?, ?)`,
      ).run("marker", JSON.stringify("rotate-me"), "2026-09-30T00:00:00.000Z"),
    rotationRoot,
    { production: true, keyProvider: rotationProvider },
  );
  const oldRotationKey = rotationProvider.currentKeyHex;
  const rotationReceipt = await rotateStorageMetadataKey(
    rotationRoot,
    rotationProvider,
  );
  assert.match(rotationReceipt.rotationId, /^[a-f0-9]{32}$/);
  assert.notEqual(rotationProvider.currentKeyHex, oldRotationKey);
  assert.equal(await readMarker(rotationRoot, rotationProvider), "rotate-me");
  await assert.rejects(
    () => readMarker(rotationRoot, new FixedKeyProvider(oldRotationKey)),
    /STORAGE_METADATA_ENCRYPTED_OPEN_FAILED/,
  );

  const rollbackRoot = path.join(work, "rotation-rollback");
  const rollbackProvider = new MemoryRotatableProvider(keyHex, true);
  await withStorageMetadata(
    (db) =>
      db.prepare(
        `INSERT INTO storage_settings(key, value_json, updated_at)
         VALUES (?, ?, ?)`,
      ).run("marker", JSON.stringify("rollback-me"), "2026-09-30T00:00:00.000Z"),
    rollbackRoot,
    { production: true, keyProvider: rollbackProvider },
  );
  await assert.rejects(
    () => rotateStorageMetadataKey(rollbackRoot, rollbackProvider),
    /STORAGE_KEY_ROTATION_FAILED/,
  );
  assert.equal(rollbackProvider.currentKeyHex, keyHex);
  assert.equal(await readMarker(rollbackRoot, rollbackProvider), "rollback-me");
  const rollbackDb = path.join(rollbackRoot, "state", "owl.db");
  assert.equal(await exists(`${rollbackDb}.key-rotation-source`), false);
  assert.equal(await exists(`${rollbackDb}.key-rotation-target`), false);
  assert.equal(await exists(`${rollbackDb}.key-rotation.json`), false);

  // Publicly observable errors and filenames must not contain key material.
  let wrongError = "";
  try {
    await readMarker(freshRoot, new FixedKeyProvider(wrongKeyHex));
  } catch (error) {
    wrongError = error instanceof Error ? error.message : String(error);
  }
  assert.equal(wrongError.includes(wrongKeyHex), false);
  const stateNames = await fs.readdir(path.join(freshRoot, "state"));
  assert.equal(stateNames.some((name) => name.includes(keyHex)), false);

  console.log(
    JSON.stringify(
      {
        ok: true,
        cipherProfile: STORAGE_METADATA_CIPHER_PROFILE,
        encryptedFromFirstCreation: true,
        correctKeyRestart: true,
        wrongKeyFailsClosed: true,
        missingKeyFailsClosed: true,
        plaintextMigrationLossless: true,
        interruptedMigrationRecovers: true,
        keyRotationSafe: true,
        keyRotationRollbackSafe: true,
        stateDirectoryMode: "0700",
        databaseMode: "0600",
        keyMaterialNotExposed: true,
      },
      null,
      2,
    ),
  );
} finally {
  await fs.rm(work, { recursive: true, force: true });
}
