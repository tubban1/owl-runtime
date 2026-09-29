import fs from "node:fs/promises";
import path from "node:path";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { z } from "zod";
import { runtimeStatePath } from "./runtimePaths.js";

export const RUNTIME_REQUEST_REPLAY_VERSION = 1 as const;

export type RuntimeRequestReplayState =
  | "in_progress"
  | "completed"
  | "failed"
  | "uncertain"
  | "expired";

export type RuntimeRequestReplayError = {
  code: string;
  name: string;
  message: string;
};

type RuntimeRequestReplayRecord = {
  version: typeof RUNTIME_REQUEST_REPLAY_VERSION;
  sessionDigest: string;
  idempotencyKey: string;
  method: string;
  requestDigest: string;
  requestId: string;
  state: RuntimeRequestReplayState;
  ownerPid: number;
  ownerInstanceId: string;
  acceptedAt: string;
  updatedAt: string;
  replayUntil?: string;
  completedAt?: string;
  failedAt?: string;
  uncertainAt?: string;
  terminalState?: "completed" | "failed";
  result?: unknown;
  error?: RuntimeRequestReplayError;
};

type EncryptedEnvelope = {
  version: 1;
  algorithm: "aes-256-gcm";
  keyId: string;
  iv: string;
  tag: string;
  ciphertext: string;
};

export type RuntimeRequestReplayInput = {
  sessionId: string;
  idempotencyKey: string;
  method: string;
  params?: unknown;
  requestId: string;
};

export type RuntimeRequestReplayResult<T> = {
  result: T;
  replayed: boolean;
  originalRequestId: string;
};

const INSTANCE_ID = randomUUID();
const KEY_PATTERN = /^[A-Za-z0-9._:@/-]{1,200}$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;

const replayErrorSchema = z.object({
  code: z.string().min(1).max(100),
  name: z.string().min(1).max(120),
  message: z.string().min(1).max(4000),
}).strict();

const replayRecordSchema = z.object({
  version: z.literal(RUNTIME_REQUEST_REPLAY_VERSION),
  sessionDigest: z.string().regex(DIGEST_PATTERN),
  idempotencyKey: z.string().regex(KEY_PATTERN),
  method: z.string().min(1).max(160),
  requestDigest: z.string().regex(DIGEST_PATTERN),
  requestId: z.string().min(1).max(200),
  state: z.enum([
    "in_progress",
    "completed",
    "failed",
    "uncertain",
    "expired",
  ]),
  ownerPid: z.number().int().positive(),
  ownerInstanceId: z.string().min(1).max(100),
  acceptedAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  replayUntil: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
  failedAt: z.string().datetime().optional(),
  uncertainAt: z.string().datetime().optional(),
  terminalState: z.enum(["completed", "failed"]).optional(),
  result: z.unknown().optional(),
  error: replayErrorSchema.optional(),
}).strict();

function replayDir(): string {
  return (
    process.env.RUNTIME_REQUEST_REPLAY_DIR?.trim() ||
    runtimeStatePath("request-replay")
  );
}

function keyPath(): string {
  return (
    process.env.RUNTIME_REQUEST_REPLAY_KEY_PATH?.trim() ||
    runtimeStatePath("request-replay.key")
  );
}

function replayTtlMs(): number {
  const raw = Number.parseInt(
    process.env.RUNTIME_REQUEST_REPLAY_TTL_MS?.trim() ||
      String(7 * 24 * 60 * 60 * 1000),
    10,
  );
  if (!Number.isSafeInteger(raw) || raw < 60_000) {
    throw new Error(
      "IDEMPOTENCY_RETENTION_INVALID: replay TTL must be at least 60000ms.",
    );
  }
  return raw;
}

function maxRecords(): number {
  const raw = Number.parseInt(
    process.env.RUNTIME_REQUEST_REPLAY_MAX_RECORDS?.trim() || "10000",
    10,
  );
  if (!Number.isSafeInteger(raw) || raw < 1 || raw > 100_000) {
    throw new Error(
      "IDEMPOTENCY_RETENTION_INVALID: max records must be 1-100000.",
    );
  }
  return raw;
}

