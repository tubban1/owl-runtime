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
process.env.BROWSER_STARTUP_BUDGET_MS = "90000";

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

assert.equal(browserStatus.details?.startupBudgetMs, 90_000);
const realBrowserExecutable =
  typeof browserStatus.details?.executable === "string"
    ? browserStatus.details.executable
    : null;
assert.ok(realBrowserExecutable, "Expected a real Chromium executable.");

const fakeBrowserExecutable = path.join(scratch, "fake-browser.sh");
await fs.writeFile(
  fakeBrowserExecutable,
  "#!/bin/sh\nexec /bin/sleep 30\n",
  { mode: 0o755 },
);

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
  process.env.BROWSER_EXECUTABLE = fakeBrowserExecutable;
  process.env.BROWSER_STARTUP_TIMEOUT_MS = "5000";
  process.env.BROWSER_CONNECT_TIMEOUT_MS = "5000";
  process.env.BROWSER_STARTUP_ATTEMPTS = "3";
  process.env.BROWSER_STARTUP_BUDGET_MS = "10000";

  const startupController = new AbortController();
  const startupStartedAt = Date.now();
  const startupTimer = setTimeout(() => {
    startupController.abort("browser cold-start cancellation");
  }, 150);

  await assert.rejects(
    () =>
      withCancellationSignal(startupController.signal, async () =>
        await browserProvider.open(
          healthyUrl,
          "domcontentloaded",
          true,
        ),
      ),
    (error: unknown) =>
      error instanceof OperationCancelledError ||
      (error instanceof Error && /OPERATION_CANCELLED/.test(error.message)),
  );
  clearTimeout(startupTimer);

  const startupCancelledInMs = Date.now() - startupStartedAt;
  assert.ok(
    startupCancelledInMs < 3_000,
    `Browser cold-start cancellation took too long: ${startupCancelledInMs}ms`,
  );

  const slowBrowserExecutable = path.join(scratch, "slow-browser.sh");
  await fs.writeFile(
    slowBrowserExecutable,
    [
      "#!/bin/sh",
      "sleep 0.8",
      `exec ${JSON.stringify(realBrowserExecutable)} "$@"`,
      "",
    ].join("\n"),
    { mode: 0o755 },
  );

  process.env.BROWSER_EXECUTABLE = slowBrowserExecutable;
  process.env.BROWSER_STARTUP_TIMEOUT_MS = "10000";
  process.env.BROWSER_CONNECT_TIMEOUT_MS = "10000";
  process.env.BROWSER_STARTUP_ATTEMPTS = "1";
  process.env.BROWSER_STARTUP_BUDGET_MS = "15000";

  const sharedController = new AbortController();
  const cancelledWaiter = withCancellationSignal(
    sharedController.signal,
    async () => await browserProvider.open(healthyUrl, "domcontentloaded", true),
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  const survivingWaiter = browserProvider.open(
    healthyUrl,
    "domcontentloaded",
    true,
  );
  const sharedCancelTimer = setTimeout(() => {
    sharedController.abort("cancel one shared browser waiter");
  }, 150);

  await assert.rejects(
    () => cancelledWaiter,
    (error: unknown) =>
      error instanceof OperationCancelledError ||
      (error instanceof Error && /OPERATION_CANCELLED/.test(error.message)),
  );
  clearTimeout(sharedCancelTimer);

  const sharedRecovered = await survivingWaiter;
  assert.equal(sharedRecovered.title, "Recovered");
  await browserProvider.close();

  const closeDuringStartup = browserProvider.open(
    healthyUrl,
    "domcontentloaded",
    true,
  );
  await new Promise((resolve) => setTimeout(resolve, 120));
  const closeStartedAt = Date.now();
  await browserProvider.close();
  const closeDuringStartupMs = Date.now() - closeStartedAt;
  await assert.rejects(
    () => closeDuringStartup,
    (error: unknown) =>
      error instanceof OperationCancelledError ||
      (error instanceof Error && /OPERATION_CANCELLED/.test(error.message)),
  );
  assert.ok(
    closeDuringStartupMs < 3_000,
    `Browser close during cold start took too long: ${closeDuringStartupMs}ms`,
  );

  process.env.BROWSER_EXECUTABLE = realBrowserExecutable;
  delete process.env.BROWSER_STARTUP_TIMEOUT_MS;
  delete process.env.BROWSER_CONNECT_TIMEOUT_MS;
  delete process.env.BROWSER_STARTUP_ATTEMPTS;
  process.env.BROWSER_STARTUP_BUDGET_MS = "90000";

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
    browserColdStartCancellation: true,
    startupCancelledInMs,
    sharedLaunchCancellationIsolated: true,
    closeDuringColdStartIsBounded: true,
    closeDuringStartupMs,
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
