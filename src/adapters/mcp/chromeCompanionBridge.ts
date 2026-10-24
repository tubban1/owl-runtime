import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { currentExecutionContext } from "../../runtime/executionContext.js";

const ALLOWED = new Set([
  "browser_companion_pair",
  "browser_companion_status",
  "browser_companion_snapshot",
  "browser_companion_fill",
  "browser_companion_click",
  "browser_companion_action_result",
  "browser_companion_screenshot",
]);

function endpoint(): URL {
  const configured = process.env.OWL_DESKTOP_MCP_URL?.trim() ||
    "http://127.0.0.1:8790/mcp";
  let url: URL;
  try { url = new URL(configured); }
  catch { throw new Error("CHROME_COMPANION_ENDPOINT_INVALID"); }
  // Never forward browser-control actions to arbitrary URLs, including a
  // public Tunnel, DNS hostname, or another machine on the local network.
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" ||
      url.pathname !== "/mcp" || url.username || url.password ||
      url.search || url.hash || !/^\d{1,5}$/.test(url.port)) {
    throw new Error("CHROME_COMPANION_ENDPOINT_NOT_LOOPBACK");
  }
  return url;
}

export function companionOwner(workstreamId?: string): string {
  const context = currentExecutionContext();
  if (context.origin !== "mcp" || context.sessionId === "runtime:system") {
    throw new Error("CHROME_COMPANION_INTERACTIVE_MCP_REQUIRED");
  }
  if (workstreamId && !/^owl-workstream:[0-9a-f-]{36}$/.test(workstreamId)) {
    throw new Error("CHROME_COMPANION_WORKSTREAM_ID_INVALID");
  }
  // This is a routing identity, never an authority token. The remote MCP and
  // extension still verify the user-initiated pairing and website consent.
  return `owl-runtime:${workstreamId || context.sessionId}`;
}

export async function callDesktopCompanion(
  toolName: string,
  args: Record<string, unknown> = {},
  workstreamId?: string,
) {
  if (!ALLOWED.has(toolName)) throw new Error("CHROME_COMPANION_TOOL_NOT_ALLOWED");
  if (process.env.OWL_COMPANION_BRIDGE_DISABLED === "true") {
    throw new Error("CHROME_COMPANION_BRIDGE_DISABLED");
  }
  const owner = companionOwner(workstreamId);
  const controller = new AbortController();
  const auth = process.env.OWL_DESKTOP_MCP_TOKEN?.trim();
  const transport = new StreamableHTTPClientTransport(endpoint(), {
    requestInit: {
      signal: controller.signal,
      headers: {
        "x-owl-owner-id": owner,
        "x-owl-client-kind": "chatgpt",
        ...(auth ? { authorization: `Bearer ${auth}` } : {}),
      },
    },
  });
  const client = new Client({ name: "owl-runtime-companion-bridge", version: "1.0.0" });
  const timer = setTimeout(() => controller.abort(), 12_000);
  timer.unref?.();
  try {
    await client.connect(transport);
    const response = await client.callTool(
      { name: toolName, arguments: args },
      undefined,
      { signal: controller.signal },
    );
    const result = response as {
      isError?: boolean;
      content?: Array<
        | { type: "text"; text: string }
        | { type: "image"; data: string; mimeType: string }
      >;
      structuredContent?: Record<string, unknown>;
    };
    if (result.isError) {
      const message = result.content
        ?.filter((entry) => entry.type === "text")
        .map((entry) => entry.type === "text" ? entry.text : "")
        .join(" ") || "Desktop MCP returned an error.";
      throw new Error(`CHROME_COMPANION_DESKTOP_ERROR: ${message.slice(0, 280)}`);
    }
    if (!Array.isArray(result.content)) {
      throw new Error("CHROME_COMPANION_DESKTOP_RESULT_INVALID");
    }
    return {
      content: result.content,
      ...(result.structuredContent ? { structuredContent: result.structuredContent } : {}),
    };
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error("CHROME_COMPANION_DESKTOP_TIMEOUT");
    }
    throw error;
  } finally {
    clearTimeout(timer);
    await client.close().catch(() => undefined);
  }
}
