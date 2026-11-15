import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type AgentOSRuntimeMode = "development" | "production" | "test";

export function runtimeMode(): AgentOSRuntimeMode {
  const raw = (process.env.OWL_RUNTIME_MODE ?? process.env.AGENTOS_RUNTIME_MODE)?.trim().toLowerCase();
  if (raw === "production" || raw === "test" || raw === "development") {
    return raw;
  }
  return "development";
}

export function runtimeCandidateMode(): boolean {
  const raw = (process.env.OWL_CANDIDATE_MODE ?? process.env.AGENTOS_CANDIDATE_MODE)?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

// Resolve symlinks in the existing parent as well as in the target. A test
// state root must never alias, contain, or sit within a live state root.
function canonicalStatePath(input: string): string {
  let existing = path.resolve(input);
  const missing: string[] = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    missing.unshift(path.basename(existing));
    existing = parent;
  }
  return path.resolve(fs.realpathSync(existing), ...missing);
}

function assertIsolatedTestRoot(input: string): void {
  // Windows filesystems normally compare paths case-insensitively. The guard
  // must treat C:\Users and c:\users as the same location.
  const normalized = (value: string) => {
    const canonical = canonicalStatePath(value);
    return process.platform === "win32" ? canonical.toLowerCase() : canonical;
  };
  const root = normalized(input);
  const liveRoots = [
    path.join(os.homedir(), ".owl-runtime-dev"),
    path.join(os.homedir(), ".owl-runtime"),
  ].map(normalized);
  for (const live of liveRoots) {
    const inside = (a: string, b: string) => a === b || a.startsWith(b + path.sep);
    if (inside(root, live) || inside(live, root)) {
      throw new Error("OWL_TEST_STATE_ROOT_NOT_ISOLATED");
    }
  }
}

export function runtimeStateRoot(): string {
  const configured = (process.env.OWL_STATE_ROOT ?? process.env.AGENTOS_STATE_ROOT)?.trim();
  const mode = runtimeMode();
  const result = configured || path.join(os.homedir(),
    mode === "development" ? ".owl-runtime-dev" :
    mode === "test" ? ".owl-runtime-test" : ".owl-runtime");
  if (mode === "test") assertIsolatedTestRoot(result);
  return result;
}

export function runtimeStatePath(...segments: string[]): string {
  return path.join(runtimeStateRoot(), ...segments);
}

export function runtimeCodeRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
}

export function isRuntimeSelfWorkspace(workspace: string): boolean {
  const left = path.resolve(workspace);
  const right = path.resolve(runtimeCodeRoot());
  return left === right;
}

export function runtimePathStatus() {
  return {
    mode: runtimeMode(),
    candidateMode: runtimeCandidateMode(),
    stateRoot: runtimeStateRoot(),
    codeRoot: runtimeCodeRoot(),
  };
}
