import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

async function browserExecutable(): Promise<string> {
  const home = process.env.HOME;
  if (home) {
    const browsersRoot = path.join(home, ".agent-browser", "browsers");
    try {
      const entries = (await fs.readdir(browsersRoot))
        .filter((name) => name.startsWith("chrome-"))
        .sort()
        .reverse();
      for (const entry of entries) {
        const candidate = path.join(
          browsersRoot,
          entry,
          "Google Chrome for Testing.app",
          "Contents",
          "MacOS",
          "Google Chrome for Testing",
        );
        if (await fs.access(candidate).then(() => true).catch(() => false)) {
          return candidate;
        }
      }
    } catch {
      // Fall back to a system Chromium browser below.
    }
  }

  const candidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  ];
  for (const candidate of candidates) {
    if (await fs.access(candidate).then(() => true).catch(() => false)) return candidate;
  }
  throw new Error("Browser startup regression requires a local Chromium browser.");
}

const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "owl-browser-startup-regression-"));
const profile = path.join(scratch, "profile");
const marker = path.join(scratch, "first-launch-failed");
const wrapper = path.join(scratch, "browser-wrapper.zsh");
const executable = await browserExecutable();
await fs.writeFile(
  wrapper,
  [
    "#!/bin/zsh",
    `if [[ ! -e ${JSON.stringify(marker)} ]]; then`,
    `  /usr/bin/touch ${JSON.stringify(marker)}`,
    "  exit 42",
    "fi",
    `exec ${JSON.stringify(executable)} "$@"`,
    "",
  ].join("\n"),
  { mode: 0o700 },
);
await fs.chmod(wrapper, 0o700);

process.env.OWL_RUNTIME_MODE = "test";
process.env.OWL_STATE_ROOT = path.join(scratch, "state");
process.env.ALLOW_BROWSER = "true";
process.env.BROWSER_HEADLESS = "true";
process.env.BROWSER_EXECUTABLE = wrapper;
process.env.BROWSER_PROFILE_DIR = profile;
process.env.BROWSER_STARTUP_TIMEOUT_MS = "10000";
process.env.BROWSER_CONNECT_TIMEOUT_MS = "10000";
process.env.ALLOWED_DIRECTORIES = scratch;

const server = http.createServer((_req, res) => {
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end("<!doctype html><title>OWL Browser Regression</title><h1>ready</h1>");
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("test server did not bind");
const url = `http://127.0.0.1:${address.port}/`;

const { browserProvider } = await import("../src/providers/browserProvider.js");
try {
  // Two cold callers share one launch. The wrapper intentionally fails the
  // first Chrome startup; BrowserProvider must reap it, retry with a new CDP
  // port, and make both callers succeed.
  const [opened, tabs] = await Promise.all([
    browserProvider.open(url, "domcontentloaded", true),
    browserProvider.listTabs(),
  ]);
  assert.equal(opened.url, url);
  assert.ok(tabs.length >= 1);
  assert.equal(await fs.access(marker).then(() => true).catch(() => false), true);
  const firstStatus = await browserProvider.status();
  assert.equal(firstStatus.details?.connected, true);
  assert.equal(typeof firstStatus.details?.cdpPort, "number");

  await browserProvider.close();
  assert.equal((await browserProvider.status()).details?.connected, false);

  // A second cold start against the same profile proves failed-start cleanup did
  // not leave an orphan process/profile lock behind.
  const reopened = await browserProvider.open(url, "domcontentloaded", true);
  assert.equal(reopened.url, url);
  await browserProvider.close();

  console.log(
    JSON.stringify(
      {
        ok: true,
        forcedFirstLaunchFailure: true,
        boundedRetryRecovered: true,
        concurrentColdCallSharedLaunch: true,
        relaunchAfterCleanup: true,
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
