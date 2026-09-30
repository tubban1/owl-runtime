import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const STORAGE_FOUNDATION_VERSION = 1 as const;

export type RetentionClass =
  | "cache"
  | "task_staging"
  | "intermediate"
  | "log"
  | "failed_debug"
  | "observation_payload"
  | "saved"
  | "task_metadata"
  | "audit";

export type ArtifactProvenance = {
  taskId?: string;
  executionRevisionId?: string;
  evidenceId?: string;
};

export type ArtifactRef = {
  schemaVersion: 1;
  artifactId: string;
  objectId: string;
  digest: `sha256:${string}`;
  mediaType: string;
  sizeBytes: number;
  createdAt: string;
  retentionClass: RetentionClass;
  provenance?: ArtifactProvenance;
};

export type StorageLayout = {
  root: string;
  state: string;
  objects: string;
  staging: string;
  logs: string;
  cache: string;
  runtime: string;
  backups: string;
  manifest: string;
};

export type StorageManifestV1 = {
  format: "owl-lab-storage";
  version: 1;
  createdAt: string;
  objectAddressing: "sha256";
  metadataStore: {
    provider: "sqlite";
    database: "state/owl.db";
    schemaVersion: 1;
  };
};

export function owlLabDataRoot(): string {
  const configured = process.env.OWL_LAB_DATA_ROOT?.trim();
  if (configured) return path.resolve(configured);
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "OWL LAB");
  }
  return path.join(os.homedir(), ".owl-lab");
}

export function storageLayout(root = owlLabDataRoot()): StorageLayout {
  const resolved = path.resolve(root);
  return {
    root: resolved,
    state: path.join(resolved, "state"),
    objects: path.join(resolved, "objects"),
    staging: path.join(resolved, "staging"),
    logs: path.join(resolved, "logs"),
    cache: path.join(resolved, "cache"),
    runtime: path.join(resolved, "runtime"),
    backups: path.join(resolved, "backups"),
    manifest: path.join(resolved, "storage-manifest.json"),
  };
}

