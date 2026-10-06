import {
  listManagedProcesses,
  type ManagedProcessRecord,
} from "./processStore.js";
import {
  cancellableSleep,
  currentCancellationSignal,
  throwIfCancelled,
} from "./cancellation.js";
import {
  classifyShellResourceDemand,
  deriveShellAdmissionBudget,
  detectHostResourceInventory,
  type ResourceDemand,
} from "./resourceAdmission.js";

type PermitKind = "exec" | "managed";

type ActivePermit = {
  id: string;
  workspace: string;
  kind: PermitKind;
  acquiredAt: number;
  demand: ResourceDemand;
};

type PendingPermit = {
  id: string;
  workspace: string;
  kind: PermitKind;
  enqueuedAt: number;
  demand: ResourceDemand;
};

export type ShellConcurrencyPermit = {
  id: string;
  workspace: string;
  kind: PermitKind;
  waitMs: number;
  resourceClass: ResourceDemand["class"];
  computeCredits: number;
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

const hardGlobalSlots = boundedInteger(
  process.env.OWL_SHELL_MAX_CONCURRENCY,
  32,
  1,
  64,
);
const hardPerWorkspaceSlots = boundedInteger(
  process.env.OWL_SHELL_MAX_CONCURRENCY_PER_WORKSPACE,
  16,
  1,
  32,
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
  return records
    .filter(
      (record) =>
        processAlive(record.pid) &&
        !active.has(`managed:${record.processId}`),
    )
    .map((record) => ({
      record,
      demand: classifyShellResourceDemand(record.command),
    }));
}

function totalCredits(
  items: Array<{ demand: ResourceDemand }>,
): number {
  return items.reduce((total, item) => total + item.demand.computeCredits, 0);
}

function totalSlots(
  items: Array<{ demand: ResourceDemand }>,
): number {
  return items.reduce((total, item) => total + item.demand.processSlots, 0);
}

export async function acquireShellConcurrencyPermit(input: {
  id: string;
  workspace: string;
  kind: PermitKind;
  command: string;
  waitMs?: number;
}): Promise<ShellConcurrencyPermit> {
  const signal = currentCancellationSignal();
  throwIfCancelled(signal);

  const demand = classifyShellResourceDemand(input.command);
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
    demand,
  });

  try {
    while (true) {
      throwIfCancelled(signal);

      const inventory = detectHostResourceInventory();
      const budget = deriveShellAdmissionBudget(inventory, {
        globalSlots: hardGlobalSlots,
        perWorkspaceSlots: hardPerWorkspaceSlots,
      });
      const recovered = await recoveredManagedProcesses();
      const activePermits = [...active.values()];
      const activeItems = activePermits.map((permit) => ({
        workspace: permit.workspace,
        demand: permit.demand,
      }));
      const recoveredItems = recovered.map(({ record, demand }) => ({
        workspace: record.workspace,
        demand,
      }));
      const allItems = [...activeItems, ...recoveredItems];
      const workspaceItems = allItems.filter(
        (item) => item.workspace === input.workspace,
      );

      const globalSlots = totalSlots(allItems);
      const workspaceSlots = totalSlots(workspaceItems);
      const globalCredits = totalCredits(allItems);
      const workspaceCredits = totalCredits(workspaceItems);

      const slotsFit =
        globalSlots + demand.processSlots <= budget.globalSlots &&
        workspaceSlots + demand.processSlots <= budget.perWorkspaceSlots;
      const creditsFit =
        globalCredits + demand.computeCredits <=
          budget.globalComputeCredits &&
        workspaceCredits + demand.computeCredits <=
          budget.perWorkspaceComputeCredits;

      if (slotsFit && creditsFit) {
        const acquiredAt = Date.now();
        active.set(input.id, {
          id: input.id,
          workspace: input.workspace,
          kind: input.kind,
          acquiredAt,
          demand,
        });
        pending.delete(input.id);

        let released = false;
        return {
          id: input.id,
          workspace: input.workspace,
          kind: input.kind,
          waitMs: acquiredAt - enqueuedAt,
          resourceClass: demand.class,
          computeCredits: demand.computeCredits,
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
          [
            "SHELL_CAPACITY_BUSY:",
            `mode=${budget.mode}`,
            `workspace slots ${workspaceSlots}/${budget.perWorkspaceSlots}`,
            `workspace credits ${workspaceCredits}/${budget.perWorkspaceComputeCredits}`,
            `runtime slots ${globalSlots}/${budget.globalSlots}`,
            `runtime credits ${globalCredits}/${budget.globalComputeCredits}`,
            `requested=${demand.class}:${demand.computeCredits} credits.`,
            "Retry after capacity recovers or use a separate worktree/target.",
          ].join(" "),
        );
        const typed = error as Error & {
          code?: string;
          retryAfterMs?: number;
          admissionMode?: string;
        };
        typed.code = "SHELL_CAPACITY_BUSY";
        typed.retryAfterMs = pollMs;
        typed.admissionMode = budget.mode;
        throw error;
      }

      await cancellableSleep(
        Math.min(pollMs, waitLimitMs - elapsed),
        signal,
      );
    }
  } finally {
    pending.delete(input.id);
  }
}

export async function shellConcurrencyStatus() {
  const inventory = detectHostResourceInventory();
  const budget = deriveShellAdmissionBudget(inventory, {
    globalSlots: hardGlobalSlots,
    perWorkspaceSlots: hardPerWorkspaceSlots,
  });
  const recovered = await recoveredManagedProcesses();

  return {
    inventory,
    budget,
    hardCeilings: {
      globalSlots: hardGlobalSlots,
      perWorkspaceSlots: hardPerWorkspaceSlots,
      waitMs: defaultWaitMs,
    },
    active: [
      ...[...active.values()].map((permit) => ({
        id: permit.id,
        workspace: permit.workspace,
        kind: permit.kind,
        source: "runtime" as const,
        activeMs: Date.now() - permit.acquiredAt,
        resourceClass: permit.demand.class,
        computeCredits: permit.demand.computeCredits,
      })),
      ...recovered.map(({ record, demand }) => ({
        id: `managed:${record.processId}`,
        workspace: record.workspace,
        kind: "managed" as const,
        source: "recovered" as const,
        activeMs: Math.max(0, Date.now() - Date.parse(record.startedAt)),
        resourceClass: demand.class,
        computeCredits: demand.computeCredits,
      })),
    ],
    pending: [...pending.values()].map((permit) => ({
      id: permit.id,
      workspace: permit.workspace,
      kind: permit.kind,
      resourceClass: permit.demand.class,
      computeCredits: permit.demand.computeCredits,
      waitingMs: Date.now() - permit.enqueuedAt,
    })),
  };
}
