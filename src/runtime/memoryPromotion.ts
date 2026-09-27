import { createHash } from "node:crypto";
import { injectTestFault } from "./faultInjection.js";
import {
  appendTaskEvent,
  readPersistentTask,
  writePersistentTask,
  type PersistentTask,
} from "../tasks/taskStore.js";
import {
  featureHashVectorize,
  hybridRetrievalScore,
} from "./retrievalVector.js";
import {
  embedQueryForDescriptor,
  embedTexts,
  embeddingDescriptorKey,
  getEmbeddingProviderStatus,
  legacyFeatureHashDescriptor,
  type EmbeddingDescriptor,
} from "./embeddingProvider.js";
import {
  deleteSemanticMemory,
  findSemanticMemoryByDigest,
  getSemanticStorageInfo,
  listSemanticMemories,
  newSemanticMemoryId,
  readSemanticMemory,
  semanticDigest,
  writeSemanticMemory,
  type GateReceipt,
  type SemanticMemoryKind,
  type SemanticMemoryRecord,
  type SemanticSensitivity,
} from "./semanticStore.js";

export type PromotionCandidateInput = {
  taskId: string;
  kind: SemanticMemoryKind;
  title: string;
  content: string;
  tags?: string[];
  sensitivity?: SemanticSensitivity;
  evidenceStepIds?: string[];
};

export type PromotionCandidate = {
  taskId: string;
  taskLabel: string;
  kind: SemanticMemoryKind;
  title: string;
  content: string;
  tags: string[];
  sensitivity: SemanticSensitivity;
  evidenceStepIds: string[];
  evidenceEventTypes: string[];
  evidenceDigest: string;
  contentDigest: string;
  candidateDigest: string;
  qualityGate: GateReceipt;
  privacyGate: GateReceipt;
  promotable: boolean;
};

const KINDS = new Set<SemanticMemoryKind>([
  "fact",
  "preference",
  "procedure",
  "pattern",
  "decision",
]);

const SENSITIVITIES = new Set<SemanticSensitivity>([
  "public",
  "internal",
  "private",
]);

function normalizeTags(tags: string[] = []): string[] {
  return [
    ...new Set(
      tags
        .map((tag) => tag.trim().toLowerCase())
        .filter(Boolean)
        .slice(0, 32),
    ),
  ];
}

function evidenceForTask(
  task: PersistentTask,
  requested?: string[],
): { stepIds: string[]; eventTypes: string[]; digest: string } {
  const succeeded = new Set(
    task.steps.filter((step) => step.state === "succeeded").map((step) => step.id),
  );
  const requestedIds =
    requested && requested.length > 0
      ? requested.map((item) => item.trim()).filter(Boolean)
      : [...succeeded];

  const stepIds = [...new Set(requestedIds)];
  const eventTypes = [...new Set(task.events.map((event) => event.type))];

  const evidence = {
    taskId: task.id,
    taskStatus: task.status,
    completedAt: task.completedAt ?? null,
    steps: stepIds.map((id) => {
      const step = task.steps.find((item) => item.id === id);
      return {
        id,
        exists: Boolean(step),
        state: step?.state ?? null,
        primitive: step?.primitive ?? null,
        op: step?.op ?? null,
        resultDigest:
          step?.state === "succeeded" && step.result !== undefined
            ? createHash("sha256")
                .update(JSON.stringify(step.result))
                .digest("hex")
            : null,
      };
    }),
    events: task.events.map((event) => ({
      type: event.type,
      stepId: event.stepId ?? null,
    })),
  };

  return {
    stepIds,
    eventTypes,
    digest: createHash("sha256")
      .update(JSON.stringify(evidence))
      .digest("hex"),
  };
}

