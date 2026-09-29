import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { InProcessRuntimeClient } from "../src/public/runtimeClient.js";
import {
  artifactObjectPath,
  commitArtifactFromFile,
  ensureStorageLayout,
  readArtifactBytes,
  storageLayout,
  verifyArtifactObject,
} from "../src/storage/storageFoundation.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "owl-storage-foundation-"));
process.env.OWL_LAB_DATA_ROOT = root;

try {
  const client = new InProcessRuntimeClient();
  const capabilities = await client.getCapabilities("storage foundation");
  assert.equal(capabilities.extensions.storageFoundation.version, 1);
  assert.equal(capabilities.extensions.storageFoundation.physicalPathsPublic, false);
  assert.equal(capabilities.extensions.storageFoundation.deletionAuthority, "runtime");

  const layout = await ensureStorageLayout();
  assert.equal(layout.root, path.resolve(root));

  const manifest = JSON.parse(await fs.readFile(layout.manifest, "utf8"));
  assert.equal(manifest.format, "owl-lab-storage");
  assert.equal(manifest.version, 1);
  assert.equal(manifest.objectAddressing, "sha256");

  const firstSource = path.join(root, "first.txt");
  const secondSource = path.join(root, "second.txt");
  await fs.writeFile(firstSource, "same bytes\n");
  await fs.writeFile(secondSource, "same bytes\n");

  const first = await commitArtifactFromFile({
    sourcePath: firstSource,
    mediaType: "text/plain",
    retentionClass: "intermediate",
    provenance: { taskId: "task_storage_a" },
  });
  const second = await commitArtifactFromFile({
    sourcePath: secondSource,
    mediaType: "text/plain",
    retentionClass: "saved",
    provenance: { taskId: "task_storage_b" },
  });

  assert.notEqual(first.artifactId, second.artifactId);
  assert.equal(first.objectId, second.objectId);
  assert.equal(first.digest, second.digest);
  assert.equal(first.sizeBytes, second.sizeBytes);
  assert.equal(first.schemaVersion, 1);
  assert.equal(second.schemaVersion, 1);

  const serialized = JSON.stringify(first);
  assert.equal(serialized.includes(root), false);
  assert.equal("sourcePath" in first, false);
  assert.equal("stagedPath" in first, false);

  const objectPath = artifactObjectPath(first.digest);
  assert.equal(objectPath.startsWith(storageLayout().objects), true);
  assert.deepEqual((await fs.readdir(path.dirname(objectPath))).length, 1);

  assert.deepEqual((await verifyArtifactObject(first)).ok, true);
  assert.equal((await readArtifactBytes(first)).toString("utf8"), "same bytes\n");

  await fs.writeFile(firstSource, "different bytes\n");
  const changed = await commitArtifactFromFile({
    sourcePath: firstSource,
    mediaType: "text/plain",
    retentionClass: "intermediate",
  });
  assert.notEqual(changed.digest, first.digest);
  assert.notEqual(changed.objectId, first.objectId);

  await fs.writeFile(objectPath, "corrupt");
  await assert.rejects(
    () => verifyArtifactObject(first),
    /STORAGE_OBJECT_CORRUPT/,
  );

  console.log(
    JSON.stringify(
      {
        ok: true,
        storageFoundationVersion: 1,
        capabilityPublished: true,
        logicalArtifactIdentityDistinctFromObjectIdentity: true,
        sha256ContentAddressing: true,
        duplicateBytesDeduplicated: true,
        physicalPathsAbsentFromArtifactRef: true,
        immutableChangeCreatesNewObject: true,
        corruptionFailsClosed: true,
      },
      null,
      2,
    ),
  );
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
