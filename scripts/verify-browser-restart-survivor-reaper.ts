import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

async function findFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not allocate survivor verifier port."));
        return;
      }
      server.close((error) =>
        error ? reject(error) : resolve(address.port),
      );
    });
  });
}

async function waitForCdp(port: number, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>((resolve) => {
      const request = http.get(
        {
          hostname: "127.0.0.1",
          port,
          path: "/json/version",
          timeout: 300,
        },
        (response) => {
          response.resume();
          resolve(response.statusCode === 200);
        },
      );
      request.once("timeout", () => {
        request.destroy();
        resolve(false);
      });
      request.once("error", () => resolve(false));
    });
    if (ok) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Survivor Chrome did not expose CDP.");
}

function isAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForExit(pid: number, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Unclaimed managed Chrome survivor was not reaped.");
}

const scratch = await fs.mkdtemp(
  path.join(os.tmpdir(), "owl-browser-survivor-reaper-"),
);
const profile = path.join(scratch, "profile");
await fs.mkdir(profile, { recursive: true });
const executable =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const port = await findFreePort();

const survivor = spawn(
  executable,
  [
    "--headless=new",
    "--remote-debugging-port=" + port,
    "--remote-debugging-address=127.0.0.1",
    "--user-data-dir=" + profile,
    "--remote-allow-origins=*",
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank",
  ],
  { stdio: ["ignore", "ignore", "ignore"] },
);

try {
  await waitForCdp(port);
  assert.equal(isAlive(survivor.pid!), true);

  process.env.OWL_RUNTIME_MODE = "test";
  process.env.OWL_STATE_ROOT = path.join(scratch, "state");
  process.env.ALLOW_BROWSER = "true";
  process.env.BROWSER_HEADLESS = "true";
  process.env.BROWSER_PROFILE_DIR = profile;
  process.env.BROWSER_EXECUTABLE = executable;
  process.env.BROWSER_RESTART_SURVIVOR_GRACE_MS = "600";
  process.env.BROWSER_STARTUP_ATTEMPTS = "1";
  process.env.BROWSER_STARTUP_BUDGET_MS = "30000";

  const { browserProvider } = await import("../src/providers/browserProvider.js");
  await waitForExit(survivor.pid!, 5_000);
  await fs.access(profile);

  const fixture = http.createServer((_req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(
      "<!doctype html><title>OWL Survivor Reaper</title><h1>relaunch-ready</h1>",
    );
  });
  await new Promise<void>((resolve, reject) => {
    fixture.once("error", reject);
    fixture.listen(0, "127.0.0.1", () => resolve());
  });
  const address = fixture.address();
  if (!address || typeof address === "string") {
    throw new Error("Survivor fixture did not bind.");
  }

  try {
    const opened = await browserProvider.open(
      "http://127.0.0.1:" + address.port + "/",
      "domcontentloaded",
      true,
    );
    assert.equal(opened.title, "OWL Survivor Reaper");
    const status = await browserProvider.status();
    assert.equal(status.details?.connected, true);
    assert.equal(status.details?.recoveredAfterRuntimeRestart, false);
    assert.equal(status.details?.restartSurvivorGraceMs, 600);
  } finally {
    await browserProvider.close().catch(() => undefined);
    await new Promise<void>((resolve) => fixture.close(() => resolve()));
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        unclaimedHeadlessSurvivorReaped: true,
        persistentProfilePreserved: true,
        cleanRelaunchAfterReap: true,
        restartSurvivorGraceMs: 600,
      },
      null,
      2,
    ),
  );
} finally {
  if (survivor.exitCode == null && survivor.pid) {
    survivor.kill("SIGKILL");
  }
  await fs.rm(scratch, { recursive: true, force: true });
}
