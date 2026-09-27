import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type AgentOSRuntimeMode = "development" | "production" | "test";

export function runtimeMode(): AgentOSRuntimeMode {
  const raw = process.env.AGENTOS_RUNTIME_MODE?.trim().toLowerCase();
  if (raw === "production" || raw === "test" || raw === "development") {
    return raw;
  }
  return "development";
}

export function runtimeCandidateMode(): boolean {
  const raw = process.env.AGENTOS_CANDIDATE_MODE?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

export function runtimeStateRoot(): string {
  const configured = process.env.AGENTOS_STATE_ROOT?.trim();
  if (configured) return configured;

  const mode = runtimeMode();
  if (mode === "development") {
    return path.join(os.homedir(), ".computer-mcp-dev");
  }
  if (mode === "test") {
    return path.join(os.homedir(), ".computer-mcp-test");
  }
  return path.join(os.homedir(), ".computer-mcp");
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
