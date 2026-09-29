import fs from "node:fs/promises";
import path from "node:path";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { runtimeStatePath } from "../runtime/runtimePaths.js";
import type {
  SkillCandidateRecord,
  UserSkillRegistryRecord,
} from "./userSkillTypes.js";

type EncryptedEnvelope = {
  version: 1;
  algorithm: "aes-256-gcm";
  keyId: string;
  iv: string;
  tag: string;
  ciphertext: string;
};

function candidateDir(): string {
  return (
    process.env.SKILL_CANDIDATE_DIR?.trim() ||
    runtimeStatePath("skill-candidates")
  );
}

function registryDir(): string {
  return process.env.USER_SKILL_DIR?.trim() || runtimeStatePath("user-skills");
}

function keyPath(): string {
  return (
    process.env.USER_SKILL_KEY_PATH?.trim() ||
    runtimeStatePath("user-skills.key")
  );
}

export function getUserSkillStorageInfo() {
  return {
    candidates: candidateDir(),
    registry: registryDir(),
    encryptedAtRest: true,
    algorithm: "aes-256-gcm",
    keyPath: keyPath(),
    schemaVersion: 1,
  };
}

async function ensureDirs(): Promise<void> {
  await Promise.all([
    fs.mkdir(candidateDir(), { recursive: true, mode: 0o700 }),
    fs.mkdir(registryDir(), { recursive: true, mode: 0o700 }),
  ]);
  await Promise.all([
    fs.chmod(candidateDir(), 0o700).catch(() => undefined),
    fs.chmod(registryDir(), 0o700).catch(() => undefined),
  ]);
}

async function loadOrCreateKey(): Promise<Buffer> {
  const file = keyPath();
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  try {
    const encoded = (await fs.readFile(file, "utf8")).trim();
    const key = Buffer.from(encoded, "base64");
    if (key.length !== 32) {
      throw new Error("User Skill encryption key must decode to 32 bytes.");
    }
    await fs.chmod(file, 0o600).catch(() => undefined);
    return key;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const key = randomBytes(32);
  try {
    await fs.writeFile(file, key.toString("base64") + "\n", {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await fs.chmod(file, 0o600).catch(() => undefined);
    return key;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return await loadOrCreateKey();
    }
    throw error;
  }
}

async function loadExistingKey(): Promise<Buffer> {
  const encoded = (await fs.readFile(keyPath(), "utf8")).trim();
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32) {
    throw new Error("User Skill encryption key must decode to 32 bytes.");
  }
  return key;
}

function keyId(key: Buffer): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

function encrypt(value: unknown, key: Buffer): EncryptedEnvelope {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(value), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    version: 1,
    algorithm: "aes-256-gcm",
    keyId: keyId(key),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

function decrypt<T>(envelope: EncryptedEnvelope, key: Buffer): T {
  if (envelope.version !== 1 || envelope.algorithm !== "aes-256-gcm") {
    throw new Error("Unsupported User Skill storage envelope.");
  }
  if (envelope.keyId !== keyId(key)) {
    throw new Error("User Skill storage key mismatch.");
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
  return JSON.parse(plaintext.toString("utf8")) as T;
}

async function atomicWrite(file: string, value: unknown): Promise<void> {
  await ensureDirs();
  const key = await loadOrCreateKey();
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, JSON.stringify(encrypt(value, key)) + "\n", {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await fs.rename(temp, file);
    await fs.chmod(file, 0o600).catch(() => undefined);
  } finally {
    await fs.rm(temp, { force: true }).catch(() => undefined);
  }
}

async function readEncrypted<T>(file: string): Promise<T> {
  const envelope = JSON.parse(await fs.readFile(file, "utf8")) as EncryptedEnvelope;
  const key = await loadExistingKey();
  return decrypt<T>(envelope, key);
}

function candidatePath(id: string): string {
  if (!/^candidate_[a-f0-9]{24}$/.test(id)) {
    throw new Error("Invalid Skill Candidate id.");
  }
  return path.join(candidateDir(), `${id}.candidate`);
}

function registryPath(skillId: string): string {
  const digest = createHash("sha256").update(skillId).digest("hex").slice(0, 32);
  return path.join(registryDir(), `skill_${digest}.registry`);
}

export async function readSkillCandidate(
  id: string,
): Promise<SkillCandidateRecord> {
  return await readEncrypted<SkillCandidateRecord>(candidatePath(id));
}

export async function writeSkillCandidate(
  record: SkillCandidateRecord,
): Promise<void> {
  record.updatedAt = new Date().toISOString();
  await atomicWrite(candidatePath(record.id), record);
}

export async function listSkillCandidates(): Promise<SkillCandidateRecord[]> {
  let names: string[];
  try {
    names = await fs.readdir(candidateDir());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const records: SkillCandidateRecord[] = [];
  for (const name of names) {
    if (!name.endsWith(".candidate")) continue;
    try {
      records.push(
        await readEncrypted<SkillCandidateRecord>(path.join(candidateDir(), name)),
      );
    } catch (error) {
      throw new Error(
        "USER_SKILL_CANDIDATE_STORE_CORRUPT: " + name,
        { cause: error },
      );
    }
  }
  return records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function readUserSkillRegistry(
  skillId: string,
): Promise<UserSkillRegistryRecord | null> {
  try {
    return await readEncrypted<UserSkillRegistryRecord>(registryPath(skillId));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function writeUserSkillRegistry(
  record: UserSkillRegistryRecord,
): Promise<void> {
  record.updatedAt = new Date().toISOString();
  await atomicWrite(registryPath(record.skillId), record);
}

export async function listUserSkillRegistries(): Promise<
  UserSkillRegistryRecord[]
> {
  let names: string[];
  try {
    names = await fs.readdir(registryDir());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const records: UserSkillRegistryRecord[] = [];
  for (const name of names) {
    if (!name.endsWith(".registry")) continue;
    try {
      records.push(
        await readEncrypted<UserSkillRegistryRecord>(path.join(registryDir(), name)),
      );
    } catch (error) {
      throw new Error(
        "USER_SKILL_REGISTRY_STORE_CORRUPT: " + name,
        { cause: error },
      );
    }
  }
  return records.sort((a, b) => a.skillId.localeCompare(b.skillId));
}