async function ensureStorageManifest(layout: StorageLayout): Promise<void> {
  let existing: Partial<StorageManifestV1> | null = null;
  try {
    existing = JSON.parse(
      await fs.readFile(layout.manifest, "utf8"),
    ) as Partial<StorageManifestV1>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  if (
    existing &&
    (existing.format !== "owl-lab-storage" || existing.version !== 1)
  ) {
    throw new Error(
      "STORAGE_MANIFEST_UNSUPPORTED: existing OWL LAB storage manifest is incompatible.",
    );
  }

  const manifest: StorageManifestV1 = {
    format: "owl-lab-storage",
    version: STORAGE_FOUNDATION_VERSION,
    createdAt:
      typeof existing?.createdAt === "string"
        ? existing.createdAt
        : new Date().toISOString(),
    objectAddressing: "sha256",
    metadataStore: {
      provider: "sqlite",
      database: "state/owl.db",
      schemaVersion: 1,
    },
  };

  const serialized = JSON.stringify(manifest, null, 2) + "\n";
  if (existing && JSON.stringify(existing) === JSON.stringify(manifest)) {
    return;
  }

  const temp = `${layout.manifest}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temp, serialized, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  try {
    await fs.rename(temp, layout.manifest);
    await fs.chmod(layout.manifest, 0o600).catch(() => undefined);
  } finally {
    await fs.rm(temp, { force: true }).catch(() => undefined);
  }
}

export async function ensureStorageLayout(
  root = owlLabDataRoot(),
): Promise<StorageLayout> {
  const layout = storageLayout(root);
  for (const directory of [
    layout.root,
    layout.state,
    layout.objects,
    layout.staging,
    layout.logs,
    layout.cache,
    layout.runtime,
    layout.backups,
  ]) {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.chmod(directory, 0o700).catch(() => undefined);
  }
  await ensureStorageManifest(layout);
  return layout;
}

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

function parseDigest(digest: ArtifactRef["digest"]): string {
  const match = /^sha256:([a-f0-9]{64})$/.exec(digest);
  if (!match) {
    throw new Error("STORAGE_DIGEST_INVALID: expected sha256:<64 lowercase hex>.");
  }
  return match[1]!;
}

export function artifactObjectPath(
  digest: ArtifactRef["digest"],
  root = owlLabDataRoot(),
): string {
  const hex = parseDigest(digest);
  return path.join(storageLayout(root).objects, hex.slice(0, 2), hex);
}

async function verifyObjectBytes(
  objectPath: string,
  expectedHex: string,
  expectedSize?: number,
): Promise<void> {
  let stat;
  try {
    stat = await fs.stat(objectPath);
  } catch {
    throw new Error("STORAGE_OBJECT_MISSING: referenced CAS object does not exist.");
  }
  if (!stat.isFile()) {
    throw new Error("STORAGE_OBJECT_INVALID: CAS object is not a regular file.");
  }
  if (expectedSize !== undefined && stat.size !== expectedSize) {
    throw new Error("STORAGE_OBJECT_CORRUPT: CAS object size mismatch.");
  }
  const actual = await sha256File(objectPath);
  if (actual !== expectedHex) {
    throw new Error("STORAGE_OBJECT_CORRUPT: CAS object digest mismatch.");
  }
}

async function commitObject(
  sourcePath: string,
  digestHex: string,
  root: string,
): Promise<string> {
  const digest = `sha256:${digestHex}` as ArtifactRef["digest"];
  const objectPath = artifactObjectPath(digest, root);
  const parent = path.dirname(objectPath);
  await fs.mkdir(parent, { recursive: true, mode: 0o700 });

  try {
    await fs.access(objectPath);
    await verifyObjectBytes(objectPath, digestHex);
    return objectPath;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const temp = path.join(
    parent,
    `.${digestHex}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await fs.copyFile(sourcePath, temp);
    await fs.chmod(temp, 0o600).catch(() => undefined);
    const tempDigest = await sha256File(temp);
    if (tempDigest !== digestHex) {
      throw new Error("STORAGE_COMMIT_VERIFY_FAILED: staged copy digest mismatch.");
    }

    try {
      await fs.link(temp, objectPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    await verifyObjectBytes(objectPath, digestHex);
    return objectPath;
  } finally {
    await fs.rm(temp, { force: true }).catch(() => undefined);
  }
}

export async function commitArtifactFromFile(input: {
  sourcePath: string;
  mediaType: string;
  retentionClass: RetentionClass;
  provenance?: ArtifactProvenance;
  root?: string;
}): Promise<ArtifactRef> {
  const root = input.root ?? owlLabDataRoot();
  await ensureStorageLayout(root);

  const sourcePath = path.resolve(input.sourcePath);
  const stat = await fs.stat(sourcePath);
  if (!stat.isFile()) {
    throw new Error("STORAGE_SOURCE_INVALID: artifact source must be a regular file.");
  }

  const digestHex = await sha256File(sourcePath);
  const objectPath = await commitObject(sourcePath, digestHex, root);
  const committed = await fs.stat(objectPath);

  return {
    schemaVersion: 1,
    artifactId: `art_${randomUUID().replaceAll("-", "")}`,
    objectId: `obj_sha256_${digestHex}`,
    digest: `sha256:${digestHex}`,
    mediaType: input.mediaType.trim() || "application/octet-stream",
    sizeBytes: committed.size,
    createdAt: new Date().toISOString(),
    retentionClass: input.retentionClass,
    ...(input.provenance ? { provenance: { ...input.provenance } } : {}),
  };
}

export async function verifyArtifactObject(
  artifact: ArtifactRef,
  root = owlLabDataRoot(),
): Promise<{ ok: true; objectId: string; digest: ArtifactRef["digest"] }> {
  const expectedHex = parseDigest(artifact.digest);
  if (artifact.objectId !== `obj_sha256_${expectedHex}`) {
    throw new Error("STORAGE_OBJECT_ID_MISMATCH: objectId does not match digest.");
  }
  await verifyObjectBytes(
    artifactObjectPath(artifact.digest, root),
    expectedHex,
    artifact.sizeBytes,
  );
  return { ok: true, objectId: artifact.objectId, digest: artifact.digest };
}

export async function readArtifactBytes(
  artifact: ArtifactRef,
  root = owlLabDataRoot(),
): Promise<Buffer> {
  await verifyArtifactObject(artifact, root);
  return await fs.readFile(artifactObjectPath(artifact.digest, root));
}
