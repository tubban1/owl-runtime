import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  artifactObjectPath,
  commitArtifactFromFile,
} from "../src/storage/storageFoundation.js";
import {
  collectGarbage,
  evaluateRetention,
  listStorageReferences,
  pinArtifactReference,
  registerArtifactReference,
  unpinArtifactReference,
} from "../src/storage/storageRetention.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "owl-storage-retention-"));
process.env.OWL_LAB_DATA_ROOT = root;
const DAY_MS = 24 * 60 * 60 * 1000;
const baseNow = Date.parse("2026-09-30T00:00:00.000Z");

try {
  const sourceA = path.join(root, "a.bin");
  const sourceB = path.join(root, "b.bin");
  await fs.writeFile(sourceA, "shared-object");
  await fs.writeFile(sourceB, "shared-object");

  const temporary = await commitArtifactFromFile({
    sourcePath: sourceA,
    mediaType: "application/octet-stream",
    retentionClass: "cache",
  });
  const saved = await commitArtifactFromFile({
    sourcePath: sourceB,
    mediaType: "application/octet-stream",
    retentionClass: "saved",
  });

  assert.equal(temporary.objectId, saved.objectId);
  await registerArtifactReference(temporary, {
    expiresAt: new Date(baseNow - DAY_MS).toISOString(),
  });
  await registerArtifactReference(saved);

  const evaluated = await evaluateRetention({ now: baseNow });
  const expired = evaluated.references.find(
    (item) => item.artifact.artifactId === temporary.artifactId,
  );
  assert.equal(expired?.lifecycle, "RECLAIMABLE");

  const dryRun = await collectGarbage({
    now: baseNow + 8 * DAY_MS,
    gracePeriodMs: 7 * DAY_MS,
    dryRun: true,
  });
  assert.deepEqual(dryRun.deletedObjectIds, []);
  assert.deepEqual(dryRun.retainedSharedObjectIds, [temporary.objectId]);

  const sharedGc = await collectGarbage({
    now: baseNow + 8 * DAY_MS,
    gracePeriodMs: 7 * DAY_MS,
  });
  assert.deepEqual(sharedGc.deletedObjectIds, []);
  assert.deepEqual(sharedGc.retainedSharedObjectIds, [temporary.objectId]);
  await fs.access(artifactObjectPath(saved.digest));

  const refsAfterSharedGc = await listStorageReferences();
  assert.equal(
    refsAfterSharedGc.find(
      (item) => item.artifact.artifactId === temporary.artifactId,
    )?.lifecycle,
    "DELETED",
  );
  assert.equal(
    refsAfterSharedGc.find((item) => item.artifact.artifactId === saved.artifactId)
      ?.lifecycle,
    "ACTIVE",
  );

  const sourceC = path.join(root, "c.bin");
  await fs.writeFile(sourceC, "pin-me");
  const pinnable = await commitArtifactFromFile({
    sourcePath: sourceC,
    mediaType: "application/octet-stream",
    retentionClass: "cache",
  });
  await registerArtifactReference(pinnable, {
    expiresAt: new Date(baseNow - DAY_MS).toISOString(),
  });
  await pinArtifactReference(pinnable.artifactId);
  await evaluateRetention({ now: baseNow + 30 * DAY_MS });
  assert.equal(
    (await listStorageReferences()).find(
      (item) => item.artifact.artifactId === pinnable.artifactId,
    )?.lifecycle,
    "PINNED",
  );

  await unpinArtifactReference(
    pinnable.artifactId,
    root,
    baseNow + 30 * DAY_MS,
  );
  await evaluateRetention({ now: baseNow + 30 * DAY_MS });
  const reclaimAt = baseNow + 38 * DAY_MS;
  const finalGc = await collectGarbage({
    now: reclaimAt,
    gracePeriodMs: 7 * DAY_MS,
  });
  assert.deepEqual(finalGc.deletedObjectIds, [pinnable.objectId]);
  await assert.rejects(
    () => fs.access(artifactObjectPath(pinnable.digest)),
    /ENOENT/,
  );

  console.log(
    JSON.stringify(
      {
        ok: true,
        storageRetentionVersion: 1,
        sharedObjectProtectedByLiveReference: true,
        expiredReferenceRetiredWithoutDeletingSharedObject: true,
        pinPreventsRetentionExpiry: true,
        gracePeriodEnforced: true,
        runtimeAuthoritativeGc: true,
      },
      null,
      2,
    ),
  );
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
