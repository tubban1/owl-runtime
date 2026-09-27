import { createHash } from "node:crypto";
import {
  featureHashVectorize,
  LOCAL_VECTOR_DIMENSIONS,
  LOCAL_VECTORIZER,
} from "./retrievalVector.js";

export type EmbeddingProviderId =
  | "feature-hash"
  | "openai"
  | "openai-compatible"
  | "ollama";

export type EmbeddingDescriptor = {
  providerId: EmbeddingProviderId;
  model: string;
  dimensions: number;
  normalized: true;
  configFingerprint: string;
};

export type StoredEmbedding = {
  descriptor: EmbeddingDescriptor;
  vector: number[];
};

export type EmbeddingBatchResult = {
  provider: EmbeddingDescriptor;
  embeddings: number[][];
  usage?: {
    inputTokens?: number;
    totalTokens?: number;
  };
};

export type EmbeddingProviderStatus = {
  contractVersion: 1;
  providerId: EmbeddingProviderId;
  model: string;
  configured: boolean;
  endpoint?: string;
  dimensions?: number;
  normalized: true;
  remote: boolean;
  requiresApiKey: boolean;
  configFingerprint: string;
  fallbackProvider: "feature-hash" | "none";
};

export interface EmbeddingProvider {
  readonly id: EmbeddingProviderId;
  readonly model: string;
  readonly remote: boolean;
  readonly requiresApiKey: boolean;
  readonly endpoint?: string;
  readonly configured: boolean;
  readonly configFingerprint: string;
  embed(texts: string[]): Promise<EmbeddingBatchResult>;
}

type OpenAiEmbeddingResponse = {
  data?: Array<{ embedding?: number[]; index?: number }>;
  usage?: {
    prompt_tokens?: number;
    total_tokens?: number;
  };
  error?: { message?: string };
};

type OllamaEmbeddingResponse = {
  embeddings?: number[][];
};

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function isLoopbackEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "::1" ||
      host.endsWith(".localhost")
    );
  } catch {
    return false;
  }
}

function remoteEndpointAllowed(remote: boolean, allowRemote?: boolean): boolean {
  return !remote || allowRemote === true;
}

function configFingerprint(parts: Array<string | number | undefined>): string {
  return createHash("sha256")
    .update(parts.map((part) => String(part ?? "")).join("|"))
    .digest("hex")
    .slice(0, 16);
}

function normalizeVector(vector: number[]): number[] {
  if (!Array.isArray(vector) || vector.length === 0) {
    throw new Error("Embedding provider returned an empty vector.");
  }
  if (!vector.every((value) => typeof value === "number" && Number.isFinite(value))) {
    throw new Error("Embedding provider returned a non-finite vector.");
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (norm === 0) return vector.map(() => 0);
  return vector.map((value) => value / norm);
}

function descriptor(
  providerId: EmbeddingProviderId,
  model: string,
  vector: number[],
  fingerprint: string,
): EmbeddingDescriptor {
  return {
    providerId,
    model,
    dimensions: vector.length,
    normalized: true,
    configFingerprint: fingerprint,
  };
}

function featureHashProvider(): EmbeddingProvider {
  const model = LOCAL_VECTORIZER;
  const fingerprint = configFingerprint([
    "feature-hash",
    model,
    LOCAL_VECTOR_DIMENSIONS,
  ]);
  return {
    id: "feature-hash",
    model,
    remote: false,
    requiresApiKey: false,
    configured: true,
    configFingerprint: fingerprint,
    async embed(texts) {
      const embeddings = texts.map((text) => featureHashVectorize(text));
      return {
        provider: {
          providerId: "feature-hash",
          model,
          dimensions: LOCAL_VECTOR_DIMENSIONS,
          normalized: true,
          configFingerprint: fingerprint,
        },
        embeddings,
      };
    },
  };
}

function openAiLikeProvider(
  id: "openai" | "openai-compatible",
  options: {
    baseUrl: string;
    model: string;
    apiKey?: string;
    dimensions?: number;
    allowRemote?: boolean;
  },
): EmbeddingProvider {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const endpoint = baseUrl.endsWith("/v1")
    ? `${baseUrl}/embeddings`
    : `${baseUrl}/v1/embeddings`;
  const fingerprint = configFingerprint([
    id,
    baseUrl,
    options.model,
    options.dimensions,
  ]);
  const requiresApiKey = id === "openai";
  const remote = !isLoopbackEndpoint(baseUrl);

  return {
    id,
    model: options.model,
    endpoint,
    remote,
    requiresApiKey,
    configured:
      Boolean(options.model) &&
      (!requiresApiKey || Boolean(options.apiKey)) &&
      remoteEndpointAllowed(remote, options.allowRemote),
    configFingerprint: fingerprint,
    async embed(texts) {
      if (texts.length === 0) {
        throw new Error("Embedding input must contain at least one text.");
      }
      if (requiresApiKey && !options.apiKey) {
        throw new Error(
          "OPENAI_API_KEY is required when EMBEDDING_PROVIDER=openai.",
        );
      }
      if (remote && options.allowRemote !== true) {
        throw new Error(
          `Embedding endpoint ${baseUrl} is not loopback. Set EMBEDDING_ALLOW_REMOTE=true before sending memory text off-device.`,
        );
      }

      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(options.apiKey
            ? { authorization: `Bearer ${options.apiKey}` }
            : {}),
        },
        body: JSON.stringify({
          model: options.model,
          input: texts,
          encoding_format: "float",
          ...(options.dimensions
            ? { dimensions: options.dimensions }
            : {}),
        }),
      });
      const payload = (await response.json()) as OpenAiEmbeddingResponse;
      if (!response.ok) {
        throw new Error(
          `Embedding provider ${id} returned HTTP ${response.status}: ${payload.error?.message ?? response.statusText}`,
        );
      }

      const data = [...(payload.data ?? [])].sort(
        (a, b) => (a.index ?? 0) - (b.index ?? 0),
      );
      const embeddings = data.map((item) =>
        normalizeVector(item.embedding ?? []),
      );
      if (embeddings.length !== texts.length) {
        throw new Error(
          `Embedding provider ${id} returned ${embeddings.length} vectors for ${texts.length} inputs.`,
        );
      }

      return {
        provider: descriptor(
          id,
          options.model,
          embeddings[0]!,
          fingerprint,
        ),
        embeddings,
        usage: {
          ...(payload.usage?.prompt_tokens !== undefined
            ? { inputTokens: payload.usage.prompt_tokens }
            : {}),
          ...(payload.usage?.total_tokens !== undefined
            ? { totalTokens: payload.usage.total_tokens }
            : {}),
        },
      };
    },
  };
}

