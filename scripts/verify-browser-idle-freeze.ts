import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

const scratch = await fs.mkdtemp(
  path.join(os.tmpdir(), "owl-browser-idle-freeze-"),
);

process.env.OWL_RUNTIME_MODE = "test";
process.env.OWL_STATE_ROOT = path.join(scratch, "state");
process.env.ALLOW_BROWSER = "true";
process.env.BROWSER_HEADLESS = "true";
process.env.BROWSER_PROFILE_DIR = path.join(scratch, "profile");
process.env.BROWSER_EXECUTABLE =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
process.env.BROWSER_IDLE_FREEZE_MS = "500";
process.env.BROWSER_STARTUP_ATTEMPTS = "1";
process.env.BROWSER_STARTUP_BUDGET_MS = "30000";

let tickCount = 0;
const server = http.createServer((req, res) => {
  if (req.url?.startsWith("/tick")) {
    tickCount += 1;
    res.statusCode = 204;
    res.end();
    return;
  }

  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(
    '<!doctype html><title>OWL Idle Freeze</title>' +
      '<h1>idle-freeze-ready</h1>' +
      '<script>setInterval(function(){fetch("/tick?at="+Date.now(),{cache:"no-store"}).catch(function(){});},50);</script>',
  );
});

await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => resolve());
});
const address = server.address();
if (!address || typeof address === "string") {
  throw new Error("Browser idle-freeze verifier server did not bind.");
}
const url = "http://127.0.0.1:" + address.port + "/";

const { browserProvider } = await import("../src/providers/browserProvider.js");

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
  message: string,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(message);
}

try {
  const opened = await browserProvider.open(url, "domcontentloaded", true);
  assert.equal(opened.title, "OWL Idle Freeze");

  await waitFor(
    () => tickCount >= 4,
    3_000,
    "Browser page never became active enough to produce ticks.",
  );

  await waitFor(
    async () => {
      const status = await browserProvider.status();
      return Number(status.details?.idleFrozenPageCount ?? 0) >= 1;
    },
    3_000,
    "Headless browser page did not enter the idle-frozen state.",
  );

  const frozenStart = tickCount;
  await new Promise((resolve) => setTimeout(resolve, 400));
  const frozenEnd = tickCount;
  assert.ok(
    frozenEnd - frozenStart <= 1,
    "Frozen page kept producing background ticks: " +
      frozenStart +
      " -> " +
      frozenEnd,
  );

  const snapshot = await browserProvider.snapshot(4_000);
  assert.match(snapshot.text, /idle-freeze-ready/);
  const afterWakeStatus = await browserProvider.status();
  assert.equal(afterWakeStatus.details?.idleFrozenPageCount, 0);

  const wakeStart = tickCount;
  await waitFor(
    () => tickCount >= wakeStart + 3,
    2_000,
    "Browser activity did not thaw the page and resume timers/network.",
  );

  await waitFor(
    async () => {
      const status = await browserProvider.status();
      return Number(status.details?.idleFrozenPageCount ?? 0) >= 1;
    },
    3_000,
    "Browser page did not return to idle-frozen state after wake.",
  );

  const finalStatus = await browserProvider.status();
  assert.equal(finalStatus.details?.idleFreezeMs, 500);
  assert.equal(finalStatus.details?.activeBrowserOperations, 0);
  assert.equal(typeof finalStatus.details?.lastBrowserActivityAt, "string");

  // Simulate a Runtime crash while an idle page is debugger-paused. The Chrome
  // process/profile must survive, and the next Runtime must reconnect and make
  // the page active again rather than inheriting a permanently paused target.
  await browserProvider.close();
  const restartProfile = path.join(scratch, "restart-profile");
  const restartState = path.join(scratch, "restart-state");
  const childPath = path.join(scratch, "pause-then-exit.ts");
  const providerModuleUrl = new URL(
    "../src/providers/browserProvider.js",
    import.meta.url,
  ).href;
  await fs.writeFile(
    childPath,
    [
      '(async () => {',
      '  const { browserProvider } = await import(process.env.OWL_TEST_BROWSER_PROVIDER_MODULE);',
      '  const url = process.env.OWL_TEST_BROWSER_URL;',
      '  await browserProvider.open(url, "domcontentloaded", true);',
      '  const deadline = Date.now() + 5000;',
      '  while (Date.now() < deadline) {',
      '    const status = await browserProvider.status();',
      '    if (Number(status.details?.idleFrozenPageCount ?? 0) >= 1) {',
      '      console.log("IDLE_PAUSED");',
      '      process.exit(0);',
      '    }',
      '    await new Promise((resolve) => setTimeout(resolve, 50));',
      '  }',
      '  throw new Error("child Runtime never reached idle pause");',
      '})().catch((error) => {',
      '  console.error(error);',
      '  process.exit(1);',
      '});',
      '',
    ].join("\n"),
    "utf8",
  );

  const child = spawn(
    path.join(process.cwd(), "node_modules", ".bin", "tsx"),
    [childPath],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        OWL_STATE_ROOT: restartState,
        BROWSER_PROFILE_DIR: restartProfile,
        BROWSER_IDLE_FREEZE_MS: "500",
        OWL_TEST_BROWSER_PROVIDER_MODULE: providerModuleUrl,
        OWL_TEST_BROWSER_URL: url,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let childStdout = "";
  let childStderr = "";
  child.stdout.on("data", (chunk) => {
    childStdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    childStderr += chunk.toString();
  });
  const childExitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code));
  });
  assert.equal(
    childExitCode,
    0,
    "pause/crash child failed: " + childStdout + childStderr,
  );
  assert.match(childStdout, /IDLE_PAUSED/);

  process.env.OWL_STATE_ROOT = restartState;
  process.env.BROWSER_PROFILE_DIR = restartProfile;
  const tickBeforeReconnect = tickCount;
  const recovered = await browserProvider.open(url, "domcontentloaded", true);
  assert.equal(recovered.title, "OWL Idle Freeze");
  const recoveredStatus = await browserProvider.status();
  assert.equal(recoveredStatus.details?.recoveredAfterRuntimeRestart, true);
  await waitFor(
    () => tickCount >= tickBeforeReconnect + 3,
    2_000,
    "Recovered Runtime did not resume the previously paused browser page.",
  );

  console.log(
    JSON.stringify(
      {
        ok: true,
        headlessIdleFreeze: true,
        backgroundTicksStopped: true,
        activityThawsPage: true,
        pageRefreezesAfterActivity: true,
        pausedPageRecoversAcrossRuntimeRestart: true,
        frozenTickDelta: frozenEnd - frozenStart,
        idleFreezeMs: finalStatus.details?.idleFreezeMs,
      },
      null,
      2,
    ),
  );
} finally {
  await browserProvider.close().catch(() => undefined);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await fs.rm(scratch, { recursive: true, force: true });
}
