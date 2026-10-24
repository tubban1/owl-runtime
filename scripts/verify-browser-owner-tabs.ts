import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "owl-tab-isolation-"));
process.env.OWL_RUNTIME_MODE = "test";
process.env.OWL_STATE_ROOT = path.join(scratch, "state");
process.env.BROWSER_PROFILE_DIR = path.join(scratch, "browser-profile");
process.env.ALLOW_BROWSER = "true";
process.env.BROWSER_HEADLESS = "true";
process.env.ALLOWED_DIRECTORIES = scratch;
process.env.BROWSER_STARTUP_ATTEMPTS = "1";
process.env.BROWSER_STARTUP_BUDGET_MS = "25000";
const { browserProvider } = await import("../src/providers/browserProvider.js");
const { withExecutionContext } = await import("../src/runtime/executionContext.js");

const server = http.createServer((req, res) => {
  res.writeHead(200, {"content-type": "text/html; charset=utf-8"});
  const owner = req.url?.includes("alpha") ? "alpha"
    : req.url?.includes("beta") ? "beta" : "human";
  res.end('<!doctype html><title>' + owner + '</title><h1>' + owner +
    '</h1><input id="note" value="' + owner + '">');
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
const address = server.address();
assert.ok(address && typeof address !== "string");
const url = "http://127.0.0.1:" + address.port;
const runAs = async <T>(owner: string, fn: () => Promise<T>) =>
  withExecutionContext({
    origin: "api",
    sessionId: owner,
    requestId: owner + "-test",
  }, fn);

try {
  // A human-visible legacy page exists before the agent creates background tabs.
  const human = await browserProvider.open(url + "/human", "domcontentloaded", true);
  assert.equal(human.title, "human");
  const spare = await browserProvider.newTab(url + "/spare");
  assert.match(spare.tabId, /^[a-fA-F0-9]{32}$/);

  const alpha = await runAs("alpha", () => browserProvider.open(url + "/alpha"));
  const beta = await runAs("beta", () => browserProvider.open(url + "/beta"));
  assert.match(alpha.tabId, /^[a-fA-F0-9]{32}$/);
  assert.match(beta.tabId, /^[a-fA-F0-9]{32}$/);
  assert.notEqual(alpha.tabId, beta.tabId);
  assert.equal(alpha.title, "alpha");
  assert.equal(beta.title, "beta");

  const alphaType = await runAs("alpha", () => browserProvider.type("#note", "alpha-only"));
  const betaType = await runAs("beta", () => browserProvider.type("#note", "beta-only"));
  assert.equal(alphaType.tabId, alpha.tabId);
  assert.equal(betaType.tabId, beta.tabId);

  const alphaInput = await runAs("alpha", () => browserProvider.controlState("#note"));
  const betaInput = await runAs("beta", () => browserProvider.controlState("#note"));
  assert.equal(alphaInput.valueLength, 10);
  assert.equal(betaInput.valueLength, 9);
  assert.notEqual(alphaInput.valueSha256, betaInput.valueSha256);
  const alphaSnap = await runAs("alpha", () => browserProvider.snapshot());
  const betaSnap = await runAs("beta", () => browserProvider.snapshot());
  assert.equal(alphaSnap.title, "alpha");
  assert.equal(betaSnap.title, "beta");

  const alphaShot = path.join(scratch, "alpha.png");
  const betaShot = path.join(scratch, "beta.png");
  const alphaEvidence = await runAs("alpha", () => browserProvider.screenshot(alphaShot));
  const betaEvidence = await runAs("beta", () => browserProvider.screenshot(betaShot));
  assert.equal(alphaEvidence.tabId, alpha.tabId);
  assert.equal(betaEvidence.tabId, beta.tabId);
  assert.ok((await fs.stat(alphaShot)).size > 100);
  assert.ok((await fs.stat(betaShot)).size > 100);

  await assert.rejects(() => runAs("alpha", () =>
    browserProvider.open(url + "/alpha", "domcontentloaded", false)),
    /Cannot change managed browser headless mode/);

  const tabA = await runAs("alpha", () => browserProvider.listTabs());
  const tabB = await runAs("beta", () => browserProvider.listTabs());
  assert.equal(tabA.filter(t => t.active).length, 1);
  assert.equal(tabB.filter(t => t.active).length, 1);
  const activeA = tabA.find(t => t.active);
  const activeB = tabB.find(t => t.active);
  assert.ok(activeA && activeB);
  assert.notEqual(activeA.index, activeB.index);
  assert.equal(activeA.tabId, alpha.tabId);
  assert.equal(activeB.tabId, beta.tabId);
  // A human removes another tab. Stable IDs retain ownership and resolve to
  // updated indices, while old indices no longer identify the same page.
  const browserContext = (browserProvider as unknown as {
    context: import("playwright-core").BrowserContext;
  }).context;
  const sparePage = browserContext.pages().find(p => p.url().endsWith("/spare"));
  assert.ok(sparePage);
  await sparePage.close();
  const reordered = await runAs("alpha", () => browserProvider.listTabs());
  const after = reordered.find(t => t.tabId === alpha.tabId);
  assert.ok(after);
  assert.notEqual(after.index, activeA.index);
  const selected = await runAs("alpha", () => browserProvider.useTab(undefined, alpha.tabId));
  assert.equal(selected.index, after.index);
  assert.equal(selected.tabId, alpha.tabId);
  await assert.rejects(() => runAs("alpha", () => browserProvider.useTab(undefined, "f".repeat(32))),
    /not found/);
  await assert.rejects(() => runAs("alpha", () => browserProvider.useTab(undefined, beta.tabId)),
    /assigned to another Runtime owner/);
  const latestBeta = reordered.find(t => t.tabId === beta.tabId);
  assert.ok(latestBeta);
  await assert.rejects(() => runAs("alpha", () => browserProvider.useTab(latestBeta.index)),
    /assigned to another Runtime owner/);

  const closed = await runAs("alpha", () => browserProvider.close());
  assert.equal(closed.scope, "owner");
  assert.equal(closed.tabClosed, true);
  assert.equal((await runAs("beta", () => browserProvider.snapshot())).title, "beta");
  const visible = await browserProvider.snapshot();
  assert.ok(["human", "spare"].includes(visible.title));
  console.log(JSON.stringify({ok: true, sessions: 2, screenshots: 2, noCrossTabMutation: true, noGlobalBrowserClose: true}));
} finally {
  await browserProvider.close().catch(() => undefined);
  await new Promise<void>(resolve => server.close(() => resolve()));
  await fs.rm(scratch, {recursive: true, force: true});
}
