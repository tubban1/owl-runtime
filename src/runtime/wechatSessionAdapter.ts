import { runtimeStatePath } from "./runtimePaths.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { executePrimitive } from "../primitives/primitiveRuntime.js";
import { resourceArbiter } from "./resourceArbiter.js";
import {
  deleteWeChatSession,
  getWeChatSessionStorageInfo,
  listWeChatSessions,
  newWeChatSessionId,
  readWeChatSession,
  writeWeChatSession,
  type WeChatSessionBinding,
} from "./wechatSessionStore.js";

type JsonObject = Record<string, unknown>;

type OcrObservation = {
  text?: string;
  confidence?: number;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
};

type OcrWindowResult = {
  path?: string;
  windowId?: number;
  windowName?: string;
  text?: string;
  observations?: OcrObservation[];
};

type FrontmostApp = {
  app?: string;
  bundleIdentifier?: string;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function digest(value: string): string {
  return createHash("sha256")
    .update(value.normalize("NFKC").trim().replace(/\s+/g, " "))
    .digest("hex");
}

function normalize(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
}

function stagingRoot(): string {
  return (
    process.env.TASK_STAGING_DIR?.trim() ||
    runtimeStatePath("staging")
  );
}

function probePath(sessionId: string): string {
  return path.join(
    stagingRoot(),
    "_wechat-session-probes",
    `${sessionId}.png`,
  );
}

async function callPrimitive(
  primitive: string,
  op: string,
  args: JsonObject,
  held: string[] = [],
) {
  return (
    await executePrimitive(primitive, op, args, {
      bypassResourceKeys: held,
    })
  ).result;
}

function visibleConversation(
  result: OcrWindowResult,
  contactName: string,
) {
  const observations = Array.isArray(result.observations)
    ? result.observations
        .filter(
          (item) =>
            typeof item.text === "string" &&
            item.text.trim().length > 0 &&
            typeof item.x === "number" &&
            typeof item.y === "number",
        )
        .map((item) => ({
          text: item.text!.trim(),
          confidence:
            typeof item.confidence === "number" ? item.confidence : 0,
          x: item.x!,
          y: item.y!,
          width: typeof item.width === "number" ? item.width : 0,
          height: typeof item.height === "number" ? item.height : 0,
        }))
    : [];

  const normalizedContact = normalize(contactName);
  const header = observations.filter((item) => {
    const centerX = item.x + item.width / 2;
    return centerX >= 0.32 && item.y >= 0.78;
  });
  const contactVerified = header.some((item) => {
    const text = normalize(item.text);
    return (
      text === normalizedContact ||
      text.includes(normalizedContact) ||
      normalizedContact.includes(text)
    );
  });

  const ignored = new Set([
    "微信",
    "wechat",
    "聊天",
    "通讯录",
    "发现",
    "我",
    "发送",
    "send",
  ]);
  const conversation = observations
    .filter((item) => {
      const centerX = item.x + item.width / 2;
      return (
        centerX >= 0.30 &&
        item.y >= 0.17 &&
        item.y <= 0.78 &&
        !ignored.has(normalize(item.text)) &&
        normalize(item.text) !== normalizedContact
      );
    })
    .sort((a, b) => {
      const rowDelta = b.y - a.y;
      if (Math.abs(rowDelta) > 0.018) return rowDelta;
      return a.x - b.x;
    });

  const visibleText = conversation.map((item) => item.text).join("\n").trim();
  const visualBottomFirst = [...conversation].sort((a, b) => {
    const rowDelta = a.y - b.y;
    if (Math.abs(rowDelta) > 0.018) return rowDelta;
    return a.x - b.x;
  });
  const latest = visualBottomFirst.slice(0, 6);
  const latestText = latest
    .slice()
    .sort((a, b) => b.y - a.y || a.x - b.x)
    .map((item) => item.text)
    .join("\n")
    .trim();

  const incoming = visualBottomFirst.filter((item) => {
    const centerX = item.x + item.width / 2;
    return centerX < 0.64;
  });
  const outgoing = visualBottomFirst.filter((item) => {
    const centerX = item.x + item.width / 2;
    return centerX >= 0.64;
  });

  const latestIncomingText = incoming
    .slice(0, 4)
    .sort((a, b) => b.y - a.y || a.x - b.x)
    .map((item) => item.text)
    .join("\n")
    .trim();
  const latestOutgoingText = outgoing
    .slice(0, 4)
    .sort((a, b) => b.y - a.y || a.x - b.x)
    .map((item) => item.text)
    .join("\n")
    .trim();

  return {
    contactVerified,
    headerText: header.map((item) => item.text),
    visibleText,
    latestText,
    latestIncomingText,
    latestOutgoingText,
    observations: conversation,
  };
}

async function backgroundOcr(
  sessionId: string,
  contactName: string,
  languages: string[],
  held: string[] = [],
) {
  const target = probePath(sessionId);
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const fixturePath =
    process.env.COMPUTER_MCP_TEST_WECHAT_OCR_FIXTURE?.trim();
  const result = fixturePath
    ? (JSON.parse(await fs.readFile(fixturePath, "utf8")) as OcrWindowResult)
    : ((await callPrimitive(
        "vision.ocr",
        "window",
        {
          path: target,
          app_name: "com.tencent.xinWeChat",
          languages,
        },
        held,
      )) as OcrWindowResult);
  const parsed = visibleConversation(result, contactName);
  const contentDigest = parsed.visibleText
    ? digest(parsed.visibleText)
    : null;
  return {
    target,
    result,
    parsed,
    contentDigest,
  };
}

async function navigateToContact(
  contactName: string,
  held: string[],
): Promise<void> {
  await callPrimitive(
    "app.lifecycle",
    "launch",
    { app_name: "com.tencent.xinWeChat" },
    held,
  );
  await sleep(220);
  await callPrimitive(
    "keyboard.press",
    "key",
    { key: "1", modifiers: ["command"] },
    held,
  );
  await sleep(150);
  await callPrimitive(
    "keyboard.press",
    "key",
    { key: "f", modifiers: ["command"] },
    held,
  );
  await sleep(150);
  await callPrimitive(
    "keyboard.press",
    "key",
    { key: "a", modifiers: ["command"] },
    held,
  );
  await callPrimitive(
    "keyboard.type",
    "text",
    { text: contactName },
    held,
  );
  await sleep(500);
  await callPrimitive(
    "keyboard.press",
    "key",
    { key: "return" },
    held,
  );
  await sleep(450);
}

async function withForegroundTransaction<T>(
  owner: string,
  restoreFocus: boolean,
  operation: (held: string[]) => Promise<T>,
): Promise<{ value: T; focusHeldMs: number; restored: boolean }> {
  const lease = await resourceArbiter.acquire(owner, [
    { key: "desktop.focus", mode: "exclusive" },
    { key: "desktop.input", mode: "exclusive" },
    { key: "desktop.accessibility", mode: "exclusive" },
    { key: "desktop.clipboard", mode: "exclusive" },
  ]);
  const held = lease.resources.map((item) => item.key);
  let previous: FrontmostApp = {};
  let restored = false;
  let value: T | undefined;
  const started = Date.now();

  try {
    previous = (await callPrimitive(
      "app.lifecycle",
      "frontmost",
      {},
      held,
    )) as FrontmostApp;
    value = await operation(held);
  } finally {
    if (
      restoreFocus &&
      previous.app &&
      previous.bundleIdentifier !== "com.tencent.xinWeChat"
    ) {
      try {
        await callPrimitive(
          "app.lifecycle",
          "launch",
          {
            app_name:
              previous.bundleIdentifier?.trim() || previous.app,
          },
          held,
        );
        restored = true;
      } catch {
        // Focus restoration is best-effort; the primary operation result remains valid.
      }
    }
    lease.release();
  }

  return {
    value: value as T,
    focusHeldMs: Date.now() - started,
    restored,
  };
}

async function foregroundOcr(
  binding: Pick<
    WeChatSessionBinding,
    "id" | "contactName" | "ocrLanguages" | "restoreFocus"
  >,
) {
  return await withForegroundTransaction(
    `wechat.session.capture.${binding.id}`,
    binding.restoreFocus,
    async (held) => {
      await navigateToContact(binding.contactName, held);
      const ocr = await backgroundOcr(
        binding.id,
        binding.contactName,
        binding.ocrLanguages,
        held,
      );
      if (!ocr.parsed.contactVerified) {
        throw new Error(
          `WeChat OCR could not verify active chat header "${binding.contactName}" after navigation.`,
        );
      }
      return ocr;
    },
  );
}

export async function bindWeChatSession(input: {
  contactName: string;
  label?: string;
  restoreFocus?: boolean;
  pollIntervalMs?: number;
  ocrLanguages?: string[];
}) {
  const contactName = input.contactName.trim();
  if (!contactName) throw new Error("WeChat contact name is required.");

  const id = newWeChatSessionId();
  const now = new Date().toISOString();
  const binding: WeChatSessionBinding = {
    version: 1,
    id,
    contactName,
    label: input.label?.trim() || `WeChat: ${contactName}`,
    createdAt: now,
    updatedAt: now,
    enabled: true,
    restoreFocus: input.restoreFocus ?? true,
    pollIntervalMs: Math.min(
      Math.max(Math.trunc(input.pollIntervalMs ?? 30_000), 5_000),
      10 * 60_000,
    ),
    ocrLanguages:
      input.ocrLanguages && input.ocrLanguages.length > 0
        ? input.ocrLanguages.slice(0, 8)
        : ["zh-Hans", "en-US"],
    turnCounter: 0,
  };

  let initial:
    | {
        value: Awaited<ReturnType<typeof backgroundOcr>>;
        background: boolean;
        focusHeldMs: number;
        restored: boolean;
      }
    | undefined;

  try {
    const background = await backgroundOcr(
      binding.id,
      binding.contactName,
      binding.ocrLanguages,
    );
    if (background.parsed.contactVerified) {
      initial = {
        value: background,
        background: true,
        focusHeldMs: 0,
        restored: false,
      };
    }
  } catch {
    // Binding can still fall back to a short foreground transaction.
  }

  if (!initial) {
    const focused = await foregroundOcr(binding);
    initial = {
      value: focused.value,
      background: false,
      focusHeldMs: focused.focusHeldMs,
      restored: focused.restored,
    };
  }

  const baseline = initial.value.contentDigest;
  binding.lastObservedDigest = baseline ?? undefined;
  binding.lastDeliveredDigest = baseline ?? undefined;
  binding.lastVisibleText = initial.value.parsed.visibleText || undefined;
  binding.lastReply =
    initial.value.parsed.latestIncomingText ||
    initial.value.parsed.latestText ||
    undefined;
  binding.lastProbeAt = new Date().toISOString();
  binding.lastCaptureAt = binding.lastProbeAt;
  await writeWeChatSession(binding);

  return {
    id: binding.id,
    contactName: binding.contactName,
    label: binding.label,
    pollIntervalMs: binding.pollIntervalMs,
    restoreFocus: binding.restoreFocus,
    baselineDigest: binding.lastDeliveredDigest ?? null,
    contactVerified: initial.value.parsed.contactVerified,
    background: initial.background,
    focusHeldMs: initial.focusHeldMs,
    focusRestored: initial.restored,
    storage: getWeChatSessionStorageInfo(),
  };
}

export async function probeWeChatSession(id: string) {
  const binding = await readWeChatSession(id);
  try {
    const ocr = await backgroundOcr(
      binding.id,
      binding.contactName,
      binding.ocrLanguages,
    );
    binding.lastProbeAt = new Date().toISOString();
    binding.lastObservedDigest = ocr.contentDigest ?? undefined;
    binding.lastVisibleText = ocr.parsed.visibleText || undefined;
    await writeWeChatSession(binding);

    const sameSession = ocr.parsed.contactVerified;
    const changed =
      sameSession &&
      Boolean(ocr.contentDigest) &&
      ocr.contentDigest !== binding.lastDeliveredDigest;

    return {
      sessionId: binding.id,
      endpoint: "wechat",
      contactName: binding.contactName,
      background: true,
      focused: false,
      readable: true,
      sameSession,
      changed,
      needsForeground: !sameSession,
      observedDigest: ocr.contentDigest,
      deliveredDigest: binding.lastDeliveredDigest ?? null,
      latestIncomingText: ocr.parsed.latestIncomingText || null,
      latestText: ocr.parsed.latestText || null,
      headerText: ocr.parsed.headerText,
      reply:
        ocr.parsed.latestIncomingText ||
        ocr.parsed.latestText ||
        null,
    };
  } catch (error) {
    return {
      sessionId: binding.id,
      endpoint: "wechat",
      contactName: binding.contactName,
      background: true,
      focused: false,
      readable: false,
      sameSession: false,
      changed: false,
      needsForeground: true,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function identifyWeChatSession(id: string) {
  const probe = await probeWeChatSession(id);
  return {
    ...probe,
    found: probe.readable,
  };
}

export async function captureLatestWeChatReply(
  id: string,
  options?: { allowFocus?: boolean },
) {
  const binding = await readWeChatSession(id);
  const probe = await probeWeChatSession(id);

  let parsed:
    | ReturnType<typeof visibleConversation>
    | undefined;
  let contentDigest: string | null = null;
  let background = true;
  let focusHeldMs = 0;

  if (probe.readable && probe.sameSession) {
    const ocr = await backgroundOcr(
      binding.id,
      binding.contactName,
      binding.ocrLanguages,
    );
    parsed = ocr.parsed;
    contentDigest = ocr.contentDigest;
  } else {
    if (options?.allowFocus === false) {
      return {
        ...probe,
        ready: false,
        reason: "foreground_required",
      };
    }
    const focused = await foregroundOcr(binding);
    parsed = focused.value.parsed;
    contentDigest = focused.value.contentDigest;
    background = false;
    focusHeldMs = focused.focusHeldMs;
  }

  const changed =
    Boolean(contentDigest) &&
    contentDigest !== binding.lastDeliveredDigest;
  const reply =
    parsed.latestIncomingText ||
    parsed.latestText ||
    parsed.visibleText ||
    "";

  if (contentDigest) {
    binding.lastObservedDigest = contentDigest;
    binding.lastDeliveredDigest = contentDigest;
  }
  binding.lastVisibleText = parsed.visibleText || undefined;
  binding.lastReply = reply || undefined;
  binding.lastCaptureAt = new Date().toISOString();
  await writeWeChatSession(binding);

  return {
    sessionId: binding.id,
    endpoint: "wechat",
    contactName: binding.contactName,
    ready: Boolean(reply),
    sameSession: parsed.contactVerified,
    changed,
    background,
    focused: !background,
    focusHeldMs,
    reply,
    replyDigest: reply ? digest(reply) : null,
    visibleText: parsed.visibleText,
    latestIncomingText: parsed.latestIncomingText || null,
    latestOutgoingText: parsed.latestOutgoingText || null,
    observedDigest: contentDigest,
    turn: binding.turnCounter,
  };
}

export async function sendWeChatSessionMessage(
  id: string,
  text: string,
  options?: {
    confirm?: boolean;
    allowDuplicate?: boolean;
    deduplicateAsSuccess?: boolean;
  },
) {
  if (options?.confirm !== true) {
    throw new Error(
      "WeChat session send requires confirm=true because it sends an external message.",
    );
  }
  const message = text.trim();
  if (!message) throw new Error("WeChat session message cannot be empty.");

  const binding = await readWeChatSession(id);
  const messageDigest = digest(message);

  if (binding.pendingSend) {
    throw new Error(
      `WeChat session ${binding.id} has an unresolved pending send from ${binding.pendingSend.at}.`,
    );
  }
  if (
    !options.allowDuplicate &&
    binding.lastSendReceipt?.digest === messageDigest
  ) {
    if (options.deduplicateAsSuccess) {
      return {
        sessionId: binding.id,
        endpoint: "wechat",
        sent: true,
        deduplicated: true,
        turn: binding.turnCounter,
        receipt: binding.lastSendReceipt,
      };
    }
    throw new Error(
      "Duplicate WeChat send blocked by durable turn receipt.",
    );
  }

  binding.pendingSend = {
    at: new Date().toISOString(),
    digest: messageDigest,
    text: message,
  };
  await writeWeChatSession(binding);

  try {
    const focused = await withForegroundTransaction(
      `wechat.session.send.${binding.id}`,
      binding.restoreFocus,
      async (held) => {
        await navigateToContact(binding.contactName, held);
        const before = await backgroundOcr(
          binding.id,
          binding.contactName,
          binding.ocrLanguages,
          held,
        );
        if (!before.parsed.contactVerified) {
          throw new Error(
            `WeChat active chat "${binding.contactName}" could not be verified before send.`,
          );
        }

        const bounds = (await callPrimitive(
          "app.lifecycle",
          "bounds",
          { app_name: "com.tencent.xinWeChat" },
          held,
        )) as {
          x: number;
          y: number;
          width: number;
          height: number;
        };
        const inputX = Math.round(bounds.x + bounds.width * 0.72);
        const inputY = Math.round(bounds.y + bounds.height * 0.84);
        await callPrimitive(
          "pointer.click",
          "coordinate",
          { x: inputX, y: inputY },
          held,
        );
        await sleep(100);
        await callPrimitive(
          "keyboard.type",
          "text",
          { text: message },
          held,
        );
        await sleep(120);
        await callPrimitive(
          "keyboard.press",
          "key",
          { key: "return" },
          held,
        );
        await sleep(350);

        return await backgroundOcr(
          binding.id,
          binding.contactName,
          binding.ocrLanguages,
          held,
        );
      },
    );

    binding.pendingSend = undefined;
    binding.turnCounter += 1;
    const afterDigest = focused.value.contentDigest;
    if (afterDigest) {
      binding.lastObservedDigest = afterDigest;
      binding.lastDeliveredDigest = afterDigest;
    }
    binding.lastVisibleText =
      focused.value.parsed.visibleText || undefined;
    binding.lastReply =
      focused.value.parsed.latestIncomingText ||
      focused.value.parsed.latestText ||
      undefined;
    binding.lastSendReceipt = {
      at: new Date().toISOString(),
      digest: messageDigest,
      turn: binding.turnCounter,
      contactName: binding.contactName,
      focusHeldMs: focused.focusHeldMs,
    };
    await writeWeChatSession(binding);

    return {
      sessionId: binding.id,
      endpoint: "wechat",
      sent: true,
      sameSession: true,
      messageDigest,
      turn: binding.turnCounter,
      focusHeldMs: focused.focusHeldMs,
      receipt: binding.lastSendReceipt,
    };
  } catch (error) {
    // Keep pendingSend intact. The external side effect may be uncertain.
    await writeWeChatSession(binding).catch(() => undefined);
    throw error;
  }
}

export async function resolvePendingWeChatSend(
  id: string,
  resolution: "sent" | "not_sent",
) {
  const binding = await readWeChatSession(id);
  const pending = binding.pendingSend;
  if (!pending) {
    return {
      sessionId: id,
      resolved: false,
      reason: "no_pending_send",
    };
  }

  if (resolution === "sent") {
    binding.turnCounter += 1;
    binding.lastSendReceipt = {
      at: new Date().toISOString(),
      digest: pending.digest,
      turn: binding.turnCounter,
      contactName: binding.contactName,
      focusHeldMs: 0,
    };
  }
  binding.pendingSend = undefined;
  await writeWeChatSession(binding);

  return {
    sessionId: id,
    resolved: true,
    resolution,
    turn: binding.turnCounter,
    receipt: binding.lastSendReceipt ?? null,
  };
}

export async function listPersistentWeChatSessions() {
  return (await listWeChatSessions()).map((binding) => ({
    id: binding.id,
    endpoint: "wechat",
    contactName: binding.contactName,
    label: binding.label,
    enabled: binding.enabled,
    restoreFocus: binding.restoreFocus,
    pollIntervalMs: binding.pollIntervalMs,
    turnCounter: binding.turnCounter,
    lastProbeAt: binding.lastProbeAt ?? null,
    lastCaptureAt: binding.lastCaptureAt ?? null,
    lastObservedDigest: binding.lastObservedDigest ?? null,
    lastDeliveredDigest: binding.lastDeliveredDigest ?? null,
    pendingSend: binding.pendingSend
      ? {
          at: binding.pendingSend.at,
          digest: binding.pendingSend.digest,
        }
      : null,
    lastSendReceipt: binding.lastSendReceipt ?? null,
  }));
}

export async function deletePersistentWeChatSession(id: string) {
  const binding = await readWeChatSession(id);
  await deleteWeChatSession(id);
  await fs.rm(probePath(id), { force: true }).catch(() => undefined);
  return {
    id,
    deleted: true,
    contactName: binding.contactName,
  };
}

export function weChatSessionAdapterContract() {
  return {
    version: 1,
    endpoint: "wechat",
    operations: [
      "bind",
      "identify",
      "probe",
      "capture_latest",
      "send",
      "resolve_pending",
      "list",
      "delete",
    ],
    lowInterruption: {
      backgroundProbe: "native window capture + Apple Vision OCR",
      foregroundOnlyWhen: [
        "bound contact is not the active WeChat conversation",
        "sending an external message",
      ],
      focusRestore: true,
      defaultPollIntervalMs: 30_000,
    },
    crashSafety: {
      pendingSendBeforeExternalSideEffect: true,
      uncertainSendRequiresExplicitResolution: true,
      duplicateSendReceipt: true,
    },
    storage: getWeChatSessionStorageInfo(),
  };
}
