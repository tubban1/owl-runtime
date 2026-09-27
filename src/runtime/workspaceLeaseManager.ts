import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  currentExecutionContext,
  executionOwnerKey,
  type ExecutionContext,
} from "./executionContext.js";
import {
  isRuntimeSelfWorkspace,
  runtimeMode,
  runtimeStatePath,
} from "./runtimePaths.js";
import { resolveWorkspace } from "./workspaceResolver.js";
import { runtimeSessionManager } from "./runtimeSessionManager.js";

const workspaceRuntimeInstanceId =
  "workspace_runtime_" +
  process.pid +
  "_" +
  Date.now().toString(36) +
  "_" +
  randomUUID().replaceAll("-", "").slice(0, 8);

export type WorkspaceLeaseRecord = {
  version: 1;
  id: string;
  workspace: string;
  mode: "write";
  ownerKey: string;
  ownerSessionId: string;
  ownerTaskId?: string;
  runtimeInstanceId?: string;
  purpose: string;
  acquiredAt: string;
  updatedAt: string;
  expiresAt: string;
  auto: boolean;
  runtimeSelf: boolean;
  pinnedProcessIds: string[];
};

export class WorkspaceBusyError extends Error {
  readonly code = "WORKSPACE_BUSY";
  readonly workspace: string;
  readonly lease: WorkspaceLeaseRecord;

  constructor(lease: WorkspaceLeaseRecord) {
    super(
      `WORKSPACE_BUSY: ${lease.workspace} is owned by ${lease.ownerKey} for "${lease.purpose}" since ${lease.acquiredAt}.`,
    );
    this.name = "WorkspaceBusyError";
    this.workspace = lease.workspace;
    this.lease = lease;
  }
}

function leaseDir(): string {
  return (
    process.env.WORKSPACE_LEASE_DIR?.trim() ||
    runtimeStatePath("workspace-leases")
  );
}

function leaseTtlMs(): number {
  const configured = Number(process.env.WORKSPACE_LEASE_TTL_MS);
  if (Number.isFinite(configured) && configured >= 10_000) {
    return Math.min(Math.trunc(configured), 24 * 60 * 60_000);
  }
  return 30 * 60_000;
}

function fileName(workspace: string): string {
  return (
    createHash("sha256").update(path.resolve(workspace)).digest("hex") +
    ".lease.json"
  );
}

function leasePath(workspace: string): string {
  return path.join(leaseDir(), fileName(workspace));
}

async function ensureDir() {
  await fs.mkdir(leaseDir(), { recursive: true, mode: 0o700 });
  await fs.chmod(leaseDir(), 0o700).catch(() => undefined);
}

function ownerMatches(
  lease: WorkspaceLeaseRecord,
  context: ExecutionContext,
): boolean {
  if (lease.ownerTaskId) {
    if (context.taskId === lease.ownerTaskId) return true;

    // A session-level lease can be promoted into the first durable task from
    // the same originating MCP session, but separate tasks never share write
    // ownership merely because they came from the same chat.
    return false;
  }
  return lease.ownerSessionId === context.sessionId;
}

function staleSessionLeaseFromPreviousRuntime(
  lease: WorkspaceLeaseRecord,
): boolean {
  return (
    !lease.ownerTaskId &&
    lease.pinnedProcessIds.length === 0 &&
    lease.runtimeInstanceId !== workspaceRuntimeInstanceId
  );
}

function disconnectedSessionReclaimGraceMs(): number {
  const configured = Number(process.env.WORKSPACE_SESSION_RECLAIM_GRACE_MS);
  if (Number.isFinite(configured) && configured >= 0) {
    return Math.min(Math.trunc(configured), 60_000);
  }
  return 5_000;
}

function idleSessionReclaimMs(): number {
  const configured = Number(process.env.WORKSPACE_SESSION_IDLE_RECLAIM_MS);
  if (Number.isFinite(configured) && configured >= 0) {
    return Math.min(Math.trunc(configured), 24 * 60 * 60_000);
  }
  return 15 * 60_000;
}

