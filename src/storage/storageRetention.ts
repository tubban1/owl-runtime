import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  artifactObjectPath,
  ensureStorageLayout,
  owlLabDataRoot,
  verifyArtifactObject,
  type ArtifactRef,
  type RetentionClass,
} from "./storageFoundation.js";

export const STORAGE_REFERENCE_INDEX_VERSION = 1 as const;

export type StorageReferenceLifecycle =
  | "ACTIVE"
  | "EXPIRED"
  | "RECLAIMABLE"
  | "GC_PENDING"
  | "PINNED"
  | "AUDIT_HOLD"
  | "DELETED";

export type StorageReference = {
  version: 1;
  artifact: ArtifactRef;
  lifecycle: StorageReferenceLifecycle;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
  reclaimableAt: string | null;
  gcPendingAt: string | null;
  deletedAt: string | null;
  pinnedAt: string | null;
  holdReason: string | null;
};

type StorageReferenceIndex = {
  format: "owl-lab-storage-reference-index";
  version: 1;
  createdAt: string;
  updatedAt: string;
  references: StorageReference[];
};

export type RetentionEvaluation = {
  evaluatedAt: string;
  changed: number;
  references: StorageReference[];
};

export type GarbageCollectionReceipt = {
  evaluatedAt: string;
  dryRun: boolean;
  retiredReferenceIds: string[];
  deletedObjectIds: string[];
  reclaimedBytes: number;
  retainedSharedObjectIds: string[];
};

const DAY_MS = 24 * 60 * 60 * 1000;
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_STALE_MS = 30_000;

export const DEFAULT_RETENTION_MS: Readonly<Record<RetentionClass, number | null>> = {
  cache: 7 * DAY_MS,
  task_staging: 7 * DAY_MS,
  intermediate: 30 * DAY_MS,
  log: 30 * DAY_MS,
  failed_debug: 30 * DAY_MS,
  observation_payload: 90 * DAY_MS,
  saved: null,
  task_metadata: null,
  audit: null,
};

function indexPath(root: string): string {
  return path.join(root, "state", "storage-references.json");
}

function lockPath(root: string): string {
  return path.join(root, "state", ".storage-references.lock");
}

function nowIso(now = Date.now()): string {
  return new Date(now).toISOString();
}

function expirationFor(
  artifact: ArtifactRef,
  createdAtMs = Date.parse(artifact.createdAt),
): string | null {
  const ttl = DEFAULT_RETENTION_MS[artifact.retentionClass];
  if (ttl === null) return null;
  return new Date(createdAtMs + ttl).toISOString();
}

function emptyIndex(now = Date.now()): StorageReferenceIndex {
  const at = nowIso(now);
  return {
    format: "owl-lab-storage-reference-index",
    version: STORAGE_REFERENCE_INDEX_VERSION,
    createdAt: at,
    updatedAt: at,
    references: [],
  };
}

function validateIndex(index: StorageReferenceIndex): StorageReferenceIndex {
  if (
    !index ||
    index.format !== "owl-lab-storage-reference-index" ||
    index.version !== STORAGE_REFERENCE_INDEX_VERSION ||
    !Array.isArray(index.references)
  ) {
    throw new Error("STORAGE_REFERENCE_INDEX_INVALID: unsupported reference index.");
  }
  return index;
}

