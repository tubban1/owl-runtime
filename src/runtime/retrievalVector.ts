export const LOCAL_VECTOR_DIMENSIONS = 256;
export const LOCAL_VECTORIZER = "feature-hash-v1";

function normalizeText(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

function wordTokens(value: string): string[] {
  const normalized = normalizeText(value);
  if (!normalized) return [];

  const tokens: string[] = [];
  try {
    const segmenter = new Intl.Segmenter(undefined, { granularity: "word" });
    for (const part of segmenter.segment(normalized)) {
      if (part.isWordLike && part.segment.trim().length > 0) {
        tokens.push(part.segment.trim());
      }
    }
  } catch {
    tokens.push(...normalized.split(/[^\p{L}\p{N}_-]+/u).filter(Boolean));
  }

  // Character n-grams improve matching for CJK text and spelling variants.
  const compact = normalized.replace(/\s+/g, "");
  if (compact.length >= 3) {
    const max = Math.min(compact.length - 2, 512);
    for (let i = 0; i < max; i += 1) {
      tokens.push(`#${compact.slice(i, i + 3)}`);
    }
  }

  return tokens.slice(0, 2048);
}

function fnv1a32(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function featureHashVectorize(value: string): number[] {
  const vector = new Array<number>(LOCAL_VECTOR_DIMENSIONS).fill(0);
  for (const token of wordTokens(value)) {
    const hash = fnv1a32(token);
    const bucket = hash % LOCAL_VECTOR_DIMENSIONS;
    const sign = (hash & 0x80000000) === 0 ? 1 : -1;
    vector[bucket] += sign;
  }

  const norm = Math.sqrt(vector.reduce((sum, item) => sum + item * item, 0));
  if (norm === 0) return vector;
  return vector.map((item) => Number((item / norm).toFixed(6)));
}

export function cosineSimilarity(a: number[], b: number[]): number {
  const length = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < length; i += 1) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export function lexicalScore(query: string, text: string): number {
  const queryTokens = [...new Set(wordTokens(query).filter((token) => !token.startsWith("#")))];
  if (queryTokens.length === 0) return 0;
  const haystack = normalizeText(text);
  let matched = 0;
  for (const token of queryTokens) {
    if (haystack.includes(token)) matched += 1;
  }
  return matched / queryTokens.length;
}

export function hybridRetrievalScore(
  query: string,
  text: string,
  queryVector: number[] | null,
  documentVector: number[] | null,
  mode: "hybrid" | "lexical" | "vector" = "hybrid",
): { lexical: number; vector: number; combined: number } {
  const lexical = lexicalScore(query, text);
  const vectorScore =
    queryVector && documentVector
      ? Math.max(0, cosineSimilarity(queryVector, documentVector))
      : 0;
  const combined =
    mode === "lexical"
      ? lexical
      : mode === "vector"
        ? vectorScore
        : lexical * 0.55 + vectorScore * 0.45;
  return {
    lexical: Number(lexical.toFixed(6)),
    vector: Number(vectorScore.toFixed(6)),
    combined: Number(combined.toFixed(6)),
  };
}

export const vectorizeText = featureHashVectorize;
