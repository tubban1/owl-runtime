import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "owl-shell-env-"));
const zdot = path.join(root, "zdot");
await fs.mkdir(zdot, { recursive: true });
await fs.writeFile(
  path.join(zdot, ".zprofile"),
  'export OWL_LOGIN_PROFILE_LOADED="yes"\nexport PATH="/tmp/owl-login-profile-poison:$PATH"\n',
  "utf8",
);

process.env.OWL_RUNTIME_MODE = "test";
process.env.OWL_STATE_ROOT = path.join(root, "state");
process.env.ALLOWED_DIRECTORIES = root;
process.env.ALLOW_SHELL = "true";
process.env.SHELL = "/bin/zsh";
process.env.ZDOTDIR = zdot;
process.env.OWL_LOGIN_PROFILE_LOADED = "";
process.env.PATH = `/usr/bin:/bin:/usr/sbin:/sbin`;

const {
  executeCommand,
  startProcess,
  getProcessOutput,
} = await import("../src/tools/shellOps.js");

async function waitForExit(processId: string) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const output = await getProcessOutput(processId, 10_000);
    if (!output.running) return output;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Managed process ${processId} did not exit in time.`);
}

try {
  const inline = await executeCommand(
    'printf "%s|%s" "${OWL_LOGIN_PROFILE_LOADED:-clean}" "$PATH"',
    root,
    5_000,
  );
  assert.equal(inline.exitCode, 0);
  assert.match(inline.stdout, /^clean\|/);
  assert.doesNotMatch(inline.stdout, /owl-login-profile-poison/);

  const managed = await startProcess(
    'printf "%s|%s" "${OWL_LOGIN_PROFILE_LOADED:-clean}" "$PATH"',
    root,
    "read",
  );
  const managedOutput = await waitForExit(managed.processId);
  assert.equal(managedOutput.exitCode, 0);
  assert.match(managedOutput.stdout, /^clean\|/);
  assert.doesNotMatch(managedOutput.stdout, /owl-login-profile-poison/);

  console.log(
    JSON.stringify(
      {
        ok: true,
        loginProfileIgnored: true,
        inlineShellEnvironmentDeterministic: true,
        managedProcessEnvironmentDeterministic: true,
      },
      null,
      2,
    ),
  );
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
