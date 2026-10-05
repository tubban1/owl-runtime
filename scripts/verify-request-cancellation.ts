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
process.env.OWL_RUNTIME_REQUIRE_SIGNED_LEASE = "false";
delete process.env.OWL_RUNTIME_LEASE_PUBLIC_KEY_PEM;
delete process.env.OWL_RUNTIME_LEASE_PUBLIC_KEY_B64;
delete process.env.OWL_RUNTIME_LEASE_PUBLIC_KEY_FILE;

const parentPath = path.join(scratch, "parent.cjs");
const childPath = path.join(scratch, "child.cjs");
const markerPath = path.join(scratch, "should-not-exist.txt");
const queuedHttpMarkerPath = path.join(
  scratch,
  "queued-http-should-not-exist.txt",
);

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
const { resourceArbiter } = await import(
  "../src/runtime/resourceArbiter.js"
);
const {
  OperationCancelledError,
  withCancellationSignal,
} = await import("../src/runtime/cancellation.js");

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

await client.authorizeRuntimeAccess({
  deviceId: "verify-request-cancellation",
  organizationId: "owl-runtime-test",
  principalId: "verify-request-cancellation",
  canRun: true,
  leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
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

  // A real HTTP disconnect while a write is waiting behind a conflicting
  // resource must cancel the queued Runtime work. Releasing the holder later
  // must not produce a delayed filesystem side effect.
  const httpHolder = await resourceArbiter.acquire("http-disconnect-holder", [
    { key: `fs:${queuedHttpMarkerPath}`, mode: "exclusive" },
  ]);
  const disconnectRequestId = "dogfood:cancellation:http-disconnect";
  const disconnectBody = JSON.stringify({
    method: "primitive.call",
    params: {
      primitive: "fs.write",
      op: "write",
      args: {
        path: queuedHttpMarkerPath,
        content: "late side effect",
        overwrite: true,
        create_parents: true,
      },
    },
  });
  const disconnectUrl = new URL("/runtime/v0.1/rpc", baseUrl);
  const disconnectRequest = http.request(
    {
      hostname: disconnectUrl.hostname,
      port: disconnectUrl.port,
      path: disconnectUrl.pathname,
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(disconnectBody),
        "x-owl-session-id": sessionId,
        "x-owl-request-id": disconnectRequestId,
      },
    },
  );
  disconnectRequest.on("error", () => undefined);
  disconnectRequest.write(disconnectBody);
  disconnectRequest.end();

  const pendingDeadline = Date.now() + 3_000;
  while (
    !resourceArbiter.status().pending.some(
      (item) => item.action === "fs.write",
    )
  ) {
    if (Date.now() >= pendingDeadline) {
      throw new Error("HTTP disconnect verifier never entered resource wait.");
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  disconnectRequest.destroy();

  const cancelledDeadline = Date.now() + 3_000;
  while (
    resourceArbiter.status().pending.some(
      (item) => item.action === "fs.write",
    )
  ) {
    if (Date.now() >= cancelledDeadline) {
      throw new Error(
        "HTTP-disconnected request remained in the resource queue.",
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  httpHolder.release();
  await new Promise((resolve) => setTimeout(resolve, 100));
  await assert.rejects(() => fs.access(queuedHttpMarkerPath));

  // A cancelled request waiting behind a conflicting resource must be removed
  // from the Arbiter queue. It must never execute later after the holder
  // releases the resource.
  const holder = await resourceArbiter.acquire("holder", [
    { key: "verify:cancellation-resource", mode: "exclusive" },
  ]);
  const queuedController = new AbortController();
  const queued = withCancellationSignal(
    queuedController.signal,
    async () =>
      await resourceArbiter.acquire("cancelled-waiter", [
        { key: "verify:cancellation-resource", mode: "exclusive" },
      ]),
  );
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(
    resourceArbiter.status().pending.some(
      (item) => item.action === "cancelled-waiter",
    ),
    true,
  );
  queuedController.abort("queued request disconnected");
  await assert.rejects(
    () => queued,
    (error: unknown) => error instanceof OperationCancelledError,
  );
  assert.equal(
    resourceArbiter.status().pending.some(
      (item) => item.action === "cancelled-waiter",
    ),
    false,
  );
  holder.release();
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(resourceArbiter.status().heldTickets, 0);

  const fresh = await resourceArbiter.acquire("fresh-waiter", [
    { key: "verify:cancellation-resource", mode: "exclusive" },
  ]);
  assert.ok(fresh.waitMs < 100);
  fresh.release();

  console.log(JSON.stringify({
    ok: true,
    explicitRequestCancellation: true,
    crossSessionCancellationRejected: true,
    operationCancelledError: true,
    processGroupTerminated: true,
    noGrandchildOrphanMarker: true,
    activeRequestRegistryCleaned: true,
    httpDisconnectCancelsQueuedWork: true,
    noLateSideEffectAfterHttpDisconnect: true,
    cancelledResourceWaitRemoved: true,
    cancelledResourceWaitNeverGrantedLater: true,
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
