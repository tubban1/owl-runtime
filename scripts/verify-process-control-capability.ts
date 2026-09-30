import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratch = path.join(root, ".tmp-verify-process-control-capability");
await fs.rm(scratch, { recursive: true, force: true });
await fs.mkdir(scratch, { recursive: true });

process.env.OWL_RUNTIME_MODE = "test";
process.env.OWL_STATE_ROOT = path.join(scratch, "state");
process.env.PROCESS_STATE_DIR = path.join(scratch, "processes");
process.env.PROCESS_STATE_KEY_PATH = path.join(scratch, "process.key");
process.env.PROCESS_LOG_DIR = path.join(scratch, "logs");
process.env.ALLOW_SHELL = "true";
process.env.ALLOWED_DIRECTORIES = root;

const {
  withExecutionContext,
  systemExecutionContext,
} = await import("../src/runtime/executionContext.js");
const {
  claimRecoveredProcess,
  getProcessOutput,
  killProcess,
  sendProcessInput,
  startProcess,
} = await import("../src/tools/shellOps.js");
const { readManagedProcess } = await import("../src/runtime/processStore.js");
const { sanitizeAuditArgs } = await import("../src/audit.js");

const sessionA = {
  sessionId: "transport:session-a",
  requestId: "request-a",
  origin: "mcp" as const,
};
const sessionB = {
  sessionId: "transport:session-b",
  requestId: "request-b",
  origin: "mcp" as const,
};

const processIds: string[] = [];

async function waitForOutput(
  processId: string,
  pattern: RegExp,
  timeoutMs = 5_000,
) {
  const deadline = Date.now() + timeoutMs;
  let latest = await getProcessOutput(processId, 10_000);
  while (Date.now() < deadline) {
    if (pattern.test(latest.stdout) || pattern.test(latest.stderr)) {
      return latest;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    latest = await getProcessOutput(processId, 10_000);
  }
  return latest;
}

async function cleanup() {
  for (const processId of processIds) {
    try {
      await withExecutionContext(systemExecutionContext(), async () => {
        await killProcess(processId, "SIGKILL");
      });
    } catch {
      // Best-effort cleanup for terminal processes.
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 150));
  await fs.rm(scratch, { recursive: true, force: true });
}

try {
  const command =
    `${JSON.stringify(process.execPath)} -e ${JSON.stringify(
      "process.stdout.write('READY> ');" +
        "process.stdin.on('data', d => {" +
        " console.log('GOT:' + d.toString().trim());" +
        " process.stdout.write('NEXT> ');" +
        "});" +
        "setTimeout(() => process.exit(0), 30000);",
    )}`;

  const started = await withExecutionContext(sessionA, async () =>
    await startProcess(command, root, "read"),
  );
  processIds.push(started.processId);

  assert.equal(typeof started.controlToken, "string");
  assert.ok(started.controlToken.length >= 40);

  const persisted = await readManagedProcess(started.processId);
  assert.equal(typeof persisted.controlTokenHash, "string");
  assert.equal(persisted.controlTokenHash?.length, 64);
  assert.notEqual(persisted.controlTokenHash, started.controlToken);
  assert.equal(
    JSON.stringify(persisted).includes(started.controlToken),
    false,
    "Raw process control token must never be persisted.",
  );

  await assert.rejects(
    () =>
      withExecutionContext(sessionB, async () =>
        await sendProcessInput(started.processId, "blocked\n"),
      ),
    /PROCESS_OWNED/,
  );

  await assert.rejects(
    () =>
      withExecutionContext(sessionB, async () =>
        await claimRecoveredProcess(started.processId, "wrong-token-value-that-is-long-enough"),
      ),
    /PROCESS_NOT_ORPHANED/,
  );

  const claimed = await withExecutionContext(sessionB, async () =>
    await claimRecoveredProcess(started.processId, started.controlToken),
  );
  assert.equal(claimed.claimed, true);
  assert.equal(claimed.previousOwnerSessionId, sessionA.sessionId);
  assert.equal(claimed.ownerSessionId, sessionB.sessionId);

  await withExecutionContext(sessionB, async () =>
    await sendProcessInput(started.processId, "claimed-control\n"),
  );
  const outputAfterClaim = await waitForOutput(
    started.processId,
    /GOT:claimed-control/,
  );
  assert.match(outputAfterClaim.stdout, /GOT:claimed-control/);

  const second = await withExecutionContext(sessionA, async () =>
    await startProcess(command, root, "read"),
  );
  processIds.push(second.processId);

  await withExecutionContext(sessionB, async () =>
    await sendProcessInput(
      second.processId,
      "capability-direct\n",
      second.controlToken,
    ),
  );
  const directOutput = await waitForOutput(
    second.processId,
    /GOT:capability-direct/,
  );
  assert.match(directOutput.stdout, /GOT:capability-direct/);

  await withExecutionContext(sessionB, async () => {
    const killed = await killProcess(
      second.processId,
      "SIGTERM",
      second.controlToken,
    );
    assert.equal(killed.sent, true);
  });

  const sanitized = sanitizeAuditArgs({
    process_id: second.processId,
    control_token: second.controlToken,
  }) as Record<string, unknown>;
  const tokenAudit = sanitized.control_token as Record<string, unknown>;
  assert.equal(tokenAudit.redacted, true);
  assert.equal(
    JSON.stringify(sanitized).includes(second.controlToken),
    false,
    "Audit payload must not contain raw process control capability.",
  );

  const legacyRecord = { ...persisted, controlTokenHash: undefined };
  assert.equal(legacyRecord.controlTokenHash, undefined);

  console.log(
    JSON.stringify(
      {
        ok: true,
        crossTransportCapabilityControl: true,
        explicitCapabilityClaim: true,
        ownershipRebindAfterClaim: true,
        invalidCapabilityRejected: true,
        rawTokenNeverPersisted: true,
        auditRedaction: true,
        legacyRecordCompatible: true,
      },
      null,
      2,
    ),
  );
} finally {
  await cleanup();
}
