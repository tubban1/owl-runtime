import { runtimeStatePath } from "../runtime/runtimePaths.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { assertAllowedExistingPath } from "../security/pathGuard.js";

export type StagedArtifact = {
  id: string;
  stepId: string;
  sourcePath: string;
  stagedPath: string;
  filename: string;
  bytes: number;
  sha256: string;
  category: "outputs";
  createdAt: string;
};

export type TaskStageManifest = {
  version: 1;
  taskId: string;
  createdAt: string;
  updatedAt: string;
  categories: string[];
  artifacts: StagedArtifact[];
};

export type TaskStagingInfo = {
  root: string;
  manifestPath: string;
  artifacts: StagedArtifact[];
  maxAutoCopyBytes: number;
};

const DEFAULT_MAX_AUTO_COPY_BYTES = 256 * 1024 * 1024;
const STAGING_CATEGORIES = [
  "inputs",
  "research",
  "drafts",
  "assets",
  "outputs",
  "scratch",
] as const;

function manifestPathFor(root: string): string {
  return path.join(root, "manifest.json");
}

async function writeManifest(
  filePath: string,
  manifest: TaskStageManifest,
): Promise<void> {
  const temp = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(manifest, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  await fs.rename(temp, filePath);
  await fs.chmod(filePath, 0o600).catch(() => undefined);
}

async function readManifest(
  taskId: string,
  root: string,
): Promise<TaskStageManifest> {
  const filePath = manifestPathFor(root);
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as TaskStageManifest;
  } catch {
    const now = new Date().toISOString();
    return {
      version: 1,
      taskId,
      createdAt: now,
      updatedAt: now,
      categories: [...STAGING_CATEGORIES],
      artifacts: [],
    };
  }
}

export function taskStagingRoot(): string {
  return (
    process.env.TASK_STAGING_DIR?.trim() ||
    runtimeStatePath("staging")
  );
}

export function taskStagePath(taskId: string): string {
  if (!/^task_[A-Za-z0-9_-]{1,96}$/.test(taskId)) {
    throw new Error("Invalid persistent task id for staging.");
  }
  return path.join(taskStagingRoot(), taskId);
}

function maxAutoCopyBytes(): number {
  const raw = Number(process.env.TASK_STAGING_MAX_AUTO_COPY_BYTES);
  if (Number.isFinite(raw) && raw >= 0) return Math.floor(raw);
  return DEFAULT_MAX_AUTO_COPY_BYTES;
}

export async function ensureTaskStage(taskId: string): Promise<TaskStagingInfo> {
  const root = taskStagePath(taskId);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  await fs.chmod(root, 0o700).catch(() => undefined);

  for (const folder of STAGING_CATEGORIES) {
    const dir = path.join(root, folder);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await fs.chmod(dir, 0o700).catch(() => undefined);
  }

  const manifestPath = manifestPathFor(root);
  const manifest = await readManifest(taskId, root);
  try {
    await fs.access(manifestPath);
  } catch {
    await writeManifest(manifestPath, manifest);
  }

  return {
    root,
    manifestPath,
    artifacts: manifest.artifacts ?? [],
    maxAutoCopyBytes: maxAutoCopyBytes(),
  };
}

function shouldIgnoreArtifactKey(key: string): boolean {
  const normalized = key.replaceAll("_", "").toLowerCase();
  return [
    "inputpath",
    "sourcepath",
    "cwd",
    "root",
    "directory",
    "executable",
    "keypath",
    "profiledir",
  ].includes(normalized);
}

function collectAbsolutePaths(
  value: unknown,
  paths = new Set<string>(),
  depth = 0,
  key = "",
): Set<string> {
  if (depth > 12 || shouldIgnoreArtifactKey(key)) return paths;

  if (typeof value === "string") {
    if (path.isAbsolute(value) && value.length <= 4096) {
      paths.add(path.resolve(value));
    }
    return paths;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectAbsolutePaths(item, paths, depth + 1, key);
    }
    return paths;
  }

  if (value && typeof value === "object") {
    for (const [childKey, child] of Object.entries(
      value as Record<string, unknown>,
    )) {
      collectAbsolutePaths(child, paths, depth + 1, childKey);
    }
  }

  return paths;
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

function safeFilename(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned.slice(0, 180) || "artifact";
}

export async function stageArtifactsFromResult(
  taskId: string,
  stepId: string,
  result: unknown,
  existing: StagedArtifact[] = [],
): Promise<StagedArtifact[]> {
  const stage = await ensureTaskStage(taskId);
  const currentArtifacts = [
    ...stage.artifacts,
    ...existing.filter(
      (item) => !stage.artifacts.some((staged) => staged.id === item.id),
    ),
  ];
  const knownSources = new Set(
    currentArtifacts.map((item) => item.sourcePath),
  );
  const knownHashes = new Set(currentArtifacts.map((item) => item.sha256));
  const candidates = [...collectAbsolutePaths(result)];
  const added: StagedArtifact[] = [];

  for (const candidate of candidates) {
    if (knownSources.has(candidate)) continue;

    let sourcePath: string;
    try {
      sourcePath = await assertAllowedExistingPath(candidate);
    } catch {
      continue;
    }

    let stat;
    try {
      stat = await fs.stat(sourcePath);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    if (stat.size > stage.maxAutoCopyBytes) continue;

    const digest = await sha256File(sourcePath);
    if (knownHashes.has(digest)) continue;

    const ext = path.extname(sourcePath);
    const base = safeFilename(path.basename(sourcePath, ext));
    const filename = `${safeFilename(stepId)}__${base}__${digest.slice(0, 10)}${ext}`;
    const stagedPath = path.join(stage.root, "outputs", filename);

    await fs.copyFile(sourcePath, stagedPath);
    await fs.chmod(stagedPath, 0o600).catch(() => undefined);

    const artifact: StagedArtifact = {
      id: `artifact_${randomUUID().replaceAll("-", "").slice(0, 16)}`,
      stepId,
      sourcePath,
      stagedPath,
      filename,
      bytes: stat.size,
      sha256: digest,
      category: "outputs",
      createdAt: new Date().toISOString(),
    };
    added.push(artifact);
    knownSources.add(sourcePath);
    knownHashes.add(digest);
  }

  if (added.length > 0) {
    const manifest = await readManifest(taskId, stage.root);
    manifest.updatedAt = new Date().toISOString();
    manifest.artifacts = [
      ...(manifest.artifacts ?? []),
      ...added.filter(
        (item) =>
          !(manifest.artifacts ?? []).some((existing) => existing.id === item.id),
      ),
    ];
    await writeManifest(stage.manifestPath, manifest);
  }

  return added;
}

export async function taskStagingStatus(
  taskId: string,
  artifacts: StagedArtifact[] = [],
) {
  const stage = await ensureTaskStage(taskId);
  const effectiveArtifacts = artifacts.length > 0 ? artifacts : stage.artifacts;
  return {
    root: stage.root,
    manifestPath: stage.manifestPath,
    categories: [...STAGING_CATEGORIES],
    artifactCount: effectiveArtifacts.length,
    bytes: effectiveArtifacts.reduce((sum, artifact) => sum + artifact.bytes, 0),
    maxAutoCopyBytes: stage.maxAutoCopyBytes,
    artifacts: effectiveArtifacts,
  };
}
