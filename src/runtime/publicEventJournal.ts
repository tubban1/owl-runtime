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

export const RUNTIME_PUBLIC_EVENT_JOURNAL_VERSION = 1 as const;
export const AGENT_REQUEST_PRODUCER_CONTRACT_VERSION = 1 as const;

export type RuntimePublicEventType =
  | "agent_request.proposed"
  | "agent_request.withdrawn";

export type RuntimeAgentRequestSubject = {
  kind: string;
  id: string;
  revision?: string;
};

export type RuntimeAgentRequestContextRef = RuntimeAgentRequestSubject;

export type RuntimeAgentRequestProposedDraft = {
  eventType: "agent_request.proposed";
  eventId: string;
  proposalId: string;
  requestType: string;
  priority: "low" | "normal" | "high" | "urgent";
  subject: RuntimeAgentRequestSubject;
  reasonCode: string;
  errorCodes: string[];
  contextRefs: RuntimeAgentRequestContextRef[];
  allowedActions: string[];
  requiresUserConfirmation: boolean;
  dedupeKey: string;
  occurredAt: string;
};

export type RuntimeAgentRequestWithdrawnDraft = {
  eventType: "agent_request.withdrawn";
  eventId: string;
  proposalId: string;
  subject: RuntimeAgentRequestSubject;
  reasonCode: string;
  dedupeKey: string;
  occurredAt: string;
};

export type RuntimePublicEventDraft =
  | RuntimeAgentRequestProposedDraft
  | RuntimeAgentRequestWithdrawnDraft;

export type RuntimePublicEvent = RuntimePublicEventDraft & {
  sequence: number;
  cursor: string;
};

export type RuntimeEventListRequest = {
  afterCursor?: string;
  limit?: number;
  types?: RuntimePublicEventType[];
};

export type RuntimeEventRetention = {
  strategy: "count";
  maxEvents: number;
  oldestSequence: number | null;
  newestSequence: number | null;
  oldestCursor: string | null;
  newestCursor: string | null;
};

export type RuntimeEventListResponse = {
  events: RuntimePublicEvent[];
  nextCursor: string;
  hasMore: boolean;
  retention: RuntimeEventRetention;
};

type EncryptedEnvelope = {
  version: 1;
  algorithm: "aes-256-gcm";
  keyId: string;
  iv: string;
  tag: string;
  ciphertext: string;
};

type RuntimePublicEventReceipt = {
  sequence: number;
  digest: string;
};

type RuntimePublicEventJournalState = {
  version: typeof RUNTIME_PUBLIC_EVENT_JOURNAL_VERSION;
  lastSequence: number;
  events: RuntimePublicEvent[];
  eventReceipts: Record<string, RuntimePublicEventReceipt>;
  updatedAt: string;
};

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const CODE_PATTERN = /^[A-Z0-9][A-Z0-9_.:-]*$/;
const CURSOR_PATTERN = /^runtime-events:([0-9]+)$/;

const subjectSchema = z.object({
  kind: z.string().min(1).max(80).regex(IDENTIFIER_PATTERN),
  id: z.string().min(1).max(180),
  revision: z.string().min(1).max(80).optional(),
}).strict();

const proposedDraftSchema = z.object({
  eventType: z.literal("agent_request.proposed"),
  eventId: z.string().min(1).max(200),
  proposalId: z.string().min(1).max(200),
  requestType: z.string().min(1).max(120).regex(IDENTIFIER_PATTERN),
  priority: z.enum(["low", "normal", "high", "urgent"]),
  subject: subjectSchema,
  reasonCode: z.string().min(1).max(100).regex(CODE_PATTERN),
  errorCodes: z.array(z.string().min(1).max(100).regex(CODE_PATTERN)).max(32),
  contextRefs: z.array(subjectSchema).max(24),
  allowedActions: z.array(
    z.string().min(1).max(120).regex(IDENTIFIER_PATTERN),
  ).max(32),
  requiresUserConfirmation: z.boolean(),
  dedupeKey: z.string().min(1).max(220),
  occurredAt: z.string().datetime(),
}).strict();

const withdrawnDraftSchema = z.object({
  eventType: z.literal("agent_request.withdrawn"),
  eventId: z.string().min(1).max(200),
  proposalId: z.string().min(1).max(200),
  subject: subjectSchema,
  reasonCode: z.string().min(1).max(100).regex(CODE_PATTERN),
  dedupeKey: z.string().min(1).max(220),
  occurredAt: z.string().datetime(),
}).strict();

const draftSchema = z.discriminatedUnion("eventType", [
  proposedDraftSchema,
  withdrawnDraftSchema,
]);

const sequenceSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const cursorSchema = z.string().regex(CURSOR_PATTERN);