function ollamaProvider(options: {
  baseUrl: string;
  model: string;
  allowRemote?: boolean;
}): EmbeddingProvider {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const endpoint = `${baseUrl}/api/embed`;
  const remote = !isLoopbackEndpoint(baseUrl);
  const fingerprint = configFingerprint([
    "ollama",
    baseUrl,
    options.model,
  ]);

  return {
    id: "ollama",
    model: options.model,
    endpoint,
    remote,
    requiresApiKey: false,
    configured:
      Boolean(options.model) &&
      remoteEndpointAllowed(remote, options.allowRemote),
    configFingerprint: fingerprint,
    async embed(texts) {
      if (!options.model) {
        throw new Error(
          "EMBEDDING_MODEL or OLLAMA_EMBEDDING_MODEL is required for Ollama embeddings.",
        );
      }
      if (remote && options.allowRemote !== true) {
        throw new Error(
          `Embedding endpoint ${baseUrl} is not loopback. Set EMBEDDING_ALLOW_REMOTE=true before sending memory text off-device.`,
        );
      }
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: options.model,
          input: texts,
        }),
      });
      const payload = (await response.json()) as OllamaEmbeddingResponse;
      if (!response.ok) {
        throw new Error(
          `Ollama embedding provider returned HTTP ${response.status}: ${response.statusText}`,
        );
      }
      const embeddings = (payload.embeddings ?? []).map(normalizeVector);
      if (embeddings.length !== texts.length) {
        throw new Error(
          `Ollama returned ${embeddings.length} vectors for ${texts.length} inputs.`,
        );
      }
      return {
        provider: descriptor(
          "ollama",
          options.model,
          embeddings[0]!,
          fingerprint,
        ),
        embeddings,
      };
    },
  };
}

function requestedProviderId(): EmbeddingProviderId {
  const value =
    process.env.EMBEDDING_PROVIDER?.trim().toLowerCase() || "feature-hash";
  if (
    !["feature-hash", "openai", "openai-compatible", "ollama"].includes(
      value,
    )
  ) {
    throw new Error(
      'EMBEDDING_PROVIDER must be "feature-hash", "openai", "openai-compatible", or "ollama".',
    );
  }
  return value as EmbeddingProviderId;
}

