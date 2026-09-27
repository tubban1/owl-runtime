import { createHash } from "node:crypto";
import { executePrimitive } from "../primitives/primitiveRuntime.js";
import { resourceArbiter } from "./resourceArbiter.js";
import {
  deleteSessionBinding,
  getSessionStorageInfo,
  listSessionBindings,
  newSessionBindingId,
  readSessionBinding,
  writeSessionBinding,
  type SessionAdapterId,
  type SessionBinding,
} from "./sessionStore.js";

type JsonObject = Record<string, unknown>;

type BrowserTab = {
  index: number;
  active: boolean;
  url: string;
  title: string;
};

type BrowserSnapshot = {
  url: string;
  title: string;
  text: string;
  controls: Array<{
    tag?: string;
    type?: string | null;
    role?: string | null;
    name?: string;
    placeholder?: string | null;
  }>;
  selection?: {
    selector: string;
    count: number;
    texts: string[];
    selectedText: string | null;
  };
};

type AdapterPreset = {
  id: SessionAdapterId;
  label: string;
  urlPattern?: string;
  inputSelector: string;
  sendSelector?: string;
  messageSelector?: string;
  busyMarkers: string[];
};

function envList(name: string, fallback: string[]): string[] {
  const value = process.env[name]?.trim();
  return value
    ? value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
    : fallback;
}

function preset(adapterId: SessionAdapterId): AdapterPreset {
  if (adapterId === "chatgpt") {
    return {
      id: adapterId,
      label: "ChatGPT",
      urlPattern: "chatgpt.com/",
      inputSelector:
        '#prompt-textarea, textarea[data-id="root"], textarea[placeholder*="Message"], div[contenteditable="true"]',
      sendSelector:
        'button[data-testid="send-button"], button[aria-label*="Send"], button[aria-label*="发送"]',
      messageSelector: '[data-message-author-role="assistant"]',
      busyMarkers: [
        "stop streaming",
        "stop generating",
        "停止生成",
        "停止回答",
      ],
    };
  }

  if (adapterId === "antigravity") {
    return {
      id: adapterId,
      label: "Antigravity",
      urlPattern:
        process.env.ANTIGRAVITY_URL_PATTERN?.trim() || "antigravity",
      inputSelector:
        process.env.ANTIGRAVITY_INPUT_SELECTOR?.trim() ||
        'textarea, div[contenteditable="true"]',
      sendSelector:
        process.env.ANTIGRAVITY_SEND_SELECTOR?.trim() ||
        'button[type="submit"], button[aria-label*="Send"], button:has-text("Send")',
      messageSelector:
        process.env.ANTIGRAVITY_MESSAGE_SELECTOR?.trim() ||
        '[data-message-author-role="assistant"], [data-role="assistant"], .assistant-message',
      busyMarkers: envList("ANTIGRAVITY_BUSY_MARKERS", [
        "stop generating",
        "stop response",
        "cancel generation",
        "停止生成",
      ]),
    };
  }

  return {
    id: adapterId,
    label: "Generic browser agent",
    inputSelector: 'textarea, div[contenteditable="true"]',
    sendSelector:
      'button[type="submit"], button[aria-label*="Send"], button:has-text("Send")',
    messageSelector:
      '[data-message-author-role="assistant"], [data-role="assistant"], .assistant-message',
    busyMarkers: ["stop generating", "stop response", "cancel generation"],
  };
}

function digest(value: string): string {
  return createHash("sha256")
    .update(value.normalize("NFKC"))
    .digest("hex");
}

