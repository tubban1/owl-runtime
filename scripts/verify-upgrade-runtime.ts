import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratch = path.join(root, ".tmp-verify-upgrade-runtime");
const stateRoot = path.join(scratch, "state");
const distServer = path.join(root, "dist", "server.js");
const controlClient = path.join(root, "scripts", "runtime-control-client.mjs");
const stateClient = path.join(root, "scripts", "runtime-state-client.mjs");
const packageJson = JSON.parse(
  await fs.readFile(path.join(root, "package.json"), "utf8"),
) as { version: string };

await fs.rm(scratch, { recursive: true, force: true });
await fs.mkdir(scratch, { recursive: true });

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Could not allocate a local verifier port."));
        return;
      }
      const port = address.port;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

type Health = {
  ok?: boolean;
  version?: string;
  runtime?: {
    mode?: string;
    candidateMode?: boolean;
    stateRoot?: string;
    codeRoot?: string;
    backgroundControllersStarted?: boolean;
    lifecycle?: {
      state?: string;
      mutationIdle?: boolean;
    };
    stateSchema?: {
      schemaVersion?: number;
      currentSchemaVersion?: number;
      readable?: boolean;
      migrationRequired?: boolean;
      nativeSchema?: boolean;
      autoMigrationSafe?: boolean;
      rollbackCompatible?: boolean;
    };
  };
  capabilities?: {
    gracefulDrain?: boolean;
    upgradeCandidateMode?: boolean;
    versionedStateSchema?: boolean;
    stateMigrationRegistry?: boolean;
  };
};

async function waitForHealth(
  port: number,
  predicate: (health: Health) => boolean,
  timeoutMs = 30_000,
): Promise<Health> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) {
        const health = (await response.json()) as Health;
        if (predicate(health)) return health;
        lastError = `unexpected health: ${JSON.stringify(health)}`;
      } else {
        lastError = `HTTP ${response.status}`;
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Health wait timed out: ${lastError}`);
}

function startRuntime(port: number, candidate: boolean) {
  const stdoutPath = path.join(
    scratch,
    candidate ? "candidate.stdout.log" : "current.stdout.log",
  );
  const stderrPath = path.join(
    scratch,
    candidate ? "candidate.stderr.log" : "current.stderr.log",
  );

  const child = execFile(
    process.execPath,
    [distServer],
    {
      cwd: root,
      env: {
        ...process.env,
        PORT: String(port),
        AGENTOS_RUNTIME_MODE: "production",
        AGENTOS_STATE_ROOT: stateRoot,
        AGENTOS_CANDIDATE_MODE: candidate ? "true" : "false",
        AUDIT_LOG_ENABLED: "false",
        PROCESS_MONITOR_POLL_MS: "60000",
        SCHEDULER_POLL_MS: "60000",
        LOOP_CONTROLLER_POLL_MS: "60000",
      },
      maxBuffer: 8 * 1024 * 1024,
    },
    async (error, stdout, stderr) => {
      await fs.writeFile(stdoutPath, stdout ?? "").catch(() => undefined);
      await fs.writeFile(stderrPath, stderr ?? "").catch(() => undefined);
      if (error && !child.killed) {
        // The verifier observes process liveness separately. Preserve logs only.
      }
    },
  );

  return { child, stdoutPath, stderrPath };
}

async function stopRuntime(
  runtime: ReturnType<typeof startRuntime> | undefined,
) {
  if (!runtime) return;
  const child = runtime.child;
  if (child.exitCode !== null || child.killed) return;
  child.kill("SIGTERM");
  const deadline = Date.now() + 5_000;
  while (child.exitCode === null && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function callRuntimeClient(
  clientPath: string,
  port: number,
  op: string,
  args: Record<string, unknown> = {},
) {
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    [
      clientPath,
      `http://127.0.0.1:${port}/mcp`,
      op,
      JSON.stringify(args),
    ],
    {
      cwd: root,
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  if (stderr.trim()) {
    throw new Error(`runtime client stderr: ${stderr.trim()}`);
  }
  return JSON.parse(stdout) as Record<string, any>;
}

async function control(
  port: number,
  op: "status" | "drain" | "wait" | "resume",
  args: Record<string, unknown> = {},
) {
  return await callRuntimeClient(controlClient, port, op, args);
}

const currentPort = await freePort();
const candidatePort = await freePort();
let current: ReturnType<typeof startRuntime> | undefined;
let candidate: ReturnType<typeof startRuntime> | undefined;

