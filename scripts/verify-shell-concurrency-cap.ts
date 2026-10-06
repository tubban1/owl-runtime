import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const scratch = await fs.mkdtemp(
  path.join(os.tmpdir(), "owl-shell-concurrency-cap-"),
);
const repoA = path.join(scratch, "repo-a");
const repoB = path.join(scratch, "repo-b");
await fs.mkdir(path.join(repoA, ".git"), { recursive: true });
await fs.mkdir(path.join(repoB, ".git"), { recursive: true });

process.env.OWL_RUNTIME_MODE = "test";
process.env.OWL_STATE_ROOT = path.join(scratch, "state");
process.env.PROCESS_STATE_DIR = path.join(scratch, "state", "processes");
process.env.PROCESS_STATE_KEY_PATH = path.join(scratch, "state", "process.key");
process.env.PROCESS_LOG_DIR = path.join(
  scratch,
  "state",
  "processes",
  "logs",
);
process.env.ALLOWED_DIRECTORIES = scratch;
process.env.ALLOW_SHELL = "true";
process.env.OWL_SHELL_MAX_CONCURRENCY = "4";
process.env.OWL_SHELL_MAX_CONCURRENCY_PER_WORKSPACE = "2";
process.env.OWL_SHELL_CONCURRENCY_WAIT_MS = "3000";
process.env.OWL_SHELL_CONCURRENCY_POLL_MS = "25";

const { withExecutionContext } = await import(
  "../src/runtime/executionContext.js"
);
const { runtimeSessionManager } = await import(
  "../src/runtime/runtimeSessionManager.js"
);
const { listProcesses, startProcess } = await import(
  "../src/tools/shellOps.js"
);
const { shellConcurrencyStatus } = await import(
  "../src/runtime/shellConcurrencyGate.js"
);

const sessions = ["A", "B", "C", "D"].map((suffix) => ({
  sessionId: `shell-cap-${suffix}`,
  requestId: `shell-cap-request-${suffix}`,
  origin: "mcp" as const,
}));
for (const session of sessions) {
  runtimeSessionManager.register(session.sessionId);
}

try {
  const first = await withExecutionContext(sessions[0]!, async () =>
    await startProcess("sleep 0.8", repoA, "read"),
  );
  const second = await withExecutionContext(sessions[1]!, async () =>
    await startProcess("sleep 0.8", repoA, "read"),
  );

  const canonicalRepoA = first.workspace;
  const beforeThird = await shellConcurrencyStatus();
  assert.equal(
    beforeThird.active.filter((item) => item.workspace === canonicalRepoA).length,
    2,
  );

  const thirdStartedAt = Date.now();
  const third = await withExecutionContext(sessions[2]!, async () =>
    await startProcess("sleep 0.1", repoA, "read"),
  );
  const thirdWaitMs =
    (third as { concurrencyWaitMs?: number }).concurrencyWaitMs ?? 0;
  const thirdWallMs = Date.now() - thirdStartedAt;

  assert.ok(
    thirdWaitMs >= 400,
    `third same-workspace process was not backpressured: wait=${thirdWaitMs}ms wall=${thirdWallMs}ms`,
  );
  assert.ok(
    thirdWaitMs < 2500,
    `third same-workspace process waited unexpectedly long: ${thirdWaitMs}ms`,
  );

  const siblingStartedAt = Date.now();
  const sibling = await withExecutionContext(sessions[3]!, async () =>
    await startProcess("sleep 0.1", repoB, "read"),
  );
  const siblingWaitMs =
    (sibling as { concurrencyWaitMs?: number }).concurrencyWaitMs ?? 0;
  assert.ok(
    siblingWaitMs < 300,
    `independent workspace was unnecessarily serialized: ${siblingWaitMs}ms`,
  );
  assert.ok(Date.now() - siblingStartedAt < 600);

  await new Promise((resolve) => setTimeout(resolve, 1_000));
  const processes = await listProcesses();
  for (const id of [
    first.processId,
    second.processId,
    third.processId,
    sibling.processId,
  ]) {
    assert.equal(
      processes.find((item) => item.processId === id)?.running,
      false,
      `process ${id} should be terminal after verifier cleanup`,
    );
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        limits: {
          global: 4,
          perWorkspace: 2,
        },
        sameWorkspaceThirdWaitMs: thirdWaitMs,
        siblingWorkspaceWaitMs: siblingWaitMs,
        backpressure: "PASS",
        crossWorkspaceConcurrency: "PASS",
      },
      null,
      2,
    ),
  );
} finally {
  for (const session of sessions) {
    runtimeSessionManager.disconnect(session.sessionId);
  }
  await new Promise((resolve) => setTimeout(resolve, 200));
  await fs.rm(scratch, { recursive: true, force: true });
}
