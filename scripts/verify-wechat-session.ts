import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratch = path.join(root, ".tmp-verify-wechat-session");
const fixturePath = path.join(scratch, "wechat-ocr.json");

process.env.ALLOWED_DIRECTORIES = root;
process.env.TASK_STAGING_DIR = path.join(scratch, "staging");
process.env.WECHAT_SESSION_DIR = path.join(scratch, "sessions");
process.env.WECHAT_SESSION_KEY_PATH = path.join(scratch, "wechat-session.key");
process.env.COMPUTER_MCP_TEST_WECHAT_OCR_FIXTURE = fixturePath;

const {
  deletePersistentWeChatSession,
  listPersistentWeChatSessions,
  probeWeChatSession,
  captureLatestWeChatReply,
  resolvePendingWeChatSend,
  weChatSessionAdapterContract,
} = await import("../src/runtime/wechatSessionAdapter.js");
const {
  newWeChatSessionId,
  readWeChatSession,
  writeWeChatSession,
} = await import("../src/runtime/wechatSessionStore.js");
const {
  captureLatestSessionEndpoint,
  probeSessionEndpoint,
  sessionEndpointKind,
} = await import("../src/runtime/sessionEndpoint.js");

function fixture(
  header: string,
  messages: Array<{
    text: string;
    x: number;
    y: number;
    width?: number;
    height?: number;
  }>,
) {
  return {
    path: "/fixture/wechat.png",
    windowId: 42,
    windowName: "微信",
    observations: [
      {
        text: header,
        confidence: 0.99,
        x: 0.48,
        y: 0.90,
        width: 0.20,
        height: 0.05,
      },
      ...messages.map((item) => ({
        confidence: 0.95,
        width: item.width ?? 0.22,
        height: item.height ?? 0.04,
        ...item,
      })),
    ],
  };
}

async function writeFixture(value: unknown) {
  await fs.mkdir(scratch, { recursive: true });
  await fs.writeFile(
    fixturePath,
    JSON.stringify(value, null, 2) + "\n",
    "utf8",
  );
}

let sessionId = "";

try {
  await fs.rm(scratch, { recursive: true, force: true });

  await writeFixture(
    fixture("drone2master", [
      { text: "old incoming", x: 0.35, y: 0.54 },
      { text: "old outgoing", x: 0.72, y: 0.42 },
    ]),
  );

  sessionId = newWeChatSessionId();
  const now = new Date().toISOString();
  await writeWeChatSession({
    version: 1,
    id: sessionId,
    contactName: "drone2master",
    label: "Verifier drone2master",
    createdAt: now,
    updatedAt: now,
    enabled: true,
    restoreFocus: true,
    pollIntervalMs: 30_000,
    ocrLanguages: ["zh-Hans", "en-US"],
    turnCounter: 0,
  });

  assert.equal(sessionEndpointKind(sessionId), "wechat");

  const initialProbe = await probeWeChatSession(sessionId);
  assert.equal(initialProbe.background, true);
  assert.equal(initialProbe.focused, false);
  assert.equal(initialProbe.readable, true);
  assert.equal(initialProbe.sameSession, true);
  assert.equal(initialProbe.changed, true);
  assert.match(String(initialProbe.reply), /old incoming/);

  let binding = await readWeChatSession(sessionId);
  binding.lastDeliveredDigest = binding.lastObservedDigest;
  await writeWeChatSession(binding);

  const unchanged = await probeSessionEndpoint(sessionId);
  assert.equal(unchanged.endpoint, "wechat");
  assert.equal(unchanged.changed, false);
  assert.equal(unchanged.focused, false);

  await writeFixture(
    fixture("drone2master", [
      { text: "old incoming", x: 0.35, y: 0.54 },
      { text: "old outgoing", x: 0.72, y: 0.42 },
      { text: "new inbound question", x: 0.36, y: 0.24 },
    ]),
  );

  const changed = await probeWeChatSession(sessionId);
  assert.equal(changed.background, true);
  assert.equal(changed.changed, true);
  assert.match(String(changed.reply), /new inbound question/);

  // Probe observes but does not consume the message.
  const stillChanged = await probeWeChatSession(sessionId);
  assert.equal(stillChanged.changed, true);

  const captured = await captureLatestSessionEndpoint(sessionId, {
    allow_focus: false,
  });
  assert.equal(captured.ready, true);
  assert.equal(captured.background, true);
  assert.equal(captured.focused, false);
  assert.equal(captured.changed, true);
  assert.match(String(captured.reply), /new inbound question/);

  const consumed = await probeWeChatSession(sessionId);
  assert.equal(consumed.changed, false);

  await writeFixture(
    fixture("someone-else", [
      { text: "unrelated message", x: 0.35, y: 0.22 },
    ]),
  );

  const wrongChat = await captureLatestWeChatReply(sessionId, {
    allowFocus: false,
  });
  assert.equal(wrongChat.ready, false);
  assert.equal(wrongChat.reason, "foreground_required");
  assert.equal(wrongChat.needsForeground, true);

  binding = await readWeChatSession(sessionId);
  binding.pendingSend = {
    at: new Date().toISOString(),
    digest: "uncertain-send-digest",
    text: "possibly sent",
  };
  await writeWeChatSession(binding);

  const resolved = await resolvePendingWeChatSend(
    sessionId,
    "not_sent",
  );
  assert.equal(resolved.resolved, true);
  assert.equal(resolved.resolution, "not_sent");

  const listed = await listPersistentWeChatSessions();
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.contactName, "drone2master");
  assert.equal(listed[0]?.pollIntervalMs, 30_000);
  assert.equal(listed[0]?.pendingSend, null);

  const contract = weChatSessionAdapterContract();
  assert.equal(contract.lowInterruption.focusRestore, true);
  assert.equal(contract.lowInterruption.defaultPollIntervalMs, 30_000);
  assert.equal(
    contract.crashSafety.uncertainSendRequiresExplicitResolution,
    true,
  );

  console.log(
    JSON.stringify(
      {
        ok: true,
        sessionId,
        endpointRouting: true,
        backgroundBindWithoutFocus: true,
        backgroundProbeWithoutFocus: true,
        contactHeaderVerification: true,
        probeDoesNotConsume: true,
        captureConsumesChange: true,
        foregroundFallbackExplicit: true,
        defaultPollIntervalMs: 30_000,
        crashSafePendingSend: true,
        encryptedSessionStore: contract.storage.encryptedAtRest,
      },
      null,
      2,
    ),
  );
} finally {
  if (sessionId) {
    await deletePersistentWeChatSession(sessionId).catch(() => undefined);
  }
  await fs.rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  delete process.env.COMPUTER_MCP_TEST_WECHAT_OCR_FIXTURE;
}
