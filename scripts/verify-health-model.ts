import assert from "node:assert/strict";
import { createObservation } from "../src/observation/observationAbi.js";
import {
  aggregateHealth,
  approvalHealth,
  getHealthModelManifest,
  processHealth,
  providerHealth,
  taskHealth,
} from "../src/health/healthModel.js";

const runningTask = taskHealth({ id: "task_a", status: "running", label: "Daily report" });
const blockedTask = taskHealth({ id: "task_b", status: "blocked" });
const failedTask = taskHealth({ id: "task_c", status: "failed" });
assert.equal(runningTask.state, "healthy");
assert.equal(blockedTask.state, "needs_attention");
assert.equal(failedTask.state, "broken");

const waitingProcess = processHealth(createObservation({
  channel: "process", provider: "managed-process", subject: "process_a",
  state: "waiting_input", data: {}, evidence: [],
}));
assert.equal(waitingProcess.state, "needs_attention");
assert.equal(waitingProcess.actionable, true);

const pendingApproval = approvalHealth({
  version: 1, id: "approval_test", subjectType: "action", subject: "git.push",
  fingerprint: "abc", riskLevel: "high", sideEffects: ["remote_git_write"],
  state: "pending", requestedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 60000).toISOString(), ownerSessionId: "test", reason: "test",
});
assert.equal(pendingApproval.state, "needs_attention");

const desktopMissingPermissions = providerHealth({
  id: "desktop",
  label: "Desktop",
  enabled: true,
  available: true,
  capabilities: ["desktop", "accessibility", "region-screenshot"],
  details: {
    helperInstalled: true,
    helperMode: "required",
    helper: {
      accessibilityTrusted: false,
      screenCaptureAllowed: false,
    },
  },
});
assert.equal(desktopMissingPermissions.state, "needs_attention");
assert.equal(desktopMissingPermissions.code, "provider_permissions_missing");
assert.deepEqual(
  desktopMissingPermissions.details?.missingPermissions,
  ["accessibility", "screen_recording"],
);

const healthyBrowser = providerHealth({
  id: "browser",
  label: "Browser",
  enabled: true,
  available: true,
  capabilities: ["browser"],
});
assert.equal(healthyBrowser.state, "healthy");

const aggregate = aggregateHealth([runningTask, blockedTask]);
assert.equal(aggregate.state, "needs_attention");
assert.equal(aggregate.actionable, true);

const allPaused = aggregateHealth([
  taskHealth({ id: "task_p1", status: "paused" }),
  taskHealth({ id: "task_p2", status: "cancelled" }),
]);
assert.equal(allPaused.state, "paused");

const manifest = getHealthModelManifest();
assert.equal(manifest.version, 1);
assert.ok(manifest.states.includes("degraded"));
assert.ok(manifest.states.includes("needs_attention"));
assert.ok(manifest.states.includes("broken"));

console.log(JSON.stringify({
  ok: true,
  healthModelVersion: manifest.version,
  stableStates: manifest.states,
  taskSignals: true,
  processSignals: true,
  approvalSignals: true,
  aggregateHealth: true,
}, null, 2));
