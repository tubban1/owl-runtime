import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratch = path.join(root, ".tmp-verify-recall");
const okPath = path.join(root, "tmp-recall-checkpoint.txt");
const missingPath = path.join(root, "tmp-recall-does-not-exist.txt");

process.env.ALLOWED_DIRECTORIES = root;
process.env.TASK_DIR = path.join(scratch, "tasks");
process.env.TASK_KEY_PATH = path.join(scratch, "task.key");
process.env.TASK_STAGING_DIR = path.join(scratch, "staging");
process.env.TASK_STAGING_EXPOSE_TO_FS = "true";
process.env.EPISODIC_INDEX_DIR = path.join(scratch, "episodes");
process.env.EPISODIC_INDEX_KEY_PATH = path.join(scratch, "episode.key");
process.env.SEMANTIC_MEMORY_DIR = path.join(scratch, "semantic");
process.env.SEMANTIC_MEMORY_KEY_PATH = path.join(scratch, "semantic.key");

const {
  createPersistentPrimitiveTask,
  deletePersistentTask,
  runPersistentTask,
} = await import("../src/tasks/taskRuntime.js");
const {
  deleteGlobalEpisode,
} = await import("../src/runtime/episodicStore.js");
const {
  episodicIndexStatus,
  rebuildGlobalEpisodicIndex,
  searchGlobalEpisodes,
} = await import("../src/runtime/episodicIndex.js");
const {
  promoteSemanticMemory,
  removeSemanticMemory,
} = await import("../src/runtime/memoryPromotion.js");
const {
  recallMemory,
  recallStatus,
} = await import("../src/runtime/memoryRecall.js");

let successfulTaskId = "";
let failedTaskId = "";
let semanticId = "";

try {
  await fs.rm(scratch, { recursive: true, force: true });
  await fs.rm(okPath, { force: true });
  await fs.rm(missingPath, { force: true });

  const successful = await createPersistentPrimitiveTask(
    "deployment checkpoint recovery procedure",
    [
      {
        id: "checkpoint",
        primitive: "fs.write",
        op: "write",
        args: {
          path: okPath,
          content: "durable checkpoint before deployment side effect\n",
          overwrite: true,
          create_parents: true,
        },
      },
      {
        id: "verify_checkpoint",
        primitive: "fs.read",
        op: "one",
        args: { path: okPath },
        dependsOn: ["checkpoint"],
      },
    ],
  );
  successfulTaskId = successful.id;
  const successfulRun = await runPersistentTask(successfulTaskId);
  assert.equal(successfulRun.status, "completed");

  const failed = await createPersistentPrimitiveTask(
    "deployment recovery missing manifest failure",
    [
      {
        id: "missing_manifest",
        primitive: "fs.read",
        op: "one",
        args: { path: missingPath },
      },
    ],
  );
  failedTaskId = failed.id;
  const failedRun = await runPersistentTask(failedTaskId);
  assert.equal(failedRun.status, "failed");

  const episodicStatus = await episodicIndexStatus();
  assert.equal(episodicStatus.recordCount, 2);
  assert.equal(episodicStatus.byStatus.completed, 1);
  assert.equal(episodicStatus.byStatus.failed, 1);
  assert.equal(episodicStatus.embeddingProvider.providerId, "feature-hash");
  assert.equal(episodicStatus.embeddingProvider.configured, true);

  const successSearch = await searchGlobalEpisodes(
    "deployment checkpoint recovery",
    { mode: "hybrid", statuses: ["completed"] },
  );
  assert.equal(successSearch[0]?.taskId, successfulTaskId);

  const failedSearch = await searchGlobalEpisodes(
    "missing manifest failure",
    { mode: "hybrid", statuses: ["failed"] },
  );
  assert.equal(failedSearch[0]?.taskId, failedTaskId);

  const promoted = await promoteSemanticMemory({
    taskId: successfulTaskId,
    kind: "procedure",
    title: "Checkpoint before deployment side effects",
    content:
      "Persist and verify a durable checkpoint before a consequential deployment side effect so restart recovery can distinguish safe retry from manual review.",
    tags: ["deployment", "checkpoint", "recovery"],
    sensitivity: "internal",
    evidenceStepIds: ["checkpoint", "verify_checkpoint"],
    confirm: true,
  });
  semanticId = promoted.id;

  const recalled = await recallMemory("deployment checkpoint recovery", {
    scope: "both",
    mode: "hybrid",
    limit: 10,
  });
  assert.ok(
    recalled.results.some(
      (item) =>
        item.memoryType === "episodic" &&
        item.sourceTaskId === successfulTaskId,
    ),
  );
  assert.ok(
    recalled.results.some(
      (item) =>
        item.memoryType === "semantic" &&
        item.id === semanticId,
    ),
  );

  const vectorOnly = await recallMemory("checkpoint deployment", {
    scope: "both",
    mode: "vector",
    limit: 10,
  });
  assert.ok(vectorOnly.results.length >= 1);

  const rebuild = await rebuildGlobalEpisodicIndex();
  assert.equal(rebuild.failed, 0);
  assert.equal(rebuild.indexed, 2);

  const status = await recallStatus();
  assert.equal(status.available, true);
  assert.equal(status.episodic.recordCount, 2);
  assert.equal(status.semantic.recordCount, 1);

  console.log(
    JSON.stringify(
      {
        ok: true,
        successfulTaskId,
        failedTaskId,
        semanticId,
        globalTerminalEpisodes: status.episodic.recordCount,
        recallsFailures: true,
        hybridRecall: true,
        vectorRecall: true,
        episodicAndSemanticTogether: true,
        encryptedEpisodicStore: status.episodic.storage.encryptedAtRest,
        embeddingProvider: status.episodic.embeddingProvider,
        storedEmbeddingProviders: status.episodic.storedEmbeddingProviders,
      },
      null,
      2,
    ),
  );
} finally {
  if (semanticId) {
    await removeSemanticMemory(semanticId).catch(() => undefined);
  }
  for (const taskId of [successfulTaskId, failedTaskId]) {
    if (!taskId) continue;
    await deleteGlobalEpisode(taskId).catch(() => undefined);
    await deletePersistentTask(taskId).catch(() => undefined);
  }
  await fs.rm(okPath, { force: true }).catch(() => undefined);
  await fs.rm(missingPath, { force: true }).catch(() => undefined);
  await fs.rm(scratch, { recursive: true, force: true }).catch(() => undefined);
}
