import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratch = path.join(root, ".tmp-verify-semantic-memory");
const sourcePath = path.join(root, "tmp-verify-semantic-source.txt");

process.env.ALLOWED_DIRECTORIES = root;
process.env.TASK_DIR = path.join(scratch, "tasks");
process.env.TASK_KEY_PATH = path.join(scratch, "task.key");
process.env.TASK_STAGING_DIR = path.join(scratch, "staging");
process.env.TASK_STAGING_EXPOSE_TO_FS = "true";
process.env.SEMANTIC_MEMORY_DIR = path.join(scratch, "semantic");
process.env.SEMANTIC_MEMORY_KEY_PATH = path.join(scratch, "semantic.key");
process.env.EPISODIC_INDEX_DIR = path.join(scratch, "episodes");
process.env.EPISODIC_INDEX_KEY_PATH = path.join(scratch, "episode.key");

const {
  createPersistentPrimitiveTask,
  deletePersistentTask,
  getPersistentTaskStatus,
  runPersistentTask,
} = await import("../src/tasks/taskRuntime.js");
const {
  getSemanticMemory,
  inspectPromotionCandidate,
  promoteSemanticMemory,
  removeSemanticMemory,
  searchSemanticMemories,
  semanticMemoryStatus,
} = await import("../src/runtime/memoryPromotion.js");

let taskId = "";
let memoryId = "";

try {
  await fs.rm(scratch, { recursive: true, force: true });

  const created = await createPersistentPrimitiveTask(
    "verify M2 to M3 semantic promotion",
    [
      {
        id: "write",
        primitive: "fs.write",
        op: "write",
        args: {
          path: sourcePath,
          content: "checkpoint before side effects\n",
          overwrite: true,
          create_parents: true,
        },
      },
      {
        id: "read",
        primitive: "fs.read",
        op: "one",
        args: { path: sourcePath },
        dependsOn: ["write"],
      },
    ],
    { maxConcurrency: 2, failFast: true },
  );
  taskId = created.id;

  const ran = await runPersistentTask(taskId, {
    maxConcurrency: 2,
    failFast: true,
  });
  assert.equal(ran.status, "completed");

  const candidateInput = {
    taskId,
    kind: "procedure" as const,
    title: "Checkpoint before consequential side effects",
    content:
      "For resumable AgentOS workflows, persist a durable checkpoint before a consequential side effect so restart recovery can distinguish safe retry from manual review.",
    tags: ["runtime", "recovery", "checkpoint"],
    sensitivity: "internal" as const,
    evidenceStepIds: ["write", "read"],
  };

  const inspected = await inspectPromotionCandidate(candidateInput);
  assert.equal(inspected.promotable, true);
  assert.equal(inspected.qualityGate.passed, true);
  assert.equal(inspected.privacyGate.passed, true);
  assert.ok(inspected.evidenceEventTypes.includes("task_completed"));

  const blocked = await inspectPromotionCandidate({
    ...candidateInput,
    title: "Must never promote credentials",
    content:
      "This candidate contains api_key=supersecretcredential123456 and must be rejected by the privacy gate.",
  });
  assert.equal(blocked.promotable, false);
  assert.equal(blocked.privacyGate.passed, false);

  const promoted = await promoteSemanticMemory({
    ...candidateInput,
    confirm: true,
  });
  memoryId = promoted.id;
  assert.equal(promoted.promotion.explicit, true);
  assert.equal(promoted.source.taskId, taskId);
  assert.deepEqual(promoted.source.evidenceStepIds, ["write", "read"]);

  const stored = await getSemanticMemory(memoryId);
  assert.equal(stored.content, candidateInput.content);
  assert.equal(stored.kind, "procedure");

  const search = await searchSemanticMemories("resumable checkpoint", {
    kind: "procedure",
    tags: ["runtime"],
  });
  assert.equal(search.length, 1);
  assert.equal(search[0].id, memoryId);

  const taskStatus = await getPersistentTaskStatus(taskId, true);
  assert.equal(taskStatus.memoryLayers.semantic.available, true);
  assert.ok(
    taskStatus.events.some((event) => event.type === "semantic_promoted"),
    "M2 task episode must record semantic promotion provenance.",
  );

  await assert.rejects(
    () =>
      promoteSemanticMemory({
        ...candidateInput,
        confirm: true,
      }),
    /already exists/,
  );

  const status = await semanticMemoryStatus();
  assert.equal(status.available, true);
  assert.equal(status.promotionMode, "explicit");
  assert.equal(status.recordCount, 1);

  console.log(
    JSON.stringify(
      {
        ok: true,
        taskId,
        memoryId,
        m2EpisodeEvidence: true,
        qualityGate: true,
        privacyGate: true,
        obviousSecretRejected: true,
        explicitPromotion: true,
        encryptedSemanticStore: status.storage.encryptedAtRest,
        searchableM3: true,
        provenanceBacklink: true,
        duplicateBlocked: true,
      },
      null,
      2,
    ),
  );
} finally {
  if (memoryId) {
    await removeSemanticMemory(memoryId).catch(() => undefined);
  }
  if (taskId) {
    await deletePersistentTask(taskId).catch(() => undefined);
  }
  await fs.rm(sourcePath, { force: true }).catch(() => undefined);
  await fs.rm(scratch, { recursive: true, force: true }).catch(() => undefined);
}
