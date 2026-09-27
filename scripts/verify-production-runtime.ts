import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distServer = path.join(root, "dist", "server.js");
const scratch = path.join(root, ".tmp-verify-production-runtime");
const stateRoot = path.join(scratch, "state");

await fs.rm(scratch, { recursive: true, force: true });
await fs.mkdir(stateRoot, { recursive: true });

await fs.access(distServer);

const installScript = await fs.readFile(
  path.join(root, "scripts", "install-production-runtime.sh"),
  "utf8",
);
assert.match(installScript, /AGENTOS_RUNTIME_MODE=production/);
assert.match(installScript, /Rollback health verified/);
assert.match(installScript, /Rollback failed health verification/);
assert.doesNotMatch(installScript, /tsx watch src\/server\.ts/);

const port = await new Promise<number>((resolve, reject) => {
  const server = net.createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      reject(new Error("Could not allocate verifier port."));
      return;
    }
    const selected = address.port;
    server.close((error) => {
      if (error) reject(error);
      else resolve(selected);
    });
  });
});

let stdout = "";
let stderr = "";
const child = spawn(process.execPath, [distServer], {
  cwd: scratch,
  env: {
    ...process.env,
    PORT: String(port),
    AGENTOS_RUNTIME_MODE: "production",
    AGENTOS_STATE_ROOT: stateRoot,
    ALLOWED_DIRECTORIES: root,
    ALLOW_SHELL: "false",
    ALLOW_BROWSER: "false",
    ALLOW_GUI: "false",
    AUDIT_LOG_ENABLED: "false",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

child.stdout.on("data", (chunk) => {
  stdout += chunk.toString();
});
child.stderr.on("data", (chunk) => {
  stderr += chunk.toString();
});

try {
  let health: any;
  let lastError = "";
  const healthDeadline = Date.now() + 60_000;
  while (Date.now() < healthDeadline) {
    if (child.exitCode !== null) {
      lastError = `child exited before health with code ${child.exitCode}`;
      break;
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) {
        health = await response.json();
        break;
      }
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  if (!health) {
    throw new Error(
      `Production Runtime did not become healthy: ${lastError}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
    );
  }

  assert.equal(health.ok, true);
  assert.equal(health.service, "computer-mcp");
  assert.equal(health.version, "0.9.16");
  assert.equal(health.runtime?.mode, "production");
  assert.equal(path.resolve(health.runtime?.stateRoot), path.resolve(stateRoot));
  assert.equal(path.resolve(health.runtime?.codeRoot), path.resolve(root));
  assert.equal(health.capabilities?.sessionAwareConcurrency, true);
  assert.equal(health.capabilities?.workspaceLeases, true);
  assert.equal(health.capabilities?.persistentProcessOwnership, true);
  assert.equal(health.capabilities?.productionRuntimeIsolation, true);
  assert.equal(health.capabilities?.runtimeSelfProtection, true);
  assert.equal(health.capabilities?.gracefulDrain, true);
  assert.equal(health.capabilities?.workspaceHandoff, true);
  assert.equal(health.capabilities?.versionedStateSchema, true);
  assert.equal(health.capabilities?.stateMigrationRegistry, true);
  assert.equal(health.capabilities?.crashRecoveryMatrix, true);
  assert.equal(health.capabilities?.multiAgentSoakHarness, true);
  assert.equal(
    health.capabilities?.sameRuntimeDisconnectedSessionReclamation,
    true,
  );
  assert.equal(
    health.capabilities?.sameRuntimeIdleSessionReclamation,
    true,
  );
  assert.equal(health.runtime?.stateSchema?.schemaVersion, 0);
  assert.equal(health.runtime?.stateSchema?.readable, true);
  assert.equal(health.runtime?.stateSchema?.migrationRequired, true);

  assert.match(stdout, /computer-mcp v0\.9\.16 listening/);
  assert.doesNotMatch(stdout, /tsx watch/);

  console.log(
    JSON.stringify(
      {
        ok: true,
        command: [process.execPath, distServer],
        sourceWatcher: false,
        healthVersion: health.version,
        runtimeMode: health.runtime.mode,
        isolatedStateRoot: health.runtime.stateRoot,
        sessionAwareConcurrency: health.capabilities.sessionAwareConcurrency,
        workspaceLeases: health.capabilities.workspaceLeases,
        persistentProcessOwnership:
          health.capabilities.persistentProcessOwnership,
        runtimeSelfProtection: health.capabilities.runtimeSelfProtection,
        versionedStateSchema: health.capabilities.versionedStateSchema,
        crashRecoveryMatrix: health.capabilities.crashRecoveryMatrix,
        multiAgentSoakHarness: health.capabilities.multiAgentSoakHarness,
        sameRuntimeDisconnectedSessionReclamation:
          health.capabilities.sameRuntimeDisconnectedSessionReclamation,
        sameRuntimeIdleSessionReclamation:
          health.capabilities.sameRuntimeIdleSessionReclamation,
        legacyStateReadable: health.runtime.stateSchema.readable,
      },
      null,
      2,
    ),
  );
} finally {
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 3000);
    timer.unref();
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  await fs.rm(scratch, { recursive: true, force: true }).catch(() => undefined);
}