function maxPayloadBytes(): number {
  const raw = Number.parseInt(
    process.env.RUNTIME_REQUEST_REPLAY_MAX_PAYLOAD_BYTES?.trim() ||
      String(1024 * 1024),
    10,
  );
  if (!Number.isSafeInteger(raw) || raw < 4096 || raw > 8 * 1024 * 1024) {
    throw new Error(
      "IDEMPOTENCY_RETENTION_INVALID: replay payload limit must be 4096-8388608 bytes.",
    );
  }
  return raw;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, stableValue(child)]),
    );
  }
  return value;
}

export function canonicalRuntimeRequestDigest(
  method: string,
  params?: unknown,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        stableValue({
          contractVersion: RUNTIME_REQUEST_REPLAY_VERSION,
          method,
          params: params ?? null,
        }),
      ),
    )
    .digest("hex");
}

function sessionDigest(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("hex");
}

function recordId(sessionId: string, idempotencyKey: string): string {
  return createHash("sha256")
    .update(sessionId)
    .update("\0")
    .update(idempotencyKey)
    .digest("hex");
}

function recordPath(sessionId: string, idempotencyKey: string): string {
  return path.join(replayDir(), recordId(sessionId, idempotencyKey) + ".state");
}

function lockPath(sessionId: string, idempotencyKey: string): string {
  return path.join(replayDir(), recordId(sessionId, idempotencyKey) + ".lock");
}

async function ensureDir(): Promise<void> {
  await fs.mkdir(replayDir(), { recursive: true, mode: 0o700 });
  await fs.chmod(replayDir(), 0o700).catch(() => undefined);
}

