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
import { runtimeStatePath } from "./runtimePaths.js";

export type ManagedProcessStatus =
  | "running"
  | "exited"
  | "lost"
  | "terminating";

export type ManagedProcessRecord = {
  version: 1;
  processId: string;
  pid: number;
  command: string;
  cwd: string;
  workspace: string;
  workspaceMode: "read" | "write";
  workspaceLeaseId?: string;
  ownerSessionId: string;
  ownerTaskId?: string;
  startedAt: string;
  updatedAt: string;
  status: ManagedProcessStatus;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  runtimeInstanceId: string;
  stdoutPath: string;
  stderrPath: string;
  inputAvailable: boolean;
  recoveredAfterRestart?: boolean;
};

type EncryptedEnvelope = {
  version: 1;
  algorithm: "aes-256-gcm";
  keyId: string;
  iv: string;
  tag: string;
  ciphertext: string;
};

function processDir(): string {
  return (
    process.env.PROCESS_STATE_DIR?.trim() ||
    runtimeStatePath("processes")
  );
}

function processKeyPath(): string {
  return (
    process.env.PROCESS_STATE_KEY_PATH?.trim() ||
    runtimeStatePath("process.key")
  );
}

function logDir(): string {
  return (
    process.env.PROCESS_LOG_DIR?.trim() ||
    path.join(processDir(), "logs")
  );
}

export function processLogPaths(processId: string) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(processId)) {
    throw new Error("Invalid managed process id.");
  }
  return {
    stdoutPath: path.join(logDir(), `${processId}.stdout.log`),
    stderrPath: path.join(logDir(), `${processId}.stderr.log`),
  };
}

async function ensureDirs() {
  await fs.mkdir(processDir(), { recursive: true, mode: 0o700 });
  await fs.mkdir(logDir(), { recursive: true, mode: 0o700 });
  await fs.chmod(processDir(), 0o700).catch(() => undefined);
  await fs.chmod(logDir(), 0o700).catch(() => undefined);
}

async function loadOrCreateKey(): Promise<Buffer> {
  const keyPath = processKeyPath();
  await fs.mkdir(path.dirname(keyPath), { recursive: true, mode: 0o700 });

  try {
    const encoded = (await fs.readFile(keyPath, "utf8")).trim();
    const key = Buffer.from(encoded, "base64");
    if (key.length !== 32) {
      throw new Error(
        "Managed process encryption key must decode to exactly 32 bytes.",
      );
    }
    await fs.chmod(keyPath, 0o600).catch(() => undefined);
    return key;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const key = randomBytes(32);
  try {
    await fs.writeFile(keyPath, key.toString("base64") + "\n", {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    return key;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return await loadOrCreateKey();
    }
    throw error;
  }
}

function keyId(key: Buffer): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

function recordPath(processId: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(processId)) {
    throw new Error("Invalid managed process id.");
  }
  return path.join(processDir(), `${processId}.process`);
}

function encrypt(
  record: ManagedProcessRecord,
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

function decrypt(
  envelope: EncryptedEnvelope,
  key: Buffer,
): ManagedProcessRecord {
  if (envelope.version !== 1 || envelope.algorithm !== "aes-256-gcm") {
    throw new Error("Unsupported managed process envelope.");
  }
  if (envelope.keyId !== keyId(key)) {
    throw new Error("Managed process key mismatch.");
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
  return JSON.parse(plaintext.toString("utf8")) as ManagedProcessRecord;
}

export function newManagedProcessId(): string {
  return `process_${Date.now().toString(36)}_${randomUUID()
    .replaceAll("-", "")
    .slice(0, 12)}`;
}

export async function writeManagedProcess(
  record: ManagedProcessRecord,
): Promise<void> {
  await ensureDirs();
  const key = await loadOrCreateKey();
  record.updatedAt = new Date().toISOString();
  const target = recordPath(record.processId);
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(encrypt(record, key)) + "\n", {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  await fs.rename(temp, target);
  await fs.chmod(target, 0o600).catch(() => undefined);
}

export async function readManagedProcess(
  processId: string,
): Promise<ManagedProcessRecord> {
  await ensureDirs();
  const key = await loadOrCreateKey();
  const envelope = JSON.parse(
    await fs.readFile(recordPath(processId), "utf8"),
  ) as EncryptedEnvelope;
  return decrypt(envelope, key);
}

export async function listManagedProcesses(): Promise<ManagedProcessRecord[]> {
  await ensureDirs();
  const key = await loadOrCreateKey();
  const names = await fs.readdir(processDir());
  const records: ManagedProcessRecord[] = [];

  for (const name of names) {
    if (!name.endsWith(".process")) continue;
    try {
      const envelope = JSON.parse(
        await fs.readFile(path.join(processDir(), name), "utf8"),
      ) as EncryptedEnvelope;
      records.push(decrypt(envelope, key));
    } catch {
      // One damaged process record must not hide the rest.
    }
  }

  return records.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export async function deleteManagedProcess(
  processId: string,
): Promise<void> {
  await ensureDirs();
  await fs.rm(recordPath(processId), { force: true });
}

export function getProcessStorageInfo() {
  return {
    directory: processDir(),
    logDirectory: logDir(),
    encryptedMetadata: true,
    logFilesEncrypted: false,
    keyPath: processKeyPath(),
  };
}
