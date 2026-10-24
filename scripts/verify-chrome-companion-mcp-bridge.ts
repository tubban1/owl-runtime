import assert from "node:assert/strict";
import { withExecutionContext } from "../src/runtime/executionContext.js";
import {
  callDesktopCompanion,
  companionOwner,
} from "../src/adapters/mcp/chromeCompanionBridge.js";

await assert.rejects(
  callDesktopCompanion("browser_companion_status"),
  /CHROME_COMPANION_INTERACTIVE_MCP_REQUIRED/,
);
await withExecutionContext(
  { sessionId: "test-runtime-session", requestId: "bridge-test", origin: "mcp" },
  async () => {
    assert.equal(companionOwner(), "owl-runtime:test-runtime-session");
    await assert.rejects(
      callDesktopCompanion("tool_that_is_not_companion"),
      /CHROME_COMPANION_TOOL_NOT_ALLOWED/,
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
          callDesktopCompanion("browser_companion_status"),
          /CHROME_COMPANION_ENDPOINT_NOT_LOOPBACK/,
          candidate,
        );
      }
    } finally {
      if (old === undefined) delete process.env.OWL_DESKTOP_MCP_URL;
      else process.env.OWL_DESKTOP_MCP_URL = old;
    }
  },
);
console.log("PASS: Chrome Companion bridge owner, allowlist, and loopback-only security");
