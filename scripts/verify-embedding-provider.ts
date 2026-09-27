import assert from "node:assert/strict";
import http from "node:http";

const ENV_KEYS = [
  "EMBEDDING_PROVIDER",
  "EMBEDDING_FALLBACK_PROVIDER",
  "EMBEDDING_MODEL",
  "EMBEDDING_BASE_URL",
  "EMBEDDING_API_KEY",
  "EMBEDDING_DIMENSIONS",
  "OPENAI_BASE_URL",
  "OPENAI_API_KEY",
  "OPENAI_EMBEDDING_MODEL",
  "OPENAI_EMBEDDING_DIMENSIONS",
  "EMBEDDING_ALLOW_REMOTE",
  "OLLAMA_BASE_URL",
  "OLLAMA_EMBEDDING_MODEL",
] as const;

const previous = Object.fromEntries(
  ENV_KEYS.map((key) => [key, process.env[key]]),
) as Record<(typeof ENV_KEYS)[number], string | undefined>;

for (const key of ENV_KEYS) delete process.env[key];

const {
  embedQueryForDescriptor,
  embedTexts,
  getEmbeddingProviderStatus,
} = await import("../src/runtime/embeddingProvider.js");

let lastRequest:
  | {
      url: string;
      authorization: string | null;
      body: any;
    }
  | undefined;

const server = http.createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const bodyText = Buffer.concat(chunks).toString("utf8");
  const body = bodyText ? JSON.parse(bodyText) : {};
  lastRequest = {
    url: req.url ?? "",
    authorization: req.headers.authorization ?? null,
    body,
  };

  res.setHeader("content-type", "application/json");
  if (req.url === "/v1/embeddings") {
    const inputs = Array.isArray(body.input) ? body.input : [body.input];
    res.end(
      JSON.stringify({
        data: inputs.map((_input: unknown, index: number) => ({
          index,
          embedding: [3 + index, 4, 0],
        })),
        usage: {
          prompt_tokens: inputs.length * 2,
          total_tokens: inputs.length * 2,
        },
      }),
    );
    return;
  }

  if (req.url === "/api/embed") {
    const inputs = Array.isArray(body.input) ? body.input : [body.input];
    res.end(
      JSON.stringify({
        embeddings: inputs.map((_input: unknown, index: number) => [
          0,
          5 + index,
          12,
        ]),
      }),
    );
    return;
  }

  res.statusCode = 404;
  res.end(JSON.stringify({ error: { message: "not found" } }));
});

await new Promise<void>((resolve) =>
  server.listen(0, "127.0.0.1", resolve),
);
const address = server.address();
if (!address || typeof address === "string") {
  throw new Error("Embedding verifier server failed to bind.");
}
const origin = `http://127.0.0.1:${address.port}`;