function staleDisconnectedSessionLease(
  lease: WorkspaceLeaseRecord,
  now = Date.now(),
): boolean {
  if (lease.ownerTaskId || lease.pinnedProcessIds.length > 0) return false;
  if (lease.runtimeInstanceId !== workspaceRuntimeInstanceId) return false;

  const ownerSession = runtimeSessionManager.status(lease.ownerSessionId);
  if (!ownerSession?.disconnectedAt || ownerSession.activeCalls > 0) {
    return false;
  }

  const disconnectedAt = Date.parse(ownerSession.disconnectedAt);
  if (!Number.isFinite(disconnectedAt)) return false;
  return now >= disconnectedAt + disconnectedSessionReclaimGraceMs();
}

function staleIdleSessionLease(
  lease: WorkspaceLeaseRecord,
  now = Date.now(),
): boolean {
  if (lease.ownerTaskId || lease.pinnedProcessIds.length > 0) return false;
  if (lease.runtimeInstanceId !== workspaceRuntimeInstanceId) return false;

  const ownerSession = runtimeSessionManager.status(lease.ownerSessionId);
  if (
    !ownerSession ||
    ownerSession.disconnectedAt ||
    ownerSession.activeCalls > 0
  ) {
    return false;
  }

  const lastActivityAt = Date.parse(ownerSession.lastActivityAt);
  if (!Number.isFinite(lastActivityAt)) return false;
  return now >= lastActivityAt + idleSessionReclaimMs();
}

function expired(lease: WorkspaceLeaseRecord, now = Date.now()): boolean {
  return (
    lease.pinnedProcessIds.length === 0 &&
    (Date.parse(lease.expiresAt) <= now ||
      staleSessionLeaseFromPreviousRuntime(lease) ||
      staleDisconnectedSessionLease(lease, now) ||
      staleIdleSessionLease(lease, now))
  );
}

