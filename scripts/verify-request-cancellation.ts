import assert from "node:assert/strict";
import express from "express";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratch = path.join(root, ".tmp-verify-request-cancellation");
await fs.rm(scratch, { recursive: true, force: true });
await fs.mkdir(scratch, { recursive: true });

process.env.OWL_RUNTIME_MODE = "test";
process.env.OWL_STATE_ROOT = path.join(scratch, "state");
process.env.ALLOWED_DIRECTORIES = root;
process.env.ALLOW_SHELL = "true";
process.env.OWL_APPROVAL_MODE = "compat";

const parentPath = path.join(scratch, "parent.cjs");
const childPath = path.join(scratch, "child.cjs");
const markerPath = path.join(scratch, "should-not-exist.txt");

await fs.writeFile(
  childPath,
  [
    "const fs = require('fs');",
    `setTimeout(() => fs.writeFileSync(${JSON.stringify(markerPath)}, 'orphan'), 1500);`,
    "setInterval(() => {}, 1000);",
  ].join("\n"),
);
await fs.writeFile(
  parentPath,
  [
    "const { spawn } = require('child_process');",
    `spawn(process.execPath, [${JSON.stringify(childPath)}], { stdio: 'ignore' });`,
    "setInterval(() => {}, 1000);",
  ].join("\n"),
);

const { registerRuntimeHttpApi } = await import(
  "../src/public/httpRuntimeApi.js"
);
const {
  HttpRuntimeClient,
  RuntimeRpcError,
} = await import("../src/public/httpRuntimeClient.js");
const { runtimeRequestCancellationRegistry } = await import(
  "../src/runtime/requestCancellationRegistry.js"
);

const app = express();
app.use(express.json({ limit: "1mb" }));
registerRuntimeHttpApi(app);

const server = http.createServer(app);
await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => resolve());
});
const address = server.address();
if (!address || typeof address === "string") {
  throw new Error("Cancellation test server has no TCP address.");
}
const baseUrl = `http://127.0.0.1:${address.port}`;

const sessionId = "dogfood:cancellation:A";
const requestId = "dogfood:cancellation:request-1";
const client = new HttpRuntimeClient({ baseUrl, sessionId });
const otherClient = new HttpRuntimeClient({
  baseUrl,
  sessionId: "dogfood:cancellation:B",
});

async function waitUntilActive(timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (
      runtimeRequestCancellationRegistry
        .list(sessionId)
        .some((request) => request.requestId === requestId)
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Cancellation test request never became active.");
}

try {
  const running = client.invoke(
    "primitive.call",
    {
      primitive: "sys.exec",
      op: "run",
      args: {
        command: `${JSON.stringify(process.execPath)} ${JSON.stringify(parentPath)}`,
        cwd: scratch,
        timeout_ms: 30_000,
      },
    },
    { requestId },
  );

  await waitUntilActive();

  await assert.rejects(
    () => otherClient.cancelRequest(requestId, "cross-session cancel"),
    (error: unknown) =>
      error instanceof RuntimeRpcError &&
      error.code === "REQUEST_OWNED",
  );

  const cancelResult = (await client.cancelRequest(
    requestId,
    "user cancelled the Runtime request",
  )) as any;
  assert.equal(cancelResult.cancelled, true);
  assert.equal(cancelResult.status, "cancelling");

  await assert.rejects(
    () => running,
    (error: unknown) =>
      error instanceof RuntimeRpcError &&
      error.code === "OPERATION_CANCELLED",
  );

  await new Promise((resolve) => setTimeout(resolve, 2_200));
  await assert.rejects(() => fs.access(markerPath));

  assert.equal(
    runtimeRequestCancellationRegistry
      .list(sessionId)
      .some((request) => request.requestId === requestId),
    false,
  );

  console.log(JSON.stringify({
    ok: true,
    explicitRequestCancellation: true,
    crossSessionCancellationRejected: true,
    operationCancelledError: true,
    processGroupTerminated: true,
    noGrandchildOrphanMarker: true,
    activeRequestRegistryCleaned: true,
  }, null, 2));
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await fs.rm(scratch, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
}
