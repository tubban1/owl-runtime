import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPersistentPrimitiveTask,
  deletePersistentTask,
  getPersistentTaskStatus,
  runPersistentTask,
} from "../src/tasks/taskRuntime.js";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const sourcePath = path.join(root, "tmp-verify-task-memory.txt");
const scratch = path.join(root, ".tmp-verify-task-memory");

process.env.ALLOWED_DIRECTORIES = root;
process.env.TASK_DIR = path.join(scratch, "tasks");
process.env.TASK_KEY_PATH = path.join(scratch, "task.key");
process.env.TASK_STAGING_DIR = path.join(scratch, "staging");
process.env.TASK_STAGING_EXPOSE_TO_FS = "true";
process.env.EPISODIC_INDEX_DIR = path.join(scratch, "episodes");
process.env.EPISODIC_INDEX_KEY_PATH = path.join(scratch, "episode.key");

let taskId = "";
let stagingRoot = "";

try {
  const created = await createPersistentPrimitiveTask(
    "verify task memory and staging",
    [
      {
        id: "write",
        primitive: "fs.write",
        op: "write",
        args: {
          path: sourcePath,
          content: "AgentOS durable staging reference\n",
          overwrite: true,
          create_parents: true,
        },
      },
      {
        id: "read_staged",
        primitive: "fs.read",
        op: "one",
        args: {
          path: { $ref: "write.staging.artifacts.0.stagedPath" },
        },
      },
    ],
    { maxConcurrency: 2, failFast: true },
  );

  taskId = created.id;
  stagingRoot = created.staging.root;

  assert.equal(created.steps[0].executionKind, "primitive");
  assert.equal(created.steps[0].primitive, "fs.write");
  assert.equal(created.steps[1].primitive, "fs.read");

  const ran = await runPersistentTask(taskId, {
    maxConcurrency: 2,
    failFast: true,
  });
  assert.equal(ran.status, "completed");

  const status = await getPersistentTaskStatus(taskId, true);
  assert.equal(status.memoryLayers.working.succeededOutputs, 2);
  assert.equal(status.memoryLayers.staging.artifactCount, 1);
  assert.ok(status.memoryLayers.episodic.eventCount > 0);

  const manifestPath = status.staging.manifestPath;
  assert.equal(typeof manifestPath, "string");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  assert.equal(manifest.taskId, taskId);
  assert.equal(manifest.artifacts.length, 1);
  assert.equal(manifest.artifacts[0].stepId, "write");

  const writeStep = status.steps.find((step) => step.id === "write");
  const readStep = status.steps.find((step) => step.id === "read_staged");
  assert.ok(writeStep);
  assert.ok(readStep);

  const stagedPath = (writeStep.result as any)?.staging?.artifacts?.[0]?.stagedPath;
  assert.equal(typeof stagedPath, "string");
  assert.ok(stagedPath.startsWith(path.join(scratch, "staging")));
  assert.equal(
    readStep.result,
    "AgentOS durable staging reference\n",
    "Downstream Primitive must be able to consume the staged artifact.",
  );

  console.log(
    JSON.stringify(
      {
        ok: true,
        taskId,
        primitiveTask: true,
        workingMemory: true,
        staging: {
          root: stagingRoot,
          manifestPath,
          manifestArtifacts: manifest.artifacts.length,
          artifacts: status.memoryLayers.staging.artifactCount,
          downstreamStagedReference: true,
        },
        episodicMemory: {
          events: status.memoryLayers.episodic.eventCount,
          runs: status.memoryLayers.episodic.runCount,
        },
        semanticMemory: status.memoryLayers.semantic,
      },
      null,
      2,
    ),
  );
} finally {
  if (taskId) {
    await deletePersistentTask(taskId).catch(() => undefined);
  }
  await fs.rm(sourcePath, { force: true }).catch(() => undefined);
  if (stagingRoot) {
    await fs
      .rm(stagingRoot, { recursive: true, force: true })
      .catch(() => undefined);
  }
  await fs.rm(scratch, { recursive: true, force: true }).catch(() => undefined);
}
