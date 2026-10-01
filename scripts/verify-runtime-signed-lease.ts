import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { generateKeyPairSync, sign } from "node:crypto";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "owl-runtime-signed-access-"));
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
process.env.OWL_RUNTIME_MODE = "test";
process.env.OWL_RUNTIME_ACCESS_MODE = "enforced";
process.env.OWL_RUNTIME_LEASE_PUBLIC_KEY_B64 = Buffer.from(
  publicKey.export({ type: "spki", format: "pem" }).toString(),
  "utf8",
).toString("base64");
process.env.OWL_STATE_ROOT = path.join(root, "state");
process.env.ALLOWED_DIRECTORIES = root;
process.env.ALLOW_WRITE = "true";
process.env.OWL_APPROVAL_MODE = "compat";

const { InProcessRuntimeClient } = await import("../src/public/runtimeClient.js");
const client = new InProcessRuntimeClient();

function leaseToken(overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  const claims = {
    schemaVersion: 1,
    issuer: "owl-cloud",
    audience: "owl-runtime",
    leaseId: "lease_test_signed",
    userId: "usr_signed",
    organizationId: "org_signed",
    deviceId: "dev_signed",
    plan: "trial",
    entitlementStatus: "trial_active",
    entitlementVersion: 1,
    features: {
      runtime: true,
      shell: true,
      browser: true,
      gui: true,
      persistentTasks: true,
      scheduler: true,
      loops: true,
      userSkills: true,
      remoteCommands: true,
      skillLibrary: true,
      cloudWorker: true,
    },
    limits: {
      devices: 1,
      concurrentTasks: 2,
      cloudWorkerMinutes: 300,
      storageMb: 2048,
    },
    issuedAt: new Date(now - 1_000).toISOString(),
    expiresAt: new Date(now + 60_000).toISOString(),
    ...overrides,
  };
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  const input = `owllease1.${payload}`;
  const signature = sign(null, Buffer.from(input, "utf8"), privateKey).toString(
    "base64url",
  );
  return `${input}.${signature}`;
}

try {
  const initial = await client.getRuntimeAccessState();
  assert.equal(initial.state, "LOCKED");

  await assert.rejects(
    () =>
      client.authorizeRuntimeAccess({
        deviceId: "dev_signed",
        canRun: true,
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    /RUNTIME_ACCESS_SIGNED_LEASE_REQUIRED/,
  );

  const ready = await client.authorizeRuntimeAccess({
    deviceId: "dev_signed",
    leaseToken: leaseToken(),
  });
  assert.equal(ready.state, "READY");
  assert.equal(ready.reasonCode, "AUTHORIZED_CLOUD_SIGNED_LEASE");
  assert.equal(ready.grant?.deviceId, "dev_signed");
  assert.equal(ready.grant?.principalId, "usr_signed");
  assert.equal(ready.grant?.source, "cloud-signed-lease");
  assert.equal(ready.grant?.signatureVerified, true);
  assert.equal(ready.grant?.entitlementPlan, "trial");
  assert.equal(ready.grant?.features?.runtime, true);

  await assert.rejects(
    () =>
      client.authorizeRuntimeAccess({
        deviceId: "dev_other",
        leaseToken: leaseToken(),
      }),
    /RUNTIME_ACCESS_DEVICE_MISMATCH/,
  );

  const valid = leaseToken();
  const [prefix, payload, signature] = valid.split(".");
  const tamperedPayload = Buffer.from(
    JSON.stringify({
      ...JSON.parse(Buffer.from(payload!, "base64url").toString("utf8")),
      deviceId: "dev_attacker",
    }),
  ).toString("base64url");
  await assert.rejects(
    () =>
      client.authorizeRuntimeAccess({
        deviceId: "dev_attacker",
        leaseToken: `${prefix}.${tamperedPayload}.${signature}`,
      }),
    /signature verification failed/,
  );

  await assert.rejects(
    () =>
      client.authorizeRuntimeAccess({
        deviceId: "dev_signed",
        leaseToken: leaseToken({
          issuedAt: new Date(Date.now() - 120_000).toISOString(),
          expiresAt: new Date(Date.now() - 60_000).toISOString(),
        }),
      }),
    /RUNTIME_ACCESS_LEASE_EXPIRED/,
  );

  console.log(
    JSON.stringify(
      {
        ok: true,
        unsignedProjectionRejected: true,
        signedLeaseAccepted: true,
        deviceBindingVerified: true,
        tamperRejected: true,
        expiryVerified: true,
      },
      null,
      2,
    ),
  );
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
