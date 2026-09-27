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

export type ScheduleTrigger =
  | { kind: "once"; at: string }
  | { kind: "interval"; everyMs: number; startAt?: string }
  | { kind: "daily"; time: string };

export type ScheduleStopWhen = {
  ref: string;
  equals?: unknown;
  truthy?: boolean;
};

export type PersistentSchedule = {
  version: 1;
  id: string;
  label: string;
  createdAt: string;
  updatedAt: string;
  enabled: boolean;
  trigger: ScheduleTrigger;
  taskTemplate: {
    label: string;
    steps: PrimitiveTaskStep[];
    maxConcurrency: number;
    failFast: boolean;
    maxWaves: number;
    timeBudgetMs: number;
  };
  stopWhen?: ScheduleStopWhen;
  maxRuns?: number;
  endAt?: string;
  runCount: number;
  nextRunAt: string | null;
  lastRunAt?: string;
  lastCompletedAt?: string;
  lastTaskId?: string;
  activeTaskId?: string;
  lastTaskStatus?: string;
  lastError?: string;
  stoppedReason?: string;
};

type EncryptedEnvelope = {
  version: 1;
  algorithm: "aes-256-gcm";
  keyId: string;
  iv: string;
  tag: string;
  ciphertext: string;
};

function scheduleDir(): string {
  return (
    process.env.SCHEDULER_DIR?.trim() ||
    runtimeStatePath("schedules")
  );
}

function scheduleKeyPath(): string {
  return (
    process.env.SCHEDULER_KEY_PATH?.trim() ||
    runtimeStatePath("schedule.key")
  );
}

export function getScheduleStorageInfo() {
  return {
    directory: scheduleDir(),
    encryptedAtRest: true,
    algorithm: "aes-256-gcm",
    keyPath: scheduleKeyPath(),
  };
}

async function ensureScheduleDir(): Promise<void> {
  await fs.mkdir(scheduleDir(), { recursive: true, mode: 0o700 });
  await fs.chmod(scheduleDir(), 0o700).catch(() => undefined);
}

async function loadOrCreateKey(): Promise<Buffer> {
  const keyPath = scheduleKeyPath();
  await fs.mkdir(path.dirname(keyPath), { recursive: true, mode: 0o700 });
  try {
    const encoded = (await fs.readFile(keyPath, "utf8")).trim();
    const key = Buffer.from(encoded, "base64");
    if (key.length !== 32) {
      throw new Error("Scheduler encryption key must decode to exactly 32 bytes.");
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

function schedulePath(id: string): string {
  if (!/^schedule_[A-Za-z0-9_-]{1,96}$/.test(id)) {
    throw new Error("Invalid persistent schedule id.");
  }
  return path.join(scheduleDir(), `${id}.schedule`);
}

function encryptSchedule(
  schedule: PersistentSchedule,
  key: Buffer,
): EncryptedEnvelope {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(schedule), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    version: 1,
    algorithm: "aes-256-gcm",
    keyId: createHash("sha256").update(key).digest("hex").slice(0, 16),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

function decryptSchedule(
  envelope: EncryptedEnvelope,
  key: Buffer,
): PersistentSchedule {
  if (
    envelope.version !== 1 ||
    envelope.algorithm !== "aes-256-gcm"
  ) {
    throw new Error("Unsupported persistent schedule envelope.");
  }

  const expectedKeyId = createHash("sha256")
    .update(key)
    .digest("hex")
    .slice(0, 16);
  if (envelope.keyId !== expectedKeyId) {
    throw new Error(
      "Persistent schedule key mismatch. The scheduler encryption key may have changed.",
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

  return JSON.parse(plaintext.toString("utf8")) as PersistentSchedule;
}

export function newScheduleId(): string {
  return `schedule_${Date.now().toString(36)}_${randomUUID()
    .replaceAll("-", "")
    .slice(0, 12)}`;
}

export async function writeSchedule(
  schedule: PersistentSchedule,
): Promise<void> {
  await ensureScheduleDir();
  const key = await loadOrCreateKey();
  schedule.updatedAt = new Date().toISOString();

  const filePath = schedulePath(schedule.id);
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const envelope = encryptSchedule(schedule, key);
  await fs.writeFile(tempPath, JSON.stringify(envelope) + "\n", {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  await fs.rename(tempPath, filePath);
  await fs.chmod(filePath, 0o600).catch(() => undefined);
}

export async function readSchedule(id: string): Promise<PersistentSchedule> {
  await ensureScheduleDir();
  const key = await loadOrCreateKey();
  const envelope = JSON.parse(
    await fs.readFile(schedulePath(id), "utf8"),
  ) as EncryptedEnvelope;
  return decryptSchedule(envelope, key);
}

export async function listSchedules(): Promise<PersistentSchedule[]> {
  await ensureScheduleDir();
  const key = await loadOrCreateKey();
  const names = await fs.readdir(scheduleDir());
  const schedules: PersistentSchedule[] = [];
  for (const name of names) {
    if (!name.endsWith(".schedule")) continue;
    try {
      const envelope = JSON.parse(
        await fs.readFile(path.join(scheduleDir(), name), "utf8"),
      ) as EncryptedEnvelope;
      schedules.push(decryptSchedule(envelope, key));
    } catch {
      // One malformed record must not hide the remaining schedules.
    }
  }
  return schedules.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function deleteScheduleRecord(id: string): Promise<void> {
  await ensureScheduleDir();
  await fs.rm(schedulePath(id), { force: false });
}
