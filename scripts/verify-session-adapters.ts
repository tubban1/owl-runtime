import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratch = path.join(root, ".tmp-verify-session-adapters");

async function findChromeForTesting(): Promise<string | undefined> {
  const home = process.env.HOME;
  if (!home) return undefined;
  const browsersRoot = path.join(home, ".agent-browser", "browsers");
  let entries: string[] = [];
  try {
    entries = await fs.readdir(browsersRoot);
  } catch {
    return undefined;
  }

  for (const entry of entries
    .filter((name) => name.startsWith("chrome-"))
    .sort()
    .reverse()) {
    const executable = path.join(
      browsersRoot,
      entry,
      "Google Chrome for Testing.app",
      "Contents",
      "MacOS",
      "Google Chrome for Testing",
    );
    try {
      await fs.access(executable);
      return executable;
    } catch {
      // Keep looking.
    }
  }
  return undefined;
}

const isolatedBrowserExecutable = await findChromeForTesting();

process.env.ALLOW_BROWSER = "true";
process.env.BROWSER_HEADLESS = "true";
process.env.BROWSER_STARTUP_TIMEOUT_MS = "60000";
process.env.BROWSER_CONNECT_TIMEOUT_MS = "60000";
if (isolatedBrowserExecutable) {
  process.env.BROWSER_EXECUTABLE = isolatedBrowserExecutable;
} else {
  delete process.env.BROWSER_EXECUTABLE;
}
process.env.BROWSER_PROFILE_DIR = path.join(scratch, "browser-profile");
process.env.SESSION_ADAPTER_DIR = path.join(scratch, "sessions");
process.env.SESSION_ADAPTER_KEY_PATH = path.join(scratch, "session.key");
process.env.LOOP_DIR = path.join(scratch, "loops");
process.env.LOOP_KEY_PATH = path.join(scratch, "loop.key");
process.env.TASK_DIR = path.join(scratch, "tasks");
process.env.TASK_KEY_PATH = path.join(scratch, "task.key");
process.env.TASK_STAGING_DIR = path.join(scratch, "staging");
process.env.EPISODIC_INDEX_DIR = path.join(scratch, "episodes");
process.env.EPISODIC_INDEX_KEY_PATH = path.join(scratch, "episode.key");
process.env.ALLOWED_DIRECTORIES = root;

function pageHtml(
  agent: "chatgpt" | "antigravity",
): string {
  const attr =
    agent === "chatgpt"
      ? 'data-message-author-role="assistant"'
      : 'data-role="assistant"';
  const initial =
    agent === "chatgpt"
      ? "ChatGPT initial answer for relay"
      : "Antigravity initial answer";
  const prefix =
    agent === "chatgpt" ? "ChatGPT reply: " : "Antigravity reply: ";

  return [
    "<!doctype html><html><body>",
    '<main id="messages">',
    '<div ' + attr + ">" + initial + "</div>",
    "</main>",
    '<textarea id="prompt"></textarea>',
    "<script>",
    "const ta=document.getElementById('prompt');",
    "ta.addEventListener('keydown',(event)=>{",
    "if(event.key==='Enter'&&!event.shiftKey){",
    "event.preventDefault();",
    "const message=ta.value; ta.value='';",
    "const node=document.createElement('div');",
    "node.setAttribute('" +
      (agent === "chatgpt"
        ? "data-message-author-role"
        : "data-role") +
      "','assistant');",
    "node.textContent=" + JSON.stringify(prefix) + "+message;",
    "document.getElementById('messages').appendChild(node);",
    "}",
    "});",
    "</script>",
    "</body></html>",
  ].join("");
}

await fs.rm(scratch, { recursive: true, force: true });

const server = http.createServer((req, res) => {
  res.setHeader("content-type", "text/html; charset=utf-8");
  if (req.url?.startsWith("/antigravity")) {
    res.end(pageHtml("antigravity"));
    return;
  }
  res.end(pageHtml("chatgpt"));
});

await new Promise<void>((resolve) => {
  server.listen(0, "127.0.0.1", resolve);
});

const address = server.address();
if (!address || typeof address === "string") {
  throw new Error("Local verifier server failed to bind.");
}
const origin = "http://127.0.0.1:" + address.port;

const {
  bindBrowserAgentSession,
  captureLatestAgentReply,
  identifyBrowserAgentSession,
  listBrowserAgentSessions,
  removeBrowserAgentSession,
  resolvePendingSessionSend,
  sendAgentMessage,
} = await import("../src/runtime/sessionAdapters.js");
const {
  createPersistentLoop,
  deletePersistentLoop,
  getPersistentLoop,
  runLoopControllerTick,
} = await import("../src/runtime/loopController.js");
const {
  readSessionBinding,
  writeSessionBinding,
} = await import("../src/runtime/sessionStore.js");
const {
  executePrimitive,
} = await import("../src/primitives/primitiveRuntime.js");

let chatgptId = "";
let antigravityId = "";
let loopId = "";

