import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
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
  releaseWorkspaceLeasesForTask,
  unpinWorkspaceLeaseForProcess,
} from "../runtime/workspaceLeaseManager.js";
import { runtimeSessionManager } from "../runtime/runtimeSessionManager.js";
import { createObservation, type ObservationState } from "../observation/observationAbi.js";
import { assessManagedProcessState } from "../runtime/processState.js";
import {
  cancellableSleep,
  currentCancellationSignal,
  OperationCancelledError,
  throwIfCancelled,
} from "../runtime/cancellation.js";
import {
  acquireShellConcurrencyPermit,
  managedProcessAdmissionWaitMs,
  releaseShellConcurrencyPermit,
} from "../runtime/shellConcurrencyGate.js";

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

function signalProcessGroup(
  child: ChildProcess,
  signal: NodeJS.Signals,
): boolean {
  if (!child.pid) return false;

  if (process.platform !== "win32") {
    try {
      process.kill(-child.pid, signal);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }

  try {
    return child.kill(signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function newProcessControlToken(): string {
  return randomBytes(32).toString("base64url");
}

function hashProcessControlToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function processControlTokenMatches(
  record: ManagedProcessRecord,
  controlToken?: string,
): boolean {
  if (!controlToken || !record.controlTokenHash) return false;
  const expected = Buffer.from(record.controlTokenHash, "hex");
  const actual = Buffer.from(hashProcessControlToken(controlToken), "hex");
  return (
    expected.length === actual.length &&
    expected.length > 0 &&
    timingSafeEqual(expected, actual)
  );
}

function processOwnerMatches(
  record: ManagedProcessRecord,
  context: ExecutionContext = currentExecutionContext(),
  controlToken?: string,
): boolean {
  if (processControlTokenMatches(record, controlToken)) return true;
  if (record.ownerTaskId && context.taskId === record.ownerTaskId) return true;
  if (record.ownerSessionId === context.sessionId) return true;
  return context.origin === "system" && context.sessionId === "runtime:system";
}

function assertProcessOwner(
  record: ManagedProcessRecord,
  controlToken?: string,
) {
  const context = currentExecutionContext();
  if (processOwnerMatches(record, context, controlToken)) return;
  throw new Error(
    `PROCESS_OWNED: ${record.processId} belongs to ${record.ownerTaskId ? `task:${record.ownerTaskId}` : `session:${record.ownerSessionId}`} and cannot be controlled by session:${context.sessionId} without the process control capability.`,
  );
}

async function ensureLogFile(filePath: string) {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const handle = await fs.open(filePath, "a", 0o600);
  await handle.chmod(0o600).catch(() => undefined);
  await handle.close();
}

async function readClassificationTail(filePath: string): Promise<string> {
  try {
    const stat = await fs.stat(filePath);
    const byteCount = Math.min(stat.size, 8_192);
    if (byteCount <= 0) return "";
    const handle = await fs.open(filePath, "r");
    try {
      const buffer = Buffer.alloc(byteCount);
      await handle.read(buffer, 0, byteCount, Math.max(0, stat.size - byteCount));
      return buffer.toString("utf8");
    } finally {
      await handle.close();
    }
  } catch {
    return "";
  }
}

export function classifyManagedProcessOutcome(input: {
  command: string;
  status: ManagedProcessRecord["status"];
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  text?: string;
}) {
  if (input.status === "running" || input.status === "terminating") {
    return {
      outcomeClass: "running" as const,
      failureCategory: null,
      failureReason: null,
    };
  }
  if (input.status === "lost") {
    return {
      outcomeClass: "runtime_failure" as const,
      failureCategory: "runtime",
      failureReason: "Managed process ownership was lost before a terminal exit could be proven.",
    };
  }
  if (input.exitCode === 0) {
    return {
      outcomeClass: "success" as const,
      failureCategory: null,
      failureReason: null,
    };
  }
  if (
    ["SIGTERM", "SIGINT", "SIGHUP"].includes(input.signal ?? "") ||
    [130, 143].includes(Number(input.exitCode))
  ) {
    return {
      outcomeClass: "expected_termination" as const,
      failureCategory: "cancelled",
      failureReason: "Process stopped by an expected termination signal.",
    };
  }

  const haystack = `${input.command}\n${input.text ?? ""}`.toLowerCase();
  const match = (pattern: RegExp) => pattern.test(haystack);
  // TAP assertion failures outrank unrelated auth/network terms in test logs.
  const testOutput = input.text ?? "";
  if (
    /(?:^|\n)\s*not ok \d+\s+-/m.test(testOutput) ||
    /(?:^|\n)\s*failureType:\s*['"]testCodeFailure['"]/m.test(testOutput) ||
    /(?:^|\n)\s*(?:code:\s*['"]ERR_ASSERTION['"]|name:\s*['"]AssertionError['"])/m.test(testOutput)
  ) {
    return {
      outcomeClass: "workload_failure" as const,
      failureCategory: "workload",
      failureReason: "Test runner reported a test or assertion failure; OWL Runtime remained available.",
    };
  }

  if (match(/resource_wait_timeout|capacity_busy|\benomem\b|out of memory|no space left|\benospc\b|resource temporarily unavailable/)) {
    return {
      outcomeClass: "resource_pressure" as const,
      failureCategory: "resource_pressure",
      failureReason: "Process failed under local resource or admission pressure.",
    };
  }
  if (match(/\b401\b|\b403\b|unauthori[sz]ed|forbidden|invalid token|authentication failed|credentials? (?:missing|invalid)|permission denied/)) {
    return {
      outcomeClass: "auth" as const,
      failureCategory: "auth",
      failureReason: "External authentication or authorization failed.",
    };
  }
  if (match(/ssl|tls|econnreset|econnrefused|etimedout|enotfound|socket hang up|network error|registry_timeout|handshake failure/)) {
    return {
      outcomeClass: "network" as const,
      failureCategory: "network",
      failureReason: "Network or transport communication failed.",
    };
  }
  if (match(/cloudflare|workers\.dev|\bneon\b|\bvercel\b|\bsupabase\b|\bgithub\b|\baws\b|npm registry|registry\.npmjs\.org/)) {
    return {
      outcomeClass: "external_service" as const,
      failureCategory: "external_service",
      failureReason: "An external service or deployment provider reported the failure.",
    };
  }
  if (match(/playwright|puppeteer|chromium|browser exited|provider unavailable|provider failed/)) {
    return {
      outcomeClass: "provider" as const,
      failureCategory: "provider",
      failureReason: "An execution provider reported the failure.",
    };
  }
  return {
    outcomeClass: "workload_failure" as const,
    failureCategory: "workload",
    failureReason: "The workload exited unsuccessfully; OWL Runtime remained available.",
  };
}

async function persistProcessOutcome(
  record: ManagedProcessRecord,
  exitCode: number | null,
  signal: NodeJS.Signals | null,
) {
  const [stdout, stderr] = await Promise.all([
    readClassificationTail(record.stdoutPath),
    readClassificationTail(record.stderrPath),
  ]);
  const outcome = classifyManagedProcessOutcome({
    command: record.command,
    status: record.status,
    exitCode,
    signal,
    text: `${stdout}\n${stderr}`,
  });
  record.outcomeClass = outcome.outcomeClass;
  record.failureCategory = outcome.failureCategory;
  record.failureReason = outcome.failureReason;
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
    await persistProcessOutcome(record, exitCode, signal);
    await writeManagedProcess(record);
  } finally {
    liveChildren.delete(processId);
    releaseShellConcurrencyPermit(`managed:${processId}`);
    await unpinWorkspaceLeaseForProcess(processId).catch(() => undefined);
  }
}

async function reconcileRecord(
  record: ManagedProcessRecord,
): Promise<ManagedProcessRecord> {
  if (record.status !== "running" && record.status !== "terminating") {
    return record;
  }

  const live = liveChildren.get(record.processId)?.child;

  // For a child owned by this Runtime instance, Node's ChildProcess lifecycle is
  // more authoritative than a point-in-time PID probe. There is a small window
  // after the OS process exits but before the async exit handler persists the
  // durable "exited" record. Treating that window as "lost" creates a false
  // terminal state and can race with markExited().
  if (live) {
    if (live.exitCode !== null || live.signalCode !== null) {
      record.status = "exited";
      record.exitCode = live.exitCode;
      record.signal = live.signalCode as NodeJS.Signals | null;
      record.inputAvailable = false;
      await persistProcessOutcome(
        record,
        live.exitCode,
        live.signalCode as NodeJS.Signals | null,
      );
      await writeManagedProcess(record);
      liveChildren.delete(record.processId);
      releaseShellConcurrencyPermit(`managed:${record.processId}`);
      await unpinWorkspaceLeaseForProcess(record.processId).catch(
        () => undefined,
      );
      return record;
    }

    if (!pidAlive(record.pid)) {
      // The child exit event has not been delivered yet. Keep the durable state
      // non-terminal for this brief transition and let the next observation (or
      // markExited) commit the real exit code/signal.
      return record;
    }

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

  // Re-read before declaring a process lost. A concurrent exit handler may
  // have persisted "exited" after this caller loaded its stale "running"
  // snapshot.
  const latest = await readManagedProcess(record.processId).catch(
    () => record,
  );
  if (
    latest.status !== "running" &&
    latest.status !== "terminating"
  ) {
    return latest;
  }

  latest.status = "lost";
  latest.inputAvailable = false;
  latest.exitCode = latest.exitCode ?? null;
  const lostOutcome = classifyManagedProcessOutcome({
    command: latest.command,
    status: "lost",
    exitCode: latest.exitCode,
    signal: latest.signal ?? null,
  });
  latest.outcomeClass = lostOutcome.outcomeClass;
  latest.failureCategory = lostOutcome.failureCategory;
  latest.failureReason = lostOutcome.failureReason;
  await writeManagedProcess(latest);
  releaseShellConcurrencyPermit(`managed:${latest.processId}`);
  await unpinWorkspaceLeaseForProcess(latest.processId).catch(
    () => undefined,
  );
  return latest;
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
  const workspace = await resolveWorkspace(safeCwd);
  const cancellationSignal = currentCancellationSignal();
  throwIfCancelled(cancellationSignal);
  const concurrencyPermit = await acquireShellConcurrencyPermit({
    id: `exec:${process.pid}:${randomBytes(8).toString("hex")}`,
    workspace,
    kind: "exec",
    command,
  });

  const executionStartedAt = Date.now();
  try {
    const executionResult = await new Promise<{
    command: string;
    cwd: string;
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
  }>((resolve, reject) => {
    const child = spawn(shellBinary(), ["-c", command], {
      cwd: safeCwd,
      env: process.env,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let cancelled = false;
    let cancellationReason: unknown;
    let settled = false;

    const cleanup = () => {
      cancellationSignal?.removeEventListener("abort", onAbort);
    };

    const terminate = () => {
      signalProcessGroup(child, "SIGTERM");
      setTimeout(() => {
        try {
          signalProcessGroup(child, "SIGKILL");
        } catch {
          // Process already exited.
        }
      }, 2_000).unref();
    };

    const onAbort = () => {
      if (settled || cancelled) return;
      cancelled = true;
      cancellationReason = cancellationSignal?.reason;
      terminate();
    };

    child.stdout?.on("data", (chunk) => {
      stdout = appendCapped(stdout, chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr = appendCapped(stderr, chunk);
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });

    cancellationSignal?.addEventListener("abort", onAbort, { once: true });

    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, Math.min(Math.max(timeoutMs, 1_000), 10 * 60_000));

    child.on("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();

      if (cancelled) {
        reject(new OperationCancelledError(cancellationReason));
        return;
      }

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
    return {
      ...executionResult,
      concurrencyWaitMs: concurrencyPermit.waitMs,
      executionDurationMs: Date.now() - executionStartedAt,
    };
  } finally {
    concurrencyPermit.release();
  }
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
  const controlToken = newProcessControlToken();
  const context = currentExecutionContext();
  const concurrencyPermit = await acquireShellConcurrencyPermit({
    id: `managed:${processId}`,
    workspace,
    kind: "managed",
    command,
    waitMs: managedProcessAdmissionWaitMs(),
  });

  const leaseContext =
    workspaceMode === "write" && !context.taskId
      ? { ...context, taskId: `process:${processId}` }
      : context;

  let child: ChildProcess | undefined;
  let permitTransferredToProcess = false;

  try {
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

    try {
      child = spawn(shellBinary(), ["-c", command], {
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
      controlTokenHash: hashProcessControlToken(controlToken),
      startedAt: now,
      updatedAt: now,
      status: "running",
      outcomeClass: "running",
      failureCategory: null,
      failureReason: null,
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

    permitTransferredToProcess = true;
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
      controlToken,
      stdoutPath: record.stdoutPath,
      stderrPath: record.stderrPath,
      concurrencyWaitMs: concurrencyPermit.waitMs,
      durable: true,
    };
  } catch (error) {
    if (child?.pid) {
      try {
        signalProcessGroup(child, "SIGTERM");
      } catch {
        // Best-effort cleanup for a partially initialized child.
      }
    }
    if (workspaceMode === "write" && !context.taskId) {
      await releaseWorkspaceLeasesForTask(`process:${processId}`).catch(
        () => undefined,
      );
    }
    throw error;
  } finally {
    if (!permitTransferredToProcess) concurrencyPermit.release();
  }
}

export async function listProcesses(options: {
  terminalLimit?: number;
  workspace?: string;
  runningOnly?: boolean;
} = {}) {
  const records = await listManagedProcesses();
  const reconciled = await Promise.all(records.map(reconcileRecord));
  const workspace = options.workspace
    ? await resolveWorkspace(options.workspace)
    : null;
  const scoped = workspace
    ? reconciled.filter((record) => record.workspace === workspace)
    : reconciled;

  const running = scoped.filter(
    (record) => record.status === "running" || record.status === "terminating",
  );
  const terminalLimit = Math.min(
    Math.max(
      Math.trunc(
        options.terminalLimit ??
          Number(process.env.OWL_PROCESS_LIST_TERMINAL_LIMIT ?? 40),
      ),
      0,
    ),
    200,
  );
  const selected = options.runningOnly
    ? running
    : [
        ...running,
        ...scoped
          .filter(
            (record) =>
              record.status !== "running" && record.status !== "terminating",
          )
          .slice(0, terminalLimit),
      ].sort((a, b) => b.startedAt.localeCompare(a.startedAt));

  return selected.map((record) => ({
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
    signal: record.signal ?? null,
    outcomeClass:
      record.outcomeClass ??
      (record.status === "running" || record.status === "terminating"
        ? "running"
        : record.status === "lost"
          ? "runtime_failure"
          : record.exitCode === 0
            ? "success"
            : "unknown"),
    failureCategory: record.failureCategory ?? null,
    failureReason: record.failureReason ?? null,
    recoveredAfterRestart: record.recoveredAfterRestart ?? false,
    inputAvailable:
      record.inputAvailable && liveChildren.has(record.processId),
  }));
}

export async function sendProcessInput(
  processId: string,
  input: string,
  controlToken?: string,
) {
  requireCapability("ALLOW_SHELL", false);
  const record = await reconcileRecord(await readManagedProcess(processId));
  assertProcessOwner(record, controlToken);

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

export async function claimRecoveredProcess(
  processId: string,
  controlToken?: string,
) {
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

  const capabilityAuthorized = processControlTokenMatches(
    record,
    controlToken,
  );

  if (!orphanedByRestart && !ownerDisconnected && !capabilityAuthorized) {
    throw new Error(
      "PROCESS_NOT_ORPHANED: claim requires a Runtime-recovered process, a disconnected original transport session, or the process control capability.",
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


export async function observeProcess(
  processId: string,
  tailChars = 20_000,
) {
  const record = await reconcileRecord(await readManagedProcess(processId));
  const [stdout, stderr] = await Promise.all([
    readLogTail(record.stdoutPath, tailChars),
    readLogTail(record.stderrPath, tailChars),
  ]);
  const stdinAttached = Boolean(
    liveChildren.get(processId)?.child.stdin?.writable,
  );
  const assessment = assessManagedProcessState({
    record,
    stdout,
    stderr,
    stdinAttached,
  });

  return createObservation({
    channel: "process",
    provider: "managed-process",
    subject: processId,
    state: assessment.observationState,
    data: {
      processId,
      pid: record.pid,
      command: record.command,
      cwd: record.cwd,
      runtimeState: assessment.state,
      durableStatus: record.status,
      terminal: assessment.terminal,
      confidence: assessment.confidence,
      reason: assessment.reason,
      exitCode: record.exitCode ?? null,
      signal: record.signal ?? null,
      outcomeClass: record.outcomeClass ?? null,
      failureCategory: record.failureCategory ?? null,
      failureReason: record.failureReason ?? null,
      inputAvailable: stdinAttached,
      recoveredAfterRestart: record.recoveredAfterRestart ?? false,
      stdout,
      stderr,
    },
    evidence: [
      ...(stdout ? [{ kind: "stdout" as const, ref: record.stdoutPath }] : []),
      ...(stderr ? [{ kind: "stderr" as const, ref: record.stderrPath }] : []),
      ...(record.status === "exited"
        ? [{
            kind: "exit_code" as const,
            metadata: { exitCode: record.exitCode ?? null, signal: record.signal ?? null },
          }]
        : []),
    ],
    metadata: {
      workspace: record.workspace,
      workspaceMode: record.workspaceMode,
      ownerSessionId: record.ownerSessionId,
      ownerTaskId: record.ownerTaskId ?? null,
    },
  });
}

export async function waitForProcessState(
  processId: string,
  options: {
    states?: ObservationState[];
    timeoutMs?: number;
    pollMs?: number;
    tailChars?: number;
  } = {},
) {
  const targets = new Set<ObservationState>(
    options.states?.length
      ? options.states
      : ["waiting_input", "finished", "failed", "lost"],
  );
  const timeoutMs = Math.min(Math.max(Math.trunc(options.timeoutMs ?? 30_000), 0), 60_000);
  const pollMs = Math.min(Math.max(Math.trunc(options.pollMs ?? 250), 100), 5_000);
  const deadline = Date.now() + timeoutMs;
  let observation = await observeProcess(processId, options.tailChars ?? 20_000);

  while (
    !targets.has(observation.state) &&
    !["finished", "failed", "lost"].includes(observation.state) &&
    Date.now() < deadline
  ) {
    await cancellableSleep(pollMs);
    observation = await observeProcess(processId, options.tailChars ?? 20_000);
  }

  return {
    matched: targets.has(observation.state),
    timedOut: !targets.has(observation.state) && Date.now() >= deadline,
    targetStates: [...targets],
    observation,
  };
}

export async function interactWithManagedProcess(
  processId: string,
  input: string,
  options: {
    timeoutMs?: number;
    pollMs?: number;
    tailChars?: number;
    controlToken?: string;
  } = {},
) {
  const tailChars = options.tailChars ?? 20_000;
  const before = await observeProcess(processId, tailChars);
  const beforeData = before.data as Record<string, unknown>;
  const beforeStdout =
    typeof beforeData.stdout === "string" ? beforeData.stdout : "";
  const beforeStderr =
    typeof beforeData.stderr === "string" ? beforeData.stderr : "";

  const write = await sendProcessInput(
    processId,
    input,
    options.controlToken,
  );

  const timeoutMs = Math.min(
    Math.max(Math.trunc(options.timeoutMs ?? 8_000), 0),
    60_000,
  );
  const pollMs = Math.min(
    Math.max(Math.trunc(options.pollMs ?? 250), 100),
    5_000,
  );
  const deadline = Date.now() + timeoutMs;

  let observation = await observeProcess(processId, tailChars);
  let matched = false;

  while (true) {
    const terminal = ["finished", "failed", "lost"].includes(
      observation.state,
    );
    const data = observation.data as Record<string, unknown>;
    const stdout = typeof data.stdout === "string" ? data.stdout : "";
    const stderr = typeof data.stderr === "string" ? data.stderr : "";
    const outputChanged =
      stdout !== beforeStdout || stderr !== beforeStderr;
    const newPrompt =
      observation.state === "waiting_input" && outputChanged;

    if (terminal || newPrompt) {
      matched = true;
      break;
    }
    if (Date.now() >= deadline) break;

    await cancellableSleep(pollMs);
    observation = await observeProcess(processId, tailChars);
  }

  return {
    write,
    matched,
    timedOut: !matched && Date.now() >= deadline,
    targetStates: ["waiting_input", "finished", "failed", "lost"],
    observation,
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
  controlToken?: string,
) {
  requireCapability("ALLOW_SHELL", false);
  const record = await reconcileRecord(await readManagedProcess(processId));
  assertProcessOwner(record, controlToken);

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
    sent = signalProcessGroup(live.child, signal);
  } else {
    try {
      if (process.platform !== "win32") {
        process.kill(-record.pid, signal);
      } else {
        process.kill(record.pid, signal);
      }
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
