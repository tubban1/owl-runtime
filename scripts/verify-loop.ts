import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratch = path.join(root, ".tmp-verify-loop");
const sourcePath = path.join(root, "tmp-loop-source.txt");
const relayPath = path.join(root, "tmp-loop-relay.txt");

process.env.ALLOWED_DIRECTORIES = root;
process.env.LOOP_DIR = path.join(scratch, "loops");
process.env.LOOP_KEY_PATH = path.join(scratch, "loop.key");
process.env.TASK_DIR = path.join(scratch, "tasks");
process.env.TASK_KEY_PATH = path.join(scratch, "task.key");
process.env.TASK_STAGING_DIR = path.join(scratch, "staging");
process.env.TASK_STAGING_EXPOSE_TO_FS = "true";
process.env.EPISODIC_INDEX_DIR = path.join(scratch, "episodes");
process.env.EPISODIC_INDEX_KEY_PATH = path.join(scratch, "episode.key");

const {
  cancelPersistentLoop,
  createPersistentLoop,
  deletePersistentLoop,
  getPersistentLoop,
  runLoopControllerTick,
} = await import("../src/runtime/loopController.js");

let loopId = "";

try {
  await fs.rm(scratch, { recursive: true, force: true });
  await fs.writeFile(sourcePath, "chatgpt-response\n", "utf8");

  const created = await createPersistentLoop({
    label: "verify persistent relay loop",
    pollIntervalMs: 1000,
    maxCycles: 2,
    phases: [
      {
        id: "capture",
        steps: [
          {
            id: "read",
            primitive: "fs.read",
            op: "one",
            args: { path: sourcePath },
          },
        ],
        outputRef: "read",
        waitForChange: true,
      },
      {
        id: "relay",
        steps: [
          {
            id: "write",
            primitive: "fs.write",
            op: "write",
            args: {
              path: relayPath,
              content: "{{loop.lastOutput}}",
              overwrite: true,
              create_parents: true,
            },
          },
        ],
      },
    ],
  });

  loopId = created.id;
  assert.equal(created.phase, "capture");

  await runLoopControllerTick(Date.now() + 100);
  let status = await getPersistentLoop(loopId);
  assert.equal(status.phase, "relay");
  assert.equal(status.lastOutput, "chatgpt-response\n");

  await runLoopControllerTick(Date.now() + 2500);
  status = await getPersistentLoop(loopId);
  assert.equal(status.phase, "capture");
  assert.equal(status.cycleCount, 1);
  assert.equal(await fs.readFile(relayPath, "utf8"), "chatgpt-response\n");

  const transitionsBeforeWait = status.transitionCount;
  await runLoopControllerTick(Date.now() + 5000);
  status = await getPersistentLoop(loopId);
  assert.equal(status.phase, "capture");
  assert.equal(status.transitionCount, transitionsBeforeWait);

  await fs.writeFile(sourcePath, "antigravity-response\n", "utf8");
  await runLoopControllerTick(Date.now() + 7500);
  status = await getPersistentLoop(loopId);
  assert.equal(status.phase, "relay");
  assert.equal(status.lastOutput, "antigravity-response\n");

  await runLoopControllerTick(Date.now() + 10000);
  status = await getPersistentLoop(loopId);
  assert.equal(status.enabled, false);
  assert.equal(status.cycleCount, 2);
  assert.match(String(status.stoppedReason), /maxCycles=2/);
  assert.equal(await fs.readFile(relayPath, "utf8"), "antigravity-response\n");

  console.log(
    JSON.stringify(
      {
        ok: true,
        loopId,
        crossPhaseCarry: true,
        waitForChange: true,
        persistedCycles: status.cycleCount,
        stoppedByMaxCycles: true,
      },
      null,
      2,
    ),
  );
} finally {
  if (loopId) {
    await cancelPersistentLoop(loopId).catch(() => undefined);
    await deletePersistentLoop(loopId).catch(() => undefined);
  }
  await fs.rm(sourcePath, { force: true }).catch(() => undefined);
  await fs.rm(relayPath, { force: true }).catch(() => undefined);
  await fs.rm(scratch, { recursive: true, force: true }).catch(() => undefined);
}
