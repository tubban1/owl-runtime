import { runtimeStatePath } from "../runtime/runtimePaths.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { assertAllowedExistingPath } from "../security/pathGuard.js";
import { requireCapability } from "../security/capabilities.js";
import { currentExecutionContext } from "../runtime/executionContext.js";
import { injectTestFault } from "../runtime/faultInjection.js";
import {
  ensureWorkspaceWriteLease,
  releaseWorkspaceLeasesForTask,
} from "../runtime/workspaceLeaseManager.js";

export type TransactionState = "active" | "completed" | "rolled_back";

export interface TransactionMetadata {
  id: string;
  label: string;
  repoRoot: string;
  branch: string | null;
  originalHead: string;
  checkpointSha: string;
  checkpointRef: string;
  createdAt: string;
  ownerSessionId?: string;
  ownerTaskId?: string;
  state: TransactionState;
  originalStatus: string;
  stagedPatchFile: string;
  completedAt?: string;
  rolledBackAt?: string;
  safetyRef?: string;
  checkpointRetained?: boolean;
}

function transactionDir(): string {
  return process.env.TRANSACTION_DIR?.trim() || runtimeStatePath("transactions");
}

function metadataPath(id: string): string {
  return path.join(transactionDir(), `${id}.json`);
}

function stagedPatchPath(id: string): string {
  return path.join(transactionDir(), `${id}.staged.patch`);
}

async function runGit(
  cwd: string,
  args: string[],
  options?: { env?: NodeJS.ProcessEnv; stdin?: string; allowFailure?: boolean },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return await new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", cwd, "-c", "core.hooksPath=/dev/null", ...args], {
      env: { ...process.env, ...(options?.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      const exitCode = code ?? 1;
      if (exitCode !== 0 && !options?.allowFailure) {
        reject(new Error(stderr.trim() || stdout.trim() || `git ${args.join(" ")} failed`));
        return;
      }
      resolve({ stdout, stderr, exitCode });
    });

    child.stdin.end(options?.stdin ?? "");
  });
}

async function resolveRepoRoot(cwd: string): Promise<string> {
  const safeCwd = await assertAllowedExistingPath(cwd);
  const result = await runGit(safeCwd, ["rev-parse", "--show-toplevel"]);
  return await assertAllowedExistingPath(result.stdout.trim());
}

async function currentBranch(repoRoot: string): Promise<string | null> {
  const result = await runGit(repoRoot, ["symbolic-ref", "--short", "-q", "HEAD"], {
    allowFailure: true,
  });
  return result.exitCode === 0 ? result.stdout.trim() : null;
}

async function readTransaction(id: string): Promise<TransactionMetadata> {
  const text = await fs.readFile(metadataPath(id), "utf8");
  return JSON.parse(text) as TransactionMetadata;
}

async function atomicWriteText(
  target: string,
  content: string,
  faultPoint?: string,
): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, content, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    if (faultPoint) injectTestFault(faultPoint);
    await fs.rename(temp, target);
    await fs.chmod(target, 0o600).catch(() => undefined);
  } finally {
    await fs.rm(temp, { force: true }).catch(() => undefined);
  }
}

async function writeTransaction(metadata: TransactionMetadata): Promise<void> {
  await atomicWriteText(
    metadataPath(metadata.id),
    JSON.stringify(metadata, null, 2) + "\n",
    "git.transaction.after_metadata_temp_before_commit",
  );
}

