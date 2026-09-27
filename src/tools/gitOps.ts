import { spawn } from "node:child_process";
import { assertAllowedExistingPath } from "../security/pathGuard.js";
import { requireCapability } from "../security/capabilities.js";

async function runGit(args: string[], cwd: string, stdin?: string) {
  const safeCwd = await assertAllowedExistingPath(cwd);

  return await new Promise<{ cwd: string; exitCode: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      const child = spawn("git", ["-C", safeCwd, "-c", "core.hooksPath=/dev/null", ...args], {
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
      child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
      child.on("error", reject);
      child.on("close", (exitCode) => resolve({ cwd: safeCwd, exitCode, stdout, stderr }));
      if (stdin != null) child.stdin.end(stdin);
      else child.stdin.end();
    },
  );
}

export async function gitStatus(cwd: string) {
  return runGit(["status", "--short", "--branch"], cwd);
}

export async function gitDiff(cwd: string, staged = false) {
  return runGit(staged ? ["diff", "--cached"] : ["diff"], cwd);
}

export async function gitLog(cwd: string, maxCount = 20) {
  return runGit(
    ["log", `--max-count=${Math.min(Math.max(maxCount, 1), 100)}`, "--oneline", "--decorate"],
    cwd,
  );
}

export async function gitAdd(cwd: string, paths: string[]) {
  requireCapability("ALLOW_WRITE", true);
  if (paths.length === 0) throw new Error("At least one path is required.");
  return runGit(["add", "--", ...paths], cwd);
}

export async function gitCommit(cwd: string, message: string) {
  requireCapability("ALLOW_WRITE", true);
  return runGit(["commit", "-m", message], cwd);
}

export async function gitPull(cwd: string, remote?: string, branch?: string) {
  requireCapability("ALLOW_WRITE", true);
  const args = ["pull"];
  if (remote) args.push(remote);
  if (branch) args.push(branch);
  return runGit(args, cwd);
}

export async function gitPush(cwd: string, remote?: string, branch?: string) {
  requireCapability("ALLOW_GIT_PUSH", false);
  const args = ["push"];
  if (remote) args.push(remote);
  if (branch) args.push(branch);
  return runGit(args, cwd);
}

export async function applyPatch(cwd: string, patch: string) {
  requireCapability("ALLOW_WRITE", true);
  const check = await runGit(["apply", "--check", "-"], cwd, patch);
  if (check.exitCode !== 0) {
    throw new Error(`Patch validation failed: ${check.stderr || check.stdout}`);
  }
  return runGit(["apply", "-"], cwd, patch);
}
