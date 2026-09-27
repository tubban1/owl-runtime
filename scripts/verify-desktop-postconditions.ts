import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const {
  createObservation,
} = await import("../src/observation/observationAbi.js");
const {
  defaultVerificationForAction,
} = await import("../src/observation/actionObservation.js");

const clipboardText = "desktop clipboard verifier";
const clipboardObservation = createObservation({
  channel: "ui",
  provider: "desktop",
  state: "ready",
  data: {
    clipboard: {
      characters: clipboardText.length,
      sha256: createHash("sha256")
        .update(clipboardText, "utf8")
        .digest("hex"),
    },
  },
  evidence: [{ kind: "structured" }],
});

const clipboardVerification = defaultVerificationForAction(
  "desktop.clipboard_write",
  { text: clipboardText },
  { writtenCharacters: clipboardText.length },
  clipboardObservation,
);
assert.equal(clipboardVerification?.status, "verified");
assert.equal(
  clipboardVerification?.specId,
  "default:desktop.clipboard_write",
);

const genericObservation = createObservation({
  channel: "ui",
  provider: "desktop",
  state: "ready",
  data: {
    frontmost: {
      app: "Fixture App",
      bundleIdentifier: "example.fixture",
    },
  },
  evidence: [{ kind: "system" }],
});

for (const action of [
  "desktop.click",
  "desktop.type",
  "desktop.key",
  "desktop.click_element",
]) {
  const verification = defaultVerificationForAction(
    action,
    action === "desktop.type"
      ? { text: "hello" }
      : action === "desktop.key"
        ? { key: "enter" }
        : { x: 10, y: 20 },
    {},
    genericObservation,
  );
  assert.equal(verification?.status, "uncertain", action);
  assert.equal(verification?.specId, `default:${action}`, action);
}

const unknownObservation = createObservation({
  channel: "ui",
  provider: "desktop",
  state: "unknown",
  data: {
    action: "desktop.click",
    observationError: "permission unavailable",
  },
  evidence: [{ kind: "system" }],
});
const unknownClick = defaultVerificationForAction(
  "desktop.click",
  { x: 10, y: 20 },
  {},
  unknownObservation,
);
assert.equal(unknownClick?.status, "uncertain");

console.log(JSON.stringify({
  ok: true,
  clipboardWriteDeterministicVerification: true,
  clipboardContentNotRequiredInObservation: true,
  genericClickUncertain: true,
  genericTypeUncertain: true,
  genericKeyUncertain: true,
  genericClickElementUncertain: true,
  observationFailureRemainsUncertain: true,
  realDesktopPermissionsNotTouchedByVerifier: true,
}, null, 2));
