import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { InProcessRuntimeClient } from "../src/public/runtimeClient.js";
import { invokeRuntimeRpc } from "../src/public/runtimeRpc.js";
import { artifactObjectPath } from "../src/storage/storageFoundation.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "owl-runtime-freeze-"));
const stateRoot = path.join(root, "runtime-state");
const dataRoot = path.join(root, "OWL LAB");
const workspace = path.join(root, "workspace");

process.env.AGENTOS_STATE_ROOT = stateRoot;
process.env.OWL_LAB_DATA_ROOT = dataRoot;
process.env.ALLOWED_DIRECTORIES = workspace;
process.env.ALLOW_WRITE = "true";

await fs.mkdir(workspace, { recursive: true });
const client = new InProcessRuntimeClient();

try {
  const capabilities = await client.getCapabilities("runtime integration freeze");
  assert.equal(capabilities.extensions.storageFoundation.version, 1);
  assert.equal(capabilities.extensions.storageRetention.version, 1);
  assert.equal(capabilities.extensions.legacyStorageMigration.version, 1);
  assert.equal(capabilities.extensions.storageManagement.version, 1);
  assert.equal(capabilities.extensions.storageManagement.internalPathsExposed, false);

  const output = path.join(workspace, "freeze-output.txt");
  const task = await client.createTask({
    label: "runtime storage public path firewall",
    steps: [
      {
        id: "write",
        action: "fs.write",
        args: { path: output, content: "freeze\n" },
      },
    ],
  });
  const run = await client.runTask({
    taskId: task.id,
    expectedRevisionDigest: task.executionRevision!.digest,
  });
  assert.equal(run.status, "completed");

  const detail = await client.getTask(task.id, true);
  assert.equal(detail.storage.internalPathsExposed, false);
  assert.equal(detail.staging.internalPathsExposed, false);
  assert.equal(detail.staging.artifactCount, 1);
  assert.equal(detail.staging.committedArtifactCount, 1);
  assert.equal(detail.staging.legacyUncommittedArtifactCount, 0);
  assert.equal(detail.staging.artifacts.length, 1);

  const serialized = JSON.stringify(detail);
  assert.equal(serialized.includes(dataRoot), false);
  assert.equal(serialized.includes("sourcePath"), false);
  assert.equal(serialized.includes("stagedPath"), false);
  assert.equal(serialized.includes("manifestPath"), false);
  assert.equal(serialized.includes("keyPath"), false);

  const artifact = detail.staging.artifacts[0]!;
  assert.match(artifact.artifactId, /^art_/);
  assert.match(artifact.objectId, /^obj_sha256_/);
  assert.match(artifact.digest, /^sha256:[a-f0-9]{64}$/);

  const status = await client.getStorageStatus();
  assert.equal(status.schemaVersion, 1);
  assert.equal(status.health, "healthy");
  assert.equal(status.internalPathsExposed, false);
  assert.equal(status.usage.logicalReferenceCount, 1);
  assert.equal(status.usage.uniqueReferencedObjectCount, 1);

  const artifacts = await client.listStorageArtifacts();
  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0]?.artifact.artifactId, artifact.artifactId);
  assert.equal(JSON.stringify(artifacts).includes(dataRoot), false);

  const rpcStatus = await invokeRuntimeRpc(client, "storage.status");
  assert.equal((rpcStatus as { internalPathsExposed: boolean }).internalPathsExposed, false);

  await assert.rejects(
    () => client.collectStorageGarbage({ confirm: false }),
    /STORAGE_GC_CONFIRM_REQUIRED/,
  );

  const healthy = await client.reconcileStorage();
  assert.equal(healthy.health, "healthy");
  assert.equal(healthy.internalPathsExposed, false);

  await fs.writeFile(artifactObjectPath(artifact.digest, dataRoot), "corrupt");
  const corrupt = await client.reconcileStorage();
  assert.equal(corrupt.health, "needs_attention");
  assert.equal(corrupt.corruptObjects.length, 1);
  assert.equal(JSON.stringify(corrupt).includes(dataRoot), false);

  console.log(
    JSON.stringify(
      {
        ok: true,
        runtimeIntegrationFreezeVersion: 1,
        taskStagingCommittedToCas: true,
        publicStoragePathsFirewalled: true,
        storageRpcTyped: true,
        destructiveGcRequiresConfirmation: true,
        reconciliationHealthyAndCorruptStatesVerified: true,
      },
      null,
      2,
    ),
  );
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