function qualityGate(
  task: PersistentTask,
  input: PromotionCandidateInput,
  evidenceStepIds: string[],
): GateReceipt {
  const title = input.title.trim();
  const content = input.content.trim();
  const succeeded = new Set(
    task.steps.filter((step) => step.state === "succeeded").map((step) => step.id),
  );
  const evidenceValid =
    evidenceStepIds.length > 0 &&
    evidenceStepIds.every((stepId) => succeeded.has(stepId));
  const taskCompleted =
    task.status === "completed" &&
    task.events.some((event) => event.type === "task_completed");
  const noUnresolvedSteps = task.steps.every(
    (step) => step.state === "succeeded",
  );

  const checks = [
    {
      id: "task_completed",
      passed: taskCompleted,
      detail: taskCompleted
        ? "Source task completed with a task_completed episode."
        : "Source task must be completed before semantic promotion.",
    },
    {
      id: "no_unresolved_steps",
      passed: noUnresolvedSteps,
      detail: noUnresolvedSteps
        ? "All task steps succeeded."
        : "Failed, pending, running, or needs-review steps block promotion.",
    },
    {
      id: "evidence_steps",
      passed: evidenceValid,
      detail: evidenceValid
        ? `${evidenceStepIds.length} succeeded evidence step(s) selected.`
        : "At least one selected evidence step must exist and have succeeded.",
    },
    {
      id: "title_quality",
      passed: title.length >= 3 && title.length <= 200,
      detail:
        title.length >= 3 && title.length <= 200
          ? "Title length is within bounds."
          : "Title must be 3-200 characters.",
    },
    {
      id: "content_quality",
      passed: content.length >= 20 && content.length <= 32_768,
      detail:
        content.length >= 20 && content.length <= 32_768
          ? "Content length is within semantic-memory bounds."
          : "Content must be 20-32768 characters.",
    },
  ];

  return {
    passed: checks.every((check) => check.passed),
    checks,
    warnings: [],
  };
}

