import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratch = path.join(root, ".tmp-verify-public-runtime-client");
await fs.rm(scratch, { recursive: true, force: true });
await fs.mkdir(scratch, { recursive: true });

process.env.OWL_RUNTIME_MODE = "test";
process.env.OWL_STATE_ROOT = path.join(scratch, "state");
process.env.ALLOWED_DIRECTORIES = root;
process.env.ALLOW_WRITE = "true";
process.env.ALLOW_DELETE = "true";
process.env.ALLOW_SHELL = "true";
process.env.OWL_APPROVAL_MODE = "compat";

const {
  InProcessRuntimeClient,
  RUNTIME_PUBLIC_API_VERSION,
} = await import("../src/public/index.js");

const client = new InProcessRuntimeClient();

const info = await client.info();
assert.equal(info.apiVersion, RUNTIME_PUBLIC_API_VERSION);
assert.equal(info.transport, "in-process");

const capabilities = await client.getCapabilities("write and verify a file");
assert.ok(capabilities);

const catalog = (await client.getPrimitiveCatalog()) as any[];
assert.ok(catalog.some((entry) => entry.id === "fs.write"));

const target = path.join(scratch, "public-client.txt");
const write = (await client.callPrimitive({
  primitive: "fs.write",
  op: "write",
  args: {
    path: target,
    content: "public api",
    overwrite: true,
    create_parents: true,
  },
})) as any;
assert.equal(write.verification?.status, "verified");
assert.equal(write.observation?.channel, "file");

const task = (await client.createTask({
  label: "public api task",
  steps: [
    {
      id: "read",
      action: "fs.read",
      args: { path: target },
    },
  ],
})) as any;
assert.ok(task.id);

const run = (await client.runTask({
  taskId: task.id,
  maxWaves: 5,
  timeBudgetMs: 30_000,
})) as any;
assert.equal(run.status, "completed");

const fetched = (await client.getTask(task.id, true)) as any;
assert.equal(fetched.status, "completed");
assert.ok(fetched.verificationCounts);

const listed = (await client.listTasks()) as any[];
const listedTask = listed.find((entry) => entry.id === task.id);
assert.ok(listedTask);
assert.equal(listedTask.staging?.internalPathsExposed, false);
assert.equal("root" in (listedTask.staging ?? {}), false);
assert.equal("manifestPath" in (listedTask.staging ?? {}), false);
assert.equal(JSON.stringify(listedTask).includes("manifestPath"), false);
assert.ok(listedTask.verificationCounts);

const health = (await client.health({ op: "task", task_id: task.id })) as any;
assert.equal(health.result?.source, "task");

const processContract = (await client.process({ op: "list" })) as any;
assert.equal(processContract.skill, "runtime.process");

console.log(JSON.stringify({
  ok: true,
  publicApiVersion: info.apiVersion,
  runtimeVersion: info.runtimeVersion,
  primitiveCall: true,
  persistentTask: true,
  taskListStorageFirewall: true,
  verificationCounts: true,
  health: true,
  processControl: true,
}, null, 2));

await fs.rm(scratch, { recursive: true, force: true });
