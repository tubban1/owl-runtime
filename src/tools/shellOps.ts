import { spawn, type ChildProcess } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { assertAllowedExistingPath } from "../security/pathGuard.js";
import { requireCapability } from "../security/capabilities.js";
import {
  currentExecutionContext,
  type ExecutionContext,
} from "../runtime/executionContext.js";
import {
  getProcessStorageInfo,
  listManagedProcesses,
  newManagedProcessId,
  processLogPaths,
  readManagedProcess,
  writeManagedProcess,
  type ManagedProcessRecord,
} from "../runtime/processStore.js";
import { resolveWorkspace } from "../runtime/workspaceResolver.js";
import {
  claimWorkspaceLeaseForRecoveredProcess,
  ensureWorkspaceWriteLease,
  pinWorkspaceLeaseForProcess,
  unpinWorkspaceLeaseForProcess,
} from "../runtime/workspaceLeaseManager.js";
import { runtimeSessionManager } from "../runtime/runtimeSessionManager.js";

const MAX_CAPTURE_BYTES = 1024 * 1024;
const runtimeInstanceId =
  `runtime_${process.pid}_${Date.now().toString(36)}`;

type LiveChild = {
  child: ChildProcess;
};

const liveChildren = new Map<string, LiveChild>();

function appendCapped(current: string, next: Buffer | string): string {
  const combined = current + next.toString();
  if (Buffer.byteLength(combined, "utf8") <= MAX_CAPTURE_BYTES) return combined;
  return combined.slice(-MAX_CAPTURE_BYTES);
}