export function getEmbeddingProvider(
  forcedId?: EmbeddingProviderId,
  forcedModel?: string,
): EmbeddingProvider {
  const providerId = forcedId ?? requestedProviderId();

  if (providerId === "feature-hash") {
    return featureHashProvider();
  }

  if (providerId === "openai") {
    return openAiLikeProvider("openai", {
      baseUrl:
        process.env.OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1",
      model:
        forcedModel ||
        process.env.OPENAI_EMBEDDING_MODEL?.trim() ||
        process.env.EMBEDDING_MODEL?.trim() ||
        "text-embedding-3-small",
      apiKey: process.env.OPENAI_API_KEY?.trim(),
      allowRemote:
        process.env.EMBEDDING_ALLOW_REMOTE?.trim().toLowerCase() === "true",
      dimensions: Number.isFinite(Number(process.env.OPENAI_EMBEDDING_DIMENSIONS))
        ? Number(process.env.OPENAI_EMBEDDING_DIMENSIONS)
        : undefined,
    });
  }

  if (providerId === "openai-compatible") {
    return openAiLikeProvider("openai-compatible", {
      baseUrl:
        process.env.EMBEDDING_BASE_URL?.trim() || "http://127.0.0.1:8080/v1",
      model:
        forcedModel ||
        process.env.EMBEDDING_MODEL?.trim() ||
        "local-embedding-model",
      apiKey: process.env.EMBEDDING_API_KEY?.trim(),
      allowRemote:
        process.env.EMBEDDING_ALLOW_REMOTE?.trim().toLowerCase() === "true",
      dimensions: Number.isFinite(Number(process.env.EMBEDDING_DIMENSIONS))
        ? Number(process.env.EMBEDDING_DIMENSIONS)
        : undefined,
    });
  }

  return ollamaProvider({
    baseUrl:
      process.env.OLLAMA_BASE_URL?.trim() || "http://127.0.0.1:11434",
    model:
      forcedModel ||
      process.env.OLLAMA_EMBEDDING_MODEL?.trim() ||
      process.env.EMBEDDING_MODEL?.trim() ||
      "nomic-embed-text",
    allowRemote:
      process.env.EMBEDDING_ALLOW_REMOTE?.trim().toLowerCase() === "true",
  });
}

function fallbackEnabled(): boolean {
  return (
    (process.env.EMBEDDING_FALLBACK_PROVIDER?.trim().toLowerCase() ||
      "feature-hash") !== "none"
  );
}

export async function embedTexts(
  texts: string[],
  options?: {
    providerId?: EmbeddingProviderId;
    model?: string;
    allowFallback?: boolean;
  },
): Promise<EmbeddingBatchResult & { fallbackUsed: boolean; error?: string }> {
  const primary = getEmbeddingProvider(options?.providerId, options?.model);
  try {
    const result = await primary.embed(texts);
    return { ...result, fallbackUsed: false };
  } catch (error) {
    const allowFallback =
      options?.allowFallback ?? fallbackEnabled();
    if (!allowFallback || primary.id === "feature-hash") {
      throw error;
    }
    const fallback = featureHashProvider();
    const result = await fallback.embed(texts);
    return {
      ...result,
      fallbackUsed: true,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function legacyFeatureHashDescriptor(): EmbeddingDescriptor {
  const provider = featureHashProvider();
  return {
    providerId: provider.id,
    model: provider.model,
    dimensions: LOCAL_VECTOR_DIMENSIONS,
    normalized: true,
    configFingerprint: provider.configFingerprint,
  };
}

export function embeddingDescriptorKey(
  value: EmbeddingDescriptor,
): string {
  return [
    value.providerId,
    value.model,
    value.dimensions,
    value.configFingerprint,
  ].join("|");
}

export async function embedQueryForDescriptor(
  query: string,
  target: EmbeddingDescriptor,
): Promise<number[] | null> {
  if (target.providerId === "feature-hash") {
    return featureHashVectorize(query);
  }

  const provider = getEmbeddingProvider(
    target.providerId,
    target.model,
  );
  if (provider.configFingerprint !== target.configFingerprint) {
    return null;
  }

  try {
    const result = await provider.embed([query]);
    const vector = result.embeddings[0];
    if (!vector || vector.length !== target.dimensions) {
      return null;
    }
    return vector;
  } catch {
    return null;
  }
}

export function getEmbeddingProviderStatus(): EmbeddingProviderStatus {
  const provider = getEmbeddingProvider();
  return {
    contractVersion: 1,
    providerId: provider.id,
    model: provider.model,
    configured: provider.configured,
    ...(provider.endpoint ? { endpoint: provider.endpoint } : {}),
    ...(provider.id === "feature-hash"
      ? { dimensions: LOCAL_VECTOR_DIMENSIONS }
      : {}),
    normalized: true,
    remote: provider.remote,
    requiresApiKey: provider.requiresApiKey,
    configFingerprint: provider.configFingerprint,
    fallbackProvider: fallbackEnabled() ? "feature-hash" : "none",
  };
}
