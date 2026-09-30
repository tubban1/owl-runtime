import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hostDir = path.join(root, "macos-runtime-host");
const [
  source,
  plist,
  baselineText,
  installer,
  installProduction,
  upgradeProduction,
] = await Promise.all([
  fs.readFile(path.join(hostDir, "OwlRuntimeHost.swift"), "utf8"),
  fs.readFile(path.join(hostDir, "Info.plist"), "utf8"),
  fs.readFile(path.join(hostDir, "production-baseline.json"), "utf8"),
  fs.readFile(path.join(root, "scripts", "install-macos-runtime-host.sh"), "utf8"),
  fs.readFile(path.join(root, "scripts", "install-production-runtime.sh"), "utf8"),
  fs.readFile(path.join(root, "scripts", "upgrade-production-runtime.sh"), "utf8"),
]);

const sha256 = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
const fingerprint = sha256(
  `${sha256(source)}\n${sha256(plist)}\n`,
);

const baseline = JSON.parse(baselineText) as {
  runtimeHostVersion: string;
  bundleId: string;
  sourceFingerprint: string;
  productionPolicy: string;
};

assert.equal(baseline.bundleId, "fan.fde.owl.runtime");
assert.equal(baseline.runtimeHostVersion, "1.0.0");
assert.equal(
  baseline.productionPolicy,
  "preserve-installed-runtime-host-through-owl-runtime-1.x",
);
assert.equal(fingerprint, baseline.sourceFingerprint);

assert.match(plist, /<string>fan\.fde\.owl\.runtime<\/string>/);
assert.match(plist, /<string>OwlRuntimeHost<\/string>/);
assert.match(
  installer,
  /INSTALL_APP="\$HOME\/Applications\/OWL Runtime\.app"/,
);
assert.match(installer, /SOURCE_FINGERPRINT=/);
assert.match(installer, /ALLOW_OWL_RUNTIME_HOST_UPDATE/);
assert.match(installer, /Full Disk Access/);
assert.match(
  installProduction,
  /OWL Runtime\.app\/Contents\/MacOS\/OwlRuntimeHost/,
);
assert.match(
  upgradeProduction,
  /OWL Runtime\.app\/Contents\/MacOS\/OwlRuntimeHost/,
);
assert.match(
  installProduction,
  /exec "\$RUNTIME_HOST_BIN" --env-file "\$ENV_FILE" "\$NODE_BIN"/,
);
assert.match(
  upgradeProduction,
  /exec "\$RUNTIME_HOST_BIN" --env-file "\$ENV_FILE" "\$NODE_BIN"/,
);
assert.match(
  installProduction,
  /<string>\$RUNTIME_HOST_BIN<\/string>/,
);
assert.match(
  installProduction,
  /<string>--env-file<\/string>/,
);

const scratch = await fs.mkdtemp(
  path.join(os.tmpdir(), "owl-runtime-host-verify-"),
);
try {
  const env = {
    ...process.env,
    HOME: scratch,
  };

  const firstInstall = spawnSync(
    "/bin/zsh",
    [path.join(root, "scripts", "install-macos-runtime-host.sh")],
    {
      cwd: root,
      env,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    },
  );
  assert.equal(
    firstInstall.status,
    0,
    firstInstall.stderr || firstInstall.stdout,
  );

  const app = path.join(scratch, "Applications", "OWL Runtime.app");
  const binary = path.join(app, "Contents", "MacOS", "OwlRuntimeHost");
  const fingerprintPath = path.join(
    app,
    "Contents",
    "Resources",
    "source.sha256",
  );
  const firstStat = await fs.stat(binary);
  assert.equal(
    (await fs.readFile(fingerprintPath, "utf8")).trim(),
    fingerprint,
  );

  const statusResult = spawnSync(binary, ["--status"], {
    env,
    encoding: "utf8",
  });
  assert.equal(statusResult.status, 0, statusResult.stderr);
  const status = JSON.parse(statusResult.stdout) as {
    ok: boolean;
    bundleIdentifier: string;
    version: string;
  };
  assert.equal(status.ok, true);
  assert.equal(status.bundleIdentifier, "fan.fde.owl.runtime");
  assert.equal(status.version, "1.0.0");

  const secondInstall = spawnSync(
    "/bin/zsh",
    [path.join(root, "scripts", "install-macos-runtime-host.sh")],
    {
      cwd: root,
      env,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    },
  );
  assert.equal(
    secondInstall.status,
    0,
    secondInstall.stderr || secondInstall.stdout,
  );
  assert.match(
    secondInstall.stdout,
    /preserving its stable macOS permission identity/,
  );
  const secondStat = await fs.stat(binary);
  assert.equal(secondStat.ino, firstStat.ino);

  const envFile = path.join(scratch, "runtime.env");
  const stateRoot = path.join(scratch, "state");
  await fs.writeFile(
    envFile,
    [
      `OWL_STATE_ROOT=${stateRoot}`,
      "HOST_VERIFY_VALUE=from-env-file",
      "",
    ].join("\n"),
    "utf8",
  );
  const childScript = path.join(scratch, "host-child.mjs");
  await fs.writeFile(
    childScript,
    [
      "console.log(JSON.stringify({",
      "  mode: process.env.OWL_RUNTIME_MODE,",
      "  stateRoot: process.env.OWL_STATE_ROOT,",
      "  value: process.env.HOST_VERIFY_VALUE",
      "}));",
      "",
    ].join("\n"),
    "utf8",
  );
  const childRun = spawnSync(
    binary,
    ["--env-file", envFile, process.execPath, childScript],
    {
      env,
      encoding: "utf8",
    },
  );
  assert.equal(childRun.status, 0, childRun.stderr);
  const childEnvironment = JSON.parse(childRun.stdout) as {
    mode: string;
    stateRoot: string;
    value: string;
  };
  assert.equal(childEnvironment.mode, "production");
  assert.equal(childEnvironment.stateRoot, stateRoot);
  assert.equal(childEnvironment.value, "from-env-file");

  console.log(
    JSON.stringify(
      {
        ok: true,
        stableRuntimeHostPath: "~/Applications/OWL Runtime.app",
        bundleId: baseline.bundleId,
        runtimeHostVersion: baseline.runtimeHostVersion,
        sourceFingerprint: fingerprint,
        isolatedInstall: true,
        repeatInstallPreservedBinaryInode: true,
        serverPromotionPreservesRuntimeHost: true,
        productionEnvironmentInjectedByHost: true,
        fullDiskAccessBoundToStableHost: true,
      },
      null,
      2,
    ),
  );
} finally {
  await fs.rm(scratch, { recursive: true, force: true });
}
