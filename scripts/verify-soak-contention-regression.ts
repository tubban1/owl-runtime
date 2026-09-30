import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "owl-soak-contention-"));
const repo = path.join(scratch, "repo");
await fs.mkdir(path.join(repo, ".git"), { recursive: true });

process.env.OWL_RUNTIME_MODE = "test";
process.env.OWL_STATE_ROOT = path.join(scratch, "state");
process.env.WORKSPACE_LEASE_DIR = path.join(scratch, "state", "workspace-leases");
process.env.ALLOWED_DIRECTORIES = scratch;
process.env.ALLOW_WRITE = "true";

const { withExecutionContext } = await import("../src/runtime/executionContext.js");
const { runtimeSessionManager } = await import("../src/runtime/runtimeSessionManager.js");
const { executeRoutedAction } = await import("../src/router/actionRouter.js");
const {
  ensureWorkspaceWriteLease,
  releaseWorkspaceLease,
} = await import("../src/runtime/workspaceLeaseManager.js");

const sessionA = {
  sessionId: "soak-regression-A",
  requestId: "soak-regression-request-A",
  origin: "mcp" as const,
};
const sessionB = {
  sessionId: "soak-regression-B",
  requestId: "soak-regression-request-B",
  origin: "mcp" as const,
};
runtimeSessionManager.register(sessionA.sessionId);
runtimeSessionManager.register(sessionB.sessionId);

const realDateNow = Date.now;
try {
  const lease = await withExecutionContext(sessionA, async () =>
    await ensureWorkspaceWriteLease(repo, {
      purpose: "24h soak contention regression",
      ttlMs: 24 * 60 * 60_000,
    }),
  );
  assert.equal(lease.ownerSessionId, sessionA.sessionId);

  // Reproduce the condition that made rc.4 flaky without actually waiting:
  // simulate a one-minute machine/scheduler pause between lease acquisition and
  // the competing write. The old 10s soak lease would have expired here.
  const acquiredWallClock = realDateNow();
  Date.now = () => acquiredWallClock + 60_000;
  await assert.rejects(
    () =>
      withExecutionContext(sessionB, async () =>
        await executeRoutedAction("fs.write", {
          path: path.join(repo, "contended.txt"),
          content: "must-not-write\n",
          overwrite: true,
          create_parents: true,
        }),
      ),
    /WORKSPACE_BUSY/,
  );
  assert.equal(
    await fs.access(path.join(repo, "contended.txt")).then(() => true).catch(() => false),
    false,
  );

  console.log(
    JSON.stringify(
      {
        ok: true,
        simulatedSchedulerPauseMs: 60_000,
        contentionStillRejected: true,
        soakLeaseTtlMs: 24 * 60 * 60_000,
      },
      null,
      2,
    ),
  );
} finally {
  Date.now = realDateNow;
  await withExecutionContext(sessionA, async () =>
    await releaseWorkspaceLease(repo).catch(() => undefined),
  );
  runtimeSessionManager.disconnect(sessionA.sessionId);
  runtimeSessionManager.disconnect(sessionB.sessionId);
  await fs.rm(scratch, { recursive: true, force: true });
}
