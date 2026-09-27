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

export type SessionAdapterId = "chatgpt" | "antigravity" | "generic-browser";

export type SessionBinding = {
  version: 1;
  id: string;
  adapterId: SessionAdapterId;
  label: string;
  createdAt: string;
  updatedAt: string;
  enabled: boolean;
  locator: {
    urlPattern?: string;
    titlePattern?: string;
  };
  selectors: {
    input: string;
    send?: string;
    message?: string;
  };
  busyMarkers: string[];
  expectedUrl?: string;
  expectedTitle?: string;
  sessionFingerprint?: string;
  lastSnapshotDigest?: string;
  lastSnapshotText?: string;
  lastCaptureDigest?: string;
  lastCapturedReply?: string;
  lastSentDigest?: string;
  lastSentText?: string;
  pendingSend?: {
    at: string;
    digest: string;
    text: string;
  };
  lastSendReceipt?: {
    at: string;
    digest: string;
    url: string;
    title: string;
    turn: number;
  };
  turnCounter: number;
};

type EncryptedEnvelope = {
  version: 1;
  algorithm: "aes-256-gcm";
  keyId: string;
  iv: string;
  tag: string;
  ciphertext: string;
};

function sessionDir(): string {
  return (
    process.env.SESSION_ADAPTER_DIR?.trim() ||
    runtimeStatePath("sessions")
  );
}

function sessionKeyPath(): string {
  return (
    process.env.SESSION_ADAPTER_KEY_PATH?.trim() ||
    runtimeStatePath("session.key")
  );
}

export function getSessionStorageInfo() {
  return {
    directory: sessionDir(),
    encryptedAtRest: true,
    algorithm: "aes-256-gcm",
    keyPath: sessionKeyPath(),
  };
}

async function ensureDir(): Promise<void> {
  await fs.mkdir(sessionDir(), { recursive: true, mode: 0o700 });
  await fs.chmod(sessionDir(), 0o700).catch(() => undefined);
}

async function loadOrCreateKey(): Promise<Buffer> {
  const keyPath = sessionKeyPath();
  await fs.mkdir(path.dirname(keyPath), { recursive: true, mode: 0o700 });
  try {
    const encoded = (await fs.readFile(keyPath, "utf8")).trim();
    const key = Buffer.from(encoded, "base64");
    if (key.length !== 32) {
      throw new Error("Session adapter key must decode to exactly 32 bytes.");
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

function bindingPath(id: string): string {
  if (!/^session_[A-Za-z0-9_-]{1,96}$/.test(id)) {
    throw new Error("Invalid session binding id.");
  }
  return path.join(sessionDir(), `${id}.session`);
}

function encrypt(binding: SessionBinding, key: Buffer): EncryptedEnvelope {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(binding), "utf8");
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

function decrypt(envelope: EncryptedEnvelope, key: Buffer): SessionBinding {
  if (envelope.version !== 1 || envelope.algorithm !== "aes-256-gcm") {
    throw new Error("Unsupported session adapter envelope.");
  }
  if (envelope.keyId !== keyId(key)) {
    throw new Error("Session adapter key mismatch.");
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
  return JSON.parse(plaintext.toString("utf8")) as SessionBinding;
}

export function newSessionBindingId(): string {
  return `session_${Date.now().toString(36)}_${randomUUID()
    .replaceAll("-", "")
    .slice(0, 12)}`;
}

export async function writeSessionBinding(
  binding: SessionBinding,
): Promise<void> {
  await ensureDir();
  const key = await loadOrCreateKey();
  binding.updatedAt = new Date().toISOString();
  const target = bindingPath(binding.id);
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(encrypt(binding, key)) + "\n", {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  await fs.rename(temp, target);
  await fs.chmod(target, 0o600).catch(() => undefined);
}

export async function readSessionBinding(id: string): Promise<SessionBinding> {
  await ensureDir();
  const key = await loadOrCreateKey();
  const envelope = JSON.parse(
    await fs.readFile(bindingPath(id), "utf8"),
  ) as EncryptedEnvelope;
  return decrypt(envelope, key);
}

export async function listSessionBindings(): Promise<SessionBinding[]> {
  await ensureDir();
  const key = await loadOrCreateKey();
  const names = await fs.readdir(sessionDir());
  const bindings: SessionBinding[] = [];
  for (const name of names) {
    if (!name.endsWith(".session")) continue;
    try {
      const envelope = JSON.parse(
        await fs.readFile(path.join(sessionDir(), name), "utf8"),
      ) as EncryptedEnvelope;
      bindings.push(decrypt(envelope, key));
    } catch {
      // One damaged binding must not hide the rest.
    }
  }
  return bindings.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function deleteSessionBinding(id: string): Promise<void> {
  await ensureDir();
  await fs.rm(bindingPath(id), { force: false });
}