function detectObviousSecrets(content: string): string[] {
  const patterns: Array<[string, RegExp]> = [
    ["private_key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i],
    ["openai_like_key", /\bsk-[A-Za-z0-9_-]{20,}\b/],
    ["github_token", /\bgh[pousr]_[A-Za-z0-9]{20,}\b/i],
    ["slack_token", /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/i],
    ["aws_access_key", /\bAKIA[0-9A-Z]{16}\b/],
    ["bearer_token", /\bBearer\s+[A-Za-z0-9._~+\/-]{20,}/i],
    [
      "credential_assignment",
      /\b(?:password|passwd|api[_-]?key|secret|access[_-]?token)\s*[:=]\s*[^\s,;]{8,}/i,
    ],
  ];

  return patterns
    .filter(([, pattern]) => pattern.test(content))
    .map(([id]) => id);
}

function privacyGate(
  input: PromotionCandidateInput,
  sensitivity: SemanticSensitivity,
): GateReceipt {
  const privacySurface = [
    input.title,
    input.content,
    ...(input.tags ?? []),
  ].join("\n");
  const secretMatches = detectObviousSecrets(privacySurface);
  const pathWarnings = [
    ...privacySurface.matchAll(/\/(?:Users|home)\/[^\s"'<>]+/g),
  ].length;

  const checks = [
    {
      id: "recognized_sensitivity",
      passed: SENSITIVITIES.has(sensitivity),
      detail: SENSITIVITIES.has(sensitivity)
        ? `Sensitivity is explicitly labeled "${sensitivity}".`
        : "Sensitivity must be public, internal, or private.",
    },
    {
      id: "obvious_secret_scan",
      passed: secretMatches.length === 0,
      detail:
        secretMatches.length === 0
          ? "No obvious credential/token pattern detected."
          : `Blocked obvious secret pattern(s): ${secretMatches.join(", ")}.`,
    },
  ];

  const warnings: string[] = [];
  if (pathWarnings > 0) {
    warnings.push(
      "Content contains absolute user filesystem paths; review whether they belong in long-term memory.",
    );
  }
  if (sensitivity === "private") {
    warnings.push(
      "Private semantic memory is encrypted locally but still becomes durable long-term state.",
    );
  }

  return {
    passed: checks.every((check) => check.passed),
    checks,
    warnings,
  };
}

export async function inspectPromotionCandidate(
  input: PromotionCandidateInput,
): Promise<PromotionCandidate> {
  if (!KINDS.has(input.kind)) {
    throw new Error(
      'Semantic memory kind must be "fact", "preference", "procedure", "pattern", or "decision".',
    );
  }

  const task = await readPersistentTask(input.taskId);
  const sensitivity = input.sensitivity ?? "internal";
  const evidence = evidenceForTask(task, input.evidenceStepIds);
  const quality = qualityGate(task, input, evidence.stepIds);
  const privacy = privacyGate(input, sensitivity);
  const contentDigest = semanticDigest(input.content);
  const candidateDigest = createHash("sha256")
    .update(
      JSON.stringify({
        taskId: task.id,
        kind: input.kind,
        title: input.title.trim(),
        contentDigest,
        evidenceDigest: evidence.digest,
      }),
    )
    .digest("hex");

  return {
    taskId: task.id,
    taskLabel: task.label,
    kind: input.kind,
    title: input.title.trim(),
    content: input.content.trim(),
    tags: normalizeTags(input.tags),
    sensitivity,
    evidenceStepIds: evidence.stepIds,
    evidenceEventTypes: evidence.eventTypes,
    evidenceDigest: evidence.digest,
    contentDigest,
    candidateDigest,
    qualityGate: quality,
    privacyGate: privacy,
    promotable: quality.passed && privacy.passed,
  };
}

async function ensurePromotionBacklink(
  task: PersistentTask,
  record: SemanticMemoryRecord,
): Promise<boolean> {
  const alreadyLinked = task.events.some(
    (event) =>
      event.type === "semantic_promoted" &&
      event.message.includes(record.id),
  );
  if (alreadyLinked) return false;

  appendTaskEvent(task, {
    type: "semantic_promoted",
    message: `Promoted semantic memory ${record.id}: ${record.title}`,
  });
  await writePersistentTask(task);
  return true;
}

export async function promoteSemanticMemory(
  input: PromotionCandidateInput & { confirm: boolean },
): Promise<SemanticMemoryRecord> {
  if (input.confirm !== true) {
    throw new Error(
      "Semantic promotion requires confirm=true after inspecting the promotion candidate.",
    );
  }

  const candidate = await inspectPromotionCandidate(input);
  if (!candidate.promotable) {
    throw new Error(
      "Semantic promotion gate rejected candidate: " +
        [
          ...candidate.qualityGate.checks,
          ...candidate.privacyGate.checks,
        ]
          .filter((check) => !check.passed)
          .map((check) => `${check.id}: ${check.detail}`)
          .join(" | "),
    );
  }

  const duplicate = await findSemanticMemoryByDigest(candidate.contentDigest);
  if (duplicate) {
    const samePromotion =
      duplicate.source.taskId === candidate.taskId &&
      duplicate.promotion.candidateDigest === candidate.candidateDigest;
    if (!samePromotion) {
      throw new Error(
        `Equivalent semantic memory already exists as ${duplicate.id}.`,
      );
    }

    const duplicateTask = await readPersistentTask(candidate.taskId);
    await ensurePromotionBacklink(duplicateTask, duplicate);
    return duplicate;
  }

  const task = await readPersistentTask(candidate.taskId);
  const semanticText = [
    candidate.title,
    candidate.content,
    candidate.kind,
    ...candidate.tags,
  ].join(" ");
  const embedding = await embedTexts([semanticText]);
  const vector = embedding.embeddings[0]!;
  const now = new Date().toISOString();
  const record: SemanticMemoryRecord = {
    version: 1,
    id: newSemanticMemoryId(),
    kind: candidate.kind,
    title: candidate.title,
    content: candidate.content,
    tags: candidate.tags,
    sensitivity: candidate.sensitivity,
    createdAt: now,
    updatedAt: now,
    contentDigest: candidate.contentDigest,
    retrieval: {
      embedding: {
        descriptor: embedding.provider,
        vector,
      },
    },
    source: {
      taskId: task.id,
      taskLabel: task.label,
      taskCompletedAt: task.completedAt ?? task.updatedAt,
      evidenceStepIds: candidate.evidenceStepIds,
      evidenceEventTypes: candidate.evidenceEventTypes,
      evidenceDigest: candidate.evidenceDigest,
    },
    promotion: {
      explicit: true,
      promotedAt: now,
      candidateDigest: candidate.candidateDigest,
      qualityGate: candidate.qualityGate,
      privacyGate: candidate.privacyGate,
    },
  };

  await writeSemanticMemory(record);
  injectTestFault("semantic.after_memory_write_before_backlink");
  await ensurePromotionBacklink(task, record);

  return record;
}

export async function searchSemanticMemories(
  query = "",
  options?: {
    kind?: SemanticMemoryKind;
    tags?: string[];
    limit?: number;
    mode?: "hybrid" | "lexical" | "vector";
  },
) {
  const requiredTags = normalizeTags(options?.tags ?? []);
  const limit = Math.min(Math.max(Math.trunc(options?.limit ?? 20), 1), 100);
  const mode = options?.mode ?? "hybrid";
  const records = (await listSemanticMemories())
    .filter((record) => !options?.kind || record.kind === options.kind)
    .filter(
      (record) =>
        requiredTags.length === 0 ||
        requiredTags.every((tag) => record.tags.includes(tag)),
    );

  const queryVectors = new Map<string, number[] | null>();
  if (query.trim() && mode !== "lexical") {
    for (const record of records) {
      const descriptor: EmbeddingDescriptor =
        record.retrieval?.embedding.descriptor ??
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
      const searchableText = [
        record.title,
        record.content,
        record.kind,
        ...record.tags,
      ].join(" ");
      const descriptor: EmbeddingDescriptor =
        record.retrieval?.embedding.descriptor ??
        legacyFeatureHashDescriptor();
      const documentVector =
        record.retrieval?.embedding.vector ??
        featureHashVectorize(searchableText);
      const key = embeddingDescriptorKey(descriptor);
      const queryVector =
        mode === "lexical" ? null : queryVectors.get(key) ?? null;
      const score = query.trim()
        ? hybridRetrievalScore(
            query,
            searchableText,
            queryVector,
            documentVector,
            mode,
          )
        : { lexical: 0, vector: 0, combined: 1 };
      return { record, score, descriptor };
    })
    .filter((item) => !query.trim() || item.score.combined > 0)
    .sort(
      (a, b) =>
        b.score.combined - a.score.combined ||
        b.record.updatedAt.localeCompare(a.record.updatedAt),
    )
    .slice(0, limit)
    .map(({ record, score, descriptor }) => ({
      ...record,
      relevanceScore: score.combined,
      retrievalScore: score,
      embedding: descriptor,
    }));
}

export async function getSemanticMemory(id: string) {
  return await readSemanticMemory(id);
}

export async function removeSemanticMemory(id: string) {
  const record = await readSemanticMemory(id);
  await deleteSemanticMemory(id);
  return {
    id,
    deleted: true,
    title: record.title,
    sourceTaskId: record.source.taskId,
  };
}

export async function semanticMemoryStatus() {
  const records = await listSemanticMemories();
  return {
    available: true,
    promotionMode: "explicit",
    recordCount: records.length,
    storage: getSemanticStorageInfo(),
    retrieval: {
      modes: ["hybrid", "lexical", "vector"],
      embeddingProvider: getEmbeddingProviderStatus(),
      storedEmbeddingProviders: [
        ...new Set(
          records.map((record) => {
            const descriptor =
              record.retrieval?.embedding.descriptor ??
              legacyFeatureHashDescriptor();
            return `${descriptor.providerId}:${descriptor.model}:${descriptor.dimensions}`;
          }),
        ),
      ],
    },
    kinds: [...KINDS],
    sensitivities: [...SENSITIVITIES],
  };
}