const proposedEventSchema = proposedDraftSchema.extend({
  sequence: sequenceSchema,
  cursor: cursorSchema,
}).strict();

const withdrawnEventSchema = withdrawnDraftSchema.extend({
  sequence: sequenceSchema,
  cursor: cursorSchema,
}).strict();

const eventSchema = z.discriminatedUnion("eventType", [
  proposedEventSchema,
  withdrawnEventSchema,
]);

const eventReceiptSchema = z.object({
  sequence: sequenceSchema,
  digest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

const journalStateSchema = z.object({
  version: z.literal(RUNTIME_PUBLIC_EVENT_JOURNAL_VERSION),
  lastSequence: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  events: z.array(eventSchema),
  eventReceipts: z.record(eventReceiptSchema).optional(),
  updatedAt: z.string().datetime(),
}).strict();

function journalDir(): string {
  return (
    process.env.RUNTIME_PUBLIC_EVENT_DIR?.trim() ||
    runtimeStatePath("public-events")
  );
}

function journalPath(): string {
  return path.join(journalDir(), "journal.state");
}

function keyPath(): string {
  return (
    process.env.RUNTIME_PUBLIC_EVENT_KEY_PATH?.trim() ||
    runtimeStatePath("public-events.key")
  );
}

function retentionLimit(): number {
  const raw = Number.parseInt(
    process.env.RUNTIME_PUBLIC_EVENT_RETENTION_MAX?.trim() || "10000",
    10,
  );
  if (!Number.isSafeInteger(raw) || raw < 1 || raw > 100_000) {
    throw new Error(
      "PUBLIC_EVENT_RETENTION_INVALID: RUNTIME_PUBLIC_EVENT_RETENTION_MAX must be 1-100000.",
    );
  }
  return raw;
}

export function getPublicEventJournalStorageInfo() {
  return {
    version: RUNTIME_PUBLIC_EVENT_JOURNAL_VERSION,
    directory: journalDir(),
    journalPath: journalPath(),
    keyPath: keyPath(),
    encryptedAtRest: true,
    algorithm: "aes-256-gcm",
    retention: {
      strategy: "count" as const,
      maxEvents: retentionLimit(),
    },
  };
}

async function ensureDir(): Promise<void> {
  await fs.mkdir(journalDir(), { recursive: true, mode: 0o700 });
  await fs.chmod(journalDir(), 0o700).catch(() => undefined);
}

async function loadOrCreateKey(): Promise<Buffer> {
  await fs.mkdir(path.dirname(keyPath()), { recursive: true, mode: 0o700 });
  try {
    const encoded = (await fs.readFile(keyPath(), "utf8")).trim();
    const key = Buffer.from(encoded, "base64");
    if (key.length !== 32) {
      throw new Error("Public event journal key must decode to 32 bytes.");
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
    throw new Error("Public event journal key must decode to 32 bytes.");
  }
  return key;
}

function keyId(key: Buffer): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

function encrypt(
  value: RuntimePublicEventJournalState,
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
): RuntimePublicEventJournalState {
  if (envelope.version !== 1 || envelope.algorithm !== "aes-256-gcm") {
    throw new Error("Unsupported public event journal envelope.");
  }
  if (envelope.keyId !== keyId(key)) {
    throw new Error("Public event journal key mismatch.");
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
  return validateJournalState(JSON.parse(plaintext.toString("utf8")));
}

function draftDigest(draft: RuntimePublicEventDraft): string {
  return createHash("sha256")
    .update(JSON.stringify(stableValue(draft)))
    .digest("hex");
}

function validateJournalState(value: unknown): RuntimePublicEventJournalState {
  const parsed = journalStateSchema.parse(value);
  const state: RuntimePublicEventJournalState = {
    ...parsed,
    eventReceipts: parsed.eventReceipts ?? {},
  } as RuntimePublicEventJournalState;

  let previous = 0;
  const eventIds = new Set<string>();
  for (const event of state.events) {
    if (event.cursor !== cursorForSequence(event.sequence)) {
      throw new Error("Public event journal cursor/sequence mismatch.");
    }
    if (previous > 0 && event.sequence !== previous + 1) {
      throw new Error("Public event journal contains a sequence gap.");
    }
    if (eventIds.has(event.eventId)) {
      throw new Error("Public event journal contains a duplicate eventId.");
    }
    eventIds.add(event.eventId);
    previous = event.sequence;

    const digest = draftDigest(draftFromEvent(event));
    const existingReceipt = state.eventReceipts[event.eventId];
    if (existingReceipt) {
      if (
        existingReceipt.sequence !== event.sequence ||
        existingReceipt.digest !== digest
      ) {
        throw new Error("Public event journal receipt mismatch.");
      }
    } else {
      state.eventReceipts[event.eventId] = {
        sequence: event.sequence,
        digest,
      };
    }
  }

  const receiptSequences = Object.values(state.eventReceipts).map(
    (receipt) => receipt.sequence,
  );
  if (
    receiptSequences.some(
      (sequence) => sequence < 1 || sequence > state.lastSequence,
    )
  ) {
    throw new Error("Public event journal receipt sequence is invalid.");
  }

  const newest = state.events.at(-1)?.sequence;
  if (newest !== undefined && newest !== state.lastSequence) {
    throw new Error("Public event journal lastSequence mismatch.");
  }
  return state;
}

function emptyState(): RuntimePublicEventJournalState {
  return {
    version: RUNTIME_PUBLIC_EVENT_JOURNAL_VERSION,
    lastSequence: 0,
    events: [],
    eventReceipts: {},
    updatedAt: new Date().toISOString(),
  };
}

async function readState(): Promise<RuntimePublicEventJournalState> {
  let encoded: string;
  try {
    encoded = await fs.readFile(journalPath(), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return emptyState();
    }
    throw error;
  }

  try {
    const envelope = JSON.parse(encoded) as EncryptedEnvelope;
    return decrypt(envelope, await loadExistingKey());
  } catch (error) {
    throw new Error(
      "PUBLIC_EVENT_JOURNAL_CORRUPT: durable public event state cannot be trusted.",
      { cause: error },
    );
  }
}

async function writeState(
  state: RuntimePublicEventJournalState,
): Promise<void> {
  await ensureDir();
  const key = await loadOrCreateKey();
  state.updatedAt = new Date().toISOString();
  validateJournalState(state);
  const target = journalPath();
  const temp =
    target + "." + process.pid + "." + randomUUID() + ".tmp";
  try {
    await fs.writeFile(temp, JSON.stringify(encrypt(state, key)) + "\n", {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await fs.rename(temp, target);
    await fs.chmod(target, 0o600).catch(() => undefined);
  } finally {
    await fs.rm(temp, { force: true }).catch(() => undefined);
  }
}

function cursorForSequence(sequence: number): string {
  return "runtime-events:" + sequence;
}

function cursorSequence(cursor: string): number {
  const match = CURSOR_PATTERN.exec(cursor);
  if (!match) {
    throw new Error(
      "CURSOR_INVALID: expected cursor format runtime-events:<sequence>.",
    );
  }
  const value = Number(match[1]);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("CURSOR_INVALID: cursor sequence is outside the safe range.");
  }
  return value;
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

function draftFromEvent(event: RuntimePublicEvent): RuntimePublicEventDraft {
  const { sequence: _sequence, cursor: _cursor, ...draft } = event;
  return draft;
}

function lockPath(): string {
  return path.join(journalDir(), "journal.lock");
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function withJournalFileLock<T>(
  operation: () => Promise<T>,
): Promise<T> {
  await ensureDir();
  const startedAt = Date.now();

  while (true) {
    let handle: fs.FileHandle | undefined;
    try {
      handle = await fs.open(lockPath(), "wx", 0o600);
      await handle.writeFile(
        JSON.stringify({
          pid: process.pid,
          acquiredAt: new Date().toISOString(),
        }) + "\n",
        "utf8",
      );
      try {
        return await operation();
      } finally {
        await handle.close().catch(() => undefined);
        await fs.rm(lockPath(), { force: true }).catch(() => undefined);
      }
    } catch (error) {
      await handle?.close().catch(() => undefined);
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }

      let reclaim = false;
      try {
        const raw = JSON.parse(await fs.readFile(lockPath(), "utf8")) as {
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
        const stat = await fs.stat(lockPath()).catch(() => null);
        reclaim = Boolean(
          stat && Date.now() - stat.mtimeMs > 30_000,
        );
      }

      if (reclaim) {
        await fs.rm(lockPath(), { force: true }).catch(() => undefined);
        continue;
      }
      if (Date.now() - startedAt > 10_000) {
        throw new Error(
          "PUBLIC_EVENT_JOURNAL_BUSY: timed out waiting for the cross-process journal lock.",
        );
      }
      await sleep(20);
    }
  }
}

let mutationTail: Promise<void> = Promise.resolve();

function serialized<T>(operation: () => Promise<T>): Promise<T> {
  const locked = () => withJournalFileLock(operation);
  const run = mutationTail.then(locked, locked);
  mutationTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export function parseRuntimePublicEventDraft(
  value: unknown,
): RuntimePublicEventDraft {
  return draftSchema.parse(value) as RuntimePublicEventDraft;
}

export async function appendPublicRuntimeEvent(
  value: unknown,
): Promise<RuntimePublicEvent> {
  const draft = parseRuntimePublicEventDraft(value);
  return await serialized(async () => {
    const state = await readState();
    const digest = draftDigest(draft);
    const receipt = state.eventReceipts[draft.eventId];
    if (receipt) {
      if (receipt.digest !== digest) {
        throw new Error(
          "PUBLIC_EVENT_ID_CONFLICT: eventId already exists with different content.",
        );
      }
      return {
        ...draft,
        sequence: receipt.sequence,
        cursor: cursorForSequence(receipt.sequence),
      } as RuntimePublicEvent;
    }

    if (state.lastSequence >= Number.MAX_SAFE_INTEGER) {
      throw new Error("PUBLIC_EVENT_SEQUENCE_EXHAUSTED");
    }
    const sequence = state.lastSequence + 1;
    const event = eventSchema.parse({
      ...draft,
      sequence,
      cursor: cursorForSequence(sequence),
    }) as RuntimePublicEvent;

    state.lastSequence = sequence;
    state.eventReceipts[event.eventId] = {
      sequence,
      digest,
    };
    state.events.push(event);
    const maxEvents = retentionLimit();
    if (state.events.length > maxEvents) {
      state.events.splice(0, state.events.length - maxEvents);
    }
    await writeState(state);
    return event;
  });
}

function normalizeListRequest(
  request: RuntimeEventListRequest,
): Required<Pick<RuntimeEventListRequest, "limit">> &
  Pick<RuntimeEventListRequest, "afterCursor" | "types"> {
  const limit = request.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    throw new Error("EVENT_LIST_LIMIT_INVALID: limit must be 1-500.");
  }
  if (request.types !== undefined) {
    if (!Array.isArray(request.types) || request.types.length > 32) {
      throw new Error("EVENT_LIST_TYPES_INVALID");
    }
    for (const type of request.types) {
      if (
        type !== "agent_request.proposed" &&
        type !== "agent_request.withdrawn"
      ) {
        throw new Error("EVENT_LIST_TYPE_UNSUPPORTED: " + String(type));
      }
    }
    const requested = new Set(request.types);
    if (
      requested.size !== 2 ||
      !requested.has("agent_request.proposed") ||
      !requested.has("agent_request.withdrawn")
    ) {
      throw new Error(
        "EVENT_LIST_TYPE_FILTER_INCOMPLETE_CHANNEL: v1 global sequence requires both AgentRequest event types.",
      );
    }
  }
  if (
    request.afterCursor !== undefined &&
    typeof request.afterCursor !== "string"
  ) {
    throw new Error("CURSOR_INVALID: afterCursor must be a string.");
  }
  return {
    limit,
    afterCursor: request.afterCursor,
    types: request.types,
  };
}

export async function listPublicRuntimeEvents(
  request: RuntimeEventListRequest = {},
): Promise<RuntimeEventListResponse> {
  const normalized = normalizeListRequest(request);
  return await serialized(async () => {
    const state = await readState();
    const oldestSequence = state.events[0]?.sequence ?? null;
    const newestSequence = state.events.at(-1)?.sequence ?? null;
    const afterSequence =
      normalized.afterCursor === undefined
        ? (oldestSequence ?? 1) - 1
        : cursorSequence(normalized.afterCursor);

    if (
      oldestSequence !== null &&
      afterSequence < oldestSequence - 1
    ) {
      throw new Error(
        "CURSOR_EXPIRED: RETENTION_GAP requested=" +
          afterSequence +
          " oldestRetained=" +
          oldestSequence +
          ".",
      );
    }
    if (afterSequence > state.lastSequence) {
      throw new Error(
        "CURSOR_AHEAD: requested=" +
          afterSequence +
          " newest=" +
          state.lastSequence +
          ".",
      );
    }

    const typeSet = normalized.types
      ? new Set<RuntimePublicEventType>(normalized.types)
      : null;
    const matching = state.events.filter(
      (event) =>
        event.sequence > afterSequence &&
        (!typeSet || typeSet.has(event.eventType)),
    );
    const events = matching.slice(0, normalized.limit);
    const nextCursor =
      events.at(-1)?.cursor ??
      normalized.afterCursor ??
      cursorForSequence(afterSequence);

    return {
      events,
      nextCursor,
      hasMore: matching.length > events.length,
      retention: {
        strategy: "count",
        maxEvents: retentionLimit(),
        oldestSequence,
        newestSequence,
        oldestCursor: state.events[0]?.cursor ?? null,
        newestCursor: state.events.at(-1)?.cursor ?? null,
      },
    };
  });
}