try {
  const chatgpt = await bindBrowserAgentSession({
    adapterId: "chatgpt",
    label: "Verifier ChatGPT",
    openUrl: origin + "/chatgpt/session-alpha",
    useActive: true,
    inputSelector: "#prompt",
    messageSelector: '[data-message-author-role="assistant"]',
    busyMarkers: ["stop generating"],
  });
  chatgptId = chatgpt.id;

  const antigravity = await bindBrowserAgentSession({
    adapterId: "antigravity",
    label: "Verifier Antigravity",
    openUrl: origin + "/antigravity/session-beta",
    useActive: true,
    inputSelector: "#prompt",
    messageSelector: '[data-role="assistant"]',
    busyMarkers: ["stop generating"],
  });
  antigravityId = antigravity.id;

  const chatIdentity = await identifyBrowserAgentSession(chatgptId);
  const antiIdentity = await identifyBrowserAgentSession(antigravityId);
  assert.equal(chatIdentity.sameSession, true);
  assert.equal(antiIdentity.sameSession, true);
  assert.notEqual(
    chatIdentity.sessionFingerprint,
    antiIdentity.sessionFingerprint,
  );

  const created = await createPersistentLoop({
    label: "verify ChatGPT Antigravity durable relay",
    pollIntervalMs: 1000,
    maxCycles: 1,
    phases: [
      {
        id: "capture_chatgpt",
        session: {
          bindingId: chatgptId,
          op: "capture_latest",
        },
        advanceWhen: { path: "changed", truthy: true },
      },
      {
        id: "send_antigravity",
        session: {
          bindingId: antigravityId,
          op: "send",
          args: {
            text: "{{loop.lastOutput.reply}}",
            confirm: true,
          },
        },
      },
      {
        id: "capture_antigravity",
        session: {
          bindingId: antigravityId,
          op: "capture_latest",
        },
        advanceWhen: { path: "changed", truthy: true },
      },
      {
        id: "send_chatgpt",
        session: {
          bindingId: chatgptId,
          op: "send",
          args: {
            text: "{{loop.lastOutput.reply}}",
            confirm: true,
          },
        },
      },
    ],
  });
  loopId = created.id;

  for (let i = 0; i < 6; i += 1) {
    await runLoopControllerTick(Date.now() + 10_000 + i * 2_000);
    const status = await getPersistentLoop(loopId);
    if (!status.enabled) break;
  }

  const loopStatus = await getPersistentLoop(loopId);
  assert.equal(loopStatus.enabled, false);
  assert.equal(loopStatus.cycleCount, 1);
  assert.match(String(loopStatus.stoppedReason), /maxCycles=1/);

  const finalChat = await captureLatestAgentReply(chatgptId);
  assert.equal(finalChat.ready, true);
  assert.match(
    String(finalChat.reply),
    /ChatGPT reply: Antigravity reply: ChatGPT initial answer for relay/,
  );

  const sessions = await listBrowserAgentSessions();
  assert.equal(sessions.length, 2);
  const chatSession = sessions.find((item) => item.id === chatgptId);
  const antiSession = sessions.find((item) => item.id === antigravityId);
  assert.equal(chatSession?.turnCounter, 1);
  assert.equal(antiSession?.turnCounter, 1);
  assert.equal(chatSession?.pendingSend, null);
  assert.equal(antiSession?.pendingSend, null);

  const duplicate = await sendAgentMessage(
    chatgptId,
    "Antigravity reply: ChatGPT initial answer for relay",
    {
      confirm: true,
      deduplicateAsSuccess: true,
    },
  );
  assert.equal(duplicate.deduplicated, true);

  const binding = await readSessionBinding(antigravityId);
  binding.pendingSend = {
    at: new Date().toISOString(),
    digest: "simulated-uncertain-send",
    text: "uncertain external side effect",
  };
  await writeSessionBinding(binding);

  await assert.rejects(
    () =>
      sendAgentMessage(antigravityId, "another turn", {
        confirm: true,
      }),
    /unresolved pending send/,
  );

  const resolved = await resolvePendingSessionSend(
    antigravityId,
    "not_sent",
  );
  assert.equal(resolved.resolved, true);
  assert.equal(resolved.resolution, "not_sent");

  console.log(
    JSON.stringify(
      {
        ok: true,
        chatgptSession: chatgptId,
        antigravitySession: antigravityId,
        loopId,
        separatePersistentTabs: true,
        sessionFingerprints: true,
        capturesLatestAssistantElement: true,
        durableLoopRelay: true,
        crossSessionCarry: true,
        duplicateSendReceipt: true,
        uncertainSendFreezesReplay: true,
        relayCycles: loopStatus.cycleCount,
      },
      null,
      2,
    ),
  );
} finally {
  if (loopId) {
    await deletePersistentLoop(loopId).catch(() => undefined);
  }
  for (const sessionId of [chatgptId, antigravityId]) {
    if (sessionId) {
      await removeBrowserAgentSession(sessionId).catch(() => undefined);
    }
  }
  await executePrimitive("web.session", "close", {}).catch(() => undefined);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await fs.rm(scratch, { recursive: true, force: true }).catch(() => undefined);
}
