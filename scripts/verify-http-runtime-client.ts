import assert from "node:assert/strict";
import express from "express";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratch = path.join(root, ".tmp-verify-http-runtime-client");
await fs.rm(scratch, { recursive: true, force: true });
await fs.mkdir(scratch, { recursive: true });

process.env.OWL_RUNTIME_MODE = "test";
process.env.OWL_STATE_ROOT = path.join(scratch, "state");
process.env.ALLOWED_DIRECTORIES = root;
process.env.ALLOW_WRITE = "true";
process.env.ALLOW_DELETE = "true";
process.env.ALLOW_SHELL = "true";
process.env.OWL_APPROVAL_MODE = "compat";

const { registerRuntimeHttpApi } = await import(
  "../src/public/httpRuntimeApi.js"
);
const { HttpRuntimeClient } = await import("../src/public/httpRuntimeClient.js");
const { runtimeSessionManager } = await import(
  "../src/runtime/runtimeSessionManager.js"
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
  throw new Error("Runtime API test server has no TCP address.");
}
const baseUrl = `http://127.0.0.1:${address.port}`;

const sessionId = "dogfood:runtime-client:A";
const client = new HttpRuntimeClient({ baseUrl, sessionId });
const otherClient = new HttpRuntimeClient({
  baseUrl,
  sessionId: "dogfood:runtime-client:B",
});

let processId: string | undefined;

try {
  const info = await client.info();
  assert.equal(info.apiVersion, "0.1");
  assert.equal(info.transport, "http");

  const filePath = path.join(scratch, "transport.txt");
  const write = (await client.callPrimitive({
    primitive: "fs.write",
    op: "write",
    args: {
      path: filePath,
      content: "stable logical session",
      overwrite: true,
      create_parents: true,
    },
  })) as any;
  assert.equal(write.observation?.channel, "file");
  assert.equal(write.verification?.status, "verified");

  const started = (await client.callPrimitive({
    primitive: "process.manage",
    op: "start",
    args: {
      command:
        `${JSON.stringify(process.execPath)} -e ${JSON.stringify("setInterval(() => {}, 1000)")}`,
      cwd: scratch,
      workspace_mode: "read",
    },
  })) as any;

  processId = started.result?.processId;
  const controlToken = started.result?.controlToken;
  assert.equal(typeof processId, "string");
  assert.equal(typeof controlToken, "string");

  const observed = (await client.process({
    op: "observe",
    process_id: processId!,
  })) as any;
  assert.equal(observed.result?.state, "running");
  assert.equal(observed.result?.subject, processId);

  await assert.rejects(
    () =>
      otherClient.callPrimitive({
        primitive: "process.manage",
        op: "kill",
        args: { process_id: processId },
      }),
    (error: any) =>
      error?.name === "RuntimeRpcError" &&
      error?.code === "PROCESS_OWNED",
  );

  const killedAcrossTransport = (await otherClient.callPrimitive({
    primitive: "process.manage",
    op: "kill",
    args: {
      process_id: processId,
      control_token: controlToken,
    },
  })) as any;
  assert.ok(killedAcrossTransport.result);
  processId = undefined;

  const healthAfterCrossTransportControl = (await client.health({
    op: "providers",
  })) as any;
  assert.ok(healthAfterCrossTransportControl.result);

  const executionTargets = (await client.getExecutionTargets()) as any;
  assert.equal(executionTargets.defaultTarget, "host");
  assert.equal(executionTargets.silentFallback, false);

  const diagnostics = (await client.getDiagnostics({
    auditLimit: 0,
  })) as any;
  assert.equal(diagnostics.supportPackageVersion, 1);
  assert.equal(diagnostics.redaction.rawArgumentsIncluded, false);

  const session = runtimeSessionManager.status(sessionId);
  assert.ok(session);
  assert.ok((session?.totalCalls ?? 0) >= 5);
  assert.equal(session?.activeCalls, 0);

  const missingSession = await fetch(`${baseUrl}/runtime/v0.1/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ method: "info" }),
  });
  assert.equal(missingSession.status, 400);
  const missingPayload = (await missingSession.json()) as any;
  assert.equal(
    missingPayload.error?.code,
    "RUNTIME_SESSION_ID_REQUIRED",
  );

  process.env.OWL_RUNTIME_MODE = "production";
  delete process.env.OWL_RUNTIME_API_TOKEN;
  const unauthenticatedProduction = await fetch(
    `${baseUrl}/runtime/v0.1/info`,
  );
  assert.equal(unauthenticatedProduction.status, 401);

  process.env.OWL_RUNTIME_API_TOKEN = "test-runtime-api-token";
  const authenticatedProductionClient = new HttpRuntimeClient({
    baseUrl,
    sessionId: "dogfood:runtime-client:production",
    token: "test-runtime-api-token",
  });
  const authenticatedInfo = await authenticatedProductionClient.info();
  assert.equal(authenticatedInfo.apiVersion, "0.1");
  assert.equal(authenticatedInfo.transport, "http");
  process.env.OWL_RUNTIME_MODE = "test";
  delete process.env.OWL_RUNTIME_API_TOKEN;

  console.log(JSON.stringify({
    ok: true,
    publicHttpApi: true,
    stableLogicalSessionAcrossRequests: true,
    crossSessionProcessOwnershipRejectedWithoutCapability: true,
    crossSessionProcessCapabilityAccepted: true,
    fileObservationAndVerificationOverHttp: true,
    executionTargetManifestOverHttp: true,
    diagnosticsOverHttp: true,
    missingLogicalSessionRejected: true,
    productionBearerTokenRequired: true,
    callsObservedForSession: session?.totalCalls ?? 0,
  }, null, 2));
} finally {
  if (processId) {
    try {
      await client.callPrimitive({
        primitive: "process.manage",
        op: "kill",
        args: { process_id: processId },
      });
    } catch {
      // Best-effort test cleanup.
    }
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await fs.rm(scratch, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
}