function normalizedSessionUrl(value: string): string {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`.replace(/\/$/, "");
  } catch {
    return value.split(/[?#]/, 1)[0] ?? value;
  }
}

function fingerprint(adapterId: SessionAdapterId, url: string): string {
  return digest(`${adapterId}|${normalizedSessionUrl(url)}`);
}

function includesInsensitive(value: string, pattern?: string): boolean {
  if (!pattern) return true;
  return value.toLowerCase().includes(pattern.toLowerCase());
}

async function callPrimitive(
  primitive: string,
  op: string,
  args: JsonObject,
  held: string[],
) {
  return (
    await executePrimitive(primitive, op, args, {
      bypassResourceKeys: held,
    })
  ).result;
}

async function withBrowserLease<T>(
  owner: string,
  operation: (held: string[]) => Promise<T>,
): Promise<T> {
  const lease = await resourceArbiter.acquire(owner, [
    { key: "browser.session", mode: "exclusive" },
  ]);
  try {
    return await operation(lease.resources.map((item) => item.key));
  } finally {
    lease.release();
  }
}

async function browserTabs(held: string[]): Promise<BrowserTab[]> {
  const result = await callPrimitive("web.session", "tabs", {}, held);
  return Array.isArray(result) ? (result as BrowserTab[]) : [];
}

function chooseBindingTab(
  tabs: BrowserTab[],
  options: {
    useActive?: boolean;
    urlPattern?: string;
    titlePattern?: string;
  },
): BrowserTab | undefined {
  if (options.useActive) {
    const active = tabs.find((tab) => tab.active);
    if (active) return active;
  }

  const candidates = tabs.filter(
    (tab) =>
      includesInsensitive(tab.url, options.urlPattern) &&
      includesInsensitive(tab.title, options.titlePattern),
  );
  return candidates.find((tab) => tab.active) ?? candidates[0];
}

async function locateBoundTab(
  binding: SessionBinding,
  held: string[],
): Promise<BrowserTab> {
  const tabs = await browserTabs(held);
  const expected = binding.expectedUrl
    ? normalizedSessionUrl(binding.expectedUrl)
    : undefined;

  if (expected) {
    const exact = tabs.find(
      (tab) => normalizedSessionUrl(tab.url) === expected,
    );
    if (exact) return exact;

    throw new Error(
      `Bound session ${binding.id} is not open in the managed browser. Expected ${expected}. Rebind explicitly instead of silently switching to another conversation.`,
    );
  }

  const matched = chooseBindingTab(tabs, binding.locator);
  if (!matched) {
    throw new Error(
      `Could not find a browser tab for session binding ${binding.id}.`,
    );
  }
  return matched;
}

function snapshotBusy(
  snapshot: BrowserSnapshot,
  markers: string[],
): { busy: boolean; matched: string[] } {
  const controls = snapshot.controls
    .map((control) => control.name ?? "")
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
  const matched = markers.filter((marker) =>
    controls.includes(marker.toLowerCase()),
  );
  return { busy: matched.length > 0, matched };
}

function fallbackReply(binding: SessionBinding, snapshot: BrowserSnapshot): {
  reply: string;
  mode: string;
} {
  if (binding.lastSentText) {
    const index = snapshot.text.lastIndexOf(binding.lastSentText);
    if (index >= 0) {
      return {
        reply: snapshot.text
          .slice(index + binding.lastSentText.length)
          .trim()
          .slice(-50_000),
        mode: "after_last_sent_text",
      };
    }
  }

  return {
    reply: snapshot.text.trim().slice(-20_000),
    mode: "snapshot_tail",
  };
}

export function getSessionAdapterContract() {
  return {
    version: 1,
    operations: [
      "bind",
      "identify",
      "capture_latest",
      "send",
      "resolve_pending",
      "rebind",
      "list",
      "delete",
      "adapters",
    ],
    requiredIdentityChecks: [
      "adapter_id",
      "normalized_conversation_url",
      "session_fingerprint",
    ],
    receipts: ["capture_digest", "send_digest", "turn_counter"],
    adapters: (["chatgpt", "antigravity", "generic-browser"] as const).map(
      (id) => {
        const item = preset(id);
        return {
          id: item.id,
          label: item.label,
          defaultUrlPattern: item.urlPattern ?? null,
          defaultInputSelector: item.inputSelector,
          defaultMessageSelector: item.messageSelector ?? null,
          busyMarkers: item.busyMarkers,
        };
      },
    ),
    storage: getSessionStorageInfo(),
  };
}

export async function bindBrowserAgentSession(input: {
  adapterId: SessionAdapterId;
  label?: string;
  useActive?: boolean;
  openUrl?: string;
  urlPattern?: string;
  titlePattern?: string;
  inputSelector?: string;
  sendSelector?: string;
  messageSelector?: string;
  busyMarkers?: string[];
}) {
  const defaults = preset(input.adapterId);
  return await withBrowserLease(
    `runtime.session.bind.${input.adapterId}`,
    async (held) => {
      if (input.openUrl) {
        await callPrimitive(
          "web.session",
          "new_tab",
          { url: input.openUrl, wait_until: "domcontentloaded" },
          held,
        );
      }
      const tabs = await browserTabs(held);
      const locator = {
        ...(input.urlPattern || defaults.urlPattern
          ? { urlPattern: input.urlPattern || defaults.urlPattern }
          : {}),
        ...(input.titlePattern ? { titlePattern: input.titlePattern } : {}),
      };
      const tab = chooseBindingTab(tabs, {
        useActive: input.useActive ?? false,
        ...locator,
      });
      if (!tab) {
        throw new Error(
          `No managed-browser tab matches adapter ${input.adapterId}. Open/login to the target session in the computer-mcp browser first, or bind the active tab with use_active=true.`,
        );
      }

      await callPrimitive("web.session", "use_tab", { index: tab.index }, held);
      const now = new Date().toISOString();
      const binding: SessionBinding = {
        version: 1,
        id: newSessionBindingId(),
        adapterId: input.adapterId,
        label: input.label?.trim() || `${defaults.label}: ${tab.title || tab.url}`,
        createdAt: now,
        updatedAt: now,
        enabled: true,
        locator,
        selectors: {
          input: input.inputSelector?.trim() || defaults.inputSelector,
          ...(input.sendSelector?.trim() || defaults.sendSelector
            ? { send: input.sendSelector?.trim() || defaults.sendSelector }
            : {}),
          ...(input.messageSelector?.trim() || defaults.messageSelector
            ? {
                message:
                  input.messageSelector?.trim() || defaults.messageSelector,
              }
            : {}),
        },
        busyMarkers:
          input.busyMarkers && input.busyMarkers.length > 0
            ? input.busyMarkers
            : defaults.busyMarkers,
        expectedUrl: tab.url,
        expectedTitle: tab.title,
        sessionFingerprint: fingerprint(input.adapterId, tab.url),
        turnCounter: 0,
      };
      await writeSessionBinding(binding);
      return {
        id: binding.id,
        adapterId: binding.adapterId,
        label: binding.label,
        expectedUrl: binding.expectedUrl,
        expectedTitle: binding.expectedTitle,
        sessionFingerprint: binding.sessionFingerprint,
        selectors: binding.selectors,
      };
    },
  );
}

export async function identifyBrowserAgentSession(bindingId: string) {
  const binding = await readSessionBinding(bindingId);
  return await withBrowserLease(
    `runtime.session.identify.${binding.adapterId}`,
    async (held) => {
      try {
        const tab = await locateBoundTab(binding, held);
        const currentFingerprint = fingerprint(binding.adapterId, tab.url);
        return {
          id: binding.id,
          adapterId: binding.adapterId,
          found: true,
          sameSession:
            currentFingerprint === binding.sessionFingerprint,
          url: tab.url,
          title: tab.title,
          sessionFingerprint: currentFingerprint,
          expectedFingerprint: binding.sessionFingerprint ?? null,
        };
      } catch (error) {
        return {
          id: binding.id,
          adapterId: binding.adapterId,
          found: false,
          sameSession: false,
          expectedUrl: binding.expectedUrl ?? null,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  );
}

export async function captureLatestAgentReply(
  bindingId: string,
  options?: { maxChars?: number },
) {
  const binding = await readSessionBinding(bindingId);
  return await withBrowserLease(
    `runtime.session.capture.${binding.adapterId}`,
    async (held) => {
      const tab = await locateBoundTab(binding, held);
      await callPrimitive("web.session", "use_tab", { index: tab.index }, held);
      const currentFingerprint = fingerprint(binding.adapterId, tab.url);
      if (
        binding.sessionFingerprint &&
        currentFingerprint !== binding.sessionFingerprint
      ) {
        throw new Error(
          "Session fingerprint changed; refusing to capture from a different conversation.",
        );
      }

      const snapshot = (await callPrimitive(
        "web.query",
        "snapshot",
        {
          max_chars: Math.min(
            Math.max(Math.trunc(options?.maxChars ?? 50_000), 1_000),
            100_000,
          ),
          ...(binding.selectors.message
            ? { selector: binding.selectors.message, last: true }
            : {}),
        },
        held,
      )) as BrowserSnapshot;

      const busy = snapshotBusy(snapshot, binding.busyMarkers);
      const selected = snapshot.selection?.selectedText?.trim();
      const fallback = selected
        ? { reply: selected, mode: "message_selector" }
        : fallbackReply(binding, snapshot);
      const reply = fallback.reply;
      const replyDigest = reply ? digest(reply) : null;
      const changed =
        Boolean(replyDigest) && replyDigest !== binding.lastCaptureDigest;
      const ready = !busy.busy && Boolean(reply);

      binding.lastSnapshotText = snapshot.text;
      binding.lastSnapshotDigest = digest(snapshot.text);
      if (ready && replyDigest) {
        binding.lastCaptureDigest = replyDigest;
        binding.lastCapturedReply = reply;
      }
      await writeSessionBinding(binding);

      if (!ready) {
        return {
          sessionId: binding.id,
          adapterId: binding.adapterId,
          ready: false,
          changed: false,
          sameSession: true,
          busyMarkers: busy.matched,
        };
      }

      return {
        sessionId: binding.id,
        adapterId: binding.adapterId,
        ready: true,
        changed,
        sameSession: true,
        turn: binding.turnCounter,
        captureMode: fallback.mode,
        reply,
        replyDigest,
        messageCount: snapshot.selection?.count ?? null,
      };
    },
  );
}

export async function sendAgentMessage(
  bindingId: string,
  text: string,
  options?: {
    confirm?: boolean;
    allowDuplicate?: boolean;
    deduplicateAsSuccess?: boolean;
  },
) {
  if (options?.confirm !== true) {
    throw new Error(
      "Session send requires confirm=true because it creates an external model turn.",
    );
  }
  const message = text.trim();
  if (!message) throw new Error("Session message cannot be empty.");

  const binding = await readSessionBinding(bindingId);
  const messageDigest = digest(message);
  if (binding.pendingSend) {
    throw new Error(
      `Session ${binding.id} has an unresolved pending send from ${binding.pendingSend.at}. Resolve it before any automatic resend.`,
    );
  }
  if (
    !options?.allowDuplicate &&
    binding.lastSentDigest === messageDigest
  ) {
    if (options?.deduplicateAsSuccess && binding.lastSendReceipt) {
      return {
        sessionId: binding.id,
        adapterId: binding.adapterId,
        sent: true,
        deduplicated: true,
        sameSession: true,
        messageDigest,
        turn: binding.turnCounter,
        receipt: binding.lastSendReceipt,
      };
    }
    throw new Error(
      "Duplicate send blocked by the session receipt. Set allow_duplicate=true only if resending is intentional.",
    );
  }

  return await withBrowserLease(
    `runtime.session.send.${binding.adapterId}`,
    async (held) => {
      const tab = await locateBoundTab(binding, held);
      await callPrimitive("web.session", "use_tab", { index: tab.index }, held);
      const currentFingerprint = fingerprint(binding.adapterId, tab.url);
      if (
        binding.sessionFingerprint &&
        currentFingerprint !== binding.sessionFingerprint
      ) {
        throw new Error(
          "Session fingerprint changed; refusing to send into a different conversation.",
        );
      }

      if (binding.selectors.message) {
        const baseline = (await callPrimitive(
          "web.query",
          "snapshot",
          {
            max_chars: 50_000,
            selector: binding.selectors.message,
            last: true,
          },
          held,
        )) as BrowserSnapshot;
        const baselineReply = baseline.selection?.selectedText?.trim();
        if (baselineReply) {
          binding.lastCaptureDigest = digest(baselineReply);
          binding.lastCapturedReply = baselineReply;
        }
      }

      binding.pendingSend = {
        at: new Date().toISOString(),
        digest: messageDigest,
        text: message,
      };
      await writeSessionBinding(binding);

      await callPrimitive(
        "web.act",
        "type",
        {
          selector: binding.selectors.input,
          text: message,
          submit: true,
        },
        held,
      );

      binding.pendingSend = undefined;
      binding.turnCounter += 1;
      binding.lastSentText = message;
      binding.lastSentDigest = messageDigest;
      binding.lastSendReceipt = {
        at: new Date().toISOString(),
        digest: messageDigest,
        url: tab.url,
        title: tab.title,
        turn: binding.turnCounter,
      };
      await writeSessionBinding(binding);

      return {
        sessionId: binding.id,
        adapterId: binding.adapterId,
        sent: true,
        sameSession: true,
        messageDigest,
        turn: binding.turnCounter,
        receipt: binding.lastSendReceipt,
      };
    },
  );
}

export async function rebindBrowserAgentSession(
  bindingId: string,
  options?: { useActive?: boolean; urlPattern?: string; titlePattern?: string },
) {
  const binding = await readSessionBinding(bindingId);
  return await withBrowserLease(
    `runtime.session.rebind.${binding.adapterId}`,
    async (held) => {
      const tabs = await browserTabs(held);
      const tab = chooseBindingTab(tabs, {
        useActive: options?.useActive ?? false,
        urlPattern:
          options?.urlPattern ??
          binding.locator.urlPattern ??
          preset(binding.adapterId).urlPattern,
        titlePattern:
          options?.titlePattern ?? binding.locator.titlePattern,
      });
      if (!tab) throw new Error("No tab matched the requested rebind target.");

      binding.expectedUrl = tab.url;
      binding.expectedTitle = tab.title;
      binding.sessionFingerprint = fingerprint(binding.adapterId, tab.url);
      binding.lastSnapshotDigest = undefined;
      binding.lastSnapshotText = undefined;
      binding.lastCaptureDigest = undefined;
      binding.lastCapturedReply = undefined;
      binding.lastSentDigest = undefined;
      binding.lastSentText = undefined;
      binding.pendingSend = undefined;
      binding.lastSendReceipt = undefined;
      binding.turnCounter = 0;
      await writeSessionBinding(binding);

      return {
        id: binding.id,
        rebound: true,
        adapterId: binding.adapterId,
        expectedUrl: binding.expectedUrl,
        expectedTitle: binding.expectedTitle,
        sessionFingerprint: binding.sessionFingerprint,
      };
    },
  );
}

export async function resolvePendingSessionSend(
  bindingId: string,
  resolution: "sent" | "not_sent",
) {
  const binding = await readSessionBinding(bindingId);
  const pending = binding.pendingSend;
  if (!pending) {
    return {
      sessionId: binding.id,
      resolved: false,
      reason: "no_pending_send",
    };
  }

  if (resolution === "sent") {
    binding.turnCounter += 1;
    binding.lastSentText = pending.text;
    binding.lastSentDigest = pending.digest;
    binding.lastSendReceipt = {
      at: new Date().toISOString(),
      digest: pending.digest,
      url: binding.expectedUrl ?? "",
      title: binding.expectedTitle ?? "",
      turn: binding.turnCounter,
    };
  }

  binding.pendingSend = undefined;
  await writeSessionBinding(binding);
  return {
    sessionId: binding.id,
    resolved: true,
    resolution,
    turn: binding.turnCounter,
    lastSendReceipt: binding.lastSendReceipt ?? null,
  };
}

export async function listBrowserAgentSessions() {
  return (await listSessionBindings()).map((binding) => ({
    id: binding.id,
    adapterId: binding.adapterId,
    label: binding.label,
    enabled: binding.enabled,
    expectedUrl: binding.expectedUrl ?? null,
    expectedTitle: binding.expectedTitle ?? null,
    sessionFingerprint: binding.sessionFingerprint ?? null,
    turnCounter: binding.turnCounter,
    lastCaptureDigest: binding.lastCaptureDigest ?? null,
    lastSentDigest: binding.lastSentDigest ?? null,
    pendingSend: binding.pendingSend
      ? { at: binding.pendingSend.at, digest: binding.pendingSend.digest }
      : null,
    lastSendReceipt: binding.lastSendReceipt ?? null,
  }));
}

export async function removeBrowserAgentSession(id: string) {
  const binding = await readSessionBinding(id);
  await deleteSessionBinding(id);
  return {
    id,
    deleted: true,
    adapterId: binding.adapterId,
    label: binding.label,
  };
}