async function loadOrCreateKey(): Promise<Buffer> {
  await fs.mkdir(path.dirname(keyPath()), { recursive: true, mode: 0o700 });
  try {
    const encoded = (await fs.readFile(keyPath(), "utf8")).trim();
    const key = Buffer.from(encoded, "base64");
    if (key.length !== 32) {
      throw new Error("Request replay key must decode to 32 bytes.");
    }
    await fs.chmod(keyPath(), 0o600).catch(() => undefined);
    return key;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const key = randomBytes(32);
  try {
    await fs.writeFile(keyPath(), key.toString("base64") + "\n", {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await fs.chmod(keyPath(), 0o600).catch(() => undefined);
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
    throw new Error("Request replay key must decode to 32 bytes.");
  }
  return key;
}

function keyId(key: Buffer): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

function encrypt(
  value: RuntimeRequestReplayRecord,
  key: Buffer,
): EncryptedEnvelope {
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

function decrypt(
  envelope: EncryptedEnvelope,
  key: Buffer,
): RuntimeRequestReplayRecord {
  if (envelope.version !== 1 || envelope.algorithm !== "aes-256-gcm") {
    throw new Error("Unsupported request replay envelope.");
  }
  if (envelope.keyId !== keyId(key)) {
    throw new Error("Request replay key mismatch.");
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
  return replayRecordSchema.parse(
    JSON.parse(plaintext.toString("utf8")),
  ) as RuntimeRequestReplayRecord;
}

async function readRecord(
  sessionId: string,
  idempotencyKey: string,
): Promise<RuntimeRequestReplayRecord | null> {
  try {
    const encoded = await fs.readFile(
      recordPath(sessionId, idempotencyKey),
      "utf8",
    );
    const envelope = JSON.parse(encoded) as EncryptedEnvelope;
    return decrypt(envelope, await loadExistingKey());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    if (
      error instanceof Error &&
      error.message.startsWith("IDEMPOTENCY_")
    ) {
      throw error;
    }
    throw new Error(
      "IDEMPOTENCY_STORE_CORRUPT: durable replay state cannot be trusted.",
    );
  }
}

async function writeRecord(record: RuntimeRequestReplayRecord): Promise<void> {
  await ensureDir();
  const parsed = replayRecordSchema.parse(record) as RuntimeRequestReplayRecord;
  const key = await loadOrCreateKey();
  const target = path.join(
    replayDir(),
    recordIdFromRecord(parsed) + ".state",
  );
  const temp =
    target + "." + process.pid + "." + randomUUID() + ".tmp";
  try {
    await fs.writeFile(
      temp,
      JSON.stringify(encrypt(parsed, key)) + "\n",
      {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      },
    );
    await fs.rename(temp, target);
    await fs.chmod(target, 0o600).catch(() => undefined);
  } finally {
    await fs.rm(temp, { force: true }).catch(() => undefined);
  }
}

function recordIdFromRecord(record: RuntimeRequestReplayRecord): string {
  return createHash("sha256")
    .update(record.sessionDigest)
    .update("\0")
    .update(record.idempotencyKey)
    .digest("hex");
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRecordLock<T>(
  sessionId: string,
  idempotencyKey: string,
  operation: () => Promise<T>,
): Promise<T> {
  await ensureDir();
  const target = lockPath(sessionId, idempotencyKey);
  const startedAt = Date.now();

  while (true) {
    let handle: fs.FileHandle | undefined;
    try {
      handle = await fs.open(target, "wx", 0o600);
      await handle.writeFile(
        JSON.stringify({
          pid: process.pid,
          instanceId: INSTANCE_ID,
          acquiredAt: new Date().toISOString(),
        }) + "\n",
        "utf8",
      );
      try {
        return await operation();
      } finally {
        await handle.close().catch(() => undefined);
        await fs.rm(target, { force: true }).catch(() => undefined);
      }
    } catch (error) {
      await handle?.close().catch(() => undefined);
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;

      let reclaim = false;
      try {
        const raw = JSON.parse(await fs.readFile(target, "utf8")) as {
          pid?: unknown;
        };
        if (
          typeof raw.pid === "number" &&
          Number.isSafeInteger(raw.pid) &&
          raw.pid > 0
        ) {
          reclaim = !processAlive(raw.pid);
        }
      } catch {
        const stat = await fs.stat(target).catch(() => null);
        reclaim = Boolean(stat && Date.now() - stat.mtimeMs > 30_000);
      }

      if (reclaim) {
        await fs.rm(target, { force: true }).catch(() => undefined);
        continue;
      }
      if (Date.now() - startedAt > 10_000) {
        throw new Error(
          "IDEMPOTENCY_STORE_BUSY: timed out waiting for replay record lock.",
        );
      }
      await sleep(20);
    }
  }
}

async function currentRecordCount(): Promise<number> {
  await ensureDir();
  return (await fs.readdir(replayDir())).filter((name) =>
    name.endsWith(".state"),
  ).length;
}

function validateInput(input: RuntimeRequestReplayInput): void {
  if (!KEY_PATTERN.test(input.idempotencyKey)) {
    throw new Error(
      "IDEMPOTENCY_KEY_INVALID: expected 1-200 safe characters.",
    );
  }
  if (!input.sessionId.trim()) {
    throw new Error("IDEMPOTENCY_SESSION_INVALID: sessionId is required.");
  }
  if (!input.method.trim()) {
    throw new Error("IDEMPOTENCY_METHOD_INVALID: method is required.");
  }
}

function normalizedError(error: unknown): RuntimeRequestReplayError {
  const message = error instanceof Error ? error.message : String(error);
  const prefixed = /^([A-Z][A-Z0-9_]{2,100}):/.exec(message)?.[1];
  const object = error as { code?: unknown; name?: unknown };
  return {
    code:
      typeof object?.code === "string"
        ? object.code
        : prefixed ?? "RUNTIME_ERROR",
    name:
      typeof object?.name === "string" && object.name
        ? object.name
        : "Error",
    message: message.slice(0, 4000) || "Runtime request failed.",
  };
}

export class RuntimeStoredReplayError extends Error {
  readonly code: string;
  readonly originalRequestId: string;

  constructor(
    stored: RuntimeRequestReplayError,
    originalRequestId: string,
  ) {
    super(stored.message);
    this.name = stored.name || "RuntimeStoredReplayError";
    this.code = stored.code;
    this.originalRequestId = originalRequestId;
  }
}

async function expirePayloadIfNeeded(
  record: RuntimeRequestReplayRecord,
): Promise<RuntimeRequestReplayRecord> {
  if (
    (record.state === "completed" || record.state === "failed") &&
    record.replayUntil &&
    Date.parse(record.replayUntil) <= Date.now()
  ) {
    const expired: RuntimeRequestReplayRecord = {
      ...record,
      state: "expired",
      terminalState: record.state,
      result: undefined,
      error: undefined,
      updatedAt: new Date().toISOString(),
    };
    await writeRecord(expired);
    return expired;
  }
  return record;
}

async function reserve(
  input: RuntimeRequestReplayInput,
  requestDigest: string,
): Promise<
  | { kind: "execute"; originalRequestId: string }
  | { kind: "completed"; result: unknown; originalRequestId: string }
  | { kind: "failed"; error: RuntimeRequestReplayError; originalRequestId: string }
> {
  return await withRecordLock(
    input.sessionId,
    input.idempotencyKey,
    async () => {
      let record = await readRecord(input.sessionId, input.idempotencyKey);
      if (record) {
        record = await expirePayloadIfNeeded(record);
        if (record.requestDigest !== requestDigest) {
          throw new Error(
            "IDEMPOTENCY_KEY_CONFLICT: key already belongs to a different canonical request digest.",
          );
        }
        if (record.state === "completed") {
          return {
            kind: "completed" as const,
            result: record.result,
            originalRequestId: record.requestId,
          };
        }
        if (record.state === "failed") {
          return {
            kind: "failed" as const,
            error: record.error ?? {
              code: "RUNTIME_ERROR",
              name: "Error",
              message: "Stored Runtime request failed.",
            },
            originalRequestId: record.requestId,
          };
        }
        if (record.state === "expired") {
          throw new Error(
            "IDEMPOTENCY_REPLAY_EXPIRED: replay payload aged out; the original request will not be executed again.",
          );
        }
        if (record.state === "uncertain") {
          throw new Error(
            "IDEMPOTENCY_OUTCOME_UNCERTAIN: the prior execution may have crossed a side-effect boundary; manual reconciliation is required.",
          );
        }
        if (record.state === "in_progress") {
          if (
            record.ownerPid !== process.pid ||
            record.ownerInstanceId !== INSTANCE_ID
          ) {
            if (processAlive(record.ownerPid)) {
              throw new Error(
                "IDEMPOTENCY_REQUEST_IN_PROGRESS: the canonical request is still owned by another Runtime process.",
              );
            }
            const now = new Date().toISOString();
            record.state = "uncertain";
            record.uncertainAt = now;
            record.updatedAt = now;
            await writeRecord(record);
            throw new Error(
              "IDEMPOTENCY_OUTCOME_UNCERTAIN: previous Runtime owner disappeared before a terminal receipt was committed.",
            );
          }
          throw new Error(
            "IDEMPOTENCY_STATE_INCONSISTENT: in-progress replay record has no live in-process execution.",
          );
        }
      }

      if ((await currentRecordCount()) >= maxRecords()) {
        throw new Error(
          "IDEMPOTENCY_STORE_CAPACITY_EXCEEDED: replay ledger reached its configured record limit; refusing unprotected eviction.",
        );
      }

      const now = new Date().toISOString();
      await writeRecord({
        version: RUNTIME_REQUEST_REPLAY_VERSION,
        sessionDigest: sessionDigest(input.sessionId),
        idempotencyKey: input.idempotencyKey,
        method: input.method,
        requestDigest,
        requestId: input.requestId,
        state: "in_progress",
        ownerPid: process.pid,
        ownerInstanceId: INSTANCE_ID,
        acceptedAt: now,
        updatedAt: now,
      });
      return {
        kind: "execute" as const,
        originalRequestId: input.requestId,
      };
    },
  );
}

async function finalizeCompleted(
  input: RuntimeRequestReplayInput,
  requestDigest: string,
  result: unknown,
): Promise<void> {
  await withRecordLock(input.sessionId, input.idempotencyKey, async () => {
    const record = await readRecord(input.sessionId, input.idempotencyKey);
    if (!record || record.requestDigest !== requestDigest) {
      throw new Error(
        "IDEMPOTENCY_RECEIPT_PERSIST_FAILED: replay record disappeared or changed before completion.",
      );
    }

    const now = new Date();
    const encoded = JSON.stringify(result ?? null);
    if (Buffer.byteLength(encoded, "utf8") > maxPayloadBytes()) {
      await writeRecord({
        ...record,
        state: "expired",
        terminalState: "completed",
        result: undefined,
        error: undefined,
        completedAt: now.toISOString(),
        updatedAt: now.toISOString(),
      });
      return;
    }

    await writeRecord({
      ...record,
      state: "completed",
      result,
      error: undefined,
      terminalState: undefined,
      completedAt: now.toISOString(),
      replayUntil: new Date(now.getTime() + replayTtlMs()).toISOString(),
      updatedAt: now.toISOString(),
    });
  });
}

async function finalizeFailed(
  input: RuntimeRequestReplayInput,
  requestDigest: string,
  error: unknown,
): Promise<void> {
  await withRecordLock(input.sessionId, input.idempotencyKey, async () => {
    const record = await readRecord(input.sessionId, input.idempotencyKey);
    if (!record || record.requestDigest !== requestDigest) {
      throw new Error(
        "IDEMPOTENCY_RECEIPT_PERSIST_FAILED: replay record disappeared or changed before failure receipt.",
      );
    }
    const now = new Date();
    await writeRecord({
      ...record,
      state: "failed",
      result: undefined,
      error: normalizedError(error),
      terminalState: undefined,
      failedAt: now.toISOString(),
      replayUntil: new Date(now.getTime() + replayTtlMs()).toISOString(),
      updatedAt: now.toISOString(),
    });
  });
}

const activeExecutions = new Map<
  string,
  {
    requestDigest: string;
    promise: Promise<{
      result: unknown;
      originalRequestId: string;
      source: "executed" | "stored";
    }>;
  }
>();

export async function withRuntimeRequestReplay<T>(
  input: RuntimeRequestReplayInput,
  operation: () => Promise<T>,
): Promise<RuntimeRequestReplayResult<T>> {
  validateInput(input);
  const requestDigest = canonicalRuntimeRequestDigest(
    input.method,
    input.params,
  );
  const activeKey = recordId(input.sessionId, input.idempotencyKey);
  const existing = activeExecutions.get(activeKey);

  if (existing) {
    if (existing.requestDigest !== requestDigest) {
      throw new Error(
        "IDEMPOTENCY_KEY_CONFLICT: in-flight key belongs to a different canonical request digest.",
      );
    }
    const joined = await existing.promise;
    return {
      result: joined.result as T,
      replayed: true,
      originalRequestId: joined.originalRequestId,
    };
  }

  const promise = (async () => {
    const reserved = await reserve(input, requestDigest);
    if (reserved.kind === "completed") {
      return {
        result: reserved.result,
        originalRequestId: reserved.originalRequestId,
        source: "stored" as const,
      };
    }
    if (reserved.kind === "failed") {
      throw new RuntimeStoredReplayError(
        reserved.error,
        reserved.originalRequestId,
      );
    }

    try {
      const result = await operation();
      await finalizeCompleted(input, requestDigest, result);
      return {
        result,
        originalRequestId: input.requestId,
        source: "executed" as const,
      };
    } catch (error) {
      await finalizeFailed(input, requestDigest, error).catch(
        (persistError) => {
          throw persistError;
        },
      );
      throw error;
    }
  })();

  activeExecutions.set(activeKey, { requestDigest, promise });

  try {
    const outcome = await promise;
    return {
      result: outcome.result as T,
      replayed: outcome.source === "stored",
      originalRequestId: outcome.originalRequestId,
    };
  } finally {
    const current = activeExecutions.get(activeKey);
    if (current?.promise === promise) activeExecutions.delete(activeKey);
  }
}

export async function reserveRuntimeRequestReplayForCrashTest(
  input: RuntimeRequestReplayInput,
): Promise<void> {
  validateInput(input);
  const requestDigest = canonicalRuntimeRequestDigest(
    input.method,
    input.params,
  );
  const result = await reserve(input, requestDigest);
  if (result.kind !== "execute") {
    throw new Error(
      "IDEMPOTENCY_TEST_RESERVE_FAILED: expected a new replay reservation.",
    );
  }
}

export function getRuntimeRequestReplayManifest() {
  return {
    version: RUNTIME_REQUEST_REPLAY_VERSION,
    scope: "logical-session",
    keyHeader: "x-owl-idempotency-key",
    requestDigest: "sha256(canonical contractVersion + method + params)",
    responseReplayTtlMs: replayTtlMs(),
    maxRecords: maxRecords(),
    maxPayloadBytes: maxPayloadBytes(),
    crashRecovery: "fail-closed-uncertain",
    expiredReplay: "never-reexecute",
    encryptedAtRest: true,
  };
}
