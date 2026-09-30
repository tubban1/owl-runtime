import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

process.env.OWL_RUNTIME_MODE = "test";

const scratch = process.env.REQUEST_REPLAY_TEST_ROOT;
if (!scratch) throw new Error("REQUEST_REPLAY_TEST_ROOT is required.");

process.env.RUNTIME_REQUEST_REPLAY_DIR = path.join(scratch, "replay");
process.env.RUNTIME_REQUEST_REPLAY_KEY_PATH = path.join(scratch, "replay.key");
process.env.RUNTIME_REQUEST_REPLAY_MAX_RECORDS = "1000";

const phase = process.argv[2];
const key = process.argv[3] ?? "worker-key";
const counterPath = path.join(scratch, "counter.txt");

const {
  reserveRuntimeRequestReplayForCrashTest,
  withRuntimeRequestReplay,
} = await import("../src/runtime/requestReplayStore.js");

async function incrementCounter() {
  let current = 0;
  try {
    current = Number.parseInt(await fs.readFile(counterPath, "utf8"), 10) || 0;
  } catch {
    // first write
  }
  current += 1;
  await fs.mkdir(scratch, { recursive: true });
  await fs.writeFile(counterPath, String(current), "utf8");
  return current;
}

const input = {
  sessionId: "replay-worker:session",
  idempotencyKey: key,
  method: "tasks.create",
  params: { label: "response-loss", steps: [] },
  requestId: "transport-attempt:first",
};

if (phase === "complete") {
  await fs.mkdir(scratch, { recursive: true });
  const outcome = await withRuntimeRequestReplay(input, async () => ({
    taskId: "task_response_loss",
    count: await incrementCounter(),
  }));
  assert.equal(outcome.replayed, false);
  assert.equal(outcome.result.count, 1);
  console.log("COMPLETE_WRITTEN");
} else if (phase === "replay") {
  const outcome = await withRuntimeRequestReplay(
    { ...input, requestId: "transport-attempt:retry" },
    async () => ({
      taskId: "task_should_not_exist",
      count: await incrementCounter(),
    }),
  );
  assert.equal(outcome.replayed, true);
  assert.equal(outcome.result.taskId, "task_response_loss");
  assert.equal(outcome.result.count, 1);
  assert.equal((await fs.readFile(counterPath, "utf8")).trim(), "1");
  console.log("REPLAY_PASS");
} else if (phase === "reserve-and-exit") {
  await fs.mkdir(scratch, { recursive: true });
  await reserveRuntimeRequestReplayForCrashTest(input);
  console.log("RESERVED_WITHOUT_TERMINAL_RECEIPT");
} else if (phase === "retry-after-owner-exit") {
  let executed = false;
  await assert.rejects(
    () =>
      withRuntimeRequestReplay(
        { ...input, requestId: "transport-attempt:after-crash" },
        async () => {
          executed = true;
          return { taskId: "unsafe-replay" };
        },
      ),
    /IDEMPOTENCY_OUTCOME_UNCERTAIN/,
  );
  assert.equal(executed, false);
  console.log("UNCERTAIN_PASS");
} else {
  throw new Error(
    "usage: verify-request-replay-worker.ts <complete|replay|reserve-and-exit|retry-after-owner-exit> [key]",
  );
}