try {
  const defaultStatus = getEmbeddingProviderStatus();
  assert.equal(defaultStatus.providerId, "feature-hash");
  assert.equal(defaultStatus.configured, true);
  assert.equal(defaultStatus.remote, false);

  const local = await embedTexts(["durable local memory"], {
    allowFallback: false,
  });
  assert.equal(local.provider.providerId, "feature-hash");
  assert.equal(local.provider.dimensions, 256);
  assert.equal(local.fallbackUsed, false);
  assert.equal(local.embeddings[0]?.length, 256);

  process.env.EMBEDDING_PROVIDER = "openai";
  process.env.OPENAI_API_KEY = "sk-verifier-not-real";
  process.env.OPENAI_BASE_URL = "https://api.openai.com/v1";
  process.env.OPENAI_EMBEDDING_MODEL = "text-embedding-3-small";
  delete process.env.EMBEDDING_ALLOW_REMOTE;
  process.env.EMBEDDING_FALLBACK_PROVIDER = "none";

  const gatedStatus = getEmbeddingProviderStatus();
  assert.equal(gatedStatus.providerId, "openai");
  assert.equal(gatedStatus.configured, false);
  assert.equal(gatedStatus.remote, true);
  await assert.rejects(
    () =>
      embedTexts(["must stay local"], {
        allowFallback: false,
      }),
    /EMBEDDING_ALLOW_REMOTE=true/,
  );

  process.env.EMBEDDING_FALLBACK_PROVIDER = "feature-hash";
  const gatedFallback = await embedTexts(["must stay local"]);
  assert.equal(gatedFallback.fallbackUsed, true);
  assert.equal(gatedFallback.provider.providerId, "feature-hash");
  assert.match(gatedFallback.error ?? "", /EMBEDDING_ALLOW_REMOTE=true/);

  process.env.EMBEDDING_ALLOW_REMOTE = "true";
  process.env.OPENAI_BASE_URL = origin + "/v1";
  process.env.EMBEDDING_FALLBACK_PROVIDER = "none";
  const openai = await embedTexts(["one", "two"], {
    allowFallback: false,
  });
  assert.equal(openai.provider.providerId, "openai");
  assert.equal(openai.provider.model, "text-embedding-3-small");
  assert.equal(openai.provider.dimensions, 3);
  assert.equal(openai.embeddings.length, 2);
  assert.equal(lastRequest?.url, "/v1/embeddings");
  assert.equal(lastRequest?.authorization, "Bearer sk-verifier-not-real");
  assert.deepEqual(lastRequest?.body.input, ["one", "two"]);
  assert.equal(lastRequest?.body.encoding_format, "float");

  const queryVector = await embedQueryForDescriptor(
    "query",
    openai.provider,
  );
  assert.equal(queryVector?.length, 3);

  process.env.EMBEDDING_PROVIDER = "openai-compatible";
  process.env.EMBEDDING_BASE_URL = "https://embeddings.example.test/v1";
  process.env.EMBEDDING_MODEL = "private-compatible";
  delete process.env.EMBEDDING_API_KEY;
  delete process.env.EMBEDDING_ALLOW_REMOTE;

  const remoteCompatibleStatus = getEmbeddingProviderStatus();
  assert.equal(remoteCompatibleStatus.remote, true);
  assert.equal(remoteCompatibleStatus.configured, false);
  await assert.rejects(
    () =>
      embedTexts(["must not leave device"], {
        allowFallback: false,
      }),
    /EMBEDDING_ALLOW_REMOTE=true/,
  );

  process.env.EMBEDDING_BASE_URL = origin + "/v1";
  process.env.EMBEDDING_MODEL = "local-openai-compatible";

  const compatible = await embedTexts(["local compatible"], {
    allowFallback: false,
  });
  assert.equal(compatible.provider.providerId, "openai-compatible");
  assert.equal(compatible.provider.model, "local-openai-compatible");
  assert.equal(compatible.provider.dimensions, 3);
  assert.equal(lastRequest?.url, "/v1/embeddings");
  assert.equal(lastRequest?.authorization, null);

  process.env.EMBEDDING_PROVIDER = "ollama";
  process.env.OLLAMA_BASE_URL = origin;
  process.env.OLLAMA_EMBEDDING_MODEL = "nomic-embed-text";

  const ollama = await embedTexts(["local ollama"], {
    allowFallback: false,
  });
  assert.equal(ollama.provider.providerId, "ollama");
  assert.equal(ollama.provider.model, "nomic-embed-text");
  assert.equal(ollama.provider.dimensions, 3);
  assert.equal(lastRequest?.url, "/api/embed");

  console.log(
    JSON.stringify(
      {
        ok: true,
        contractVersion: 1,
        defaultProvider: defaultStatus.providerId,
        featureHashDimensions: local.provider.dimensions,
        openAiRemoteGate: true,
        openAiMock: {
          endpoint: "/v1/embeddings",
          model: openai.provider.model,
          dimensions: openai.provider.dimensions,
          descriptorQueryCompatibility: true,
        },
        openAiCompatibleMock: true,
        nonLoopbackCompatibleRemoteGate: true,
        ollamaMock: true,
        fallbackToLocal: gatedFallback.fallbackUsed,
      },
      null,
      2,
    ),
  );
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const key of ENV_KEYS) {
    const value = previous[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
