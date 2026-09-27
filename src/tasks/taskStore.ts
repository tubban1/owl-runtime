import { runtimeStatePath } from "../runtime/runtimePaths.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { StagedArtifact } from "./taskStaging.js";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";

export type PersistentTaskStatus =
  | "pending"
  | "running"
  | "paused"
  | "blocked"
  | "failed"
  | "completed"
  | "cancelled";

export type PersistentStepState =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "needs_review";

export interface PersistentTaskStep {
  id: string;
  action: string;
  executionKind?: "action" | "primitive";
  primitive?: string;
  op?: string;
  args: Record<string, unknown>;
  dependsOn: string[];
  parallelSafe: boolean;
  retryPolicy?: "automatic" | "manual" | "never";
  riskLevel?: "low" | "medium" | "high" | "critical";
  sideEffects?: string[];
  requiresVerification?: boolean;
  resources?: Array<{ key: string; mode: "shared" | "exclusive" }>;
  state: PersistentStepState;
  attempts: number;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  result?: unknown;
  error?: string;
  recoveryNote?: string;
}

export interface PersistentTaskEvent {
  at: string;
  type: string;
  message: string;
  stepId?: string;
}

export interface PersistentTask {
  version: 1;
  id: string;
  label: string;
  ownerSessionId?: string;
  createdAt: string;
  updatedAt: string;
  status: PersistentTaskStatus;
  defaultMaxConcurrency: number;
  defaultFailFast: boolean;
  runCount: number;
  runnerInstanceId?: string;
  runnerPid?: number;
  lastRunAt?: string;
  completedAt?: string;
  pausedAt?: string;
  blockedAt?: string;
  cancelledAt?: string;
  pauseRequested: boolean;
  cancelRequested: boolean;
  stagingRoot?: string;
  stagingManifestPath?: string;
  stagedArtifacts?: StagedArtifact[];
  steps: PersistentTaskStep[];
  events: PersistentTaskEvent[];
}

type EncryptedEnvelope = {
  version: 1;
  algorithm: "aes-256-gcm";
  keyId: string;
  iv: string;
  tag: string;
  ciphertext: string;
};

function taskDir(): string {
  return (
    process.env.TASK_DIR?.trim() ||
    runtimeStatePath("tasks")
  );
}

function taskKeyPath(): string {
  return (
    process.env.TASK_KEY_PATH?.trim() ||
    runtimeStatePath("task.key")
  );
}

export function getTaskStorageInfo() {
  return {
    directory: taskDir(),
    encryptedAtRest: true,
    algorithm: "aes-256-gcm",
    keyPath: taskKeyPath(),
  };
}

async function ensureTaskDir(): Promise<void> {
  await fs.mkdir(taskDir(), { recursive: true, mode: 0o700 });
  await fs.chmod(taskDir(), 0o700).catch(() => undefined);
}

async function loadOrCreateKey(): Promise<Buffer> {
  const keyPath = taskKeyPath();
  await fs.mkdir(path.dirname(keyPath), { recursive: true, mode: 0o700 });

  try {
    const encoded = (await fs.readFile(keyPath, "utf8")).trim();
    const key = Buffer.from(encoded, "base64");
    if (key.length !== 32) {
      throw new Error("Persistent task encryption key must decode to exactly 32 bytes.");
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

function taskPath(id: string): string {
  if (!/^task_[A-Za-z0-9_-]{1,96}$/.test(id)) {
    throw new Error("Invalid persistent task id.");
  }
  return path.join(taskDir(), `${id}.task`);
}

function encryptTask(task: PersistentTask, key: Buffer): EncryptedEnvelope {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(task), "utf8");
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

function decryptTask(envelope: EncryptedEnvelope, key: Buffer): PersistentTask {
  if (
    envelope.version !== 1 ||
    envelope.algorithm !== "aes-256-gcm"
  ) {
    throw new Error("Unsupported persistent task envelope.");
  }

  const expectedKeyId = createHash("sha256")
    .update(key)
    .digest("hex")
    .slice(0, 16);
  if (envelope.keyId !== expectedKeyId) {
    throw new Error(
      "Persistent task key mismatch. The task encryption key may have changed.",
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

  return JSON.parse(plaintext.toString("utf8")) as PersistentTask;
}

export async function writePersistentTask(task: PersistentTask): Promise<void> {
  await ensureTaskDir();
  const key = await loadOrCreateKey();
  task.updatedAt = new Date().toISOString();

  const filePath = taskPath(task.id);
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const envelope = encryptTask(task, key);

  await fs.writeFile(tempPath, JSON.stringify(envelope) + "\n", {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  await fs.rename(tempPath, filePath);
  await fs.chmod(filePath, 0o600).catch(() => undefined);
}

export async function readPersistentTask(id: string): Promise<PersistentTask> {
  await ensureTaskDir();
  const key = await loadOrCreateKey();
  const envelope = JSON.parse(
    await fs.readFile(taskPath(id), "utf8"),
  ) as EncryptedEnvelope;
  return decryptTask(envelope, key);
}

export async function deletePersistentTaskRecord(id: string): Promise<void> {
  await ensureTaskDir();
  await fs.rm(taskPath(id), { force: false });
}

export async function listPersistentTaskRecords(): Promise<PersistentTask[]> {
  await ensureTaskDir();
  const key = await loadOrCreateKey();
  const names = await fs.readdir(taskDir());
  const tasks: PersistentTask[] = [];

  for (const name of names) {
    if (!name.endsWith(".task")) continue;
    try {
      const envelope = JSON.parse(
        await fs.readFile(path.join(taskDir(), name), "utf8"),
      ) as EncryptedEnvelope;
      tasks.push(decryptTask(envelope, key));
    } catch {
      // Ignore malformed task files so one damaged record does not hide the rest.
    }
  }

  return tasks.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function appendTaskEvent(
  task: PersistentTask,
  event: Omit<PersistentTaskEvent, "at">,
): void {
  task.events.push({
    at: new Date().toISOString(),
    ...event,
  });
  if (task.events.length > 1000) {
    task.events.splice(0, task.events.length - 1000);
  }
}
