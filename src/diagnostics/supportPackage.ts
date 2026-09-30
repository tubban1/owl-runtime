import { createHash } from "node:crypto";
import os from "node:os";
import { readAuditLog } from "../audit.js";
import { providerHealth } from "../health/healthModel.js";
import { getProviderStatuses } from "../providers/registry.js";
import { getExecutionTargetManifest } from "../runtime/executionTarget.js";
import { runtimeLifecycle } from "../runtime/runtimeLifecycle.js";
import { runtimePathStatus } from "../runtime/runtimePaths.js";
import { RUNTIME_VERSION } from "../runtime/runtimeVersion.js";
import { getStateSchemaStatus } from "../runtime/stateSchema.js";
import { listWorkspaceLeases } from "../runtime/workspaceLeaseManager.js";
import { listPersistentTasks } from "../tasks/taskRuntime.js";
import { listProcesses } from "../tools/shellOps.js";

export const SUPPORT_PACKAGE_VERSION = 1 as const;

function shortHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 16);
}

function redactHome(value: string): string {
  const home = os.homedir();
  return home && value.includes(home) ? value.replaceAll(home, "<home>") : value;
}

function redactText(value: string): string {
  return redactHome(value)
    .replace(/Bearer\s+[^\s]+/gi, "Bearer <redacted>")
    .replace(
      /(?:token|secret|password|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi,
      (match) => match.replace(/([:=]\s*).+$/, "$1<redacted>"),
    );
}

function countBy<T>(items: T[], key: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const name = key(item);
    counts[name] = (counts[name] ?? 0) + 1;
  }
  return counts;
}

function safePathStatus() {
  const status = runtimePathStatus();
  return {
    mode: status.mode,
    candidateMode: status.candidateMode,
    stateRoot: redactHome(status.stateRoot),
    codeRoot: redactHome(status.codeRoot),
  };
}

function safeStateSchema(status: Awaited<ReturnType<typeof getStateSchemaStatus>>) {
  return {
    schemaVersion: status.schemaVersion,
    currentSchemaVersion: status.currentSchemaVersion,
    readable: status.readable,
    migrationRequired: status.migrationRequired,
    nativeSchema: status.nativeSchema,
    autoMigrationSafe: status.autoMigrationSafe,
    rollbackCompatible: status.rollbackCompatible,
    pendingMigration: status.pendingMigration
      ? {
          id: status.pendingMigration.migrationId,
          from: status.pendingMigration.from,
          to: status.pendingMigration.to,
        }
      : null,
    recoverableCommittedJournal: status.recoverableCommittedJournal,
    incompatibleReason:
      typeof status.incompatibleReason === "string"
        ? redactText(status.incompatibleReason)
        : status.incompatibleReason ?? null,
  };
}

export type SupportPackageOptions = {
  auditLimit?: number;
};

export async function createSupportPackage(
  options: SupportPackageOptions = {},
) {
  const auditLimit = Math.min(
    Math.max(Math.trunc(options.auditLimit ?? 30), 0),
    100,
  );

  const [providers, stateSchema, tasks, processes, leases, audit] =
    await Promise.all([
      getProviderStatuses(),
      getStateSchemaStatus(),
      listPersistentTasks(),
      listProcesses(),
      listWorkspaceLeases(),
      auditLimit > 0 ? readAuditLog(auditLimit) : Promise.resolve([]),
    ]);

  const providerSignals = providers.map((status) => {
    const health = providerHealth(status);
    return {
      id: status.id,
      enabled: status.enabled,
      available: status.available,
      capabilities: status.capabilities,
      executionTargets: status.executionTargets ?? ["host"],
      health: {
        state: health.state,
        code: health.code,
        summary: redactText(health.summary),
        actionable: health.actionable,
        ...(Array.isArray(health.details?.missingPermissions)
          ? {
              missingPermissions: health.details.missingPermissions,
            }
          : {}),
      },
    };
  });

  const taskRows = tasks.slice(0, 50).map((task) => ({
    idHash: shortHash(task.id),
    status: task.status,
    runCount: task.runCount,
    counts: task.counts,
    updatedAt: task.updatedAt,
  }));

  const processRows = processes.slice(0, 50).map((process) => ({
    idHash: shortHash(process.processId),
    pid: process.pid,
    status: process.status,
    running: process.running,
    workspaceMode: process.workspaceMode,
    recoveredAfterRestart: process.recoveredAfterRestart,
    inputAvailable: process.inputAvailable,
    owner: process.ownerTaskId
      ? { kind: "task", idHash: shortHash(process.ownerTaskId) }
      : { kind: "session", idHash: shortHash(process.ownerSessionId) },
  }));

  const leaseRows = leases.slice(0, 50).map((lease) => ({
    idHash: shortHash(lease.id),
    workspaceHash: shortHash(lease.workspace),
    ownerKeyHash: shortHash(lease.ownerKey),
    runtimeSelf: lease.runtimeSelf,
    auto: lease.auto,
    pinnedProcessCount: lease.pinnedProcessIds.length,
    acquiredAt: lease.acquiredAt,
    updatedAt: lease.updatedAt,
    expiresAt: lease.expiresAt,
  }));

  const auditRows = audit.map((entry) => ({
    timestamp: entry.timestamp,
    tool: entry.tool,
    status: entry.status,
    durationMs: entry.durationMs,
    error:
      typeof entry.error === "string" ? redactText(entry.error) : null,
  }));

  const lifecycle = runtimeLifecycle.status();

  return {
    supportPackageVersion: SUPPORT_PACKAGE_VERSION,
    generatedAt: new Date().toISOString(),
    runtime: {
      version: RUNTIME_VERSION,
      paths: safePathStatus(),
      lifecycle: {
        state: lifecycle.state,
        acceptingNewMutations: lifecycle.acceptingNewMutations,
        stateChangedAt: lifecycle.stateChangedAt,
        activeMutationCount: lifecycle.activeMutationCount,
      },
      executionTargets: getExecutionTargetManifest(),
    },
    platform: {
      platform: process.platform,
      arch: process.arch,
      osRelease: os.release(),
      nodeVersion: process.version,
    },
    stateSchema: safeStateSchema(stateSchema),
    providers: providerSignals,
    tasks: {
      count: tasks.length,
      byStatus: countBy(tasks, (task) => task.status),
      recent: taskRows,
    },
    processes: {
      count: processes.length,
      byStatus: countBy(processes, (process) => process.status),
      recent: processRows,
    },
    workspaceLeases: {
      count: leases.length,
      runtimeSelfCount: leases.filter((lease) => lease.runtimeSelf).length,
      pinnedProcessCount: leases.reduce(
        (sum, lease) => sum + lease.pinnedProcessIds.length,
        0,
      ),
      recent: leaseRows,
    },
    audit: {
      requestedLimit: auditLimit,
      returned: auditRows.length,
      errors: auditRows.filter((entry) => entry.status === "error").length,
      recent: auditRows,
    },
    redaction: {
      rawArgumentsIncluded: false,
      commandTextIncluded: false,
      stdoutIncluded: false,
      stderrIncluded: false,
      fileContentsIncluded: false,
      clipboardIncluded: false,
      rawTaskIdsIncluded: false,
      rawProcessIdsIncluded: false,
      rawWorkspacePathsIncluded: false,
      homeDirectoryReplaced: true,
    },
  };
}
