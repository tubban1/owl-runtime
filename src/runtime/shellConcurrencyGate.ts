import {
  listManagedProcesses,
  type ManagedProcessRecord,
} from "./processStore.js";
import {
  cancellableSleep,
  currentCancellationSignal,
  throwIfCancelled,
} from "./cancellation.js";

type PermitKind = "exec" | "managed";

type ActivePermit = {
  id: string;
  workspace: string;
  kind: PermitKind;
  acquiredAt: number;
};

type PendingPermit = {
  id: string;
  workspace: string;
  kind: PermitKind;
  enqueuedAt: number;
};

export type ShellConcurrencyPermit = {
  id: string;
  workspace: string;
  kind: PermitKind;
  waitMs: number;
  release: () => void;
};

function boundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, minimum), maximum);
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

const maxGlobal = boundedInteger(
  process.env.OWL_SHELL_MAX_CONCURRENCY,
  4,
  1,
  32,
);
const maxPerWorkspace = boundedInteger(
  process.env.OWL_SHELL_MAX_CONCURRENCY_PER_WORKSPACE,
  2,
  1,
  16,
);
const defaultWaitMs = boundedInteger(
  process.env.OWL_SHELL_CONCURRENCY_WAIT_MS,
  10_000,
  0,
  120_000,
);
const pollMs = boundedInteger(
  process.env.OWL_SHELL_CONCURRENCY_POLL_MS,
  100,
  25,
  1_000,
);

const active = new Map<string, ActivePermit>();
const pending = new Map<string, PendingPermit>();

let recoveredSnapshot: ManagedProcessRecord[] | null = null;
let recoveredSnapshotPromise: Promise<ManagedProcessRecord[]> | null = null;

export function releaseShellConcurrencyPermit(id: string): void {
  active.delete(id);
}

async function loadRecoveredSnapshot(): Promise<ManagedProcessRecord[]> {
  if (recoveredSnapshot) return recoveredSnapshot;
  if (recoveredSnapshotPromise) return await recoveredSnapshotPromise;

  recoveredSnapshotPromise = listManagedProcesses()
    .then((records) =>
      records.filter(
        (record) =>
          record.status === "running" || record.status === "terminating",
      ),
    )
    .then((records) => {
      recoveredSnapshot = records;
      return records;
    })
    .finally(() => {
      recoveredSnapshotPromise = null;
    });

  return await recoveredSnapshotPromise;
}

async function recoveredManagedProcesses() {
  const records = await loadRecoveredSnapshot();
  return records.filter(
    (record) =>
      processAlive(record.pid) &&
      !active.has(`managed:${record.processId}`),
  );
}

export async function acquireShellConcurrencyPermit(input: {
  id: string;
  workspace: string;
  kind: PermitKind;
  waitMs?: number;
}): Promise<ShellConcurrencyPermit> {
  const signal = currentCancellationSignal();
  throwIfCancelled(signal);

  const waitLimitMs =
    input.waitMs === undefined
      ? defaultWaitMs
      : Math.min(Math.max(Math.trunc(input.waitMs), 0), 120_000);
  const enqueuedAt = Date.now();
  pending.set(input.id, {
    id: input.id,
    workspace: input.workspace,
    kind: input.kind,
    enqueuedAt,
  });

  try {
    while (true) {
      throwIfCancelled(signal);

      const recovered = await recoveredManagedProcesses();
      const activePermits = [...active.values()];
      const globalCount = activePermits.length + recovered.length;
      const workspaceCount =
        activePermits.filter((permit) => permit.workspace === input.workspace)
          .length +
        recovered.filter((record) => record.workspace === input.workspace)
          .length;

      if (
        globalCount < maxGlobal &&
        workspaceCount < maxPerWorkspace
      ) {
        const acquiredAt = Date.now();
        active.set(input.id, {
          id: input.id,
          workspace: input.workspace,
          kind: input.kind,
          acquiredAt,
        });
        pending.delete(input.id);

        let released = false;
        return {
          id: input.id,
          workspace: input.workspace,
          kind: input.kind,
          waitMs: acquiredAt - enqueuedAt,
          release: () => {
            if (released) return;
            released = true;
            releaseShellConcurrencyPermit(input.id);
          },
        };
      }

      const elapsed = Date.now() - enqueuedAt;
      if (elapsed >= waitLimitMs) {
        const error = new Error(
          `SHELL_CAPACITY_BUSY: workspace has ${workspaceCount}/${maxPerWorkspace} active shell processes and Runtime has ${globalCount}/${maxGlobal}. Retry after an existing process completes or use a separate worktree.`,
        );
        (error as Error & { code?: string; retryAfterMs?: number }).code =
          "SHELL_CAPACITY_BUSY";
        (error as Error & { retryAfterMs?: number }).retryAfterMs = pollMs;
        throw error;
      }

      await cancellableSleep(Math.min(pollMs, waitLimitMs - elapsed), signal);
    }
  } finally {
    pending.delete(input.id);
  }
}

export async function shellConcurrencyStatus() {
  const recovered = await recoveredManagedProcesses();
  return {
    limits: {
      global: maxGlobal,
      perWorkspace: maxPerWorkspace,
      waitMs: defaultWaitMs,
    },
    active: [
      ...[...active.values()].map((permit) => ({
        id: permit.id,
        workspace: permit.workspace,
        kind: permit.kind,
        source: "runtime" as const,
        activeMs: Date.now() - permit.acquiredAt,
      })),
      ...recovered.map((record) => ({
        id: `managed:${record.processId}`,
        workspace: record.workspace,
        kind: "managed" as const,
        source: "recovered" as const,
        activeMs: Math.max(0, Date.now() - Date.parse(record.startedAt)),
      })),
    ],
    pending: [...pending.values()].map((permit) => ({
      ...permit,
      waitingMs: Date.now() - permit.enqueuedAt,
    })),
  };
}
