import type { PersistentTaskStatus } from "../tasks/taskStore.js";
import {
  episodicIndexStatus,
  rebuildGlobalEpisodicIndex,
  searchGlobalEpisodes,
} from "./episodicIndex.js";
import {
  searchSemanticMemories,
  semanticMemoryStatus,
} from "./memoryPromotion.js";
import type { SemanticMemoryKind } from "./semanticStore.js";

export type RecallScope = "episodic" | "semantic" | "both";
export type RecallMode = "hybrid" | "lexical" | "vector";

export async function recallMemory(
  query: string,
  options?: {
    scope?: RecallScope;
    mode?: RecallMode;
    limit?: number;
    statuses?: PersistentTaskStatus[];
    semanticKind?: SemanticMemoryKind;
    tags?: string[];
  },
) {
  const scope = options?.scope ?? "both";
  const mode = options?.mode ?? "hybrid";
  const limit = Math.min(Math.max(Math.trunc(options?.limit ?? 20), 1), 100);

  const episodic =
    scope === "semantic"
      ? []
      : await searchGlobalEpisodes(query, {
          mode,
          statuses: options?.statuses,
          limit,
        });

  const semantic =
    scope === "episodic"
      ? []
      : await searchSemanticMemories(query, {
          mode,
          kind: options?.semanticKind,
          tags: options?.tags,
          limit,
        });

  const combined = [
    ...episodic.map((item) => ({
      memoryType: "episodic" as const,
      id: item.episodeId,
      sourceTaskId: item.taskId,
      title: item.label,
      status: item.status,
      terminalAt: item.terminalAt,
      score: item.score,
      details: item,
    })),
    ...semantic.map((item) => ({
      memoryType: "semantic" as const,
      id: item.id,
      sourceTaskId: item.source.taskId,
      title: item.title,
      kind: item.kind,
      updatedAt: item.updatedAt,
      score: item.retrievalScore,
      details: item,
    })),
  ]
    .sort(
      (a, b) =>
        (b.score?.combined ?? 0) - (a.score?.combined ?? 0),
    )
    .slice(0, limit);

  return {
    query,
    scope,
    mode,
    resultCount: combined.length,
    results: combined,
  };
}

export async function recallStatus() {
  const [episodic, semantic] = await Promise.all([
    episodicIndexStatus(),
    semanticMemoryStatus(),
  ]);
  return {
    available: true,
    scopes: ["episodic", "semantic", "both"],
    modes: ["hybrid", "lexical", "vector"],
    episodic,
    semantic,
  };
}

export async function rebuildRecallIndexes() {
  return {
    episodic: await rebuildGlobalEpisodicIndex(),
    semantic: {
      rebuilt: false,
      reason:
        "Semantic records are already self-contained; v0.9.9 computes local vectors deterministically at retrieval time.",
    },
  };
}
