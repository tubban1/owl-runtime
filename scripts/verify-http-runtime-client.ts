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
process.env.OWL_RUNTIME_ACCESS_MODE = "enforced";
process.env.OWL_RUNTIME_REQUIRE_SIGNED_LEASE = "false";
delete process.env.OWL_RUNTIME_LEASE_PUBLIC_KEY_PEM;
delete process.env.OWL_RUNTIME_LEASE_PUBLIC_KEY_B64;
delete process.env.OWL_RUNTIME_LEASE_PUBLIC_KEY_FILE;
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

  const lockedAccess = await client.getRuntimeAccessState();
  assert.equal(lockedAccess.state, "LOCKED");
  await assert.rejects(
    () =>
      client.invoke(
        "tasks.create",
        {
          label: "must remain locked",
          steps: [],
        },
        {
          requestId: "access:locked",
          idempotencyKey: "access-locked-task",
        },
      ),
    (error: any) =>
      error?.name === "RuntimeRpcError" &&
      error?.code === "RUNTIME_ACCESS_LOCKED",
  );

  await assert.rejects(
    () => client.listTasks(),
    (error: any) =>
      error?.name === "RuntimeRpcError" &&
      error?.code === "RUNTIME_ACCESS_LOCKED",
  );
  await assert.rejects(
    () => client.getCapabilities("locked-read"),
    (error: any) =>
      error?.name === "RuntimeRpcError" &&
      error?.code === "RUNTIME_ACCESS_LOCKED",
  );

  const readyAccess = await client.authorizeRuntimeAccess({
    deviceId: "dev_http_access",
    organizationId: "org_http_access",
    principalId: "user_http_access",
    canRun: true,
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  assert.equal(readyAccess.state, "READY");

  const capabilities = (await client.getCapabilities("idempotency")) as any;
  assert.equal(capabilities.extensions.consequentialRequestReplay.version, 1);
  assert.equal(
    capabilities.extensions.consequentialRequestReplay.keyHeader,
    "x-owl-idempotency-key",
  );

  const replayTaskRequest = {
    label: "http idempotency task",
    steps: [
      {
        id: "read",
        action: "fs.read",
        args: { path: path.join(scratch, "missing-ok.txt") },
      },
    ],
  };
  const replayTaskA = (await client.invoke(
    "tasks.create",
    replayTaskRequest,
    {
      requestId: "http-replay:first",
      idempotencyKey: "http-task-create-1",
    },
  )) as any;
  const replayTaskB = (await client.invoke(
    "tasks.create",
    replayTaskRequest,
    {
      requestId: "http-replay:retry",
      idempotencyKey: "http-task-create-1",
    },
  )) as any;
  assert.equal(replayTaskA.id, replayTaskB.id);

  const replayTasks = (await client.listTasks()) as any[];
  assert.equal(
    replayTasks.filter((task) => task.label === "http idempotency task").length,
    1,
  );

  await assert.rejects(
    () =>
      client.invoke(
        "tasks.create",
        { ...replayTaskRequest, label: "different request" },
        {
          requestId: "http-replay:conflict",
          idempotencyKey: "http-task-create-1",
        },
      ),
    (error: any) =>
      error?.name === "RuntimeRpcError" &&
      error?.code === "IDEMPOTENCY_KEY_CONFLICT",
  );

  const replayTaskOtherSession = (await otherClient.invoke(
    "tasks.create",
    replayTaskRequest,
    {
      requestId: "http-replay:other-session",
      idempotencyKey: "http-task-create-1",
    },
  )) as any;
  assert.notEqual(replayTaskOtherSession.id, replayTaskA.id);

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

  const detachedTask = await client.createTask({
    label: "http detached task",
    steps: [
      {
        id: "read",
        action: "fs.read",
        args: { path: filePath },
      },
    ],
  });
  const detachedStart = await client.startTask({
    taskId: detachedTask.id,
    expectedRevisionDigest: detachedTask.executionRevision?.digest,
  });
  assert.equal(detachedStart.accepted, true);
  assert.equal(detachedStart.progress.schemaVersion, 1);
  let detachedStatus = await client.getTask(detachedTask.id);
  const detachedDeadline = Date.now() + 10_000;
  while (!detachedStatus.progress.terminal && Date.now() < detachedDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    detachedStatus = await client.getTask(detachedTask.id);
  }
  assert.equal(detachedStatus.status, "completed");
  assert.ok(detachedStatus.progress.revision >= detachedStart.progress.revision);
  await client.deleteTask(detachedTask.id);

  const publicEvents = await client.listEvents({
    afterCursor: "runtime-events:0",
    limit: 100,
    types: ["agent_request.proposed", "agent_request.withdrawn"],
  });
  assert.deepEqual(publicEvents.events, []);
  assert.equal(publicEvents.nextCursor, "runtime-events:0");
  assert.equal(publicEvents.hasMore, false);
  assert.equal(publicEvents.retention.newestSequence, null);

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
    durablePublicEventsOverHttp: true,
    detachedTaskStartOverHttp: true,
    taskProgressProjectionOverHttp: true,
    consequentialReplayOverHttp: true,
    replayKeyConflictFailClosed: true,
    replayKeyScopedToLogicalSession: true,
    diagnosticsOverHttp: true,
    missingLogicalSessionRejected: true,
    productionBearerTokenRequired: true,
    callsObservedForSession: session?.totalCalls ?? 0,
  }, null, 2));
} finally {
  try {
    const tasks = (await client.listTasks()) as any[];
    for (const task of tasks) {
      if (task.label === "http idempotency task") {
        await client.deleteTask(task.id).catch(() => undefined);
      }
    }
    const otherTasks = (await otherClient.listTasks()) as any[];
    for (const task of otherTasks) {
      if (task.label === "http idempotency task") {
        await otherClient.deleteTask(task.id).catch(() => undefined);
      }
    }
  } catch {
    // Best-effort replay task cleanup.
  }
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
