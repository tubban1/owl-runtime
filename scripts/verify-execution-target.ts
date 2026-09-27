import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratch = path.join(root, ".tmp-verify-execution-target");
await fs.rm(scratch, { recursive: true, force: true });
await fs.mkdir(scratch, { recursive: true });

process.env.OWL_RUNTIME_MODE = "test";
process.env.OWL_STATE_ROOT = path.join(scratch, "state");
process.env.ALLOWED_DIRECTORIES = root;
process.env.ALLOW_WRITE = "true";
process.env.ALLOW_DELETE = "true";
process.env.ALLOW_SHELL = "true";
process.env.OWL_APPROVAL_MODE = "compat";

const { InProcessRuntimeClient } = await import("../src/public/index.js");

const client = new InProcessRuntimeClient();

async function absent(filePath: string) {
  try {
    await fs.access(filePath);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

try {
  const manifest = (await client.getExecutionTargets()) as any;
  assert.equal(manifest.version, 1);
  assert.equal(manifest.defaultTarget, "host");
  assert.equal(manifest.silentFallback, false);
  assert.equal(
    manifest.targets.find((item: any) => item.kind === "host")?.available,
    true,
  );
  assert.equal(
    manifest.targets.find((item: any) => item.kind === "sandbox")?.available,
    false,
  );
  assert.equal(
    manifest.targets.find((item: any) => item.kind === "remote")?.available,
    false,
  );

  const hostPath = path.join(scratch, "host.txt");
  const hostWrite = (await client.callPrimitive({
    primitive: "fs.write",
    op: "write",
    args: {
      path: hostPath,
      content: "host execution",
      overwrite: true,
      create_parents: true,
    },
    executionTarget: { kind: "host" },
  })) as any;
  assert.equal(hostWrite.executionTarget?.kind, "host");
  assert.equal(hostWrite.verification?.status, "verified");

  const sandboxPath = path.join(scratch, "sandbox.txt");
  await assert.rejects(
    () =>
      client.callPrimitive({
        primitive: "fs.write",
        op: "write",
        args: {
          path: sandboxPath,
          content: "must not execute",
          overwrite: true,
          create_parents: true,
        },
        executionTarget: { kind: "sandbox" },
      }),
    /EXECUTION_TARGET_UNAVAILABLE/,
  );
  assert.equal(await absent(sandboxPath), true);

  const remotePath = path.join(scratch, "remote.txt");
  await assert.rejects(
    () =>
      client.callPrimitive({
        primitive: "fs.write",
        op: "write",
        args: {
          path: remotePath,
          content: "must not execute",
          overwrite: true,
          create_parents: true,
        },
        executionTarget: { kind: "remote", targetId: "remote-test" },
      }),
    /EXECUTION_TARGET_UNAVAILABLE/,
  );
  assert.equal(await absent(remotePath), true);

  const affinityPath = path.join(scratch, "affinity.txt");
  await assert.rejects(
    () =>
      client.callPrimitive({
        primitive: "fs.write",
        op: "write",
        args: {
          path: affinityPath,
          content: "must not execute",
          overwrite: true,
          create_parents: true,
        },
        executionTarget: {
          kind: "host",
          providerAffinity: ["browser"],
        },
      }),
    /PROVIDER_AFFINITY_MISMATCH/,
  );
  assert.equal(await absent(affinityPath), true);

  await assert.rejects(
    () =>
      client.callPrimitive({
        primitive: "fs.read",
        op: "one",
        args: { path: hostPath },
        executionTarget: {
          kind: "host",
          allowFallback: true,
        } as any,
      }),
    /EXECUTION_TARGET_FALLBACK_FORBIDDEN/,
  );

  const taskPath = path.join(scratch, "task.txt");
  const task = (await client.createTask({
    label: "host target task",
    executionTarget: { kind: "host", providerAffinity: ["filesystem"] },
    steps: [
      {
        id: "write",
        action: "fs.write",
        args: {
          path: taskPath,
          content: "durable host target",
          overwrite: true,
          create_parents: true,
        },
      },
    ],
  })) as any;
  assert.equal(task.executionTarget?.kind, "host");
  assert.deepEqual(task.executionTarget?.providerAffinity, ["filesystem"]);

  const taskRun = (await client.runTask({
    taskId: task.id,
    maxWaves: 5,
    timeBudgetMs: 30_000,
  })) as any;
  assert.equal(taskRun.status, "completed");

  const taskStatus = (await client.getTask(task.id, true)) as any;
  assert.equal(taskStatus.executionTarget?.kind, "host");
  assert.deepEqual(taskStatus.executionTarget?.providerAffinity, ["filesystem"]);

  const schedule = (await client.createSchedule({
    label: "host target schedule",
    executionTarget: { kind: "host", providerAffinity: ["filesystem"] },
    trigger: { kind: "interval", everyMs: 60_000 },
    steps: [
      {
        id: "read",
        primitive: "fs.read",
        op: "one",
        args: { path: hostPath },
      },
    ],
    maxRuns: 1,
  })) as any;
  assert.equal(schedule.taskTemplate?.executionTarget?.kind, "host");
  assert.deepEqual(
    schedule.taskTemplate?.executionTarget?.providerAffinity,
    ["filesystem"],
  );
  await client.cancelSchedule(schedule.id);
  await client.deleteSchedule(schedule.id);

  console.log(
    JSON.stringify(
      {
        ok: true,
        hostExecution: true,
        sandboxFailsClosed: true,
        remoteFailsClosed: true,
        providerAffinityFailsClosed: true,
        silentFallbackForbidden: true,
        taskTargetDurable: true,
        scheduleTargetDurable: true,
      },
      null,
      2,
    ),
  );
} finally {
  await fs.rm(scratch, { recursive: true, force: true });
}
