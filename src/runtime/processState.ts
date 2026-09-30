import type { ManagedProcessRecord } from "./processStore.js";
import type { ObservationState } from "../observation/observationAbi.js";

export type ProcessRuntimeState =
  | "running"
  | "waiting_input"
  | "finished"
  | "failed"
  | "terminating"
  | "lost";

export type ProcessStateAssessment = {
  state: ProcessRuntimeState;
  observationState: ObservationState;
  terminal: boolean;
  confidence: "deterministic" | "heuristic";
  reason: string;
};

const PROMPT_PATTERNS = [
  /(?:^|\n)>>> ?$/,
  /(?:^|\n)\.\.\. ?$/,
  /(?:^|\n)[^\n]{0,120}[#$>] ?$/,
  /(?:password|passphrase|token|otp|code): ?$/i,
  /(?:\[Y\/n\]|\[y\/N\]|\(y\/n\)|\(yes\/no\)) ?$/i,
  /(?:continue|press enter|hit enter).*:? ?$/i,
];

export function looksLikeInputPrompt(output: string): boolean {
  const tail = output.replace(/\r/g, "").slice(-4000).trimEnd();
  if (!tail) return false;
  return PROMPT_PATTERNS.some((pattern) => pattern.test(tail));
}

export function assessManagedProcessState(input: {
  record: ManagedProcessRecord;
  stdout?: string;
  stderr?: string;
  stdinAttached?: boolean;
}): ProcessStateAssessment {
  const { record } = input;

  if (record.status === "lost") {
    return {
      state: "lost",
      observationState: "lost",
      terminal: true,
      confidence: "deterministic",
      reason: "The durable process record exists but its PID is no longer alive.",
    };
  }

  if (record.status === "terminating") {
    return {
      state: "terminating",
      observationState: "terminating",
      terminal: false,
      confidence: "deterministic",
      reason: "A termination signal has been sent and process exit is pending.",
    };
  }

  if (record.status === "exited") {
    const successful = record.exitCode === 0;
    return {
      state: successful ? "finished" : "failed",
      observationState: successful ? "finished" : "failed",
      terminal: true,
      confidence: "deterministic",
      reason: successful
        ? "The managed process exited with code 0."
        : `The managed process exited with code ${record.exitCode ?? "unknown"}${record.signal ? ` (${record.signal})` : ""}.`,
    };
  }

  const output = `${input.stdout ?? ""}\n${input.stderr ?? ""}`;
  if ((input.stdinAttached ?? record.inputAvailable) && looksLikeInputPrompt(output)) {
    return {
      state: "waiting_input",
      observationState: "waiting_input",
      terminal: false,
      confidence: "heuristic",
      reason: "The process is alive, stdin is attached, and recent output looks like an interactive prompt.",
    };
  }

  return {
    state: "running",
    observationState: "running",
    terminal: false,
    confidence: "deterministic",
    reason: record.recoveredAfterRestart
      ? "The process is alive after Runtime recovery; stdin may no longer be attached."
      : "The managed process is alive.",
  };
}

export function getProcessStateMachineManifest() {
  return {
    version: 1,
    stability: "candidate" as const,
    states: [
      "running",
      "waiting_input",
      "finished",
      "failed",
      "terminating",
      "lost",
    ] as ProcessRuntimeState[],
    durableRecordCompatibility: ["running", "exited", "lost", "terminating"],
    waitingNetworkReserved: true,
    invariant:
      "Realtime process state is derived from durable process facts plus current Runtime attachment/output; old encrypted process records require no migration.",
  };
}
