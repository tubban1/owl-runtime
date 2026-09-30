import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratch = path.join(root, ".tmp-verify-browser-cancellation");
await fs.rm(scratch, { recursive: true, force: true });
await fs.mkdir(scratch, { recursive: true });

process.env.OWL_RUNTIME_MODE = "test";
process.env.OWL_STATE_ROOT = path.join(scratch, "state");
process.env.BROWSER_PROFILE_DIR = path.join(scratch, "browser-profile");
process.env.ALLOW_BROWSER = "true";
process.env.ALLOWED_DIRECTORIES = root;

const { browserProvider } = await import("../src/providers/browserProvider.js");
const {
  OperationCancelledError,
  withCancellationSignal,
} = await import("../src/runtime/cancellation.js");

const browserStatus = await browserProvider.status();
if (!browserStatus.available) {
  console.log(JSON.stringify({
    ok: true,
    skipped: true,
    reason: "No supported Chromium browser executable is available.",
  }, null, 2));
  process.exit(0);
}

const hangingSockets = new Set<import("node:net").Socket>();
const hanging = http.createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.write("<!doctype html><html><body>still loading");
});
hanging.on("connection", (socket) => {
  hangingSockets.add(socket);
  socket.on("close", () => hangingSockets.delete(socket));
});
await new Promise<void>((resolve, reject) => {
  hanging.once("error", reject);
  hanging.listen(0, "127.0.0.1", () => resolve());
});
const hangingAddress = hanging.address();
if (!hangingAddress || typeof hangingAddress === "string") {
  throw new Error("Hanging fixture server has no TCP address.");
}
const hangingUrl = `http://127.0.0.1:${hangingAddress.port}/`;

const healthy = http.createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end("<!doctype html><html><head><title>Recovered</title></head><body>ready</body></html>");
});
await new Promise<void>((resolve, reject) => {
  healthy.once("error", reject);
  healthy.listen(0, "127.0.0.1", () => resolve());
});
const healthyAddress = healthy.address();
if (!healthyAddress || typeof healthyAddress === "string") {
  throw new Error("Healthy fixture server has no TCP address.");
}
const healthyUrl = `http://127.0.0.1:${healthyAddress.port}/`;

try {
  const controller = new AbortController();
  const startedAt = Date.now();
  const timer = setTimeout(() => {
    controller.abort("browser verifier cancellation");
  }, 400);

  await assert.rejects(
    () =>
      withCancellationSignal(controller.signal, async () =>
        await browserProvider.open(
          hangingUrl,
          "domcontentloaded",
          true,
        ),
      ),
    (error: unknown) =>
      error instanceof OperationCancelledError ||
      (error instanceof Error && /OPERATION_CANCELLED/.test(error.message)),
  );
  clearTimeout(timer);

  const cancelledInMs = Date.now() - startedAt;
  assert.ok(
    cancelledInMs < 5_000,
    `Browser cancellation took too long: ${cancelledInMs}ms`,
  );

  const recovered = await browserProvider.open(
    healthyUrl,
    "domcontentloaded",
    true,
  );
  assert.equal(recovered.title, "Recovered");
  assert.equal(recovered.url, healthyUrl);

  console.log(JSON.stringify({
    ok: true,
    browserCancellationInterruptsPendingNavigation: true,
    cancelledInMs,
    cancelledPageDoesNotPoisonProvider: true,
    providerRecoveredAfterCancellation: true,
    cancellationDoesNotClaimSideEffectRollback: true,
  }, null, 2));
} finally {
  await browserProvider.close().catch(() => undefined);
  for (const socket of hangingSockets) socket.destroy();
  await new Promise<void>((resolve) => hanging.close(() => resolve()));
  await new Promise<void>((resolve) => healthy.close(() => resolve()));
  await fs.rm(scratch, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
}