function transactionId(): string {
  return `tx_${Date.now().toString(36)}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

export async function beginTransaction(cwd: string, label = "computer-mcp task") {
  requireCapability("ALLOW_WRITE", true);

  const repoRoot = await resolveRepoRoot(cwd);
  const context = currentExecutionContext();
  const id = transactionId();
  const transactionContext = {
    ...context,
    taskId: `transaction:${id}`,
  };
  await ensureWorkspaceWriteLease(repoRoot, {
    context: transactionContext,
    purpose: `Git transaction: ${label}`,
    auto: true,
  });
  const originalHeadResult = await runGit(repoRoot, ["rev-parse", "HEAD"], { allowFailure: true });
  if (originalHeadResult.exitCode !== 0) {
    throw new Error("Transactions currently require a Git repository with at least one commit.");
  }

  const originalHead = originalHeadResult.stdout.trim();
  const branch = await currentBranch(repoRoot);
  const checkpointRef = `refs/computer-mcp/checkpoints/${id}`;
  const tempIndex = path.join(os.tmpdir(), `computer-mcp-index-${randomUUID()}`);
  const alternateIndexEnv = { GIT_INDEX_FILE: tempIndex };

  await fs.mkdir(transactionDir(), { recursive: true });

  try {
    await runGit(repoRoot, ["read-tree", "HEAD"], { env: alternateIndexEnv });
    await runGit(repoRoot, ["add", "-A"], { env: alternateIndexEnv });
    const tree = (await runGit(repoRoot, ["write-tree"], { env: alternateIndexEnv })).stdout.trim();
    const checkpointSha = (
      await runGit(repoRoot, [
        "commit-tree",
        tree,
        "-p",
        originalHead,
        "-m",
        `computer-mcp checkpoint: ${label}`,
      ])
    ).stdout.trim();

    await runGit(repoRoot, ["update-ref", checkpointRef, checkpointSha]);

    const stagedPatch = (await runGit(repoRoot, ["diff", "--cached", "--binary", "HEAD"])).stdout;
    const stagedFile = stagedPatchPath(id);
    await atomicWriteText(stagedFile, stagedPatch);

    const originalStatus = (await runGit(repoRoot, ["status", "--short", "--branch"])).stdout;

    const metadata: TransactionMetadata = {
      id,
      label,
      repoRoot,
      branch,
      originalHead,
      checkpointSha,
      checkpointRef,
      createdAt: new Date().toISOString(),
      ownerSessionId: context.sessionId,
      ...(context.taskId ? { ownerTaskId: context.taskId } : {}),
      state: "active",
      originalStatus,
      stagedPatchFile: stagedFile,
    };

    await writeTransaction(metadata);
    injectTestFault("git.transaction.after_active_receipt");

    return {
      id,
      label,
      repoRoot,
      branch,
      originalHead,
      checkpointSha,
      checkpointRef,
      state: metadata.state,
      originalStatus,
    };
  } finally {
    await fs.rm(tempIndex, { force: true }).catch(() => undefined);
  }
}

export async function getTransactionStatus(id: string) {
  const metadata = await readTransaction(id);
  const repoRoot = await assertAllowedExistingPath(metadata.repoRoot);
  const currentHead = (await runGit(repoRoot, ["rev-parse", "HEAD"])).stdout.trim();
  const branch = await currentBranch(repoRoot);
  const status = (await runGit(repoRoot, ["status", "--short", "--branch"])).stdout;
  const diffStat = (
    await runGit(repoRoot, ["diff", "--stat", metadata.checkpointSha, "--"])
  ).stdout;

  return {
    ...metadata,
    currentHead,
    currentBranch: branch,
    status,
    diffStat,
  };
}

export async function listTransactions(repoPath?: string) {
  let files: string[];
  try {
    files = await fs.readdir(transactionDir());
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return [];
    throw error;
  }

  const repoRoot = repoPath ? await resolveRepoRoot(repoPath) : null;
  const items: TransactionMetadata[] = [];

  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    try {
      const metadata = JSON.parse(
        await fs.readFile(path.join(transactionDir(), file), "utf8"),
      ) as TransactionMetadata;
      if (!repoRoot || metadata.repoRoot === repoRoot) items.push(metadata);
    } catch {
      // Skip malformed or stale metadata.
    }
  }

  return items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function rollbackTransaction(id: string) {
  requireCapability("ALLOW_ROLLBACK", false);

  const metadata = await readTransaction(id);
  await ensureWorkspaceWriteLease(metadata.repoRoot, {
    context: {
      ...currentExecutionContext(),
      taskId: `transaction:${id}`,
    },
    purpose: `Rollback transaction ${id}`,
    auto: true,
  });

  if (metadata.state === "rolled_back") {
    await releaseWorkspaceLeasesForTask(`transaction:${id}`);
    return {
      id,
      state: metadata.state,
      repoRoot: metadata.repoRoot,
      restoredHead: metadata.originalHead,
      safetyRef: metadata.safetyRef ?? null,
      recovered: true,
      status: (
        await runGit(metadata.repoRoot, ["status", "--short", "--branch"])
      ).stdout,
      note: "Rollback receipt already committed; lease cleanup was reconciled.",
    };
  }
  if (metadata.state !== "active") {
    throw new Error(
      `Transaction ${id} is ${metadata.state}; only active transactions can be rolled back.`,
    );
  }

  const repoRoot = await assertAllowedExistingPath(metadata.repoRoot);
  const branch = await currentBranch(repoRoot);
  if (branch !== metadata.branch) {
    throw new Error(
      `Refusing rollback because the current branch changed from ${metadata.branch ?? "(detached)"} to ${branch ?? "(detached)"}.`,
    );
  }

  const currentHead = (await runGit(repoRoot, ["rev-parse", "HEAD"])).stdout.trim();
  const safetyRef = `refs/computer-mcp/pre-rollback/${id}-${Date.now()}`;
  await runGit(repoRoot, ["update-ref", safetyRef, currentHead]);

  // Restore the complete checkpoint tree, remove new untracked non-ignored files,
  // then move the branch back to its original HEAD while leaving checkpoint
  // contents in the worktree.
  await runGit(repoRoot, ["reset", "--hard", metadata.checkpointSha]);
  await runGit(repoRoot, ["clean", "-fd"]);
  await runGit(repoRoot, ["reset", "--mixed", metadata.originalHead]);

  const stagedPatch = await fs.readFile(metadata.stagedPatchFile, "utf8").catch(() => "");
  if (stagedPatch.trim()) {
    await runGit(repoRoot, ["apply", "--cached", "--binary", "-"], { stdin: stagedPatch });
  }

  metadata.state = "rolled_back";
  metadata.rolledBackAt = new Date().toISOString();
  metadata.safetyRef = safetyRef;
  await writeTransaction(metadata);
  injectTestFault("git.transaction.after_rollback_receipt_before_lease_release");
  await releaseWorkspaceLeasesForTask(`transaction:${id}`);

  return {
    id,
    state: metadata.state,
    repoRoot,
    restoredHead: metadata.originalHead,
    safetyRef,
    recovered: false,
    status: (await runGit(repoRoot, ["status", "--short", "--branch"])).stdout,
    note: "Ignored files and external/network side effects are not rolled back.",
  };
}

export async function completeTransaction(id: string, keepCheckpoint = false) {
  const metadata = await readTransaction(id);
  await ensureWorkspaceWriteLease(metadata.repoRoot, {
    context: {
      ...currentExecutionContext(),
      taskId: `transaction:${id}`,
    },
    purpose: `Complete transaction ${id}`,
    auto: true,
  });

  const repoRoot = await assertAllowedExistingPath(metadata.repoRoot);

  if (metadata.state === "completed") {
    const retained = metadata.checkpointRetained === true;
    if (!retained) {
      await runGit(repoRoot, ["update-ref", "-d", metadata.checkpointRef], {
        allowFailure: true,
      });
    }
    await releaseWorkspaceLeasesForTask(`transaction:${id}`);
    return {
      id,
      state: metadata.state,
      keepCheckpoint: retained,
      checkpointRef: retained ? metadata.checkpointRef : null,
      recovered: true,
    };
  }
  if (metadata.state !== "active") {
    throw new Error(`Transaction ${id} is already ${metadata.state}.`);
  }

  // Commit the durable completion receipt before deleting the optional
  // checkpoint ref. A crash after this point can safely replay cleanup.
  metadata.state = "completed";
  metadata.completedAt = new Date().toISOString();
  metadata.checkpointRetained = keepCheckpoint;
  await writeTransaction(metadata);
  injectTestFault("git.transaction.after_complete_receipt_before_ref_cleanup");

  if (!keepCheckpoint) {
    await runGit(repoRoot, ["update-ref", "-d", metadata.checkpointRef], {
      allowFailure: true,
    });
  }
  await releaseWorkspaceLeasesForTask(`transaction:${id}`);

  return {
    id,
    state: metadata.state,
    keepCheckpoint,
    checkpointRef: keepCheckpoint ? metadata.checkpointRef : null,
    recovered: false,
  };
}