function shellBinary(): string {
  return process.env.SHELL || "/bin/zsh";
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function processOwnerMatches(
  record: ManagedProcessRecord,
  context: ExecutionContext = currentExecutionContext(),
): boolean {
  if (record.ownerTaskId && context.taskId === record.ownerTaskId) return true;
  if (record.ownerSessionId === context.sessionId) return true;
  return context.origin === "system" && context.sessionId === "runtime:system";
}

function assertProcessOwner(record: ManagedProcessRecord) {
  const context = currentExecutionContext();
  if (processOwnerMatches(record, context)) return;
  throw new Error(
    `PROCESS_OWNED: ${record.processId} belongs to ${record.ownerTaskId ? `task:${record.ownerTaskId}` : `session:${record.ownerSessionId}`} and cannot be controlled by session:${context.sessionId}.`,
  );
}

async function ensureLogFile(filePath: string) {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const handle = await fs.open(filePath, "a", 0o600);
  await handle.chmod(0o600).catch(() => undefined);
  await handle.close();
}

async function markExited(
  processId: string,
  exitCode: number | null,
  signal: NodeJS.Signals | null,
) {
  try {
    const record = await readManagedProcess(processId);
    record.status = "exited";
    record.exitCode = exitCode;
    record.signal = signal;
    record.inputAvailable = false;
    await writeManagedProcess(record);
  } finally {
    liveChildren.delete(processId);
    await unpinWorkspaceLeaseForProcess(processId).catch(() => undefined);
  }
}

async function reconcileRecord(
  record: ManagedProcessRecord,
): Promise<ManagedProcessRecord> {
  if (record.status !== "running" && record.status !== "terminating") {
    return record;
  }

  if (pidAlive(record.pid)) {
    if (record.runtimeInstanceId !== runtimeInstanceId) {
      record.runtimeInstanceId = runtimeInstanceId;
      record.recoveredAfterRestart = true;
      record.inputAvailable = false;
      await writeManagedProcess(record);
    }
    return record;
  }

  record.status = "lost";
  record.inputAvailable = false;
  record.exitCode = record.exitCode ?? null;
  await writeManagedProcess(record);
  await unpinWorkspaceLeaseForProcess(record.processId).catch(() => undefined);
  return record;
}

async function readLogTail(filePath: string, tailChars: number): Promise<string> {
  const limit = Math.min(Math.max(Math.trunc(tailChars), 1_000), 200_000);
  try {
    const stat = await fs.stat(filePath);
    const byteCount = Math.min(stat.size, Math.max(limit * 4, 16_384));
    const handle = await fs.open(filePath, "r");
    try {
      const buffer = Buffer.alloc(byteCount);
      await handle.read(buffer, 0, byteCount, Math.max(0, stat.size - byteCount));
      return buffer.toString("utf8").slice(-limit);
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

export async function executeCommand(
  command: string,
  cwd: string,
  timeoutMs = 60_000,
) {
  requireCapability("ALLOW_SHELL", false);
  const safeCwd = await assertAllowedExistingPath(cwd);

  return await new Promise<{
    command: string;
    cwd: string;
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
  }>((resolve, reject) => {
    const child = spawn(shellBinary(), ["-lc", command], {
      cwd: safeCwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    child.stdout?.on("data", (chunk) => {
      stdout = appendCapped(stdout, chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr = appendCapped(stderr, chunk);
    });
    child.on("error", reject);

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
    }, Math.min(Math.max(timeoutMs, 1_000), 10 * 60_000));

    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      resolve({
        command,
        cwd: safeCwd,
        exitCode,
        signal,
        stdout,
        stderr,
        timedOut,
      });
    });
  });
}

export async function startProcess(
  command: string,
  cwd: string,
  workspaceMode: "read" | "write" = "write",
) {
  requireCapability("ALLOW_SHELL", false);
  const safeCwd = await assertAllowedExistingPath(cwd);
  const workspace = await resolveWorkspace(safeCwd);
  const processId = newManagedProcessId();
  const context = currentExecutionContext();

  const leaseContext =
    workspaceMode === "write" && !context.taskId
      ? { ...context, taskId: `process:${processId}` }
      : context;

  let workspaceLeaseId: string | undefined;
  if (workspaceMode === "write") {
    const lease = await ensureWorkspaceWriteLease(workspace, {
      context: leaseContext,
      purpose: `Long-running process ${processId}`,
      auto: true,
    });
    workspaceLeaseId = lease.id;
  }

  const logs = processLogPaths(processId);
  await Promise.all([
    ensureLogFile(logs.stdoutPath),
    ensureLogFile(logs.stderrPath),
  ]);

  const stdoutFd = fsSync.openSync(logs.stdoutPath, "a", 0o600);
  const stderrFd = fsSync.openSync(logs.stderrPath, "a", 0o600);

  let child: ChildProcess;
  try {
    child = spawn(shellBinary(), ["-lc", command], {
      cwd: safeCwd,
      env: process.env,
      detached: true,
      stdio: ["pipe", stdoutFd, stderrFd],
    });
  } finally {
    fsSync.closeSync(stdoutFd);
    fsSync.closeSync(stderrFd);
  }

  if (!child.pid) {
    child.kill("SIGKILL");
    throw new Error("Managed process failed to obtain a PID.");
  }

  const now = new Date().toISOString();
  const record: ManagedProcessRecord = {
    version: 1,
    processId,
    pid: child.pid,
    command,
    cwd: safeCwd,
    workspace,
    workspaceMode,
    ...(workspaceLeaseId ? { workspaceLeaseId } : {}),
    ownerSessionId: context.sessionId,
    ...(context.taskId ? { ownerTaskId: context.taskId } : {}),
    startedAt: now,
    updatedAt: now,
    status: "running",
    runtimeInstanceId,
    stdoutPath: logs.stdoutPath,
    stderrPath: logs.stderrPath,
    inputAvailable: Boolean(child.stdin?.writable),
  };

  await writeManagedProcess(record);

  if (workspaceMode === "write") {
    const pinned = await pinWorkspaceLeaseForProcess(
      workspace,
      processId,
      leaseContext,
    );
    record.workspaceLeaseId = pinned.id;
    await writeManagedProcess(record);
  }

  liveChildren.set(processId, { child });

  child.once("exit", (code, signal) => {
    void markExited(processId, code, signal).catch(() => undefined);
  });
  child.once("error", (error) => {
    void fs
      .appendFile(
        logs.stderrPath,
        `\n[AgentOS process error] ${error.message}\n`,
        { encoding: "utf8", mode: 0o600 },
      )
      .catch(() => undefined);
  });

  child.unref();
  const stdinHandle = child.stdin as unknown as { unref?: () => void } | null;
  stdinHandle?.unref?.();

  return {
    processId,
    pid: child.pid,
    command,
    cwd: safeCwd,
    workspace,
    workspaceMode,
    workspaceLeaseId: record.workspaceLeaseId ?? null,
    ownerSessionId: record.ownerSessionId,
    ownerTaskId: record.ownerTaskId ?? null,
    stdoutPath: record.stdoutPath,
    stderrPath: record.stderrPath,
    durable: true,
  };
}

export async function listProcesses() {
  const records = await listManagedProcesses();
  const reconciled = await Promise.all(records.map(reconcileRecord));
  return reconciled.map((record) => ({
    processId: record.processId,
    pid: record.pid,
    command: record.command,
    cwd: record.cwd,
    workspace: record.workspace,
    workspaceMode: record.workspaceMode,
    workspaceLeaseId: record.workspaceLeaseId ?? null,
    ownerSessionId: record.ownerSessionId,
    ownerTaskId: record.ownerTaskId ?? null,
    startedAt: record.startedAt,
    running: record.status === "running" || record.status === "terminating",
    status: record.status,
    exitCode: record.exitCode ?? null,
    recoveredAfterRestart: record.recoveredAfterRestart ?? false,
    inputAvailable:
      record.inputAvailable && liveChildren.has(record.processId),
  }));
}

export async function sendProcessInput(processId: string, input: string) {
  requireCapability("ALLOW_SHELL", false);
  const record = await reconcileRecord(await readManagedProcess(processId));
  assertProcessOwner(record);

  if (record.status !== "running") {
    throw new Error("Process is not running.");
  }

  const live = liveChildren.get(processId);
  if (!live?.child.stdin?.writable) {
    throw new Error(
      "Process stdin is not attached to this Runtime instance. This can happen after a Runtime restart; restart the interactive process if stdin is required.",
    );
  }

  live.child.stdin.write(input);
  return {
    processId,
    bytesWritten: Buffer.byteLength(input, "utf8"),
  };
}

export async function claimRecoveredProcess(processId: string) {
  const record = await reconcileRecord(await readManagedProcess(processId));
  if (
    record.status !== "running" &&
    record.status !== "terminating"
  ) {
    throw new Error(
      `Only a recovered running process can be claimed; ${processId} is ${record.status}.`,
    );
  }
  const ownerSession = runtimeSessionManager.status(record.ownerSessionId);
  const ownerDisconnected =
    Boolean(ownerSession?.disconnectedAt) &&
    (ownerSession?.activeCalls ?? 0) === 0;
  const orphanedByRestart =
    Boolean(record.recoveredAfterRestart) && !liveChildren.has(processId);

  if (!orphanedByRestart && !ownerDisconnected) {
    throw new Error(
      "PROCESS_NOT_ORPHANED: claim requires either a Runtime-recovered process or a disconnected original MCP transport session.",
    );
  }

  const context = currentExecutionContext();
  const previousOwnerSessionId = record.ownerSessionId;
  record.ownerSessionId = context.sessionId;
  record.ownerTaskId = context.taskId;
  await claimWorkspaceLeaseForRecoveredProcess(processId, context);
  await writeManagedProcess(record);

  return {
    processId,
    claimed: true,
    previousOwnerSessionId,
    ownerSessionId: record.ownerSessionId,
    ownerTaskId: record.ownerTaskId ?? null,
    workspace: record.workspace,
    workspaceLeaseId: record.workspaceLeaseId ?? null,
  };
}

export async function getProcessOutput(
  processId: string,
  tailChars = 20_000,
) {
  const record = await reconcileRecord(await readManagedProcess(processId));
  const [stdout, stderr] = await Promise.all([
    readLogTail(record.stdoutPath, tailChars),
    readLogTail(record.stderrPath, tailChars),
  ]);
  return {
    processId,
    running: record.status === "running" || record.status === "terminating",
    status: record.status,
    exitCode: record.exitCode ?? null,
    stdout,
    stderr,
    recoveredAfterRestart: record.recoveredAfterRestart ?? false,
  };
}

export async function killProcess(
  processId: string,
  signal: NodeJS.Signals = "SIGTERM",
) {
  requireCapability("ALLOW_SHELL", false);
  const record = await reconcileRecord(await readManagedProcess(processId));
  assertProcessOwner(record);

  if (record.status !== "running" && record.status !== "terminating") {
    return {
      processId,
      signal,
      sent: false,
      status: record.status,
    };
  }

  let sent = false;
  const live = liveChildren.get(processId);
  if (live) {
    sent = live.child.kill(signal);
  } else {
    try {
      process.kill(record.pid, signal);
      sent = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }

  if (sent) {
    record.status = "terminating";
    record.inputAvailable = false;
    await writeManagedProcess(record);
  }

  return {
    processId,
    signal,
    sent,
    pid: record.pid,
    status: record.status,
  };
}

export async function reconcilePersistentProcesses() {
  const records = await listManagedProcesses();
  let running = 0;
  let recovered = 0;
  let lost = 0;

  for (const record of records) {
    const before = record.status;
    const next = await reconcileRecord(record);
    if (next.status === "running" || next.status === "terminating") {
      running += 1;
      if (next.recoveredAfterRestart) recovered += 1;
    } else if (before === "running" && next.status === "lost") {
      lost += 1;
    }
  }

  return {
    records: records.length,
    running,
    recovered,
    lost,
    storage: getProcessStorageInfo(),
  };
}

export function startPersistentProcessMonitor() {
  const configured = Number(process.env.PROCESS_MONITOR_POLL_MS);
  const pollMs = Number.isFinite(configured)
    ? Math.min(Math.max(Math.trunc(configured), 1_000), 60_000)
    : 5_000;

  void reconcilePersistentProcesses().catch((error) => {
    console.error("AgentOS process recovery failed:", error);
  });

  const timer = setInterval(() => {
    void reconcilePersistentProcesses().catch((error) => {
      console.error("AgentOS process monitor failed:", error);
    });
  }, pollMs);
  timer.unref();

  return {
    pollMs,
    runtimeInstanceId,
    storage: getProcessStorageInfo(),
  };
}
