import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const evidenceDir = path.join(root, ".release-evidence");
const latestPath = path.join(evidenceDir, "rc-fast-latest.json");
fs.mkdirSync(evidenceDir, { recursive: true });

function isolatedVerifierEnv() {
  const env = {
    ...process.env,
    OWL_RUNTIME_MODE: "test",
    OWL_RUNTIME_ACCESS_MODE: "compat",
    OWL_RUNTIME_REQUIRE_SIGNED_LEASE: "false",
  };
  // Release verification must never inherit the running Desktop/Cloud lease
  // configuration from the developer shell. Verifiers that exercise signed
  // leases set their own isolated key material explicitly.
  delete env.OWL_RUNTIME_LEASE_PUBLIC_KEY_PEM;
  delete env.OWL_RUNTIME_LEASE_PUBLIC_KEY_B64;
  delete env.OWL_RUNTIME_LEASE_PUBLIC_KEY_FILE;
  return env;
}

function run(command, args, options = {}) {
  const startedAt = Date.now();
  const result = spawnSync(command, args, {
    cwd: root,
    env: isolatedVerifierEnv(),
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    ...options,
  });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  return {
    command: [command, ...args].join(" "),
    exitCode: result.status,
    signal: result.signal,
    durationMs: Date.now() - startedAt,
    ok: result.status === 0,
    tail: (stdout + stderr).slice(-8000),
  };
}

function gitText(...args) {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  }
  return (result.stdout || "").trim();
}

const checks = [
  ["typecheck", "npm", ["run", "typecheck"]],
  ["build", "npm", ["run", "build"]],
  ["git-diff-check", "git", ["diff", "--check"]],
  ["shell-syntax", "/bin/zsh", ["-n",
    "scripts/install-production-runtime.sh",
    "scripts/install-macos-runtime-host.sh",
    "scripts/upgrade-production-runtime.sh",
    "scripts/status-production-runtime.sh",
    "scripts/uninstall-production-runtime.sh",
  ]],
  ["primitive-isa", "npm", ["run", "verify:isa"]],
  ["skill-abi", "npm", ["run", "verify:skill-abi"]],
  ["user-skills", "npm", ["run", "verify:user-skills"]],
  ["workflow-discovery", "npm", ["run", "verify:workflow-discovery"]],
  ["observation-abi", "npm", ["run", "verify:observation-abi"]],
  ["verifier-abi", "npm", ["run", "verify:verifier-abi"]],
  ["action-observation", "npm", ["run", "verify:action-observation"]],
  ["verification-coverage", "npm", ["run", "verify:verification-coverage"]],
  ["task-orchestration", "npm", ["run", "verify:task-orchestration"]],
  ["browser-postconditions", "npm", ["run", "verify:browser-postconditions"]],
  ["browser-cancellation", "npm", ["run", "verify:browser-cancellation"]],
  ["browser-idle-freeze", "npm", ["run", "verify:browser-idle-freeze"]],
  ["browser-survivor-reaper", "npm", ["run", "verify:browser-survivor-reaper"]],
  ["desktop-postconditions", "npm", ["run", "verify:desktop-postconditions"]],
  ["process-state", "npm", ["run", "verify:process-state"]],
  ["process-control", "npm", ["run", "verify:process-control"]],
  ["shell-environment", "npm", ["run", "verify:shell-environment"]],
  ["request-cancellation", "npm", ["run", "verify:request-cancellation"]],
  ["approval-policy", "npm", ["run", "verify:approval-policy"]],
  ["health-model", "npm", ["run", "verify:health-model"]],
  ["execution-target", "npm", ["run", "verify:execution-target"]],
  ["support-package", "npm", ["run", "verify:support-package"]],
  ["public-runtime-client", "npm", ["run", "verify:public-runtime-client"]],
  ["http-runtime-client", "npm", ["run", "verify:http-runtime-client"]],
  ["task-memory", "npm", ["run", "verify:task-memory"]],
  ["scheduler", "npm", ["run", "verify:scheduler"]],
  ["loop", "npm", ["run", "verify:loop"]],
  ["semantic-memory", "npm", ["run", "verify:semantic-memory"]],
  ["recall", "npm", ["run", "verify:recall"]],
  ["embedding-provider", "npm", ["run", "verify:embedding-provider"]],
  ["identity", "npm", ["run", "verify:identity"]],
  ["drain-handoff", "npm", ["run", "verify:drain-handoff"]],
  ["recovery-matrix", "npm", ["run", "verify:recovery-matrix"]],
  ["production-runtime", "npm", ["run", "verify:production-runtime"]],
  ["upgrade-runtime", "npm", ["run", "verify:upgrade-runtime"]],
  ["macos-helper", "npm", ["run", "verify:macos-helper"]],
  ["runtime-host", "npm", ["run", "verify:runtime-host"]],
];

const branch = gitText("branch", "--show-current");
const commit = gitText("rev-parse", "HEAD");
const dirtyBefore = gitText("status", "--porcelain");

const report = {
  version: 1,
  gate: "owl-runtime-1.0-rc-fast",
  startedAt: new Date().toISOString(),
  branch,
  commit,
  platform: process.platform,
  arch: process.arch,
  osRelease: os.release(),
  nodeVersion: process.version,
  cleanTrackedWorktreeAtStart: dirtyBefore.length === 0,
  checks: [],
  passed: false,
};

if (dirtyBefore.length !== 0) {
  report.checks.push({
    name: "clean-tracked-worktree",
    ok: false,
    exitCode: 1,
    durationMs: 0,
    command: "git status --porcelain",
    tail: dirtyBefore,
  });
} else {
  report.checks.push({
    name: "clean-tracked-worktree",
    ok: true,
    exitCode: 0,
    durationMs: 0,
    command: "git status --porcelain",
    tail: "",
  });
}

for (const [name, command, args] of checks) {
  process.stdout.write(`[rc-fast] ${name} ... `);
  const result = run(command, args);
  report.checks.push({ name, ...result });
  console.log(result.ok ? `PASS (${result.durationMs}ms)` : "FAIL");
  if (!result.ok) {
    console.error(result.tail);
    break;
  }
}

const dirtyAfter = gitText("status", "--porcelain");
report.cleanTrackedWorktreeAtEnd = dirtyAfter.length === 0;
if (dirtyAfter.length !== 0) {
  report.checks.push({
    name: "clean-tracked-worktree-after",
    ok: false,
    exitCode: 1,
    durationMs: 0,
    command: "git status --porcelain",
    tail: dirtyAfter,
  });
}

report.finishedAt = new Date().toISOString();
report.durationMs =
  Date.parse(report.finishedAt) - Date.parse(report.startedAt);
report.passed =
  report.cleanTrackedWorktreeAtStart &&
  report.cleanTrackedWorktreeAtEnd &&
  report.checks.every((check) => check.ok);

fs.writeFileSync(latestPath, JSON.stringify(report, null, 2) + "\n", "utf8");
console.log(JSON.stringify({
  gate: report.gate,
  commit: report.commit,
  checks: report.checks.length,
  durationMs: report.durationMs,
  passed: report.passed,
  evidence: latestPath,
}, null, 2));

if (!report.passed) process.exitCode = 1;
