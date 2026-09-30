import fs from "node:fs/promises";
import {
  artifactObjectPath,
  owlLabDataRoot,
  verifyArtifactObject,
  type ArtifactRef,
  type RetentionClass,
} from "./storageFoundation.js";
import {
  getObjectRow,
  getReferenceRow,
  listReferenceRows,
  putObjectRow,
  putReferenceRow,
  withStorageMetadata,
  type StorageObjectRecord,
  type StorageMetadataDatabase,
} from "./storageMetadataStore.js";

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

function cloneReference(reference: StorageReference): StorageReference {
  return JSON.parse(JSON.stringify(reference)) as StorageReference;
}

async function transaction<T>(
  db: StorageMetadataDatabase,
  operation: () => Promise<T> | T,
): Promise<T> {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = await operation();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function assertObjectCompatible(
  object: StorageObjectRecord,
  artifact: ArtifactRef,
): void {
  if (
    object.digest !== artifact.digest ||
    object.sizeBytes !== artifact.sizeBytes
  ) {
    throw new Error(
      "STORAGE_OBJECT_IDENTITY_CONFLICT: object metadata does not match ArtifactRef.",
    );
  }
}

export async function registerArtifactReference(
  artifact: ArtifactRef,
  options: { root?: string; expiresAt?: string | null } = {},
): Promise<StorageReference> {
  const root = options.root ?? owlLabDataRoot();
  return await withStorageMetadata(async (db) =>
    await transaction(db, async () => {
      await verifyArtifactObject(artifact, root);

      const existing = getReferenceRow(db, artifact.artifactId);
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

      const object = getObjectRow(db, artifact.objectId);
      if (object?.state === "GC_PENDING") {
        throw new Error(
          "STORAGE_OBJECT_GC_PENDING: object is being garbage-collected; retry registration.",
        );
      }
      if (object) assertObjectCompatible(object, artifact);

      const at = nowIso();
      putObjectRow(db, {
        objectId: artifact.objectId,
        digest: artifact.digest,
        sizeBytes: artifact.sizeBytes,
        state: "ACTIVE",
        createdAt: object?.createdAt ?? artifact.createdAt,
        updatedAt: at,
      });

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
      putReferenceRow(db, reference);
      return cloneReference(reference);
    }),
  root);
}

export async function listStorageReferences(
  root = owlLabDataRoot(),
): Promise<StorageReference[]> {
  return await withStorageMetadata(
    (db) => listReferenceRows(db).map(cloneReference),
    root,
  );
}

export async function pinArtifactReference(
  artifactId: string,
  root = owlLabDataRoot(),
): Promise<StorageReference> {
  return await withStorageMetadata(async (db) =>
    await transaction(db, () => {
      const reference = getReferenceRow(db, artifactId);
      if (!reference || reference.lifecycle === "DELETED") {
        throw new Error("STORAGE_REFERENCE_NOT_FOUND: artifact reference not found.");
      }
      const at = nowIso();
      reference.lifecycle = "PINNED";
      reference.pinnedAt = at;
      reference.updatedAt = at;
      reference.reclaimableAt = null;
      reference.gcPendingAt = null;
      putReferenceRow(db, reference);
      return cloneReference(reference);
    }),
  root);
}

export async function unpinArtifactReference(
  artifactId: string,
  root = owlLabDataRoot(),
  now = Date.now(),
): Promise<StorageReference> {
  return await withStorageMetadata(async (db) =>
    await transaction(db, () => {
      const reference = getReferenceRow(db, artifactId);
      if (!reference || reference.lifecycle !== "PINNED") {
        throw new Error("STORAGE_REFERENCE_NOT_PINNED: artifact reference is not pinned.");
      }
      reference.pinnedAt = null;
      reference.lifecycle =
        reference.expiresAt && Date.parse(reference.expiresAt) <= now
          ? "EXPIRED"
          : "ACTIVE";
      reference.updatedAt = nowIso(now);
      putReferenceRow(db, reference);
      return cloneReference(reference);
    }),
  root);
}

export async function holdArtifactReference(
  artifactId: string,
  reason: string,
  root = owlLabDataRoot(),
): Promise<StorageReference> {
  if (!reason.trim()) {
    throw new Error("STORAGE_HOLD_REASON_REQUIRED: audit hold needs a reason.");
  }
  return await withStorageMetadata(async (db) =>
    await transaction(db, () => {
      const reference = getReferenceRow(db, artifactId);
      if (!reference || reference.lifecycle === "DELETED") {
        throw new Error("STORAGE_REFERENCE_NOT_FOUND: artifact reference not found.");
      }
      const at = nowIso();
      reference.lifecycle = "AUDIT_HOLD";
      reference.holdReason = reason.trim();
      reference.updatedAt = at;
      reference.reclaimableAt = null;
      reference.gcPendingAt = null;
      putReferenceRow(db, reference);
      return cloneReference(reference);
    }),
  root);
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

  return await withStorageMetadata(async (db) =>
    await transaction(db, () => {
      const references = listReferenceRows(db);
      let changed = 0;

      for (const reference of references) {
        if (
          reference.lifecycle === "PINNED" ||
          reference.lifecycle === "AUDIT_HOLD" ||
          reference.lifecycle === "DELETED" ||
          reference.lifecycle === "GC_PENDING" ||
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
        putReferenceRow(db, reference);
      }

      return {
        evaluatedAt: at,
        changed,
        references: listReferenceRows(db).map(cloneReference),
      };
    }),
  root);
}

function isLive(reference: StorageReference): boolean {
  return (
    reference.lifecycle === "ACTIVE" ||
    reference.lifecycle === "PINNED" ||
    reference.lifecycle === "AUDIT_HOLD"
  );
}

function graceSatisfied(
  reference: StorageReference,
  now: number,
  gracePeriodMs: number,
): boolean {
  if (reference.lifecycle === "GC_PENDING") return true;
  if (reference.lifecycle !== "RECLAIMABLE" || !reference.reclaimableAt) {
    return false;
  }
  return Date.parse(reference.reclaimableAt) + gracePeriodMs <= now;
}

type GcPlan = {
  retireOnly: Array<{ artifactId: string; objectId: string }>;
  deleteObjects: Array<{
    objectId: string;
    digest: ArtifactRef["digest"];
    sizeBytes: number;
    artifactIds: string[];
  }>;
};

function buildGcPlan(
  references: StorageReference[],
  now: number,
  gracePeriodMs: number,
): GcPlan {
  const groups = new Map<string, StorageReference[]>();
  for (const reference of references) {
    const group = groups.get(reference.artifact.objectId) ?? [];
    group.push(reference);
    groups.set(reference.artifact.objectId, group);
  }

  const retireOnly: GcPlan["retireOnly"] = [];
  const deleteObjects: GcPlan["deleteObjects"] = [];

  for (const [objectId, group] of groups) {
    const live = group.filter((reference) => reference.lifecycle !== "DELETED");
    const eligible = live.filter((reference) =>
      graceSatisfied(reference, now, gracePeriodMs),
    );
    if (eligible.length === 0) continue;

    if (live.some(isLive)) {
      for (const reference of eligible) {
        if (!isLive(reference)) {
          retireOnly.push({
            artifactId: reference.artifact.artifactId,
            objectId,
          });
        }
      }
      continue;
    }

    if (!live.every((reference) => graceSatisfied(reference, now, gracePeriodMs))) {
      continue;
    }

    const exemplar = live[0];
    if (!exemplar) continue;
    deleteObjects.push({
      objectId,
      digest: exemplar.artifact.digest,
      sizeBytes: exemplar.artifact.sizeBytes,
      artifactIds: live.map((reference) => reference.artifact.artifactId),
    });
  }

  return { retireOnly, deleteObjects };
}

export async function collectGarbage(options: {
  root?: string;
  now?: number;
  gracePeriodMs?: number;
  dryRun?: boolean;
}): Promise<GarbageCollectionReceipt> {
  const root = options.root ?? owlLabDataRoot();
  const now = options.now ?? Date.now();
  const gracePeriodMs = Math.max(
    0,
    options.gracePeriodMs ?? 7 * DAY_MS,
  );
  const dryRun = options.dryRun ?? false;
  const at = nowIso(now);

  if (dryRun) {
    const references = await listStorageReferences(root);
    const plan = buildGcPlan(references, now, gracePeriodMs);
    return {
      evaluatedAt: at,
      dryRun: true,
      retiredReferenceIds: [
        ...plan.retireOnly.map((item) => item.artifactId),
        ...plan.deleteObjects.flatMap((item) => item.artifactIds),
      ],
      deletedObjectIds: plan.deleteObjects.map((item) => item.objectId),
      reclaimedBytes: plan.deleteObjects.reduce(
        (sum, item) => sum + item.sizeBytes,
        0,
      ),
      retainedSharedObjectIds: [
        ...new Set(plan.retireOnly.map((item) => item.objectId)),
      ],
    };
  }

  const plan = await withStorageMetadata(async (db) =>
    await transaction(db, () => {
      const references = listReferenceRows(db);
      const candidate = buildGcPlan(references, now, gracePeriodMs);

      for (const item of candidate.retireOnly) {
        const reference = getReferenceRow(db, item.artifactId);
        if (!reference || reference.lifecycle === "DELETED") continue;
        reference.lifecycle = "DELETED";
        reference.deletedAt = at;
        reference.updatedAt = at;
        putReferenceRow(db, reference);
      }

      for (const item of candidate.deleteObjects) {
        const object = getObjectRow(db, item.objectId);
        if (object?.state === "DELETED") continue;
        if (object) {
          putObjectRow(db, {
            ...object,
            state: "GC_PENDING",
            updatedAt: at,
          });
        } else {
          putObjectRow(db, {
            objectId: item.objectId,
            digest: item.digest,
            sizeBytes: item.sizeBytes,
            state: "GC_PENDING",
            createdAt: at,
            updatedAt: at,
          });
        }

        for (const artifactId of item.artifactIds) {
          const reference = getReferenceRow(db, artifactId);
          if (!reference || reference.lifecycle === "DELETED") continue;
          reference.lifecycle = "GC_PENDING";
          reference.gcPendingAt ??= at;
          reference.updatedAt = at;
          putReferenceRow(db, reference);
        }
      }

      return candidate;
    }),
  root);

  let reclaimedBytes = 0;
  const deletedObjectIds: string[] = [];

  for (const item of plan.deleteObjects) {
    let deleteError: unknown = null;
    try {
      const objectPath = artifactObjectPath(item.digest, root);
      try {
        const stat = await fs.stat(objectPath);
        await fs.rm(objectPath, { force: false });
        reclaimedBytes += Number(stat.size);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    } catch (error) {
      deleteError = error;
    }

    await withStorageMetadata(async (db) =>
      await transaction(db, () => {
        const object = getObjectRow(db, item.objectId);
        if (deleteError) {
          if (object) {
            putObjectRow(db, {
              ...object,
              state: "ACTIVE",
              updatedAt: nowIso(),
            });
          }
          for (const artifactId of item.artifactIds) {
            const reference = getReferenceRow(db, artifactId);
            if (!reference || reference.lifecycle !== "GC_PENDING") continue;
            reference.lifecycle = "RECLAIMABLE";
            reference.gcPendingAt = null;
            reference.updatedAt = nowIso();
            putReferenceRow(db, reference);
          }
          return;
        }

        if (object) {
          putObjectRow(db, {
            ...object,
            state: "DELETED",
            updatedAt: nowIso(),
          });
        }
        for (const artifactId of item.artifactIds) {
          const reference = getReferenceRow(db, artifactId);
          if (!reference) continue;
          reference.lifecycle = "DELETED";
          reference.deletedAt = nowIso();
          reference.updatedAt = reference.deletedAt;
          putReferenceRow(db, reference);
        }
      }),
    root);

    if (deleteError) throw deleteError;
    deletedObjectIds.push(item.objectId);
  }

  return {
    evaluatedAt: at,
    dryRun: false,
    retiredReferenceIds: [
      ...plan.retireOnly.map((item) => item.artifactId),
      ...plan.deleteObjects.flatMap((item) => item.artifactIds),
    ],
    deletedObjectIds,
    reclaimedBytes,
    retainedSharedObjectIds: [
      ...new Set(plan.retireOnly.map((item) => item.objectId)),
    ],
  };
}