function pathContains(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function workspacesOverlap(left: string, right: string): boolean {
  return pathContains(left, right) || pathContains(right, left);
}

async function readLeaseRaw(
  workspace: string,
): Promise<WorkspaceLeaseRecord | null> {
  await ensureDir();
  try {
    const parsed = JSON.parse(
      await fs.readFile(leasePath(workspace), "utf8"),
    ) as WorkspaceLeaseRecord;
    if (parsed.version !== 1 || parsed.workspace !== path.resolve(workspace)) {
      throw new Error("Workspace lease record is invalid.");
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function writeLease(record: WorkspaceLeaseRecord): Promise<void> {
  await ensureDir();
  record.updatedAt = new Date().toISOString();
  const target = leasePath(record.workspace);
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(record, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  await fs.rename(temp, target);
  await fs.chmod(target, 0o600).catch(() => undefined);
}

async function deleteLease(workspace: string): Promise<void> {
  await ensureDir();
  await fs.rm(leasePath(workspace), { force: true });
}

let serial: Promise<unknown> = Promise.resolve();

function serialized<T>(operation: () => Promise<T>): Promise<T> {
  const next = serial.then(operation, operation);
  serial = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

async function activeLease(
  workspace: string,
): Promise<WorkspaceLeaseRecord | null> {
  const current = await readLeaseRaw(workspace);
  if (!current) return null;
  if (expired(current)) {
    await deleteLease(workspace);
    return null;
  }
  return current;
}

function contextWithFallback(
  context?: ExecutionContext,
): ExecutionContext {
  return context ?? currentExecutionContext();
}

function ensureProductionSelfMutationAllowed(workspace: string) {
  if (
    runtimeMode() === "production" &&
    isRuntimeSelfWorkspace(workspace) &&
    process.env.ALLOW_RUNTIME_SELF_MUTATION?.trim().toLowerCase() !== "true"
  ) {
    throw new Error(
      "RUNTIME_SELF_IMMUTABLE: production Runtime code cannot mutate its own active release. Build and deploy a new release instead.",
    );
  }
}

export async function ensureWorkspaceWriteLease(
  workspaceInput: string,
  options?: {
    context?: ExecutionContext;
    purpose?: string;
    ttlMs?: number;
    auto?: boolean;
    waitMs?: number;
  },
): Promise<WorkspaceLeaseRecord> {
  const workspace = await resolveWorkspace(workspaceInput);
  ensureProductionSelfMutationAllowed(workspace);
  const context = contextWithFallback(options?.context);
  const ownerKey = executionOwnerKey(context);
  const ttl = Math.min(
    Math.max(Math.trunc(options?.ttlMs ?? leaseTtlMs()), 10_000),
    24 * 60 * 60_000,
  );
  const deadline = Date.now() + Math.max(0, options?.waitMs ?? 0);

  while (true) {
    try {
      return await serialized(async () => {
        const records = await listWorkspaceLeasesUnsafe();
        const overlapping = records.filter((record) =>
          workspacesOverlap(record.workspace, workspace),
        );
        const promotable = (record: WorkspaceLeaseRecord) =>
          !record.ownerTaskId &&
          Boolean(context.taskId) &&
          record.ownerSessionId === context.sessionId;
        const conflict = overlapping.find(
          (record) =>
            !ownerMatches(record, context) && !promotable(record),
        );
        if (conflict) throw new WorkspaceBusyError(conflict);

        const current =
          overlapping.find((record) => record.workspace === workspace) ??
          null;
        const now = new Date();

        if (current) {
          current.expiresAt = new Date(now.getTime() + ttl).toISOString();
          current.purpose = options?.purpose ?? current.purpose;
          current.runtimeInstanceId = workspaceRuntimeInstanceId;
          if (context.taskId && !current.ownerTaskId) {
            current.ownerTaskId = context.taskId;
            current.ownerKey = ownerKey;
          }
          await writeLease(current);
          return current;
        }

        const record: WorkspaceLeaseRecord = {
          version: 1,
          id: `workspace_lease_${Date.now().toString(36)}_${randomUUID()
            .replaceAll("-", "")
            .slice(0, 12)}`,
          workspace,
          mode: "write",
          ownerKey,
          ownerSessionId: context.sessionId,
          ...(context.taskId ? { ownerTaskId: context.taskId } : {}),
          runtimeInstanceId: workspaceRuntimeInstanceId,
          purpose:
            options?.purpose ??
            (context.taskId
              ? `Task ${context.taskId}`
              : `MCP session ${context.sessionId}`),
          acquiredAt: now.toISOString(),
          updatedAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + ttl).toISOString(),
          auto: options?.auto ?? false,
          runtimeSelf: isRuntimeSelfWorkspace(workspace),
          pinnedProcessIds: [],
        };
        await writeLease(record);
        return record;
      });
    } catch (error) {
      if (!(error instanceof WorkspaceBusyError) || Date.now() >= deadline) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

export async function assertWorkspaceWriteAllowed(
  workspaceInput: string,
  contextInput?: ExecutionContext,
): Promise<{
  workspace: string;
  coveringLease: WorkspaceLeaseRecord | null;
}> {
  const workspace = await resolveWorkspace(workspaceInput);
  ensureProductionSelfMutationAllowed(workspace);
  const context = contextWithFallback(contextInput);

  return await serialized(async () => {
    const records = await listWorkspaceLeasesUnsafe();
    const overlapping = records.filter((record) =>
      workspacesOverlap(record.workspace, workspace),
    );
    const conflict = overlapping.find(
      (record) => !ownerMatches(record, context),
    );
    if (conflict) throw new WorkspaceBusyError(conflict);
    return {
      workspace,
      coveringLease: overlapping[0] ?? null,
    };
  });
}

export async function waitForWorkspaceAvailable(
  workspaceInput: string,
  options?: {
    timeoutMs?: number;
    pollMs?: number;
    context?: ExecutionContext;
  },
): Promise<{
  available: boolean;
  timedOut: boolean;
  waitedMs: number;
  workspace: string;
  lease: WorkspaceLeaseRecord | null;
}> {
  const context = contextWithFallback(options?.context);
  const timeoutMs = Math.min(
    Math.max(Math.trunc(options?.timeoutMs ?? 60_000), 0),
    10 * 60_000,
  );
  const pollMs = Math.min(
    Math.max(Math.trunc(options?.pollMs ?? 100), 20),
    2_000,
  );
  const startedAt = Date.now();

  while (true) {
    const status = await workspaceLeaseStatus(workspaceInput);
    if (!status.lease || ownerMatches(status.lease, context)) {
      return {
        available: true,
        timedOut: false,
        waitedMs: Date.now() - startedAt,
        workspace: status.workspace,
        lease: status.lease,
      };
    }
    if (Date.now() - startedAt >= timeoutMs) {
      return {
        available: false,
        timedOut: true,
        waitedMs: Date.now() - startedAt,
        workspace: status.workspace,
        lease: status.lease,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

export async function workspaceLeaseStatus(
  workspaceInput: string,
): Promise<{
  workspace: string;
  lease: WorkspaceLeaseRecord | null;
  busy: boolean;
  runtimeSelf: boolean;
}> {
  const workspace = await resolveWorkspace(workspaceInput);
  const lease = await serialized(async () => {
    const records = await listWorkspaceLeasesUnsafe();
    return (
      records.find((record) => record.workspace === workspace) ??
      records.find((record) =>
        workspacesOverlap(record.workspace, workspace),
      ) ??
      null
    );
  });
  return {
    workspace,
    lease,
    busy: Boolean(lease),
    runtimeSelf: isRuntimeSelfWorkspace(workspace),
  };
}

export async function listWorkspaceLeases(): Promise<WorkspaceLeaseRecord[]> {
  return await serialized(async () => {
    await ensureDir();
    const names = await fs.readdir(leaseDir());
    const records: WorkspaceLeaseRecord[] = [];

    for (const name of names) {
      if (!name.endsWith(".lease.json")) continue;
      try {
        const record = JSON.parse(
          await fs.readFile(path.join(leaseDir(), name), "utf8"),
        ) as WorkspaceLeaseRecord;
        if (record.version !== 1) continue;
        if (expired(record)) {
          await fs.rm(path.join(leaseDir(), name), { force: true });
          continue;
        }
        records.push(record);
      } catch {
        // One damaged lease must not hide healthy ownership records.
      }
    }

    return records.sort((a, b) => a.workspace.localeCompare(b.workspace));
  });
}

export async function releaseWorkspaceLease(
  workspaceInput: string,
  options?: {
    context?: ExecutionContext;
    force?: boolean;
  },
): Promise<{ released: boolean; workspace: string; reason?: string }> {
  const workspace = await resolveWorkspace(workspaceInput);
  const context = contextWithFallback(options?.context);

  return await serialized(async () => {
    const current = await activeLease(workspace);
    if (!current) return { released: false, workspace, reason: "no_lease" };

    if (
      options?.force !== true &&
      !ownerMatches(current, context) &&
      current.ownerSessionId !== context.sessionId
    ) {
      throw new WorkspaceBusyError(current);
    }

    if (current.pinnedProcessIds.length > 0 && options?.force !== true) {
      return {
        released: false,
        workspace,
        reason: `pinned_by_process:${current.pinnedProcessIds.join(",")}`,
      };
    }

    await deleteLease(workspace);
    return { released: true, workspace };
  });
}

export async function releaseWorkspaceLeasesForTask(
  taskId: string,
): Promise<number> {
  return await serialized(async () => {
    const records = await listWorkspaceLeasesUnsafe();
    let released = 0;
    for (const record of records) {
      if (record.ownerTaskId !== taskId) continue;
      if (record.pinnedProcessIds.length === 0) {
        await deleteLease(record.workspace);
        released += 1;
      } else {
        // Keep protection while the process is alive, but make the lease
        // immediately collectable when the final process unpins.
        record.expiresAt = new Date(0).toISOString();
        record.purpose =
          `Task ${taskId} ended; release after pinned process exits`;
        await writeLease(record);
      }
    }
    return released;
  });
}

export async function releaseWorkspaceLeasesForSession(
  sessionId: string,
): Promise<number> {
  return await serialized(async () => {
    const records = await listWorkspaceLeasesUnsafe();
    let released = 0;
    for (const record of records) {
      if (
        record.ownerSessionId !== sessionId ||
        record.ownerTaskId
      ) {
        continue;
      }
      if (record.pinnedProcessIds.length === 0) {
        await deleteLease(record.workspace);
        released += 1;
      } else {
        record.expiresAt = new Date(0).toISOString();
        record.purpose =
          `Session ${sessionId} disconnected; release after pinned process exits`;
        await writeLease(record);
      }
    }
    return released;
  });
}

async function listWorkspaceLeasesUnsafe(): Promise<WorkspaceLeaseRecord[]> {
  await ensureDir();
  const names = await fs.readdir(leaseDir());
  const records: WorkspaceLeaseRecord[] = [];
  for (const name of names) {
    if (!name.endsWith(".lease.json")) continue;
    const filePath = path.join(leaseDir(), name);
    try {
      const record = JSON.parse(
        await fs.readFile(filePath, "utf8"),
      ) as WorkspaceLeaseRecord;
      if (record.version !== 1) continue;
      if (expired(record)) {
        await fs.rm(filePath, { force: true });
        continue;
      }
      records.push(record);
    } catch {
      // Ignore malformed records.
    }
  }
  return records;
}

export async function pinWorkspaceLeaseForProcess(
  workspaceInput: string,
  processId: string,
  context?: ExecutionContext,
): Promise<WorkspaceLeaseRecord> {
  const workspace = await resolveWorkspace(workspaceInput);
  const lease = await ensureWorkspaceWriteLease(workspace, {
    context,
    purpose: `Long-running process ${processId}`,
    auto: true,
  });

  return await serialized(async () => {
    const current = (await activeLease(workspace)) ?? lease;
    if (!current.pinnedProcessIds.includes(processId)) {
      current.pinnedProcessIds.push(processId);
    }
    await writeLease(current);
    return current;
  });
}

export async function claimWorkspaceLeaseForRecoveredProcess(
  processId: string,
  context: ExecutionContext = currentExecutionContext(),
): Promise<WorkspaceLeaseRecord | null> {
  return await serialized(async () => {
    const records = await listWorkspaceLeasesUnsafe();
    const record = records.find((item) =>
      item.pinnedProcessIds.includes(processId),
    );
    if (!record) return null;

    const leaseContext = context.taskId
      ? context
      : { ...context, taskId: `process:${processId}` };
    record.ownerSessionId = context.sessionId;
    record.ownerTaskId = leaseContext.taskId;
    record.ownerKey = executionOwnerKey(leaseContext);
    record.runtimeInstanceId = workspaceRuntimeInstanceId;
    record.purpose = `Recovered process ${processId} claimed by ${record.ownerKey}`;
    record.expiresAt = new Date(Date.now() + leaseTtlMs()).toISOString();
    await writeLease(record);
    return record;
  });
}

export async function unpinWorkspaceLeaseForProcess(
  processId: string,
): Promise<number> {
  return await serialized(async () => {
    const records = await listWorkspaceLeasesUnsafe();
    let changed = 0;

    for (const record of records) {
      const next = record.pinnedProcessIds.filter((id) => id !== processId);
      if (next.length === record.pinnedProcessIds.length) continue;
      record.pinnedProcessIds = next;
      changed += 1;

      if (
        next.length === 0 &&
        record.ownerTaskId === `process:${processId}`
      ) {
        await deleteLease(record.workspace);
      } else if (expired(record)) {
        await deleteLease(record.workspace);
      } else {
        await writeLease(record);
      }
    }

    return changed;
  });
}

export function getWorkspaceLeaseStorageInfo() {
  return {
    directory: leaseDir(),
    defaultTtlMs: leaseTtlMs(),
    runtimeInstanceId: workspaceRuntimeInstanceId,
    durable: true,
    writeOwnershipOnly: true,
    readWhileWriteOwned: true,
    orphanSessionLeaseReclamation: true,
    sameRuntimeDisconnectedSessionReclamation: true,
    sessionReclaimGraceMs: disconnectedSessionReclaimGraceMs(),
    staleActiveSessionReclamation: true,
    sessionIdleReclaimMs: idleSessionReclaimMs(),
    hierarchicalWorkspaceConflicts: true,
  };
}
