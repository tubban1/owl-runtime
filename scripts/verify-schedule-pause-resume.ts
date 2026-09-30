import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { InProcessRuntimeClient } from "../src/public/runtimeClient.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "owl-schedule-resume-"));
process.env.AGENTOS_STATE_ROOT = root;
process.env.ALLOWED_DIRECTORIES = root;

const client = new InProcessRuntimeClient();
const output = path.join(root, "schedule.txt");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

try {
  const capabilities = await client.getCapabilities("schedule pause resume");
  assert.equal(capabilities.extensions.schedulePauseResume.version, 1);

  const interval = await client.createSchedule({
    label: "skip missed occurrence",
    trigger: {
      kind: "interval",
      everyMs: 1_000,
      startAt: new Date(Date.now() + 500).toISOString(),
    },
    steps: [
      {
        id: "append",
        primitive: "fs.write",
        op: "append",
        args: { path: output, content: "interval\n" },
      },
    ],
  });
  const intervalId = interval.id;
  const originalNext = interval.nextRunAt;
  const paused = await client.pauseSchedule(intervalId);
  assert.equal(paused.id, intervalId);
  assert.equal(paused.enabled, false);
  assert.equal(paused.nextRunAt, null);
  assert.equal(paused.pausedNextRunAt, originalNext);

  const pausedAgain = await client.pauseSchedule(intervalId);
  assert.equal(pausedAgain.id, intervalId);
  assert.equal(pausedAgain.pausedAt, paused.pausedAt);

  await sleep(700);
  const resumed = await client.resumeSchedule({
    scheduleId: intervalId,
  });
  assert.equal(resumed.id, intervalId);
  assert.equal(resumed.enabled, true);
  assert.equal(resumed.pausedAt, null);
  assert.equal(resumed.pausedNextRunAt, null);
  assert.ok(Date.parse(resumed.nextRunAt!) > Date.now());

  const oneShot = await client.createSchedule({
    label: "explicit catch up",
    trigger: {
      kind: "once",
      at: new Date(Date.now() + 500).toISOString(),
    },
    steps: [
      {
        id: "append",
        primitive: "fs.write",
        op: "append",
        args: { path: output, content: "once\n" },
      },
    ],
  });
  await client.pauseSchedule(oneShot.id);
  await sleep(700);

  await assert.rejects(
    () =>
      client.resumeSchedule({
        scheduleId: oneShot.id,
        missedRunPolicy: "skip",
      }),
    /SCHEDULE_RESUME_NO_FUTURE_OCCURRENCE/,
  );

  const catchUp = await client.resumeSchedule({
    scheduleId: oneShot.id,
    missedRunPolicy: "catch_up",
  });
  assert.equal(catchUp.enabled, true);
  assert.ok(Date.parse(catchUp.nextRunAt!) <= Date.now() + 100);

  const cancelled = await client.cancelSchedule(intervalId);
  assert.equal(cancelled.enabled, false);
  await assert.rejects(
    () => client.resumeSchedule({ scheduleId: intervalId }),
    /SCHEDULE_NOT_PAUSED/,
  );

  console.log(
    JSON.stringify(
      {
        ok: true,
        schedulePauseResumeVersion: 1,
        scheduleIdentityPreserved: true,
        pauseIdempotent: true,
        defaultMissedRunPolicySkip: true,
        explicitCatchUpRequired: true,
        cancelDistinctFromPause: true,
      },
      null,
      2,
    ),
  );
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
