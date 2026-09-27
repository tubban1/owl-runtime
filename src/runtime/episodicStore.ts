import { runtimeStatePath } from "./runtimePaths.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import type { PersistentTaskStatus } from "../tasks/taskStore.js";
import type { StoredEmbedding } from "./embeddingProvider.js";

export type EpisodicStepSummary = {
  id: string;
  primitive?: string;
  op?: string;
  action: string;
  state: string;
  attempts: number;
  durationMs?: number;
  error?: string;
  recoveryNote?: string;
};

export type GlobalEpisodeRecord = {
  version: 1;
  id: string;
  taskId: string;
  label: string;
  status: PersistentTaskStatus;
  createdAt: string;
  updatedAt: string;
  terminalAt: string;
  runCount: number;
  stepCount: number;
  steps: EpisodicStepSummary[];
  eventTypes: string[];
  eventMessages: string[];
  searchableText: string;
  contentDigest: string;
  retrieval: {
    embedding?: StoredEmbedding;
    vectorizer?: "feature-hash-v1";
    dimensions: number;
    vector: number[];
  };
};

type EncryptedEnvelope = {
  version: 1;
  algorithm: "aes-256-gcm";
  keyId: string;
  iv: string;
  tag: string;
  ciphertext: string;
};

function episodicDir(): string {
  return (
    process.env.EPISODIC_INDEX_DIR?.trim() ||
    runtimeStatePath("episodes")
  );
}

function episodicKeyPath(): string {
  return (
    process.env.EPISODIC_INDEX_KEY_PATH?.trim() ||
    runtimeStatePath("episode.key")
  );
}

export function getEpisodicStorageInfo() {
  return {
    directory: episodicDir(),
    encryptedAtRest: true,
    algorithm: "aes-256-gcm",
    keyPath: episodicKeyPath(),
  };
}

async function ensureDir(): Promise<void> {
  await fs.mkdir(episodicDir(), { recursive: true, mode: 0o700 });
  await fs.chmod(episodicDir(), 0o700).catch(() => undefined);
}

async function loadOrCreateKey(): Promise<Buffer> {
  const keyPath = episodicKeyPath();
  await fs.mkdir(path.dirname(keyPath), { recursive: true, mode: 0o700 });
  try {
    const encoded = (await fs.readFile(keyPath, "utf8")).trim();
    const key = Buffer.from(encoded, "base64");
    if (key.length !== 32) {
      throw new Error("Episodic index key must decode to exactly 32 bytes.");
    }
    await fs.chmod(keyPath, 0o600).catch(() => undefined);
    return key;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw error;
  }

  const key = randomBytes(32);
  try {
    await fs.writeFile(keyPath, key.toString("base64") + "\n", {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await fs.chmod(keyPath, 0o600).catch(() => undefined);
    return key;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") return await loadOrCreateKey();
    throw error;
  }
}

function keyId(key: Buffer): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

function recordPath(taskId: string): string {
  if (!/^task_[A-Za-z0-9_-]{1,96}$/.test(taskId)) {
    throw new Error("Invalid episodic task id.");
  }
  return path.join(episodicDir(), `episode_${taskId}.episode`);
}

function encrypt(record: GlobalEpisodeRecord, key: Buffer): EncryptedEnvelope {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(record), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    version: 1,
    algorithm: "aes-256-gcm",
    keyId: keyId(key),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

function decrypt(envelope: EncryptedEnvelope, key: Buffer): GlobalEpisodeRecord {
  if (envelope.version !== 1 || envelope.algorithm !== "aes-256-gcm") {
    throw new Error("Unsupported global episode envelope.");
  }
  if (envelope.keyId !== keyId(key)) {
    throw new Error("Global episodic index key mismatch.");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(envelope.iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, "base64")),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString("utf8")) as GlobalEpisodeRecord;
}

export async function writeGlobalEpisode(
  record: GlobalEpisodeRecord,
): Promise<void> {
  await ensureDir();
  const key = await loadOrCreateKey();
  const target = recordPath(record.taskId);
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(encrypt(record, key)) + "\n", {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  await fs.rename(temp, target);
  await fs.chmod(target, 0o600).catch(() => undefined);
}

export async function listGlobalEpisodes(): Promise<GlobalEpisodeRecord[]> {
  await ensureDir();
  const key = await loadOrCreateKey();
  const names = await fs.readdir(episodicDir());
  const records: GlobalEpisodeRecord[] = [];
  for (const name of names) {
    if (!name.endsWith(".episode")) continue;
    try {
      const envelope = JSON.parse(
        await fs.readFile(path.join(episodicDir(), name), "utf8"),
      ) as EncryptedEnvelope;
      records.push(decrypt(envelope, key));
    } catch {
      // One damaged episode must not hide the rest.
    }
  }
  return records.sort((a, b) => b.terminalAt.localeCompare(a.terminalAt));
}

export async function deleteGlobalEpisode(taskId: string): Promise<void> {
  await ensureDir();
  await fs.rm(recordPath(taskId), { force: false });
}

export function newEpisodeId(): string {
  return `episode_${Date.now().toString(36)}_${randomUUID()
    .replaceAll("-", "")
    .slice(0, 12)}`;
}
