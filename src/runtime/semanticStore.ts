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
import type { StoredEmbedding } from "./embeddingProvider.js";

export type SemanticMemoryKind =
  | "fact"
  | "preference"
  | "procedure"
  | "pattern"
  | "decision";

export type SemanticSensitivity = "public" | "internal" | "private";

export type GateReceipt = {
  passed: boolean;
  checks: Array<{
    id: string;
    passed: boolean;
    detail: string;
  }>;
  warnings: string[];
};

export type SemanticMemoryRecord = {
  version: 1;
  id: string;
  kind: SemanticMemoryKind;
  title: string;
  content: string;
  tags: string[];
  sensitivity: SemanticSensitivity;
  createdAt: string;
  updatedAt: string;
  contentDigest: string;
  retrieval?: {
    embedding: StoredEmbedding;
  };
  source: {
    taskId: string;
    taskLabel: string;
    taskCompletedAt: string;
    evidenceStepIds: string[];
    evidenceEventTypes: string[];
    evidenceDigest: string;
  };
  promotion: {
    explicit: true;
    promotedAt: string;
    candidateDigest: string;
    qualityGate: GateReceipt;
    privacyGate: GateReceipt;
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

function semanticDir(): string {
  return (
    process.env.SEMANTIC_MEMORY_DIR?.trim() ||
    runtimeStatePath("semantic")
  );
}

function semanticKeyPath(): string {
  return (
    process.env.SEMANTIC_MEMORY_KEY_PATH?.trim() ||
    runtimeStatePath("semantic.key")
  );
}

export function getSemanticStorageInfo() {
  return {
    directory: semanticDir(),
    encryptedAtRest: true,
    algorithm: "aes-256-gcm",
    keyPath: semanticKeyPath(),
  };
}

async function ensureSemanticDir(): Promise<void> {
  await fs.mkdir(semanticDir(), { recursive: true, mode: 0o700 });
  await fs.chmod(semanticDir(), 0o700).catch(() => undefined);
}

async function loadOrCreateKey(): Promise<Buffer> {
  const keyPath = semanticKeyPath();
  await fs.mkdir(path.dirname(keyPath), { recursive: true, mode: 0o700 });

  try {
    const encoded = (await fs.readFile(keyPath, "utf8")).trim();
    const key = Buffer.from(encoded, "base64");
    if (key.length !== 32) {
      throw new Error("Semantic memory key must decode to exactly 32 bytes.");
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

function recordPath(id: string): string {
  if (!/^memory_[A-Za-z0-9_-]{1,96}$/.test(id)) {
    throw new Error("Invalid semantic memory id.");
  }
  return path.join(semanticDir(), `${id}.memory`);
}

function encryptRecord(
  record: SemanticMemoryRecord,
  key: Buffer,
): EncryptedEnvelope {
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

function decryptRecord(
  envelope: EncryptedEnvelope,
  key: Buffer,
): SemanticMemoryRecord {
  if (envelope.version !== 1 || envelope.algorithm !== "aes-256-gcm") {
    throw new Error("Unsupported semantic memory envelope.");
  }
  if (envelope.keyId !== keyId(key)) {
    throw new Error(
      "Semantic memory key mismatch. The semantic encryption key may have changed.",
    );
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
  return JSON.parse(plaintext.toString("utf8")) as SemanticMemoryRecord;
}

export function semanticDigest(value: string): string {
  return createHash("sha256")
    .update(value.normalize("NFKC").trim().replace(/\s+/g, " "))
    .digest("hex");
}

export function newSemanticMemoryId(): string {
  return `memory_${Date.now().toString(36)}_${randomUUID()
    .replaceAll("-", "")
    .slice(0, 12)}`;
}

export async function writeSemanticMemory(
  record: SemanticMemoryRecord,
): Promise<void> {
  await ensureSemanticDir();
  const key = await loadOrCreateKey();
  record.updatedAt = new Date().toISOString();

  const target = recordPath(record.id);
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(encryptRecord(record, key)) + "\n", {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  await fs.rename(temp, target);
  await fs.chmod(target, 0o600).catch(() => undefined);
}

export async function readSemanticMemory(
  id: string,
): Promise<SemanticMemoryRecord> {
  await ensureSemanticDir();
  const key = await loadOrCreateKey();
  const envelope = JSON.parse(
    await fs.readFile(recordPath(id), "utf8"),
  ) as EncryptedEnvelope;
  return decryptRecord(envelope, key);
}

export async function listSemanticMemories(): Promise<SemanticMemoryRecord[]> {
  await ensureSemanticDir();
  const key = await loadOrCreateKey();
  const names = await fs.readdir(semanticDir());
  const records: SemanticMemoryRecord[] = [];

  for (const name of names) {
    if (!name.endsWith(".memory")) continue;
    try {
      const envelope = JSON.parse(
        await fs.readFile(path.join(semanticDir(), name), "utf8"),
      ) as EncryptedEnvelope;
      records.push(decryptRecord(envelope, key));
    } catch {
      // One damaged record must not hide the rest.
    }
  }

  return records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function deleteSemanticMemory(id: string): Promise<void> {
  await ensureSemanticDir();
  await fs.rm(recordPath(id), { force: false });
}

export async function findSemanticMemoryByDigest(
  digest: string,
): Promise<SemanticMemoryRecord | undefined> {
  return (await listSemanticMemories()).find(
    (record) => record.contentDigest === digest,
  );
}
