import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  commitArtifactFromFile,
  verifyArtifactObject,
  type ArtifactRef,
  type RetentionClass,
} from "./storageFoundation.js";
import { registerArtifactReference } from "./storageRetention.js";

export const LEGACY_STORAGE_MIGRATION_VERSION = 1 as const;

export type LegacyStorageSource = "computer-mcp" | "agentos" | "owl-runtime";

export type LegacyMigrationDecision = "migrate" | "discardable" | "review";

export type LegacyStorageInventoryItem = {
  version: 1;
  source: LegacyStorageSource;
  relativePath: string;
  sizeBytes: number;
  modifiedAt: string;
  inferredType: string;
  digest: `sha256:${string}`;
  migrationDecision: LegacyMigrationDecision;
  retentionClass: RetentionClass | null;
  confidence: number;
};

export type LegacyStorageInventory = {
  version: 1;
  createdAt: string;
  roots: Array<{
    source: LegacyStorageSource;
    exists: boolean;
    fileCount: number;
    sizeBytes: number;
  }>;
  items: LegacyStorageInventoryItem[];
  totals: {
    bytes: number;
    migrateBytes: number;
    discardableBytes: number;
    reviewBytes: number;
  };
};

export type LegacyMigrationReceipt = {
  version: 1;
  migratedAt: string;
  confirmed: true;
  migrated: Array<{
    source: LegacyStorageSource;
    relativePath: string;
    artifact: ArtifactRef;
  }>;
  objectIds: string[];
  migratedBytes: number;
  uniqueObjectBytes: number;
  deduplicatedBytes: number;
  reclaimableLegacyBytes: number;
  reviewBytes: number;
  legacyDeleted: false;
};

export type LegacyStorageRoots = Partial<Record<LegacyStorageSource, string>>;

function defaultLegacyRoots(): Record<LegacyStorageSource, string> {
  return {
    "computer-mcp": path.join(os.homedir(), ".computer-mcp"),
    agentos: path.join(os.homedir(), ".agentos"),
    "owl-runtime": path.join(os.homedir(), ".owl-runtime"),
  };
}

function safeRelative(root: string, fullPath: string): string {
  const relative = path.relative(root, fullPath);
  if (
    !relative ||
    relative === "." ||
    relative.startsWith("..") ||
    path.isAbsolute(relative)
  ) {
    throw new Error("LEGACY_STORAGE_PATH_ESCAPE: inventory path escaped source root.");
  }
  return relative.split(path.sep).join("/");
}

async function sha256File(filePath: string): Promise<`sha256:${string}`> {
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
  return `sha256:${hash.digest("hex")}`;
}

function classifyLegacyPath(relativePath: string): Pick<
  LegacyStorageInventoryItem,
  "inferredType" | "migrationDecision" | "retentionClass" | "confidence"
> {
  const normalized = `/${relativePath.toLowerCase()}/`;

  if (
    normalized.includes("/cache/") ||
    normalized.includes("/caches/") ||
    normalized.includes("/node_modules/") ||
    normalized.endsWith(".cache/")
  ) {
    return {
      inferredType: "cache",
      migrationDecision: "discardable",
      retentionClass: "cache",
      confidence: 0.98,
    };
  }

  if (
    normalized.includes("/logs/") ||
    normalized.includes("/log/") ||
    /\.log\/?$/.test(normalized)
  ) {
    return {
      inferredType: "log",
      migrationDecision: "discardable",
      retentionClass: "log",
      confidence: 0.97,
    };
  }

  if (
    normalized.includes("/evidence/") ||
    normalized.includes("/artifacts/") ||
    normalized.includes("/outputs/") ||
    normalized.includes("/assets/") ||
    normalized.includes("/drafts/") ||
    normalized.includes("/research/")
  ) {
    return {
      inferredType: normalized.includes("/evidence/") ? "evidence_payload" : "artifact",
      migrationDecision: "migrate",
      retentionClass: normalized.includes("/evidence/")
        ? "observation_payload"
        : "intermediate",
      confidence: 0.9,
    };
  }

  if (
    normalized.includes("/staging/") &&
    !normalized.includes("/scratch/")
  ) {
    return {
      inferredType: "staging_artifact",
      migrationDecision: "migrate",
      retentionClass: "task_staging",
      confidence: 0.82,
    };
  }

  if (
    normalized.includes("/scratch/") ||
    normalized.endsWith(".tmp/") ||
    normalized.includes("/tmp/")
  ) {
    return {
      inferredType: "scratch",
      migrationDecision: "review",
      retentionClass: null,
      confidence: 0.75,
    };
  }

  if (
    normalized.includes("/tasks/") ||
    normalized.endsWith(".task/") ||
    normalized.includes("/memory/") ||
    normalized.includes("/schedules/") ||
    normalized.includes("/approvals/")
  ) {
    return {
      inferredType: "structured_runtime_state",
      migrationDecision: "review",
      retentionClass: null,
      confidence: 0.92,
    };
  }

  return {
    inferredType: "unknown",
    migrationDecision: "review",
    retentionClass: null,
    confidence: 0.5,
  };
}

async function walkFiles(
  root: string,
  current: string,
  items: Array<{ fullPath: string; stat: Awaited<ReturnType<typeof fs.stat>> }>,
): Promise<void> {
  const entries = await fs.readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(current, entry.name);

    if (entry.isSymbolicLink()) {
      continue;
    }
    if (entry.isDirectory()) {
      await walkFiles(root, fullPath, items);
      continue;
    }
    if (!entry.isFile()) continue;

    const stat = await fs.stat(fullPath);
    items.push({ fullPath, stat });
  }
}

