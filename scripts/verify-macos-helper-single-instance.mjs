import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { setTimeout as sleep } from "node:timers/promises";

if (process.platform !== "darwin") {
  console.log("SKIP helper single-instance smoke: macOS required");
  process.exit(0);
}
const root = mkdtempSync(path.join(os.tmpdir(), "owl-helper-lock-"));
const program = path.join(root, "Helper");
const socket = path.join(root, "helper.sock");
const build = spawnSync("xcrun", [
  "swiftc", "-O", "macos-helper/ComputerMCPHelper.swift", "-o", program,
], { encoding: "utf8", timeout: 120_000 });
assert.equal(build.status, 0, build.stderr?.slice(-1500));
const first = spawn(program, ["--serve", "--socket", socket], { stdio: "ignore" });
try {
  for (let i = 0; i < 100 && !existsSync(socket); i++) {
    assert.equal(first.exitCode, null, "first Helper exited before creating socket");
    await sleep(50);
  }
  assert.ok(existsSync(socket), "first Helper never created socket");
  const second = spawnSync(program, ["--serve", "--socket", socket], {
    encoding: "utf8", timeout: 5_000,
  });
  assert.notEqual(second.status, 0, "second Helper unexpectedly acquired same socket");
  assert.equal(first.exitCode, null, "second Helper stopped the first listener");
  const response = await new Promise((resolve, reject) => {
    const c = net.connect({ path: socket });
    const timeout = setTimeout(() => { c.destroy(); reject(new Error("status request timed out")); }, 3_000);
    let buffer = "";
    c.setEncoding("utf8");
    c.on("connect", () => c.write('{"action":"status","args":{}}\n'));
    c.on("data", (chunk) => {
      buffer += chunk;
      if (!buffer.includes("\n")) return;
      clearTimeout(timeout);
      c.destroy();
      try { resolve(JSON.parse(buffer.slice(0, buffer.indexOf("\n")))); }
      catch (error) { reject(error); }
    });
    c.on("error", (error) => { clearTimeout(timeout); reject(error); });
  });
  assert.equal(response.ok, true);
  console.log("PASS: only one Helper owns a socket and first remains usable");
} finally {
  first.kill("SIGTERM");
  for (let i = 0; i < 50 && first.exitCode === null; i++) await sleep(50);
  if (first.exitCode === null) first.kill("SIGKILL");
  rmSync(root, { recursive: true, force: true });
}
