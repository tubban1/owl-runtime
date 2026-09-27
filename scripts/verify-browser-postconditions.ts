import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratch = path.join(root, ".tmp-verify-browser-postconditions");
await fs.rm(scratch, { recursive: true, force: true });
await fs.mkdir(scratch, { recursive: true });

process.env.OWL_STATE_ROOT = path.join(scratch, "state");
process.env.BROWSER_PROFILE_DIR = path.join(scratch, "browser-profile");
process.env.ALLOW_BROWSER = "true";
process.env.ALLOWED_DIRECTORIES = root;
process.env.OWL_APPROVAL_MODE = "compat";

const { browserProvider } = await import("../src/providers/browserProvider.js");
const {
  createPersistentTask,
  getPersistentTaskStatus,
  runPersistentTask,
} = await import("../src/tasks/taskRuntime.js");

const browserStatus = await browserProvider.status();
if (!browserStatus.available) {
  console.log(JSON.stringify({
    ok: true,
    skipped: true,
    reason: "No supported Chromium browser executable is available.",
  }, null, 2));
  process.exit(0);
}

const html = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>OWL Worker Fixture</title></head>
<body>
  <h1 id="status">Orders ready</h1>
  <div id="order-count" data-count="127">127 orders</div>
  <input id="report-name" placeholder="Report name">
  <button id="generate" onclick="document.querySelector('#status').textContent='Report generated'; document.querySelector('#result').textContent='sales-report.csv';">Generate report</button>
  <div id="result"></div>
</body>
</html>`;

const server = http.createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(html);
});

await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => resolve());
});
const address = server.address();
if (!address || typeof address === "string") throw new Error("Fixture server has no TCP address.");
const url = `http://127.0.0.1:${address.port}/`;

try {
  const task = await createPersistentTask(
    "browser report with verified postconditions",
    [
      {
        id: "open",
        action: "browser.open",
        args: { url, wait_until: "domcontentloaded", headless: true },
      },
      {
        id: "name",
        action: "browser.type",
        args: {
          selector: "#report-name",
          text: "Daily Sales Report",
          submit: false,
        },
        dependsOn: ["open"],
      },
      {
        id: "generate",
        action: "browser.click",
        args: { selector: "#generate" },
        dependsOn: ["name"],
        verify: {
          id: "report-generated",
          description: "The report action must visibly finish and expose the generated filename.",
          expectations: [
            {
              path: "data.text",
              operator: "contains",
              expected: "Report generated",
            },
            {
              path: "data.text",
              operator: "contains",
              expected: "sales-report.csv",
            },
          ],
        },
      },
    ],
    { maxConcurrency: 1, failFast: true },
  );

  const createdGenerate = task.steps.find((step) => step.id === "generate");
  assert.equal(createdGenerate?.requiresVerification, true);
  assert.equal(createdGenerate?.verificationSpec?.id, "report-generated");

  const run = await runPersistentTask(task.id, {
    maxConcurrency: 1,
    maxWaves: 10,
    timeBudgetMs: 60_000,
  });
  assert.equal(run.status, "completed");

  const status = await getPersistentTaskStatus(task.id, true);
  const generated = status.steps.find((step) => step.id === "generate");
  assert.equal(generated?.state, "succeeded");
  assert.equal(generated?.observation?.channel, "web");
  assert.equal(generated?.observation?.provider, "browser");
  assert.equal(generated?.verification?.status, "verified");
  assert.equal(generated?.verification?.specId, "report-generated");
  assert.ok(
    status.events.some(
      (event: any) =>
        event.stepId === "generate" && event.type === "step_verified",
    ),
  );

  console.log(JSON.stringify({
    ok: true,
    browserObservation: true,
    explicitPostconditions: true,
    persistentTaskCompleted: true,
    verificationStatus: generated?.verification?.status,
    fixture: {
      orders: 127,
      expectedStatus: "Report generated",
      expectedArtifact: "sales-report.csv",
    },
  }, null, 2));
} finally {
  await browserProvider.close().catch(() => undefined);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await new Promise((resolve) => setTimeout(resolve, 300));
  await fs.rm(scratch, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
}