try {
  current = startRuntime(currentPort, false);
  const currentHealth = await waitForHealth(
    currentPort,
    (health) =>
      health.ok === true &&
      health.version === packageJson.version &&
      health.runtime?.mode === "production" &&
      health.runtime?.candidateMode === false &&
      health.runtime?.backgroundControllersStarted === true &&
      health.runtime?.lifecycle?.state === "running" &&
      health.runtime?.stateSchema?.readable === true &&
      health.capabilities?.gracefulDrain === true &&
      health.capabilities?.upgradeCandidateMode === true &&
      health.capabilities?.versionedStateSchema === true &&
      health.capabilities?.stateMigrationRegistry === true,
  );

  candidate = startRuntime(candidatePort, true);
  const candidateHealth = await waitForHealth(
    candidatePort,
    (health) =>
      health.ok === true &&
      health.version === packageJson.version &&
      health.runtime?.mode === "production" &&
      health.runtime?.candidateMode === true &&
      health.runtime?.backgroundControllersStarted === false &&
      health.runtime?.lifecycle?.state === "draining" &&
      health.runtime?.stateSchema?.readable === true &&
      health.runtime?.stateSchema?.migrationRequired === true &&
      health.runtime?.stateSchema?.autoMigrationSafe === true &&
      health.runtime?.stateSchema?.rollbackCompatible === true &&
      health.capabilities?.upgradeCandidateMode === true &&
      health.capabilities?.versionedStateSchema === true &&
      health.capabilities?.stateMigrationRegistry === true,
  );

  assert.equal(candidateHealth.runtime?.stateRoot, currentHealth.runtime?.stateRoot);
  assert.equal(candidateHealth.runtime?.lifecycle?.mutationIdle, true);

  const initial = await control(currentPort, "status");
  assert.equal(initial.lifecycle.state, "running");

  const drained = await control(currentPort, "drain", {
    reason: "verify upgrade coordinator",
  });
  assert.equal(drained.lifecycle.state, "draining");

  const waited = await control(currentPort, "wait", { timeout_ms: 5_000 });
  assert.equal(waited.drained, true);
  assert.equal(waited.timedOut, false);

  const healthWhileDrained = await waitForHealth(
    currentPort,
    (health) => health.runtime?.lifecycle?.state === "draining",
  );
  assert.equal(healthWhileDrained.runtime?.lifecycle?.mutationIdle, true);

  const stateMigration = await callRuntimeClient(
    stateClient,
    candidatePort,
    "migrate",
    { confirm: true },
  );
  assert.equal(stateMigration.changed, true);

  const candidateAfterMigration = await waitForHealth(
    candidatePort,
    (health) =>
      health.runtime?.stateSchema?.migrationRequired === false &&
      health.runtime?.stateSchema?.nativeSchema === true &&
      health.runtime?.stateSchema?.schemaVersion ===
        health.runtime?.stateSchema?.currentSchemaVersion,
  );
  assert.equal(candidateAfterMigration.runtime?.stateSchema?.nativeSchema, true);

  const resumed = await control(currentPort, "resume");
  assert.equal(resumed.lifecycle.state, "running");

  const resumedHealth = await waitForHealth(
    currentPort,
    (health) =>
      health.runtime?.lifecycle?.state === "running" &&
      health.runtime?.candidateMode === false,
  );
  assert.equal(resumedHealth.runtime?.backgroundControllersStarted, true);

  await execFileAsync("/bin/zsh", ["-n", "scripts/upgrade-production-runtime.sh"], {
    cwd: root,
    timeout: 10_000,
  });
  await execFileAsync("/bin/zsh", ["-n", "scripts/install-production-runtime.sh"], {
    cwd: root,
    timeout: 10_000,
  });
  await execFileAsync(
    "/bin/zsh",
    ["-c", 'x=120000; [[ "$x" =~ ^[0-9]+$ ]]'],
    { cwd: root, timeout: 10_000 },
  );
  await assert.rejects(
    () =>
      execFileAsync(
        "/bin/zsh",
        ["-c", 'x=abc; [[ "$x" =~ ^[0-9]+$ ]]'],
        { cwd: root, timeout: 10_000 },
      ),
  );

  for (const script of [
    "scripts/install-production-runtime.sh",
    "scripts/upgrade-production-runtime.sh",
  ]) {
    const source = await fs.readFile(path.join(root, script), "utf8");
    assert.match(
      source,
      /RELEASE_ROOT="\\\$\(cd "\\\$\(dirname "\\\$0"\)" && pwd\)"/,
    );
    assert.match(
      source,
      /exec "\$NODE_BIN" "\\\$RELEASE_ROOT\/dist\/server\.js"/,
    );
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        version: packageJson.version,
        currentRuntime: {
          candidateMode: false,
          backgroundControllersStarted: true,
          gracefulDrain: true,
        },
        candidateRuntime: {
          alternatePort: true,
          sameStateRoot: true,
          startsDraining: true,
          backgroundControllersStarted: false,
          compatibilityHealth: true,
        },
        mcpDrainControl: true,
        drainWait: true,
        candidateStateMigration: true,
        stateMigrationBeforeCutover: true,
        resume: true,
        upgradeScriptSyntax: true,
        drainTimeoutValidation: true,
        releaseRunTemplateEscaped: true,
        installScriptSyntax: true,
      },
      null,
      2,
    ),
  );
} finally {
  await stopRuntime(candidate);
  await stopRuntime(current);
  await fs.rm(scratch, { recursive: true, force: true }).catch(
    () => undefined,
  );
}
