import assert from "node:assert/strict";
import {
  OBSERVATION_ABI_VERSION,
  createObservation,
  getObservationAbiManifest,
  normalizeManagedProcessState,
  validateObservation,
} from "../src/observation/observationAbi.js";

const web = createObservation({
  channel: "web",
  provider: "browser",
  subject: "https://example.test/orders",
  state: "ready",
  data: { url: "https://example.test/orders", visibleText: "127 orders" },
  evidence: [
    { kind: "dom", summary: "DOM snapshot available" },
    { kind: "screenshot", ref: "/tmp/orders.png", mimeType: "image/png" },
  ],
});

const processObservation = createObservation({
  channel: "process",
  provider: "managed-process",
  subject: "process_demo",
  state: normalizeManagedProcessState("exited", 0),
  data: { processId: "process_demo", exitCode: 0 },
  evidence: [{ kind: "exit_code", metadata: { exitCode: 0 } }],
});

assert.equal(web.abiVersion, OBSERVATION_ABI_VERSION);
assert.equal(web.channel, "web");
assert.equal(processObservation.state, "finished");
assert.equal(normalizeManagedProcessState("exited", 2), "failed");
assert.equal(normalizeManagedProcessState("running"), "running");
assert.equal(normalizeManagedProcessState("terminating"), "terminating");
assert.equal(normalizeManagedProcessState("lost"), "lost");
assert.deepEqual(validateObservation(JSON.parse(JSON.stringify(web))), web);
assert.throws(() =>
  validateObservation({ ...web, provider: "" }),
);

const manifest = getObservationAbiManifest();
assert.equal(manifest.version, 1);
assert.ok(manifest.channels.includes("ui"));
assert.ok(manifest.channels.includes("web"));
assert.ok(manifest.channels.includes("process"));
assert.ok(manifest.channels.includes("file"));
assert.ok(manifest.evidenceKinds.includes("accessibility"));
assert.ok(manifest.evidenceKinds.includes("stdout"));

console.log(JSON.stringify({
  ok: true,
  observationAbiVersion: manifest.version,
  channels: manifest.channels,
  normalizedProcessStates: true,
  providerNeutralEnvelope: true,
  evidenceModel: true,
}, null, 2));
