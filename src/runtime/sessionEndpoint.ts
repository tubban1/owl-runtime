import {
  captureLatestAgentReply,
  identifyBrowserAgentSession,
  sendAgentMessage,
} from "./sessionAdapters.js";
import {
  captureLatestWeChatReply,
  identifyWeChatSession,
  probeWeChatSession,
  sendWeChatSessionMessage,
} from "./wechatSessionAdapter.js";

export type SessionEndpointOperation =
  | "identify"
  | "probe"
  | "capture_latest"
  | "send";

export function sessionEndpointKind(
  bindingId: string,
): "browser-agent" | "wechat" {
  if (bindingId.startsWith("wechat_session_")) return "wechat";
  if (bindingId.startsWith("session_")) return "browser-agent";
  throw new Error(
    `Unknown session endpoint id "${bindingId}". Expected session_* or wechat_session_*.`,
  );
}

export async function identifySessionEndpoint(bindingId: string) {
  return sessionEndpointKind(bindingId) === "wechat"
    ? await identifyWeChatSession(bindingId)
    : await identifyBrowserAgentSession(bindingId);
}

export async function probeSessionEndpoint(bindingId: string) {
  if (sessionEndpointKind(bindingId) === "wechat") {
    return await probeWeChatSession(bindingId);
  }
  const captured = await captureLatestAgentReply(bindingId);
  return {
    ...captured,
    endpoint: "browser-agent",
    probe: true,
  };
}

export async function captureLatestSessionEndpoint(
  bindingId: string,
  args?: Record<string, unknown>,
) {
  if (sessionEndpointKind(bindingId) === "wechat") {
    return await captureLatestWeChatReply(bindingId, {
      allowFocus: args?.allow_focus !== false,
    });
  }
  return await captureLatestAgentReply(bindingId, {
    maxChars:
      typeof args?.max_chars === "number"
        ? args.max_chars
        : undefined,
  });
}

export async function sendSessionEndpoint(
  bindingId: string,
  text: string,
  args?: Record<string, unknown>,
) {
  if (sessionEndpointKind(bindingId) === "wechat") {
    return await sendWeChatSessionMessage(bindingId, text, {
      confirm: args?.confirm === true,
      allowDuplicate: args?.allow_duplicate === true,
      deduplicateAsSuccess: true,
    });
  }
  return await sendAgentMessage(bindingId, text, {
    confirm: args?.confirm === true,
    allowDuplicate: args?.allow_duplicate === true,
    deduplicateAsSuccess: true,
  });
}
