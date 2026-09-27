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
import type { PrimitiveTaskStep } from "../tasks/taskRuntime.js";

export type LoopAdvanceWhen = {
  path?: string;
  equals?: unknown;
  truthy?: boolean;
};

export type LoopSessionAction = {
  bindingId: string;
  op: "identify" | "probe" | "capture_latest" | "send";
  args?: Record<string, unknown>;
};

export type LoopPhase = {
  id: string;
  label?: string;
  steps?: PrimitiveTaskStep[];
  session?: LoopSessionAction;
  outputRef?: string;
  waitForChange?: boolean;
  advanceWhen?: LoopAdvanceWhen;
};

export type PersistentLoop = {
  version: 1;
  id: string;
  label: string;
  createdAt: string;
  updatedAt: string;
  enabled: boolean;
  phases: LoopPhase[];
  currentPhaseIndex: number;
  cycleCount: number;
  transitionCount: number;
  /**
   * Monotonic execution sequence for Primitive-backed phase attempts.
   *
   * Unlike transitionCount, this advances even when waitForChange keeps the
   * loop on the same phase. It lets each normal poll execute a fresh Task while
   * an interrupted attempt still reuses its persisted activeTaskId.
   *
   * Optional for backward compatibility with pre-v0.9.15 loop records.
   */
  taskSequence?: number;
  pollIntervalMs: number;
  nextRunAt: string | null;
  maxCycles?: number;
  endAt?: string;
  activeTaskId?: string;
  lastTaskId?: string;
  lastTaskStatus?: string;
  lastError?: string;
  stoppedReason?: string;
  lastOutput?: unknown;
  phaseOutputs: Record<string, unknown>;
  phaseHashes: Record<string, string>;
  taskRuntime: {
    maxConcurrency: number;
    failFast: boolean;
    maxWaves: number;
    timeBudgetMs: number;
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

function loopDir(): string {
  return (
    process.env.LOOP_DIR?.trim() ||
    runtimeStatePath("loops")
  );
}

function loopKeyPath(): string {
  return (
    process.env.LOOP_KEY_PATH?.trim() ||
    runtimeStatePath("loop.key")
  );
}

export function getLoopStorageInfo() {
  return {
    directory: loopDir(),
    encryptedAtRest: true,
    algorithm: "aes-256-gcm",
    keyPath: loopKeyPath(),
  };
}

async function ensureLoopDir(): Promise<void> {
  await fs.mkdir(loopDir(), { recursive: true, mode: 0o700 });
  await fs.chmod(loopDir(), 0o700).catch(() => undefined);
}

async function loadOrCreateKey(): Promise<Buffer> {
  const keyPath = loopKeyPath();
  await fs.mkdir(path.dirname(keyPath), { recursive: true, mode: 0o700 });

  try {
    const encoded = (await fs.readFile(keyPath, "utf8")).trim();
    const key = Buffer.from(encoded, "base64");
    if (key.length !== 32) {
      throw new Error("Loop encryption key must decode to exactly 32 bytes.");
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

function loopPath(id: string): string {
  if (!/^loop_[A-Za-z0-9_-]{1,96}$/.test(id)) {
    throw new Error("Invalid persistent loop id.");
  }
  return path.join(loopDir(), `${id}.loop`);
}

function encryptLoop(loop: PersistentLoop, key: Buffer): EncryptedEnvelope {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(loop), "utf8");
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

function decryptLoop(envelope: EncryptedEnvelope, key: Buffer): PersistentLoop {
  if (envelope.version !== 1 || envelope.algorithm !== "aes-256-gcm") {
    throw new Error("Unsupported persistent loop envelope.");
  }
  if (envelope.keyId !== keyId(key)) {
    throw new Error(
      "Persistent loop key mismatch. The loop encryption key may have changed.",
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
  return JSON.parse(plaintext.toString("utf8")) as PersistentLoop;
}

export function newLoopId(): string {
  return `loop_${Date.now().toString(36)}_${randomUUID()
    .replaceAll("-", "")
    .slice(0, 12)}`;
}

export async function writeLoop(loop: PersistentLoop): Promise<void> {
  await ensureLoopDir();
  const key = await loadOrCreateKey();
  loop.updatedAt = new Date().toISOString();
  const target = loopPath(loop.id);
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(encryptLoop(loop, key)), {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  await fs.rename(temp, target);
  await fs.chmod(target, 0o600).catch(() => undefined);
}

export async function readLoop(id: string): Promise<PersistentLoop> {
  const key = await loadOrCreateKey();
  const envelope = JSON.parse(
    await fs.readFile(loopPath(id), "utf8"),
  ) as EncryptedEnvelope;
  return decryptLoop(envelope, key);
}

export async function listLoopRecords(): Promise<PersistentLoop[]> {
  await ensureLoopDir();
  const key = await loadOrCreateKey();
  const names = await fs.readdir(loopDir());
  const loops: PersistentLoop[] = [];

  for (const name of names) {
    if (!name.endsWith(".loop")) continue;
    try {
      const envelope = JSON.parse(
        await fs.readFile(path.join(loopDir(), name), "utf8"),
      ) as EncryptedEnvelope;
      loops.push(decryptLoop(envelope, key));
    } catch {
      // One malformed record must not hide the remaining loops.
    }
  }

  return loops.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function deleteLoopRecord(id: string): Promise<void> {
  await fs.rm(loopPath(id), { force: false });
}
