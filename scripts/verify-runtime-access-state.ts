import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "owl-runtime-access-"));
process.env.OWL_RUNTIME_MODE = "test";
process.env.OWL_RUNTIME_ACCESS_MODE = "enforced";
process.env.OWL_RUNTIME_REQUIRE_SIGNED_LEASE = "false";
delete process.env.OWL_RUNTIME_LEASE_PUBLIC_KEY_PEM;
delete process.env.OWL_RUNTIME_LEASE_PUBLIC_KEY_B64;
delete process.env.OWL_RUNTIME_LEASE_PUBLIC_KEY_FILE;
process.env.OWL_STATE_ROOT = path.join(root, "state");
process.env.ALLOWED_DIRECTORIES = root;
process.env.ALLOW_WRITE = "true";
process.env.OWL_APPROVAL_MODE = "compat";

const { InProcessRuntimeClient } = await import("../src/public/runtimeClient.js");
const client = new InProcessRuntimeClient();
const target = path.join(root, "proof.txt");

async function expectDenied(pattern: RegExp) {
  await assert.rejects(
    () =>
      client.callPrimitive({
        primitive: "fs.write",
        op: "write",
        args: { path: target, content: "proof\n", overwrite: true },
      }),
    pattern,
  );
}

try {
  const initial = await client.getRuntimeAccessState();
  assert.equal(initial.state, "LOCKED");
  await expectDenied(/RUNTIME_ACCESS_LOCKED/);

  const ready = await client.authorizeRuntimeAccess({
    deviceId: "dev_access_e2e",
    organizationId: "org_access_e2e",
    principalId: "user_access_e2e",
    canRun: true,
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    evidence: { source: "cloud-effective-access", canRun: true },
  });
  assert.equal(ready.state, "READY");
  assert.equal(ready.grant?.deviceId, "dev_access_e2e");

  await client.callPrimitive({
    primitive: "fs.write",
    op: "write",
    args: { path: target, content: "proof\n", overwrite: true },
  });
  assert.equal(await fs.readFile(target, "utf8"), "proof\n");

  const locked = await client.lockRuntimeAccess("ACCOUNT_LOGGED_OUT");
  assert.equal(locked.state, "LOCKED");
  await expectDenied(/RUNTIME_ACCESS_LOCKED/);

  const readyAgain = await client.authorizeRuntimeAccess({
    deviceId: "dev_access_e2e",
    canRun: true,
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  assert.equal(readyAgain.state, "READY");

  const revoked = await client.revokeRuntimeAccess("DEVICE_REVOKED");
  assert.equal(revoked.state, "REVOKED");
  await expectDenied(/RUNTIME_ACCESS_REVOKED/);

  await client.authorizeRuntimeAccess({
    deviceId: "dev_reenrolled",
    canRun: true,
    leaseExpiresAt: new Date(Date.now() + 80).toISOString(),
  });
  await new Promise((resolve) => setTimeout(resolve, 120));
  const expired = await client.getRuntimeAccessState();
  assert.equal(expired.state, "LOCKED");
  assert.equal(expired.reasonCode, "LEASE_EXPIRED");
  await expectDenied(/RUNTIME_ACCESS_LEASE_EXPIRED/);

  console.log(
    JSON.stringify(
      {
        ok: true,
        initial: "LOCKED",
        authorized: "READY",
        lockedAfterLogout: true,
        revokedBlocksMutations: true,
        expiredLeaseBlocksMutations: true,
        readOnlyStateAvailableWhileLocked: true,
      },
      null,
      2,
    ),
  );
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