export async function inventoryLegacyStorage(
  options: { roots?: LegacyStorageRoots } = {},
): Promise<LegacyStorageInventory> {
  const configured = {
    ...defaultLegacyRoots(),
    ...(options.roots ?? {}),
  };

  const roots: LegacyStorageInventory["roots"] = [];
  const items: LegacyStorageInventoryItem[] = [];

  for (const source of [
    "computer-mcp",
    "agentos",
    "owl-runtime",
  ] as const) {
    const root = path.resolve(configured[source]);
    let exists = true;
    try {
      const stat = await fs.stat(root);
      if (!stat.isDirectory()) exists = false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") exists = false;
      else throw error;
    }

    if (!exists) {
      roots.push({ source, exists: false, fileCount: 0, sizeBytes: 0 });
      continue;
    }

    const sourceFiles: Array<{
      fullPath: string;
      stat: Awaited<ReturnType<typeof fs.stat>>;
    }> = [];
    await walkFiles(root, root, sourceFiles);

    let sourceBytes = 0;
    for (const { fullPath, stat } of sourceFiles) {
      const relativePath = safeRelative(root, fullPath);
      const classification = classifyLegacyPath(relativePath);
      const sizeBytes = Number(stat.size);
      if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
        throw new Error("LEGACY_STORAGE_SIZE_INVALID: file size is outside safe integer range.");
      }
      sourceBytes += sizeBytes;
      items.push({
        version: 1,
        source,
        relativePath,
        sizeBytes,
        modifiedAt: stat.mtime.toISOString(),
        inferredType: classification.inferredType,
        digest: await sha256File(fullPath),
        migrationDecision: classification.migrationDecision,
        retentionClass: classification.retentionClass,
        confidence: classification.confidence,
      });
    }

    roots.push({
      source,
      exists: true,
      fileCount: sourceFiles.length,
      sizeBytes: sourceBytes,
    });
  }

  items.sort((left, right) =>
    `${left.source}/${left.relativePath}`.localeCompare(
      `${right.source}/${right.relativePath}`,
    ),
  );

  const totals = items.reduce(
    (acc, item) => {
      acc.bytes += item.sizeBytes;
      if (item.migrationDecision === "migrate") acc.migrateBytes += item.sizeBytes;
      if (item.migrationDecision === "discardable")
        acc.discardableBytes += item.sizeBytes;
      if (item.migrationDecision === "review") acc.reviewBytes += item.sizeBytes;
      return acc;
    },
    { bytes: 0, migrateBytes: 0, discardableBytes: 0, reviewBytes: 0 },
  );

  return {
    version: 1,
    createdAt: new Date().toISOString(),
    roots,
    items,
    totals,
  };
}

function sourcePath(
  item: LegacyStorageInventoryItem,
  roots: Record<LegacyStorageSource, string>,
): string {
  const root = path.resolve(roots[item.source]);
  const resolved = path.resolve(root, item.relativePath);
  if (
    resolved === root ||
    (!resolved.startsWith(root + path.sep) && resolved !== root)
  ) {
    throw new Error("LEGACY_STORAGE_PATH_ESCAPE: migration path escaped source root.");
  }
  return resolved;
}

export async function migrateLegacyStorage(options: {
  inventory: LegacyStorageInventory;
  confirm: boolean;
  roots?: LegacyStorageRoots;
  storageRoot?: string;
}): Promise<LegacyMigrationReceipt> {
  if (!options.confirm) {
    throw new Error(
      "LEGACY_STORAGE_MIGRATION_CONFIRM_REQUIRED: migration requires confirm=true.",
    );
  }

  const roots = {
    ...defaultLegacyRoots(),
    ...(options.roots ?? {}),
  };
  const migrated: LegacyMigrationReceipt["migrated"] = [];
  const uniqueObjects = new Map<string, number>();
  let migratedBytes = 0;

  for (const item of options.inventory.items) {
    if (item.migrationDecision !== "migrate" || !item.retentionClass) continue;

    const filePath = sourcePath(item, roots);
    const currentDigest = await sha256File(filePath);
    if (currentDigest !== item.digest) {
      throw new Error(
        `LEGACY_STORAGE_CHANGED_SINCE_INVENTORY: ${item.source}/${item.relativePath}`,
      );
    }

    const artifact = await commitArtifactFromFile({
      sourcePath: filePath,
      mediaType: "application/octet-stream",
      retentionClass: item.retentionClass,
      root: options.storageRoot,
    });
    if (artifact.digest !== item.digest) {
      throw new Error("LEGACY_STORAGE_MIGRATION_VERIFY_FAILED: digest changed during migration.");
    }
    await registerArtifactReference(artifact, {
      root: options.storageRoot,
    });
    await verifyArtifactObject(artifact, options.storageRoot);

    migrated.push({
      source: item.source,
      relativePath: item.relativePath,
      artifact,
    });
    migratedBytes += item.sizeBytes;
    uniqueObjects.set(artifact.objectId, artifact.sizeBytes);
  }

  const uniqueObjectBytes = [...uniqueObjects.values()].reduce(
    (sum, bytes) => sum + bytes,
    0,
  );

  return {
    version: 1,
    migratedAt: new Date().toISOString(),
    confirmed: true,
    migrated,
    objectIds: [...uniqueObjects.keys()].sort(),
    migratedBytes,
    uniqueObjectBytes,
    deduplicatedBytes: Math.max(0, migratedBytes - uniqueObjectBytes),
    reclaimableLegacyBytes:
      options.inventory.totals.discardableBytes + migratedBytes,
    reviewBytes: options.inventory.totals.reviewBytes,
    legacyDeleted: false,
  };
}
