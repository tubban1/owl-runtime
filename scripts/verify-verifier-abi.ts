import assert from "node:assert/strict";
import { createObservation } from "../src/observation/observationAbi.js";
import {
  getVerifierAbiManifest,
  verificationFollowUp,
  verifyObservation,
} from "../src/verification/verifier.js";

const downloaded = createObservation({
  channel: "file",
  provider: "filesystem",
  state: "ready",
  data: { path: "/tmp/orders.csv", bytes: 2048, rows: 127 },
  evidence: [{ kind: "file_metadata", metadata: { bytes: 2048 } }],
});

const verified = verifyObservation(downloaded, {
  id: "download-orders",
  expectations: [
    { path: "data.bytes", operator: "gt", expected: 0 },
    { path: "data.rows", operator: "equals", expected: 127 },
  ],
});
assert.equal(verified.status, "verified");
assert.equal(
  verificationFollowUp(verified, { idempotent: false, retryPolicy: "manual", sideEffects: ["download"] }),
  "accept",
);

const uncertain = verifyObservation(downloaded, {
  id: "email-sent",
  expectations: [{ path: "data.sentFolderMessageId", operator: "exists" }],
});
assert.equal(uncertain.status, "failed");

const missingRecipient = verifyObservation(downloaded, {
  id: "email-recipient",
  expectations: [{ path: "data.recipient", operator: "equals", expected: "buyer@example.test" }],
});
assert.equal(missingRecipient.status, "uncertain");
assert.equal(
  verificationFollowUp(missingRecipient, {
    idempotent: false,
    retryPolicy: "manual",
    sideEffects: ["external_message"],
  }),
  "review",
);

const mismatch = verifyObservation(
  createObservation({
    channel: "web",
    provider: "browser",
    data: { recipient: "wrong@example.test" },
    evidence: [{ kind: "dom" }],
  }),
  {
    id: "recipient-check",
    expectations: [{ path: "data.recipient", operator: "equals", expected: "buyer@example.test" }],
  },
);
assert.equal(mismatch.status, "failed");
assert.equal(
  verificationFollowUp(mismatch, { idempotent: true, retryPolicy: "automatic", sideEffects: [] }),
  "retry",
);
assert.equal(
  verificationFollowUp(mismatch, { idempotent: false, retryPolicy: "manual", sideEffects: ["external_message"] }),
  "review",
);

const manifest = getVerifierAbiManifest();
assert.equal(manifest.version, 1);
assert.ok(manifest.statuses.includes("uncertain"));

console.log(JSON.stringify({
  ok: true,
  verifierAbiVersion: manifest.version,
  verifiedStatus: verified.status,
  uncertainStatus: missingRecipient.status,
  failedStatus: mismatch.status,
  uncertainSideEffectRequiresReview: true,
  safeAutomaticRetryOnlyAfterDefiniteFailure: true,
}, null, 2));
