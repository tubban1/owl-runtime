import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  interactWithManagedProcess,
  observeProcess,
  startProcess,
  waitForProcessState,
} from "../src/tools/shellOps.js";
import {
  assessManagedProcessState,
  getProcessStateMachineManifest,
  looksLikeInputPrompt,
} from "../src/runtime/processState.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratch = path.join(root, ".tmp-verify-process-state-machine");
await fs.rm(scratch, { recursive: true, force: true });
await fs.mkdir(scratch, { recursive: true });

process.env.ALLOW_SHELL = "true";
process.env.ALLOWED_DIRECTORIES = root;
process.env.PROCESS_STATE_DIR = path.join(scratch, "processes");
process.env.PROCESS_STATE_KEY_PATH = path.join(scratch, "process.key");
process.env.PROCESS_LOG_DIR = path.join(scratch, "logs");

assert.equal(looksLikeInputPrompt("Python 3\n>>> "), true);
assert.equal(looksLikeInputPrompt("READY> "), true);
assert.equal(looksLikeInputPrompt("ordinary log line\n"), false);

const legacyExited = assessManagedProcessState({
  record: {
    version: 1, processId: "process_test", pid: 1, command: "x", cwd: root,
    workspace: root, workspaceMode: "read", ownerSessionId: "test",
    startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    status: "exited", exitCode: 0, runtimeInstanceId: "old",
    stdoutPath: "out", stderrPath: "err", inputAvailable: false,
  },
});
assert.equal(legacyExited.state, "finished");
assert.equal(legacyExited.terminal, true);

const childScript =
  "process.stdout.write('READY> ');" +
  "process.stdin.once('data', first => {" +
  " console.log('GOT1:' + first.toString().trim());" +
  " process.stdout.write('NEXT> ');" +
  " process.stdin.once('data', second => {" +
  "  console.log('GOT2:' + second.toString().trim());" +
  "  process.exit(0);" +
  " });" +
  "});";
const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(childScript)}`;
const processIds: string[] = [];

for (let round = 1; round <= 5; round += 1) {
  const started = await startProcess(command, root, "read");
  processIds.push(started.processId);

  const waiting = await waitForProcessState(started.processId, {
    states: ["waiting_input"],
    timeoutMs: 10_000,
    pollMs: 100,
  });
  assert.equal(waiting.matched, true);
  assert.equal(waiting.observation.state, "waiting_input");
  assert.equal((waiting.observation.data as any).terminal, false);

  const firstInteraction = await interactWithManagedProcess(
    started.processId,
    `hello-${round}\n`,
    {
      timeoutMs: 10_000,
      pollMs: 100,
    },
  );
  assert.equal(firstInteraction.matched, true);
  assert.equal(firstInteraction.observation.state, "waiting_input");
  assert.match(
    (firstInteraction.observation.data as any).stdout,
    new RegExp(`GOT1:hello-${round}`),
  );
  assert.match(
    (firstInteraction.observation.data as any).stdout,
    /NEXT> /,
  );

  const secondInteraction = await interactWithManagedProcess(
    started.processId,
    `bye-${round}\n`,
    {
      timeoutMs: 10_000,
      pollMs: 100,
    },
  );
  assert.equal(secondInteraction.matched, true);
  assert.equal(secondInteraction.observation.state, "finished");
  assert.match(
    (secondInteraction.observation.data as any).stdout,
    new RegExp(`GOT2:bye-${round}`),
  );

  const finalObservation = await observeProcess(started.processId);
  assert.equal(finalObservation.state, "finished");
  assert.equal((finalObservation.data as any).exitCode, 0);
}

const manifest = getProcessStateMachineManifest();
assert.ok(manifest.states.includes("waiting_input"));
assert.ok(manifest.durableRecordCompatibility.includes("exited"));

console.log(JSON.stringify({
  ok: true,
  waitingInputDetection: true,
  interactiveRoundTrip: true,
  terminalExitDetection: true,
  legacyRecordCompatibility: true,
  observationAbiIntegration: true,
  stalePromptRaceCovered: true,
  exitReconciliationRaceCovered: true,
  rounds: processIds.length,
  processIds,
}, null, 2));

await fs.rm(scratch, { recursive: true, force: true });
