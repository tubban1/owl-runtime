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

export type WeChatSessionBinding = {
  version: 1;
  id: string;
  contactName: string;
  label: string;
  createdAt: string;
  updatedAt: string;
  enabled: boolean;
  restoreFocus: boolean;
  pollIntervalMs: number;
  ocrLanguages: string[];
  lastObservedDigest?: string;
  lastDeliveredDigest?: string;
  lastVisibleText?: string;
  lastReply?: string;
  lastProbeAt?: string;
  lastCaptureAt?: string;
  turnCounter: number;
  pendingSend?: {
    at: string;
    digest: string;
    text: string;
  };
  lastSendReceipt?: {
    at: string;
    digest: string;
    turn: number;
    contactName: string;
    focusHeldMs: number;
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

function storeDir(): string {
  return (
    process.env.WECHAT_SESSION_DIR?.trim() ||
    runtimeStatePath("wechat-sessions")
  );
}

function keyPath(): string {
  return (
    process.env.WECHAT_SESSION_KEY_PATH?.trim() ||
    runtimeStatePath("wechat-session.key")
  );
}

export function getWeChatSessionStorageInfo() {
  return {
    directory: storeDir(),
    encryptedAtRest: true,
    algorithm: "aes-256-gcm",
    keyPath: keyPath(),
  };
}

async function ensureDir(): Promise<void> {
  await fs.mkdir(storeDir(), { recursive: true, mode: 0o700 });
  await fs.chmod(storeDir(), 0o700).catch(() => undefined);
}

async function loadOrCreateKey(): Promise<Buffer> {
  const target = keyPath();
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  try {
    const encoded = (await fs.readFile(target, "utf8")).trim();
    const key = Buffer.from(encoded, "base64");
    if (key.length !== 32) {
      throw new Error("WeChat session key must decode to exactly 32 bytes.");
    }
    await fs.chmod(target, 0o600).catch(() => undefined);
    return key;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const key = randomBytes(32);
  try {
    await fs.writeFile(target, key.toString("base64") + "\n", {
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

function bindingPath(id: string): string {
  if (!/^wechat_session_[A-Za-z0-9_-]{1,96}$/.test(id)) {
    throw new Error("Invalid WeChat session id.");
  }
  return path.join(storeDir(), `${id}.session`);
}

function encrypt(
  binding: WeChatSessionBinding,
  key: Buffer,
): EncryptedEnvelope {
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

function decrypt(
  envelope: EncryptedEnvelope,
  key: Buffer,
): WeChatSessionBinding {
  if (envelope.version !== 1 || envelope.algorithm !== "aes-256-gcm") {
    throw new Error("Unsupported WeChat session envelope.");
  }
  if (envelope.keyId !== keyId(key)) {
    throw new Error("WeChat session key mismatch.");
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
  return JSON.parse(plaintext.toString("utf8")) as WeChatSessionBinding;
}

export function newWeChatSessionId(): string {
  return `wechat_session_${Date.now().toString(36)}_${randomUUID()
    .replaceAll("-", "")
    .slice(0, 12)}`;
}

export async function writeWeChatSession(
  binding: WeChatSessionBinding,
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

export async function readWeChatSession(
  id: string,
): Promise<WeChatSessionBinding> {
  await ensureDir();
  const key = await loadOrCreateKey();
  const envelope = JSON.parse(
    await fs.readFile(bindingPath(id), "utf8"),
  ) as EncryptedEnvelope;
  return decrypt(envelope, key);
}

export async function listWeChatSessions(): Promise<WeChatSessionBinding[]> {
  await ensureDir();
  const key = await loadOrCreateKey();
  const names = await fs.readdir(storeDir());
  const bindings: WeChatSessionBinding[] = [];
  for (const name of names) {
    if (!name.endsWith(".session")) continue;
    try {
      const envelope = JSON.parse(
        await fs.readFile(path.join(storeDir(), name), "utf8"),
      ) as EncryptedEnvelope;
      bindings.push(decrypt(envelope, key));
    } catch {
      // A damaged binding must not hide the remaining sessions.
    }
  }
  return bindings.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function deleteWeChatSession(id: string): Promise<void> {
  await ensureDir();
  await fs.rm(bindingPath(id), { force: false });
}
