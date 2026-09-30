import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "owl-mcp-reconnect-"));

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Failed to allocate MCP reconnect test port."));
        return;
      }
      const port = address.port;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function waitForHealth(port: number, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 20_000;
  let lastError = "";
  while (Date.now() < deadline) {
    if (child.exitCode != null) {
      throw new Error(
        `MCP reconnect fixture exited during startup with code ${child.exitCode}. ${lastError}`,
      );
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
      lastError = `health returned ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for MCP reconnect fixture: ${lastError}`);
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode != null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  await Promise.race([
    exited,
    new Promise<void>((resolve) => setTimeout(resolve, 3_000)),
  ]);
  if (child.exitCode == null) {
    child.kill("SIGKILL");
    await exited;
  }
}

const port = await freePort();
const tsx = path.join(root, "node_modules", ".bin", "tsx");
let stderr = "";
const child = spawn(tsx, ["src/adapters/mcp/server.ts"], {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(port),
    OWL_RUNTIME_MODE: "test",
    OWL_CANDIDATE_MODE: "true",
    OWL_STATE_ROOT: path.join(scratch, "state"),
    ALLOWED_DIRECTORIES: scratch,
    ALLOW_WRITE: "true",
    ALLOW_SHELL: "false",
    ALLOW_BROWSER: "false",
    ALLOW_GUI: "false",
  },
  stdio: ["ignore", "ignore", "pipe"],
});
child.stderr?.on("data", (chunk) => {
  stderr += chunk.toString();
  if (stderr.length > 20_000) stderr = stderr.slice(-20_000);
});

const initializeBody = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "owl-mcp-reconnect-regression", version: "1.0" },
  },
};

try {
  await waitForHealth(port, child);

  const initialized = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-session-id": "",
    },
    body: JSON.stringify(initializeBody),
  });
  assert.equal(
    initialized.status,
    200,
    `empty-session initialize must succeed; stderr=${stderr}`,
  );
  const issuedSessionId = initialized.headers.get("mcp-session-id");
  assert.ok(issuedSessionId && issuedSessionId.trim().length > 0);
  await initialized.text();

  const stale = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-session-id": "stale-session-from-previous-runtime",
    },
    body: JSON.stringify(initializeBody),
  });
  assert.equal(stale.status, 404);
  const staleBody = (await stale.json()) as {
    error?: { message?: string };
  };
  assert.equal(staleBody.error?.message, "Session not found");

  console.log(
    JSON.stringify(
      {
        ok: true,
        emptySessionHeaderNormalized: true,
        initializeIssuesFreshSession: true,
        staleSessionReturns404: true,
        reconnectCanReinitialize: true,
      },
      null,
      2,
    ),
  );
} finally {
  await stop(child);
  await fs.rm(scratch, { recursive: true, force: true });
}
