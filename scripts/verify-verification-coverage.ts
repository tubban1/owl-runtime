import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratch = path.join(root, ".tmp-verify-verification-coverage");
const repo = path.join(scratch, "repo");
await fs.rm(scratch, { recursive: true, force: true });
await fs.mkdir(repo, { recursive: true });

process.env.OWL_STATE_ROOT = path.join(scratch, "state");
process.env.ALLOWED_DIRECTORIES = scratch;
process.env.ALLOW_WRITE = "true";
process.env.ALLOW_DELETE = "true";
process.env.ALLOW_SHELL = "true";
process.env.ALLOW_GIT_PUSH = "true";
process.env.OWL_APPROVAL_MODE = "compat";

const { executeRoutedAction, getRouterCatalog } = await import(
  "../src/router/actionRouter.js"
);
const { getActionContract } = await import("../src/runtime/actionContracts.js");
const { createObservation } = await import(
  "../src/observation/observationAbi.js"
);
const { defaultVerificationForAction } = await import(
  "../src/observation/actionObservation.js"
);
const {
  createPersistentTask,
  getPersistentTaskStatus,
  runPersistentTask,
} = await import("../src/tasks/taskRuntime.js");

function git(args: string[]) {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    env: process.env,
  });
}

try {
  // Coverage invariant: every action contract that requires verification must
  // have a default receipt path. The receipt may be verified, failed or
  // uncertain, but it must never silently fall back to null.
  const verificationRequiredActions = getRouterCatalog()
    .filter((entry) => entry.contract.requiresVerification)
    .map((entry) => entry.action)
    .sort();
  const syntheticObservation = createObservation({
    channel: "environment",
    provider: "verification-coverage",
    state: "unknown",
    data: {},
    evidence: [{ kind: "system" }],
  });
  const missingDefaultReceipts = verificationRequiredActions.filter(
    (action) =>
      !defaultVerificationForAction(
        action,
        {},
        {},
        syntheticObservation,
      ),
  );
  assert.deepEqual(
    missingDefaultReceipts,
    [],
    `Verification-required actions without a default receipt: ${missingDefaultReceipts.join(", ")}`,
  );

  // Filesystem writes must be re-read from disk and content-identified.
  const fileA = path.join(scratch, "content.txt");
  const write = await executeRoutedAction("fs.write", {
    path: fileA,
    content: "alpha",
    overwrite: true,
    create_parents: true,
  });
  assert.equal(write.verification?.status, "verified");
  assert.equal(write.verification?.specId, "default:fs.write");
  assert.equal(
    (write.observation?.data as any).sha256,
    (write.result as any).contentSha256,
  );

  const append = await executeRoutedAction("fs.append", {
    path: fileA,
    content: " beta",
  });
  assert.equal(append.verification?.status, "verified");
  assert.equal(
    (append.observation?.data as any).sha256,
    (append.result as any).contentSha256,
  );

  const edit = await executeRoutedAction("fs.edit", {
    path: fileA,
    old_text: "beta",
    new_text: "gamma",
    replace_all: false,
  });
  assert.equal(edit.verification?.status, "verified");
  assert.equal(
    (edit.observation?.data as any).sha256,
    (edit.result as any).contentSha256,
  );

  const copyPath = path.join(scratch, "copy.txt");
  const copied = await executeRoutedAction("fs.copy", {
    source_path: fileA,
    destination_path: copyPath,
    recursive: true,
  });
  assert.equal(copied.verification?.status, "verified");
  assert.equal(
    (copied.observation?.data as any).copyDigestMatches,
    true,
  );

  const movedPath = path.join(scratch, "moved.txt");
  const moved = await executeRoutedAction("fs.move", {
    source_path: copyPath,
    destination_path: movedPath,
  });
  assert.equal(moved.verification?.status, "verified");
  assert.equal((moved.observation?.data as any).source.exists, false);

  const batchA = path.join(scratch, "batch-a.txt");
  const batchB = path.join(scratch, "batch-b.txt");
  await fs.writeFile(batchA, "alpha one\n", "utf8");
  await fs.writeFile(batchB, "beta one\n", "utf8");
  const batch = await executeRoutedAction("fs.batch_edit", {
    edits: [
      {
        path: batchA,
        old_text: "one",
        new_text: "two",
        replace_all: false,
      },
      {
        path: batchB,
        old_text: "one",
        new_text: "three",
        replace_all: false,
      },
    ],
  });
  assert.equal(batch.verification?.status, "verified");
  assert.equal((batch.observation?.data as any).allDigestsMatch, true);

  // Git mutation contracts now require post-action verification.
  execFileSync("git", ["init", repo], { stdio: "ignore" });
  git(["config", "user.name", "OWL Verification"]);
  git(["config", "user.email", "verification@owl.local"]);
  const tracked = path.join(repo, "tracked.txt");
  await fs.writeFile(tracked, "one\n", "utf8");

  for (const action of ["git.add", "git.commit", "git.patch"]) {
    assert.equal(
      getActionContract(action, { cwd: repo }).requiresVerification,
      true,
      action,
    );
  }

  const add = await executeRoutedAction("git.add", {
    cwd: repo,
    paths: ["tracked.txt"],
  });
  assert.equal(add.observation?.provider, "git");
  assert.equal(add.verification?.status, "verified");
  assert.equal(add.verification?.specId, "default:git.add");

  const commit = await executeRoutedAction("git.commit", {
    cwd: repo,
    message: "verification baseline",
  });
  assert.equal(commit.verification?.status, "verified");
  assert.equal(commit.verification?.specId, "default:git.commit");
  assert.match((commit.observation?.data as any).head, /verification baseline/);

  const patch = [
    "--- a/tracked.txt",
    "+++ b/tracked.txt",
    "@@ -1 +1 @@",
    "-one",
    "+two",
    "",
  ].join("\n");
  const patched = await executeRoutedAction("git.patch", {
    cwd: repo,
    patch,
  });
  assert.equal(patched.verification?.status, "verified");
  assert.equal(patched.verification?.specId, "default:git.patch");
  assert.equal((patched.observation?.data as any).postMutationVisible, true);
  assert.equal(await fs.readFile(tracked, "utf8"), "two\n");

  await executeRoutedAction("git.add", {
    cwd: repo,
    paths: ["tracked.txt"],
  });
  const patchCommit = await executeRoutedAction("git.commit", {
    cwd: repo,
    message: "apply verified patch",
  });
  assert.equal(patchCommit.verification?.status, "verified");

  // Remote Git effects remain fail-closed unless the remote state is
  // independently observed. Use a local bare remote so the gate is hermetic.
  const bareRemote = path.join(scratch, "remote.git");
  execFileSync("git", ["init", "--bare", bareRemote], { stdio: "ignore" });
  git(["remote", "add", "origin", bareRemote]);
  const branch = git(["branch", "--show-current"]).trim();

  const push = await executeRoutedAction("git.push", {
    cwd: repo,
    remote: "origin",
    branch,
  });
  assert.equal((push.result as any).exitCode, 0);
  assert.equal(push.observation?.provider, "git");
  assert.equal(push.verification?.status, "uncertain");
  assert.equal(push.verification?.specId, "default:git.push");

  const remoteWriter = path.join(scratch, "remote-writer");
  execFileSync("git", ["clone", bareRemote, remoteWriter], {
    stdio: "ignore",
  });
  execFileSync("git", ["-C", remoteWriter, "config", "user.name", "OWL Remote"]);
  execFileSync("git", [
    "-C",
    remoteWriter,
    "config",
    "user.email",
    "remote@owl.local",
  ]);
  await fs.writeFile(
    path.join(remoteWriter, "tracked.txt"),
    "three\n",
    "utf8",
  );
  execFileSync("git", ["-C", remoteWriter, "add", "tracked.txt"]);
  execFileSync("git", [
    "-C",
    remoteWriter,
    "commit",
    "-m",
    "remote verified change",
  ]);
  execFileSync("git", ["-C", remoteWriter, "push", "origin", branch]);

  const pull = await executeRoutedAction("git.pull", {
    cwd: repo,
    remote: "origin",
    branch,
  });
  assert.equal((pull.result as any).exitCode, 0);
  assert.equal(pull.verification?.status, "verified");
  assert.equal(pull.verification?.specId, "default:git.pull");
  assert.match((pull.observation?.data as any).head, /remote verified change/);
  assert.equal(await fs.readFile(tracked, "utf8"), "three\n");

  // shell.start has a deterministic action-level postcondition: the durable
  // process can be re-observed as running.
  const started = await executeRoutedAction("shell.start", {
    command: "sleep 30",
    cwd: scratch,
    workspace_mode: "read",
  });
  assert.equal(started.observation?.channel, "process");
  assert.equal(started.observation?.state, "running");
  assert.equal(started.verification?.status, "verified");
  assert.equal(started.verification?.specId, "default:shell.start");
  const startedResult = started.result as any;
  await executeRoutedAction("shell.kill", {
    process_id: startedResult.processId,
    signal: "SIGTERM",
    control_token: startedResult.controlToken,
  });

  // A generic shell command may have arbitrary external side effects. Exit 0
  // proves execution completion, not the intended business outcome.
  const genericShell = await executeRoutedAction("shell.exec", {
    command: "printf shell-ok",
    cwd: scratch,
    timeout_ms: 10_000,
    workspace_mode: "read",
  });
  assert.equal(genericShell.observation?.state, "finished");
  assert.equal(genericShell.verification?.status, "uncertain");
  assert.equal(genericShell.verification?.specId, "default:shell.exec");

  const failedShell = await executeRoutedAction("shell.exec", {
    command: "exit 7",
    cwd: scratch,
    timeout_ms: 10_000,
    workspace_mode: "read",
  });
  assert.equal(failedShell.observation?.state, "failed");
  assert.equal(failedShell.verification?.status, "failed");

  // Durable Task without a semantic shell postcondition fails closed.
  const genericTask = await createPersistentTask(
    "generic shell must not self-certify",
    [
      {
        id: "shell",
        action: "shell.exec",
        args: {
          command: "printf generic-task",
          cwd: scratch,
          timeout_ms: 10_000,
          workspace_mode: "read",
        },
      },
    ],
    { maxConcurrency: 1, failFast: true },
  );
  const genericRun = await runPersistentTask(genericTask.id, {
    maxConcurrency: 1,
    maxWaves: 5,
    timeBudgetMs: 30_000,
  });
  assert.equal(genericRun.status, "blocked");
  const genericStatus = await getPersistentTaskStatus(genericTask.id, true);
  assert.equal(genericStatus.steps[0]?.state, "needs_review");
  assert.equal(genericStatus.steps[0]?.verification?.status, "uncertain");

  // The same shell action becomes autonomous only when the Task states the
  // intended postcondition explicitly.
  const verifiedTask = await createPersistentTask(
    "shell with explicit semantic postcondition",
    [
      {
        id: "shell",
        action: "shell.exec",
        args: {
          command: "printf verified-task",
          cwd: scratch,
          timeout_ms: 10_000,
          workspace_mode: "read",
        },
        verify: {
          id: "shell-output-confirmed",
          description:
            "The command must finish and emit the expected deterministic marker.",
          expectations: [
            {
              path: "state",
              operator: "equals",
              expected: "finished",
            },
            {
              path: "data.stdout",
              operator: "contains",
              expected: "verified-task",
            },
          ],
        },
      },
    ],
    { maxConcurrency: 1, failFast: true },
  );
  const verifiedRun = await runPersistentTask(verifiedTask.id, {
    maxConcurrency: 1,
    maxWaves: 5,
    timeBudgetMs: 30_000,
  });
  assert.equal(verifiedRun.status, "completed");
  const verifiedStatus = await getPersistentTaskStatus(
    verifiedTask.id,
    true,
  );
  assert.equal(verifiedStatus.steps[0]?.state, "succeeded");
  assert.equal(verifiedStatus.steps[0]?.verification?.status, "verified");
  assert.equal(
    verifiedStatus.steps[0]?.verification?.specId,
    "shell-output-confirmed",
  );

  console.log(
    JSON.stringify(
      {
        ok: true,
        coverageInvariant: {
          verificationRequiredActions,
          missingDefaultReceipts: [],
        },
        filesystem: {
          writeDigest: true,
          appendDigest: true,
          editDigest: true,
          batchEditDigest: true,
          copyDigest: true,
          moveSourceAbsence: true,
        },
        git: {
          mutationsRequireVerification: true,
          addReobserved: true,
          commitHeadReobserved: true,
          patchStateReobserved: true,
          pushFailsClosedWithoutRemoteRefVerification: true,
          pullLocalHeadReobserved: true,
        },
        shell: {
          startProcessReobserved: true,
          genericSuccessFailsClosedAsUncertain: true,
          nonZeroExitFailsVerification: true,
          durableTaskWithoutPostconditionNeedsReview: true,
          explicitPostconditionCompletes: true,
        },
      },
      null,
      2,
    ),
  );
} finally {
  await fs.rm(scratch, { recursive: true, force: true });
}
