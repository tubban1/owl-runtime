import {
  DEFAULT_RETENTION_MS,
  collectGarbage,
  evaluateRetention,
  listStorageReferences,
  pinArtifactReference,
  unpinArtifactReference,
  type StorageReference,
} from "./storageRetention.js";
import {
  inventoryLegacyStorage,
  migrateLegacyStorage as migrateLegacyStorageInternal,
  type LegacyStorageInventory,
} from "./legacyStorageMigration.js";
import {
  reconcileStorage,
  type StorageReconciliationReport,
} from "./storageReconciliation.js";
import {
  STORAGE_METADATA_SCHEMA_VERSION,
  STORAGE_METADATA_CIPHER_PROFILE,
} from "./storageMetadataStore.js";

function publicReference(reference: StorageReference) {
  return {
    schemaVersion: 1 as const,
    artifact: reference.artifact,
    lifecycle: reference.lifecycle,
    expiresAt: reference.expiresAt,
    reclaimableAt: reference.reclaimableAt,
    pinnedAt: reference.pinnedAt,
    holdReason: reference.holdReason,
  };
}

export async function getStorageRuntimeStatus() {
  const [references, reconciliation] = await Promise.all([
    listStorageReferences(),
    reconcileStorage(),
  ]);
  const live = references.filter((reference) => reference.lifecycle !== "DELETED");
  const unique = new Map<string, number>();
  for (const reference of live) {
    unique.set(reference.artifact.objectId, reference.artifact.sizeBytes);
  }

  const lifecycleCounts = live.reduce<Record<string, number>>((counts, reference) => {
    counts[reference.lifecycle] = (counts[reference.lifecycle] ?? 0) + 1;
    return counts;
  }, {});

  const classCounts = live.reduce<Record<string, number>>((counts, reference) => {
    const key = reference.artifact.retentionClass;
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});

  return {
    schemaVersion: 1 as const,
    foundationVersion: 1 as const,
    retentionVersion: 1 as const,
    reconciliationVersion: reconciliation.version,
    metadataStore: {
      provider: "sqlite" as const,
      schemaVersion: STORAGE_METADATA_SCHEMA_VERSION,
      database: "state/owl.db" as const,
      absolutePathExposed: false as const,
      secretsStoredHere: false as const,
      encryptedAtRest: process.env.OWL_RUNTIME_MODE === "production",
      cipherProfile:
        process.env.OWL_RUNTIME_MODE === "production"
          ? STORAGE_METADATA_CIPHER_PROFILE
          : null,
    },
    health: reconciliation.health,
    usage: {
      logicalReferenceCount: live.length,
      uniqueReferencedObjectCount: unique.size,
      uniqueReferencedBytes: [...unique.values()].reduce((sum, bytes) => sum + bytes, 0),
      unreferencedObjectCount: reconciliation.unreferencedObjects.length,
      unreferencedBytes: reconciliation.unreferencedObjects.reduce(
        (sum, object) => sum + object.sizeBytes,
        0,
      ),
      staleStagingCount: reconciliation.staleStaging.length,
    },
    lifecycleCounts,
    retentionClassCounts: classCounts,
    retentionDefaultsMs: { ...DEFAULT_RETENTION_MS },
    internalPathsExposed: false as const,
  };
}

export async function listPublicStorageArtifacts() {
  return (await listStorageReferences()).map(publicReference);
}

export async function reconcilePublicStorage(): Promise<StorageReconciliationReport> {
  return await reconcileStorage();
}

export async function evaluatePublicStorageRetention() {
  const evaluation = await evaluateRetention();
  return {
    schemaVersion: 1 as const,
    evaluatedAt: evaluation.evaluatedAt,
    changed: evaluation.changed,
    artifacts: evaluation.references.map(publicReference),
  };
}

export async function collectPublicStorageGarbage(request: {
  confirm: boolean;
  dryRun?: boolean;
  gracePeriodMs?: number;
}) {
  const dryRun = request.dryRun ?? false;
  if (!dryRun && request.confirm !== true) {
    throw new Error(
      "STORAGE_GC_CONFIRM_REQUIRED: destructive garbage collection requires confirm=true.",
    );
  }
  const receipt = await collectGarbage({
    dryRun,
    gracePeriodMs: request.gracePeriodMs,
  });
  return {
    schemaVersion: 1 as const,
    ...receipt,
  };
}

export async function pinPublicStorageArtifact(artifactId: string) {
  return publicReference(await pinArtifactReference(artifactId));
}

export async function unpinPublicStorageArtifact(artifactId: string) {
  return publicReference(await unpinArtifactReference(artifactId));
}

export async function inventoryPublicLegacyStorage(): Promise<LegacyStorageInventory> {
  return await inventoryLegacyStorage();
}

export async function migratePublicLegacyStorage(request: {
  inventory: LegacyStorageInventory;
  confirm: boolean;
}) {
  return await migrateLegacyStorageInternal({
    inventory: request.inventory,
    confirm: request.confirm,
  });
}
