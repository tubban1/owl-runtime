import assert from "node:assert/strict";
import { withExecutionContext } from "../src/runtime/executionContext.js";
import {
  callDesktopAgentBrowser,
  agentBrowserOwner,
} from "../src/adapters/mcp/desktopAgentBrowserBridge.js";

await assert.rejects(
  callDesktopAgentBrowser("browser_agent_status"),
  /AGENT_BROWSER_BRIDGE_INTERACTIVE_MCP_REQUIRED/,
);
await withExecutionContext(
  { sessionId: "test-runtime-session", requestId: "bridge-test", origin: "mcp" },
  async () => {
    assert.equal(agentBrowserOwner(), "owl-runtime:test-runtime-session");
    await assert.rejects(
      callDesktopAgentBrowser("tool_that_is_not_companion"),
      /AGENT_BROWSER_BRIDGE_TOOL_NOT_ALLOWED/,
    );
    const old = process.env.OWL_DESKTOP_MCP_URL;
    try {
      for (const candidate of [
        "https://evil.example/mcp",
        "http://192.168.1.2:8790/mcp",
        "http://localhost:8790/mcp",
        "http://127.0.0.1:8790/unrestricted",
        "http://attacker@127.0.0.1:8790/mcp",
      ]) {
        process.env.OWL_DESKTOP_MCP_URL = candidate;
        await assert.rejects(
          callDesktopAgentBrowser("browser_agent_status"),
          /AGENT_BROWSER_BRIDGE_ENDPOINT_NOT_LOOPBACK/,
          candidate,
        );
      }
    } finally {
      if (old === undefined) delete process.env.OWL_DESKTOP_MCP_URL;
      else process.env.OWL_DESKTOP_MCP_URL = old;
    }
  },
);
console.log("PASS: Agent Browser bridge owner, allowlist, and loopback-only security");
