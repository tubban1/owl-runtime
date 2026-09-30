import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratch = path.join(root, ".tmp-verify-action-observation");
await fs.rm(scratch, { recursive: true, force: true });
await fs.mkdir(scratch, { recursive: true });

process.env.OWL_STATE_ROOT = path.join(scratch, "state");
process.env.ALLOWED_DIRECTORIES = root;
process.env.ALLOW_WRITE = "true";
process.env.ALLOW_DELETE = "true";
process.env.OWL_APPROVAL_MODE = "compat";

const { executeRoutedAction } = await import("../src/router/actionRouter.js");
const { executePrimitive } = await import("../src/primitives/primitiveRuntime.js");
const {
  createPersistentTask,
  getPersistentTaskStatus,
  runPersistentTask,
} = await import("../src/tasks/taskRuntime.js");

const directPath = path.join(scratch, "direct.txt");
const directWrite = await executeRoutedAction("fs.write", {
  path: directPath,
  content: "hello",
  overwrite: true,
  create_parents: true,
});
assert.equal(directWrite.observation?.channel, "file");
assert.equal(directWrite.observation?.provider, "filesystem");
assert.equal((directWrite.observation?.data as any).exists, true);
assert.equal((directWrite.observation?.data as any).size, 5);
assert.equal(directWrite.verification?.status, "verified");

const directRead = await executeRoutedAction("fs.read", { path: directPath });
assert.equal(directRead.observation?.channel, "file");
assert.equal((directRead.observation?.data as any).content, "hello");
assert.equal(directRead.verification, null);

const primitivePath = path.join(scratch, "primitive.txt");
const primitiveWrite = await executePrimitive("fs.write", "write", {
  path: primitivePath,
  content: "primitive",
  overwrite: true,
  create_parents: true,
});
assert.equal(primitiveWrite.observation?.channel, "file");
assert.equal(primitiveWrite.verification?.status, "verified");

const taskPath = path.join(scratch, "task.txt");
const created = await createPersistentTask(
  "verified file write",
  [
    {
      id: "write",
      action: "fs.write",
      args: {
        path: taskPath,
        content: "task verified",
        overwrite: true,
        create_parents: true,
      },
    },
  ],
  { maxConcurrency: 1, failFast: true },
);
const createdStep = created.steps[0];
assert.equal(createdStep?.requiresVerification, true);

const run = await runPersistentTask(created.id, {
  maxConcurrency: 1,
  maxWaves: 5,
  timeBudgetMs: 30_000,
});
assert.equal(run.status, "completed");

const taskStatus = await getPersistentTaskStatus(created.id, true);
const taskStep = taskStatus.steps[0];
assert.equal(taskStep?.state, "succeeded");
assert.equal(taskStep?.observation?.channel, "file");
assert.equal(taskStep?.verification?.status, "verified");
assert.ok(
  taskStatus.events.some((event: any) => event.type === "step_verified"),
);

const deleted = await executeRoutedAction("fs.delete", { path: directPath });
assert.equal((deleted.observation?.data as any).exists, false);
assert.equal(deleted.verification?.status, "verified");

console.log(JSON.stringify({
  ok: true,
  routedActionObservation: true,
  primitiveObservationPropagation: true,
  defaultFileVerification: true,
  persistentTaskVerificationReceipt: true,
  deleteAbsenceVerification: true,
}, null, 2));

await fs.rm(scratch, { recursive: true, force: true });
