import { createHash } from "node:crypto";
import {
  listPersistentTaskRecords,
  type PersistentTask,
  type PersistentTaskStatus,
} from "../tasks/taskStore.js";
import {
  getEpisodicStorageInfo,
  listGlobalEpisodes,
  newEpisodeId,
  writeGlobalEpisode,
  type GlobalEpisodeRecord,
} from "./episodicStore.js";
import { hybridRetrievalScore } from "./retrievalVector.js";
import {
  embedQueryForDescriptor,
  embedTexts,
  embeddingDescriptorKey,
  getEmbeddingProviderStatus,
  legacyFeatureHashDescriptor,
  type EmbeddingDescriptor,
} from "./embeddingProvider.js";

const TERMINAL = new Set<PersistentTaskStatus>([
  "completed",
  "failed",
  "blocked",
  "cancelled",
]);

function terminalAt(task: PersistentTask): string {
  return (
    task.completedAt ??
    task.cancelledAt ??
    task.blockedAt ??
    task.updatedAt
  );
}

function buildSearchableText(task: PersistentTask): string {
  const stepText = task.steps
    .map((step) =>
      [
        step.id,
        step.primitive ?? "",
        step.op ?? "",
        step.action,
        step.state,
        step.error ?? "",
        step.recoveryNote ?? "",
      ]
        .filter(Boolean)
        .join(" "),
    )
    .join("\n");

  const eventText = task.events
    .slice(-250)
    .map((event) => [event.type, event.stepId ?? "", event.message].join(" "))
    .join("\n");

  return [
    `task ${task.id}`,
    `label ${task.label}`,
    `status ${task.status}`,
    stepText,
    eventText,
  ]
    .join("\n")
    .trim();
}

export async function taskToGlobalEpisode(
  task: PersistentTask,
): Promise<GlobalEpisodeRecord> {
  if (!TERMINAL.has(task.status)) {
    throw new Error(
      `Only terminal tasks can enter the global episodic index; ${task.id} is ${task.status}.`,
    );
  }

  const searchableText = buildSearchableText(task);
  const embedding = await embedTexts([searchableText]);
  const vector = embedding.embeddings[0]!;
  const now = new Date().toISOString();
  return {
    version: 1,
    id: newEpisodeId(),
    taskId: task.id,
    label: task.label,
    status: task.status,
    createdAt: task.createdAt,
    updatedAt: now,
    terminalAt: terminalAt(task),
    runCount: task.runCount,
    stepCount: task.steps.length,
    steps: task.steps.map((step) => ({
      id: step.id,
      ...(step.primitive ? { primitive: step.primitive } : {}),
      ...(step.op ? { op: step.op } : {}),
      action: step.action,
      state: step.state,
      attempts: step.attempts,
      ...(step.durationMs !== undefined ? { durationMs: step.durationMs } : {}),
      ...(step.error ? { error: step.error } : {}),
      ...(step.recoveryNote ? { recoveryNote: step.recoveryNote } : {}),
    })),
    eventTypes: [...new Set(task.events.map((event) => event.type))],
    eventMessages: task.events.slice(-250).map((event) => event.message),
    searchableText,
    contentDigest: createHash("sha256")
      .update(searchableText.normalize("NFKC"))
      .digest("hex"),
    retrieval: {
      embedding: {
        descriptor: embedding.provider,
        vector,
      },
      dimensions: vector.length,
      vector,
    },
  };
}

export async function indexTaskEpisode(task: PersistentTask) {
  if (!TERMINAL.has(task.status)) {
    return { indexed: false, reason: "task_not_terminal", taskId: task.id };
  }
  const record = await taskToGlobalEpisode(task);
  await writeGlobalEpisode(record);
  return {
    indexed: true,
    taskId: task.id,
    episodeId: record.id,
    status: task.status,
    terminalAt: record.terminalAt,
  };
}

export async function rebuildGlobalEpisodicIndex() {
  const tasks = await listPersistentTaskRecords();
  let indexed = 0;
  let skipped = 0;
  const failures: Array<{ taskId: string; error: string }> = [];

  for (const task of tasks) {
    if (!TERMINAL.has(task.status)) {
      skipped += 1;
      continue;
    }
    try {
      await indexTaskEpisode(task);
      indexed += 1;
    } catch (error) {
      failures.push({
        taskId: task.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    indexed,
    skipped,
    failed: failures.length,
    failures,
    storage: getEpisodicStorageInfo(),
  };
}

export async function searchGlobalEpisodes(
  query: string,
  options?: {
    mode?: "hybrid" | "lexical" | "vector";
    statuses?: PersistentTaskStatus[];
    limit?: number;
  },
) {
  const mode = options?.mode ?? "hybrid";
  const statuses = new Set(options?.statuses ?? []);
  const limit = Math.min(Math.max(Math.trunc(options?.limit ?? 20), 1), 100);
  const records = (await listGlobalEpisodes()).filter(
    (record) => statuses.size === 0 || statuses.has(record.status),
  );

  const queryVectors = new Map<string, number[] | null>();
  if (query.trim() && mode !== "lexical") {
    for (const record of records) {
      const descriptor: EmbeddingDescriptor =
        record.retrieval.embedding?.descriptor ??
        legacyFeatureHashDescriptor();
      const key = embeddingDescriptorKey(descriptor);
      if (!queryVectors.has(key)) {
        queryVectors.set(
          key,
          await embedQueryForDescriptor(query, descriptor),
        );
      }
    }
  }

  return records
    .map((record) => {
      const descriptor: EmbeddingDescriptor =
        record.retrieval.embedding?.descriptor ??
        legacyFeatureHashDescriptor();
      const key = embeddingDescriptorKey(descriptor);
      const queryVector =
        mode === "lexical" ? null : queryVectors.get(key) ?? null;
      return {
        record,
        descriptor,
        score: query.trim()
          ? hybridRetrievalScore(
              query,
              record.searchableText,
              queryVector,
              record.retrieval.vector,
              mode,
            )
          : { lexical: 0, vector: 0, combined: 1 },
      };
    })
    .filter((item) => !query.trim() || item.score.combined > 0)
    .sort(
      (a, b) =>
        b.score.combined - a.score.combined ||
        b.record.terminalAt.localeCompare(a.record.terminalAt),
    )
    .slice(0, limit)
    .map(({ record, score, descriptor }) => ({
      taskId: record.taskId,
      episodeId: record.id,
      label: record.label,
      status: record.status,
      terminalAt: record.terminalAt,
      runCount: record.runCount,
      stepCount: record.stepCount,
      steps: record.steps,
      eventTypes: record.eventTypes,
      score,
      embedding: descriptor,
    }));
}

export async function episodicIndexStatus() {
  const records = await listGlobalEpisodes();
  const byStatus = Object.fromEntries(
    [...TERMINAL].map((status) => [
      status,
      records.filter((record) => record.status === status).length,
    ]),
  );
  return {
    available: true,
    autoIndexTerminalTasks: true,
    recordCount: records.length,
    byStatus,
    embeddingProvider: getEmbeddingProviderStatus(),
    storedEmbeddingProviders: [
      ...new Set(
        records.map((record) => {
          const descriptor =
            record.retrieval.embedding?.descriptor ??
            legacyFeatureHashDescriptor();
          return `${descriptor.providerId}:${descriptor.model}:${descriptor.dimensions}`;
        }),
      ),
    ],
    storage: getEpisodicStorageInfo(),
  };
}
