import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

process.env.OWL_RUNTIME_MODE = "test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratch = path.join(root, ".tmp-verify-request-replay");
await fs.rm(scratch, { recursive: true, force: true });
await fs.mkdir(scratch, { recursive: true });

process.env.RUNTIME_REQUEST_REPLAY_DIR = path.join(scratch, "direct", "replay");
process.env.RUNTIME_REQUEST_REPLAY_KEY_PATH = path.join(
  scratch,
  "direct",
  "replay.key",
);
process.env.RUNTIME_REQUEST_REPLAY_MAX_RECORDS = "1000";

const {
  RuntimeStoredReplayError,
  withRuntimeRequestReplay,
} = await import("../src/runtime/requestReplayStore.js");

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runWorker(
  workerScratch: string,
  phase: string,
  key: string,
): Promise<string> {
  const tsx = path.join(root, "node_modules", ".bin", "tsx");
  const worker = path.join(root, "scripts", "verify-request-replay-worker.ts");
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(tsx, [worker, phase, key], {
      cwd: root,
      env: {
        ...process.env,
        REQUEST_REPLAY_TEST_ROOT: workerScratch,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) {
        reject(new Error(stdout + stderr));
        return;
      }
      resolve(stdout);
    });
  });
}

try {
  let executions = 0;
  const shared = {
    sessionId: "replay:session:A",
    idempotencyKey: "concurrent-task-create",
    method: "tasks.create",
    params: {
      label: "same request",
      steps: [{ id: "one", primitive: "git.query", op: "status" }],
    },
  };

  const [first, second] = await Promise.all([
    withRuntimeRequestReplay(
      { ...shared, requestId: "attempt:first" },
      async () => {
        executions += 1;
        await sleep(80);
        return { taskId: "task_once" };
      },
    ),
    withRuntimeRequestReplay(
      { ...shared, requestId: "attempt:second" },
      async () => {
        executions += 1;
        return { taskId: "task_duplicate" };
      },
    ),
  ]);
  assert.equal(executions, 1);
  assert.deepEqual(first.result, { taskId: "task_once" });
  assert.deepEqual(second.result, { taskId: "task_once" });
  assert.equal(first.replayed, false);
  assert.equal(second.replayed, true);

  await assert.rejects(
    () =>
      withRuntimeRequestReplay(
        {
          ...shared,
          requestId: "attempt:conflict",
          params: { label: "different request", steps: [] },
        },
        async () => ({ taskId: "must_not_execute" }),
      ),
    /IDEMPOTENCY_KEY_CONFLICT/,
  );
  assert.equal(executions, 1);

  let otherSessionExecutions = 0;
  const otherSession = await withRuntimeRequestReplay(
    {
      ...shared,
      sessionId: "replay:session:B",
      requestId: "attempt:other-session",
    },
    async () => {
      otherSessionExecutions += 1;
      return { taskId: "task_other_session" };
    },
  );
  assert.equal(otherSessionExecutions, 1);
  assert.equal(otherSession.replayed, false);
  assert.equal(otherSession.result.taskId, "task_other_session");

  let failedExecutions = 0;
  const failureInput = {
    sessionId: "replay:failure",
    idempotencyKey: "stable-failure",
    method: "schedules.create",
    params: { label: "bad schedule" },
  };
  await assert.rejects(
    () =>
      withRuntimeRequestReplay(
        { ...failureInput, requestId: "failure:first" },
        async () => {
          failedExecutions += 1;
          throw new Error("TEST_FAILURE: deterministic rejection");
        },
      ),
    /TEST_FAILURE/,
  );
  await assert.rejects(
    () =>
      withRuntimeRequestReplay(
        { ...failureInput, requestId: "failure:retry" },
        async () => {
          failedExecutions += 1;
          return { unsafe: true };
        },
      ),
    (error: any) =>
      error instanceof RuntimeStoredReplayError &&
      error.code === "TEST_FAILURE",
  );
  assert.equal(failedExecutions, 1);

  const secretValue = "secret-user-payload-must-not-appear-in-ledger";
  await withRuntimeRequestReplay(
    {
      sessionId: "replay:encrypted",
      idempotencyKey: "encrypted-record",
      method: "primitive.call",
      params: {
        primitive: "fs.write",
        args: { content: secretValue },
      },
      requestId: "encrypted:first",
    },
    async () => ({ privateResult: secretValue }),
  );
  const ledgerFiles = await fs.readdir(
    process.env.RUNTIME_REQUEST_REPLAY_DIR!,
  );
  const stateFile = ledgerFiles.find((name) => name.endsWith(".state"));
  assert.ok(stateFile);
  const rawLedger = await fs.readFile(
    path.join(process.env.RUNTIME_REQUEST_REPLAY_DIR!, stateFile!),
    "utf8",
  );
  assert.equal(rawLedger.includes(secretValue), false);

  const responseLossScratch = path.join(scratch, "response-loss");
  const complete = await runWorker(
    responseLossScratch,
    "complete",
    "response-loss-key",
  );
  assert.match(complete, /COMPLETE_WRITTEN/);
  const replay = await runWorker(
    responseLossScratch,
    "replay",
    "response-loss-key",
  );
  assert.match(replay, /REPLAY_PASS/);

  const crashScratch = path.join(scratch, "crash-owner");
  const reserved = await runWorker(
    crashScratch,
    "reserve-and-exit",
    "crash-key",
  );
  assert.match(reserved, /RESERVED_WITHOUT_TERMINAL_RECEIPT/);
  const uncertain = await runWorker(
    crashScratch,
    "retry-after-owner-exit",
    "crash-key",
  );
  assert.match(uncertain, /UNCERTAIN_PASS/);

  const corruptionDir = path.join(scratch, "corruption", "replay");
  process.env.RUNTIME_REQUEST_REPLAY_DIR = corruptionDir;
  process.env.RUNTIME_REQUEST_REPLAY_KEY_PATH = path.join(
    scratch,
    "corruption",
    "replay.key",
  );
  await withRuntimeRequestReplay(
    {
      sessionId: "replay:corrupt",
      idempotencyKey: "corrupt-key",
      method: "tasks.create",
      params: { label: "corrupt", steps: [] },
      requestId: "corrupt:first",
    },
    async () => ({ taskId: "task_corrupt" }),
  );
  const corruptFile = (await fs.readdir(corruptionDir)).find((name) =>
    name.endsWith(".state"),
  );
  assert.ok(corruptFile);
  await fs.writeFile(
    path.join(corruptionDir, corruptFile!),
    "{broken\n",
    "utf8",
  );
  await assert.rejects(
    () =>
      withRuntimeRequestReplay(
        {
          sessionId: "replay:corrupt",
          idempotencyKey: "corrupt-key",
          method: "tasks.create",
          params: { label: "corrupt", steps: [] },
          requestId: "corrupt:retry",
        },
        async () => ({ taskId: "must_not_reexecute" }),
      ),
    /IDEMPOTENCY_STORE_CORRUPT/,
  );

  console.log(
    JSON.stringify(
      {
        ok: true,
        sameProcessConcurrentJoin: true,
        requestDigestConflictFailClosed: true,
        logicalSessionScopedKeys: true,
        terminalFailureReplay: true,
        encryptedLedgerNoPlaintextPayload: true,
        responseLossCrossProcessReplay: true,
        deadOwnerBecomesUncertain: true,
        corruptLedgerFailClosed: true,
      },
      null,
      2,
    ),
  );
} finally {
  await fs.rm(scratch, { recursive: true, force: true }).catch(() => undefined);
}
