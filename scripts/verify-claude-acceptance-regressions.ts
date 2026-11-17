import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratch = path.join(root, ".tmp-verify-claude-acceptance");
await fs.rm(scratch, { recursive: true, force: true });
await fs.mkdir(scratch, { recursive: true });

process.env.OWL_RUNTIME_MODE = "test";
process.env.OWL_STATE_ROOT = path.join(scratch, "runtime-state");
process.env.OWL_RESOURCE_TEST_PRESSURE_MODE = "normal";
process.env.OWL_RESOURCE_TEST_PARALLELISM = "8";
process.env.ALLOW_WRITE = "true";
process.env.ALLOW_SHELL = "true";
process.env.ALLOWED_DIRECTORIES = root;
process.env.PROCESS_STATE_DIR = path.join(scratch, "processes");
process.env.PROCESS_STATE_KEY_PATH = path.join(scratch, "process.key");
process.env.PROCESS_LOG_DIR = path.join(scratch, "logs");

const { withExecutionContext, systemExecutionContext } = await import("../src/runtime/executionContext.js");
const { startProcess, listProcesses, getProcessOutput, observeProcess, claimRecoveredProcess, killProcess } = await import("../src/tools/shellOps.js");
const { gitAdd, gitCommit } = await import("../src/tools/gitOps.js");
const { assertAllowedExistingPath, assertAllowedTargetPath } = await import("../src/security/pathGuard.js");
const { validateRoutedAction } = await import("../src/router/actionRouter.js");

const ownerA = { sessionId: "owl-workstream:test-owner-A", requestId: "acceptance-A", origin: "mcp" as const };
const ownerB = { sessionId: "owl-workstream:test-owner-B", requestId: "acceptance-B", origin: "mcp" as const };
let processId: string | null = null;

try {
  // Windows formerly reported exit=0 with stdout length=0 when detached:true.
  const started = await withExecutionContext(ownerA, () => startProcess("node --version", scratch, "read"));
  processId = started.processId;
  assert.ok(started.controlToken.length > 32, "Internal recovery capability still exists");
  let output = await withExecutionContext(ownerA, () => getProcessOutput(started.processId));
  const deadline = Date.now() + 10_000;
  while (output.status !== "exited" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    output = await withExecutionContext(ownerA, () => getProcessOutput(started.processId));
  }
  assert.equal(output.status, "exited");
  assert.equal(output.exitCode, 0);
  assert.match(output.stdout, /v\d+\.\d+\.\d+/);
  await assert.rejects(
    () => assertAllowedExistingPath(path.join(scratch, "processes")),
    /runtime process state is private/,
  );
  await assert.rejects(
    () => assertAllowedTargetPath(path.join(scratch, "logs", "probe.txt")),
    /runtime process state is private/,
  );
  await assert.rejects(
    () => assertAllowedExistingPath(path.join(scratch, "process.key")),
    /runtime process state is private/,
  );
  const routedGit = validateRoutedAction("git.commit", {
    cwd: scratch, message: "test", author_name: "OWL LAB QA Agent",
    author_email: "owl-qa@users.noreply.github.com",
  });
  assert.equal((routedGit.args as any).author_name, "OWL LAB QA Agent");
  assert.throws(() => validateRoutedAction("git.commit", {
    cwd: scratch, message: "test", author_name: "Missing email",
  }));
  const routedStart = validateRoutedAction("shell.start", {
    command: "node --version", cwd: scratch, include_control_token: true,
  });
  assert.equal((routedStart.args as any).include_control_token, true);
  const listedA = await withExecutionContext(ownerA, () => listProcesses());
  assert.ok(listedA.some((p) => p.processId === started.processId));
  const listedB = await withExecutionContext(ownerB, () => listProcesses());
  assert.ok(listedB.every((p) => p.processId !== started.processId));
  await assert.rejects(
    () => withExecutionContext(ownerB, () => getProcessOutput(started.processId)),
    /PROCESS_OWNED/,
  );
  await assert.rejects(
    () => withExecutionContext(ownerB, () => observeProcess(started.processId)),
    /PROCESS_OWNED/,
  );
  const listedSystem = await withExecutionContext(systemExecutionContext(), () => listProcesses());
  assert.ok(listedSystem.some((p) => p.processId === started.processId));

  // An unrelated session must not claim an abandoned or recovered process
  // without a bearer token. A terminal process must never be claimable either.
  await assert.rejects(
    () => withExecutionContext(ownerB, () => claimRecoveredProcess(started.processId)),
    /Only a recovered running process|PROCESS_NOT_ORPHANED/,
  );

  const repo = path.join(scratch, "git-test");
  await fs.mkdir(repo);
  const init = spawnSync("git", ["init", "-q", repo], { encoding: "utf8" });
  assert.equal(init.status, 0, init.stderr);
  await fs.writeFile(path.join(repo, "README.md"), "Claude acceptance git identity\n");
  const add = await gitAdd(repo, ["README.md"]);
  assert.equal(add.exitCode, 0, add.stderr);
  const commit = await gitCommit(repo, "test: per-call author without global config", {
    name: "OWL LAB QA Agent",
    email: "owl-qa@users.noreply.github.com",
  });
  assert.equal(commit.exitCode, 0, commit.stderr);
  const log = spawnSync("git", ["-C", repo, "show", "-s", "--format=%an|%ae|%cn|%ce"], { encoding: "utf8" });
  assert.equal(log.status, 0, log.stderr);
  assert.equal(log.stdout.trim(), "OWL LAB QA Agent|owl-qa@users.noreply.github.com|OWL LAB QA Agent|owl-qa@users.noreply.github.com");
  const localName = spawnSync("git", ["-C", repo, "config", "--local", "--get", "user.name"], { encoding: "utf8" });
  assert.equal(localName.status, 1, "Per-call author must not persist in repo config");
  await assert.rejects(
    () => gitCommit(repo, "bad identity", { name: "injected\nname", email: "a@example.org" }),
    /GIT_AUTHOR_IDENTITY_INVALID/,
  );

  console.log(JSON.stringify({
    ok: true, platform: process.platform, processStdoutCaptured: true,
    processCrossOwnerListDenied: true, processCrossOwnerOutputDenied: true,
    perInvocationGitAuthor: true, noLocalGitConfigMutation: true,
    processPrivateStateGuarded: true, processControlCapabilityOptInSchema: true,
  }));
} finally {
  if (processId) {
    try {
      await withExecutionContext(systemExecutionContext(), async () => {
        await killProcess(processId!, "SIGKILL");
      });
    } catch { /* already exited */ }
  }
  await fs.rm(scratch, { recursive: true, force: true });
}