async function readIndex(root: string): Promise<StorageReferenceIndex> {
  await ensureStorageLayout(root);
  try {
    return validateIndex(
      JSON.parse(await fs.readFile(indexPath(root), "utf8")) as StorageReferenceIndex,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyIndex();
    throw error;
  }
}

async function atomicWriteIndex(
  root: string,
  index: StorageReferenceIndex,
): Promise<void> {
  const target = indexPath(root);
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(index, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  try {
    await fs.rename(temp, target);
    await fs.chmod(target, 0o600).catch(() => undefined);
  } finally {
    await fs.rm(temp, { force: true }).catch(() => undefined);
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireIndexLock(root: string): Promise<() => Promise<void>> {
  await ensureStorageLayout(root);
  const lock = lockPath(root);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;

  while (true) {
    try {
      const handle = await fs.open(lock, "wx", 0o600);
      await handle.writeFile(
        JSON.stringify({ pid: process.pid, createdAt: nowIso() }) + "\n",
      );
      await handle.close();
      return async () => {
        await fs.rm(lock, { force: true }).catch(() => undefined);
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;

      try {
        const stat = await fs.stat(lock);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          await fs.rm(lock, { force: true });
          continue;
        }
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw statError;
      }

      if (Date.now() >= deadline) {
        throw new Error("STORAGE_REFERENCE_LOCK_TIMEOUT: reference index is busy.");
      }
      await sleep(25);
    }
  }
}

async function mutateIndex<T>(
  root: string,
  mutation: (index: StorageReferenceIndex) => Promise<T> | T,
): Promise<T> {
  const release = await acquireIndexLock(root);
  try {
    const index = await readIndex(root);
    const result = await mutation(index);
    index.updatedAt = nowIso();
    await atomicWriteIndex(root, index);
    return result;
  } finally {
    await release();
  }
}

function cloneReference(reference: StorageReference): StorageReference {
  return JSON.parse(JSON.stringify(reference)) as StorageReference;
}

export async function registerArtifactReference(
  artifact: ArtifactRef,
  options: { root?: string; expiresAt?: string | null } = {},
): Promise<StorageReference> {
  const root = options.root ?? owlLabDataRoot();
  return await mutateIndex(root, async (index) => {
    await verifyArtifactObject(artifact, root);
    const existing = index.references.find(
      (reference) => reference.artifact.artifactId === artifact.artifactId,
    );
    if (existing) {
      if (
        existing.artifact.objectId !== artifact.objectId ||
        existing.artifact.digest !== artifact.digest
      ) {
        throw new Error(
          "STORAGE_REFERENCE_IDENTITY_CONFLICT: artifactId already binds another object.",
        );
      }
      return cloneReference(existing);
    }

    const at = nowIso();
    const reference: StorageReference = {
      version: 1,
      artifact: { ...artifact },
      lifecycle: "ACTIVE",
      createdAt: at,
      updatedAt: at,
      expiresAt:
        options.expiresAt === undefined
          ? expirationFor(artifact)
          : options.expiresAt,
      reclaimableAt: null,
      gcPendingAt: null,
      deletedAt: null,
      pinnedAt: null,
      holdReason: null,
    };
    index.references.push(reference);
    return cloneReference(reference);
  });
}

export async function listStorageReferences(
  root = owlLabDataRoot(),
): Promise<StorageReference[]> {
  return (await readIndex(root)).references.map(cloneReference);
}

export async function pinArtifactReference(
  artifactId: string,
  root = owlLabDataRoot(),
): Promise<StorageReference> {
  return await mutateIndex(root, (index) => {
    const reference = index.references.find(
      (item) => item.artifact.artifactId === artifactId,
    );
    if (!reference || reference.lifecycle === "DELETED") {
      throw new Error("STORAGE_REFERENCE_NOT_FOUND: artifact reference not found.");
    }
    const at = nowIso();
    reference.lifecycle = "PINNED";
    reference.pinnedAt = at;
    reference.updatedAt = at;
    reference.reclaimableAt = null;
    reference.gcPendingAt = null;
    return cloneReference(reference);
  });
}

export async function unpinArtifactReference(
  artifactId: string,
  root = owlLabDataRoot(),
  now = Date.now(),
): Promise<StorageReference> {
  return await mutateIndex(root, (index) => {
    const reference = index.references.find(
      (item) => item.artifact.artifactId === artifactId,
    );
    if (!reference || reference.lifecycle !== "PINNED") {
      throw new Error("STORAGE_REFERENCE_NOT_PINNED: artifact reference is not pinned.");
    }
    reference.pinnedAt = null;
    reference.lifecycle =
      reference.expiresAt && Date.parse(reference.expiresAt) <= now
        ? "EXPIRED"
        : "ACTIVE";
    reference.updatedAt = nowIso(now);
    return cloneReference(reference);
  });
}

export async function holdArtifactReference(
  artifactId: string,
  reason: string,
  root = owlLabDataRoot(),
): Promise<StorageReference> {
  if (!reason.trim()) {
    throw new Error("STORAGE_HOLD_REASON_REQUIRED: audit hold needs a reason.");
  }
  return await mutateIndex(root, (index) => {
    const reference = index.references.find(
      (item) => item.artifact.artifactId === artifactId,
    );
    if (!reference || reference.lifecycle === "DELETED") {
      throw new Error("STORAGE_REFERENCE_NOT_FOUND: artifact reference not found.");
    }
    const at = nowIso();
    reference.lifecycle = "AUDIT_HOLD";
    reference.holdReason = reason.trim();
    reference.updatedAt = at;
    reference.reclaimableAt = null;
    reference.gcPendingAt = null;
    return cloneReference(reference);
  });
}

export async function evaluateRetention(
  options: {
    root?: string;
    now?: number;
  } = {},
): Promise<RetentionEvaluation> {
  const root = options.root ?? owlLabDataRoot();
  const now = options.now ?? Date.now();
  const at = nowIso(now);

  return await mutateIndex(root, (index) => {
    let changed = 0;
    for (const reference of index.references) {
      if (
        reference.lifecycle === "PINNED" ||
        reference.lifecycle === "AUDIT_HOLD" ||
        reference.lifecycle === "DELETED" ||
        !reference.expiresAt
      ) {
        continue;
      }

      if (Date.parse(reference.expiresAt) > now) continue;

      if (reference.lifecycle === "ACTIVE") {
        reference.lifecycle = "EXPIRED";
        reference.updatedAt = at;
        changed += 1;
      }
      if (reference.lifecycle === "EXPIRED") {
        reference.lifecycle = "RECLAIMABLE";
        reference.reclaimableAt ??= at;
        reference.updatedAt = at;
        changed += 1;
      }
    }

    return {
      evaluatedAt: at,
      changed,
      references: index.references.map(cloneReference),
    };
  });
}

function isLive(reference: StorageReference): boolean {
  return (
    reference.lifecycle === "ACTIVE" ||
    reference.lifecycle === "PINNED" ||
    reference.lifecycle === "AUDIT_HOLD"
  );
}

export async function collectGarbage(options: {
  root?: string;
  now?: number;
  gracePeriodMs?: number;
  dryRun?: boolean;
}): Promise<GarbageCollectionReceipt> {
  const root = options.root ?? owlLabDataRoot();
  const now = options.now ?? Date.now();
  const gracePeriodMs = Math.max(0, options.gracePeriodMs ?? 7 * DAY_MS);
  const dryRun = options.dryRun ?? false;
  const at = nowIso(now);

  return await mutateIndex(root, async (index) => {
    const eligible = index.references.filter((reference) => {
      if (reference.lifecycle !== "RECLAIMABLE") return false;
      if (!reference.reclaimableAt) return false;
      return Date.parse(reference.reclaimableAt) + gracePeriodMs <= now;
    });

    const objectGroups = new Map<string, StorageReference[]>();
    for (const reference of index.references) {
      const group = objectGroups.get(reference.artifact.objectId) ?? [];
      group.push(reference);
      objectGroups.set(reference.artifact.objectId, group);
    }

    const retiredReferenceIds: string[] = [];
    const deletedObjectIds: string[] = [];
    const retainedSharedObjectIds: string[] = [];
    let reclaimedBytes = 0;
    const processedObjectIds = new Set<string>();

    for (const reference of eligible) {
      if (processedObjectIds.has(reference.artifact.objectId)) continue;
      processedObjectIds.add(reference.artifact.objectId);
      const group = objectGroups.get(reference.artifact.objectId) ?? [];
      const otherLive = group.some(
        (candidate) =>
          candidate.artifact.artifactId !== reference.artifact.artifactId &&
          isLive(candidate),
      );

      if (otherLive) {
        if (!dryRun) {
          reference.lifecycle = "DELETED";
          reference.deletedAt = at;
          reference.updatedAt = at;
        }
        retiredReferenceIds.push(reference.artifact.artifactId);
        if (!retainedSharedObjectIds.includes(reference.artifact.objectId)) {
          retainedSharedObjectIds.push(reference.artifact.objectId);
        }
        continue;
      }

      const allNonDeleted = group.filter(
        (candidate) => candidate.lifecycle !== "DELETED",
      );
      const groupEligible = allNonDeleted.every((candidate) => {
        if (candidate.lifecycle === "RECLAIMABLE" && candidate.reclaimableAt) {
          return Date.parse(candidate.reclaimableAt) + gracePeriodMs <= now;
        }
        return candidate.lifecycle === "GC_PENDING";
      });
      if (!groupEligible) continue;

      if (!dryRun) {
        for (const candidate of allNonDeleted) {
          candidate.lifecycle = "GC_PENDING";
          candidate.gcPendingAt ??= at;
          candidate.updatedAt = at;
        }

        const objectPath = artifactObjectPath(reference.artifact.digest, root);
        try {
          const stat = await fs.stat(objectPath);
          await fs.rm(objectPath, { force: false });
          reclaimedBytes += stat.size;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }

        for (const candidate of allNonDeleted) {
          candidate.lifecycle = "DELETED";
          candidate.deletedAt = at;
          candidate.updatedAt = at;
          if (!retiredReferenceIds.includes(candidate.artifact.artifactId)) {
            retiredReferenceIds.push(candidate.artifact.artifactId);
          }
        }
      } else {
        for (const candidate of allNonDeleted) {
          if (!retiredReferenceIds.includes(candidate.artifact.artifactId)) {
            retiredReferenceIds.push(candidate.artifact.artifactId);
          }
        }
        reclaimedBytes += reference.artifact.sizeBytes;
      }

      if (!deletedObjectIds.includes(reference.artifact.objectId)) {
        deletedObjectIds.push(reference.artifact.objectId);
      }
    }

    return {
      evaluatedAt: at,
      dryRun,
      retiredReferenceIds,
      deletedObjectIds,
      reclaimedBytes,
      retainedSharedObjectIds,
    };
  });
}
