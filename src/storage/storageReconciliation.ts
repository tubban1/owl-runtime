import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  ensureStorageLayout,
  owlLabDataRoot,
  storageLayout,
} from "./storageFoundation.js";
import { listStorageReferences } from "./storageRetention.js";

export const STORAGE_RECONCILIATION_VERSION = 1 as const;

export type StorageHealth = "healthy" | "degraded" | "needs_attention";

export type StorageReconciliationReport = {
  version: 1;
  checkedAt: string;
  health: StorageHealth;
  referencedObjectCount: number;
  physicalObjectCount: number;
  missingReferences: Array<{
    artifactId: string;
    objectId: string;
    digest: string;
  }>;
  corruptObjects: Array<{
    objectId: string;
    digest: string;
    reason: string;
  }>;
  unreferencedObjects: Array<{
    objectId: string;
    digest: string;
    sizeBytes: number;
  }>;
  staleStaging: Array<{
    taskId: string;
    ageMs: number;
  }>;
  internalPathsExposed: false;
};

async function sha256File(filePath: string): Promise<string> {
  const handle = await fs.open(filePath, "r");
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}

async function physicalObjects(root: string): Promise<
  Array<{ objectId: string; digest: string; sizeBytes: number; filePath: string }>
> {
  const layout = storageLayout(root);
  await ensureStorageLayout(root);
  const output: Array<{
    objectId: string;
    digest: string;
    sizeBytes: number;
    filePath: string;
  }> = [];

  const prefixes = await fs.readdir(layout.objects, { withFileTypes: true });
  for (const prefix of prefixes) {
    if (!prefix.isDirectory() || !/^[a-f0-9]{2}$/.test(prefix.name)) continue;
    const directory = path.join(layout.objects, prefix.name);
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !/^[a-f0-9]{64}$/.test(entry.name)) continue;
      const filePath = path.join(directory, entry.name);
      const stat = await fs.stat(filePath);
      output.push({
        objectId: `obj_sha256_${entry.name}`,
        digest: `sha256:${entry.name}`,
        sizeBytes: Number(stat.size),
        filePath,
      });
    }
  }
  return output;
}

async function staleStaging(
  root: string,
  now: number,
  staleAfterMs: number,
): Promise<StorageReconciliationReport["staleStaging"]> {
  const staging = storageLayout(root).staging;
  await fs.mkdir(staging, { recursive: true, mode: 0o700 });
  const output: StorageReconciliationReport["staleStaging"] = [];
  for (const entry of await fs.readdir(staging, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^task_[A-Za-z0-9_-]{1,96}$/.test(entry.name)) {
      continue;
    }
    const stat = await fs.stat(path.join(staging, entry.name));
    const ageMs = Math.max(0, now - stat.mtimeMs);
    if (ageMs >= staleAfterMs) {
      output.push({ taskId: entry.name, ageMs });
    }
  }
  return output.sort((a, b) => b.ageMs - a.ageMs);
}

export async function reconcileStorage(options: {
  root?: string;
  now?: number;
  stagingStaleAfterMs?: number;
} = {}): Promise<StorageReconciliationReport> {
  const root = options.root ?? owlLabDataRoot();
  const now = options.now ?? Date.now();
  const references = (await listStorageReferences(root)).filter(
    (reference) => reference.lifecycle !== "DELETED",
  );
  const objects = await physicalObjects(root);
  const byObjectId = new Map(objects.map((object) => [object.objectId, object]));

  const missingReferences: StorageReconciliationReport["missingReferences"] = [];
  const corruptObjects: StorageReconciliationReport["corruptObjects"] = [];
  const checkedObjects = new Set<string>();

  for (const reference of references) {
    const object = byObjectId.get(reference.artifact.objectId);
    if (!object) {
      missingReferences.push({
        artifactId: reference.artifact.artifactId,
        objectId: reference.artifact.objectId,
        digest: reference.artifact.digest,
      });
      continue;
    }
    if (checkedObjects.has(object.objectId)) continue;
    checkedObjects.add(object.objectId);

    const expected = reference.artifact.digest.replace(/^sha256:/, "");
    try {
      const actual = await sha256File(object.filePath);
      if (actual !== expected || object.digest !== reference.artifact.digest) {
        corruptObjects.push({
          objectId: object.objectId,
          digest: object.digest,
          reason: "digest_mismatch",
        });
      }
    } catch {
      corruptObjects.push({
        objectId: object.objectId,
        digest: object.digest,
        reason: "read_failed",
      });
    }
  }

  const referencedIds = new Set(references.map((item) => item.artifact.objectId));
  const unreferencedObjects = objects
    .filter((object) => !referencedIds.has(object.objectId))
    .map(({ objectId, digest, sizeBytes }) => ({
      objectId,
      digest,
      sizeBytes,
    }))
    .sort((a, b) => a.objectId.localeCompare(b.objectId));

  const stale = await staleStaging(
    root,
    now,
    options.stagingStaleAfterMs ?? 7 * 24 * 60 * 60 * 1000,
  );

  const health: StorageHealth =
    missingReferences.length > 0 || corruptObjects.length > 0
      ? "needs_attention"
      : unreferencedObjects.length > 0 || stale.length > 0
        ? "degraded"
        : "healthy";

  return {
    version: 1,
    checkedAt: new Date(now).toISOString(),
    health,
    referencedObjectCount: referencedIds.size,
    physicalObjectCount: objects.length,
    missingReferences,
    corruptObjects,
    unreferencedObjects,
    staleStaging: stale,
    internalPathsExposed: false,
  };
}
