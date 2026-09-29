import assert from "node:assert/strict";
import express from "express";
import http from "node:http";

process.env.OWL_RUNTIME_MODE = "test";

const {
  emitRuntimeProviderTelemetry,
  runtimeProviderTelemetry,
  RUNTIME_TELEMETRY_MAX_EVENTS,
} = await import("../src/observability/providerTelemetry.js");
const { registerRuntimeHttpApi } = await import(
  "../src/public/httpRuntimeApi.js"
);

runtimeProviderTelemetry.resetForTest();

const first = emitRuntimeProviderTelemetry({
  eventId: "rtel-test-1",
  eventType: "runtime.health.changed",
  severity: "info",
  component: "runtime.health",
  operation: "aggregate",
  attributes: { state: "healthy", architecture: process.arch },
});

assert.equal(first.producer, "owl-runtime");
assert.equal(first.eventVersion, 1);
assert.equal(first.componentVersion.length > 0, true);

const page = runtimeProviderTelemetry.list(0, 10);
assert.equal(page.events.length, 1);
assert.equal(page.events[0]?.cursor, 1);
assert.equal(page.events[0]?.event.eventId, "rtel-test-1");

assert.throws(
  () =>
    emitRuntimeProviderTelemetry({
      eventType: "runtime.invalid",
      severity: "error",
      component: "runtime.test",
      attributes: { accessToken: "must-not-exist" },
    }),
  /TELEMETRY_SENSITIVE_ATTRIBUTE_KEY/,
);

for (let index = 0; index < RUNTIME_TELEMETRY_MAX_EVENTS + 5; index += 1) {
  emitRuntimeProviderTelemetry({
    eventId: `rtel-bounded-${index}`,
    eventType: "runtime.sample",
    severity: "info",
    component: "runtime.test",
  });
}
const bounded = runtimeProviderTelemetry.list(0, 100);
assert.equal(bounded.oldestCursor !== null && bounded.oldestCursor > 1, true);
assert.equal(bounded.events.length, 100);

runtimeProviderTelemetry.resetForTest();

const app = express();
app.use(express.json({ limit: "1mb" }));
registerRuntimeHttpApi(app);
const server = http.createServer(app);
await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => resolve());
});

try {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Telemetry verification server has no address");
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const empty = await fetch(`${baseUrl}/runtime/v0.1/telemetry?after=0&limit=100`);
  assert.equal(empty.status, 200);
  const emptyPayload = (await empty.json()) as any;
  assert.equal(emptyPayload.result.events.length, 0);

  const failedRpc = await fetch(`${baseUrl}/runtime/v0.1/rpc`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-owl-request-id": "corr-provider-telemetry-test",
    },
    body: JSON.stringify({ method: "info" }),
  });
  assert.equal(failedRpc.status, 400);

  const telemetry = await fetch(
    `${baseUrl}/runtime/v0.1/telemetry?after=0&limit=100`,
  );
  assert.equal(telemetry.status, 200);
  const payload = (await telemetry.json()) as any;
  assert.equal(payload.result.events.length, 1);
  const event = payload.result.events[0].event;
  assert.equal(event.eventType, "runtime.rpc.failed");
  assert.equal(event.errorCode, "RUNTIME_SESSION_ID_REQUIRED");
  assert.equal(event.errorFingerprint, "runtime_rpc:unknown:RUNTIME_SESSION_ID_REQUIRED");
  assert.equal(event.correlationId, "corr-provider-telemetry-test");
  assert.equal("message" in event, false);
  assert.equal("params" in event, false);

  const invalidLimit = await fetch(
    `${baseUrl}/runtime/v0.1/telemetry?after=0&limit=101`,
  );
  assert.equal(invalidLimit.status, 400);

  console.log(JSON.stringify({
    ok: true,
    providerTelemetryBufferBounded: true,
    privacySensitiveKeysRejected: true,
    localTelemetryFeed: true,
    rpcFailureTelemetryNoPayload: true,
  }, null, 2));
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
