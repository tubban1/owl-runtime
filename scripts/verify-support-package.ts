import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratch = path.join(root, ".tmp-verify-support-package");
await fs.rm(scratch, { recursive: true, force: true });
await fs.mkdir(scratch, { recursive: true });

process.env.OWL_RUNTIME_MODE = "test";
process.env.OWL_STATE_ROOT = path.join(scratch, "state");
process.env.ALLOWED_DIRECTORIES = root;
process.env.ALLOW_WRITE = "true";
process.env.ALLOW_DELETE = "true";
process.env.ALLOW_SHELL = "true";
process.env.ALLOW_BROWSER = "false";
process.env.ALLOW_GUI = "false";
process.env.AUDIT_LOG_ENABLED = "true";
process.env.OWL_APPROVAL_MODE = "compat";

const secret = "support-package-super-secret-value";
const bearer = "support-package-bearer-secret";
const {
  InProcessRuntimeClient,
} = await import("../src/public/index.js");
const {
  appendAudit,
} = await import("../src/audit.js");

const client = new InProcessRuntimeClient();

try {
  await appendAudit({
    timestamp: new Date().toISOString(),
    tool: "diagnostic.test",
    status: "error",
    durationMs: 12,
    args: {
      content: secret,
      command: `echo ${secret}`,
    },
    error:
      `failed at ${path.join(os.homedir(), "private", "project")} Bearer ${bearer} token=${secret}`,
  });

  const task = (await client.createTask({
    label: "sensitive task label that must not be exported",
    executionTarget: { kind: "host", providerAffinity: ["filesystem"] },
    steps: [
      {
        id: "read",
        action: "fs.list",
        args: { path: scratch },
      },
    ],
  })) as any;

  const diagnostics = (await client.getDiagnostics({
    auditLimit: 20,
  })) as any;

  assert.equal(diagnostics.supportPackageVersion, 1);
  assert.equal(diagnostics.runtime.version, "0.10.0-dev.0");
  assert.equal(diagnostics.runtime.executionTargets.defaultTarget, "host");
  assert.equal(diagnostics.redaction.rawArgumentsIncluded, false);
  assert.equal(diagnostics.redaction.commandTextIncluded, false);
  assert.equal(diagnostics.redaction.stdoutIncluded, false);
  assert.equal(diagnostics.redaction.fileContentsIncluded, false);
  assert.ok(diagnostics.tasks.count >= 1);
  assert.ok(diagnostics.audit.returned >= 1);

  const serialized = JSON.stringify(diagnostics);
  assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes(bearer), false);
  assert.equal(serialized.includes(task.id), false);
  assert.equal(
    serialized.includes("sensitive task label that must not be exported"),
    false,
  );
  assert.equal(serialized.includes(os.homedir()), false);
  assert.equal(serialized.includes("<home>"), true);

  const diagnosticAudit = diagnostics.audit.recent.find(
    (entry: any) => entry.tool === "diagnostic.test",
  );
  assert.ok(diagnosticAudit);
  assert.equal(diagnosticAudit.status, "error");
  assert.match(diagnosticAudit.error, /<home>/);
  assert.match(diagnosticAudit.error, /Bearer <redacted>/);
  assert.match(diagnosticAudit.error, /token=<redacted>/);

  console.log(
    JSON.stringify(
      {
        ok: true,
        machineReadable: true,
        runtimeAndPlatformSummary: true,
        providerHealthIncluded: true,
        taskSummaryWithoutLabels: true,
        processSummaryWithoutCommands: true,
        leaseSummaryWithoutPaths: true,
        auditArgsExcluded: true,
        auditErrorsRedacted: true,
        homePathRedacted: true,
        rawIdsExcluded: true,
      },
      null,
      2,
    ),
  );
} finally {
  await fs.rm(scratch, { recursive: true, force: true });
}
