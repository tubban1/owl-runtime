import type { Observation } from "../observation/observationAbi.js";
import type { PersistentTaskStatus } from "../tasks/taskStore.js";
import type { ApprovalRecord } from "../policy/approvalPolicy.js";
import type { ProviderStatus } from "../providers/types.js";

export const HEALTH_MODEL_VERSION = 1 as const;
export const HEALTH_STATES = [
  "healthy",
  "degraded",
  "needs_attention",
  "paused",
  "broken",
] as const;

export type HealthState = (typeof HEALTH_STATES)[number];
export type HealthSource = "task" | "process" | "approval" | "runtime" | "provider";

export type HealthSignal = {
  version: typeof HEALTH_MODEL_VERSION;
  state: HealthState;
  code: string;
  summary: string;
  source: HealthSource;
  sourceId?: string;
  observedAt: string;
  actionable: boolean;
  details?: Record<string, unknown>;
};

function signal(input: Omit<HealthSignal, "version" | "observedAt">): HealthSignal {
  return {
    version: HEALTH_MODEL_VERSION,
    observedAt: new Date().toISOString(),
    ...input,
  };
}

export function taskHealth(
  task: { id: string; status: PersistentTaskStatus; label?: string; steps?: unknown },
): HealthSignal {
  const common = { source: "task" as const, sourceId: task.id };
  switch (task.status) {
    case "failed":
      return signal({ ...common, state: "broken", code: "task_failed", summary: "Task execution failed.", actionable: true, details: { label: task.label ?? null } });
    case "blocked":
      return signal({ ...common, state: "needs_attention", code: "task_blocked", summary: "Task is blocked and needs review or an external condition to be resolved.", actionable: true, details: { label: task.label ?? null } });
    case "waiting_approval":
      return signal({ ...common, state: "needs_attention", code: "task_waiting_approval", summary: "Task is paused at an exact approval boundary.", actionable: true, details: { label: task.label ?? null } });
    case "paused":
      return signal({ ...common, state: "paused", code: "task_paused", summary: "Task is paused.", actionable: true, details: { label: task.label ?? null } });
    case "cancelled":
      return signal({ ...common, state: "paused", code: "task_cancelled", summary: "Task was cancelled.", actionable: false, details: { label: task.label ?? null } });
    case "pending":
      return signal({ ...common, state: "healthy", code: "task_pending", summary: "Task is ready to run.", actionable: false, details: { label: task.label ?? null } });
    case "running":
      return signal({ ...common, state: "healthy", code: "task_running", summary: "Task is running.", actionable: false, details: { label: task.label ?? null } });
    case "completed":
      return signal({ ...common, state: "healthy", code: "task_completed", summary: "Task completed successfully.", actionable: false, details: { label: task.label ?? null } });
  }
}

export function processHealth(observation: Observation): HealthSignal {
  const sourceId = observation.subject;
  const common = { source: "process" as const, ...(sourceId ? { sourceId } : {}) };
  switch (observation.state) {
    case "waiting_input":
      return signal({ ...common, state: "needs_attention", code: "process_waiting_input", summary: "Process is waiting for input.", actionable: true });
    case "failed":
      return signal({ ...common, state: "broken", code: "process_failed", summary: "Process exited unsuccessfully.", actionable: true });
    case "lost":
      return signal({ ...common, state: "broken", code: "process_lost", summary: "Runtime lost the managed process.", actionable: true });
    case "timed_out":
      return signal({ ...common, state: "broken", code: "process_timed_out", summary: "Process timed out.", actionable: true });
    case "terminating":
      return signal({ ...common, state: "degraded", code: "process_terminating", summary: "Process termination is still in progress.", actionable: false });
    case "waiting_network":
      return signal({ ...common, state: "degraded", code: "process_waiting_network", summary: "Process is waiting on network activity.", actionable: false });
    case "finished":
      return signal({ ...common, state: "healthy", code: "process_finished", summary: "Process finished successfully.", actionable: false });
    case "running":
    case "ready":
      return signal({ ...common, state: "healthy", code: "process_running", summary: "Process is healthy and running.", actionable: false });
    case "unknown":
      return signal({ ...common, state: "degraded", code: "process_unknown", summary: "Process state is uncertain.", actionable: true });
  }
}

export function approvalHealth(record: ApprovalRecord): HealthSignal {
  const common = { source: "approval" as const, sourceId: record.id };
  switch (record.state) {
    case "pending":
      return signal({ ...common, state: "needs_attention", code: "approval_pending", summary: `${record.subject} is waiting for approval.`, actionable: true });
    case "approved":
      return signal({ ...common, state: "degraded", code: "approval_ready", summary: `${record.subject} is approved but has not executed yet.`, actionable: false });
    case "consumed":
      return signal({ ...common, state: "healthy", code: "approval_consumed", summary: `${record.subject} approval was consumed by one execution.`, actionable: false });
    case "denied":
      return signal({ ...common, state: "paused", code: "approval_denied", summary: `${record.subject} approval was denied.`, actionable: false });
    case "expired":
      return signal({ ...common, state: "needs_attention", code: "approval_expired", summary: `${record.subject} approval expired before execution.`, actionable: true });
  }
}

export function providerHealth(status: ProviderStatus): HealthSignal {
  const common = { source: "provider" as const, sourceId: status.id };

  if (!status.enabled) {
    return signal({
      ...common,
      state: "paused",
      code: "provider_disabled",
      summary: `${status.label} provider is disabled by policy/configuration.`,
      actionable: true,
      details: { capabilities: status.capabilities, status },
    });
  }

  if (!status.available) {
    return signal({
      ...common,
      state: "broken",
      code: "provider_unavailable",
      summary: `${status.label} provider is not available on this machine.`,
      actionable: true,
      details: { capabilities: status.capabilities, status },
    });
  }

  if (status.id === "desktop") {
    const helper =
      status.details?.helper &&
      typeof status.details.helper === "object"
        ? (status.details.helper as Record<string, unknown>)
        : null;

    if (helper) {
      const missingPermissions: string[] = [];
      if (helper.accessibilityTrusted === false) {
        missingPermissions.push("accessibility");
      }
      if (helper.screenCaptureAllowed === false) {
        missingPermissions.push("screen_recording");
      }
      if (missingPermissions.length > 0) {
        return signal({
          ...common,
          state: "needs_attention",
          code: "provider_permissions_missing",
          summary: `Desktop provider needs macOS permission: ${missingPermissions.join(", ")}.`,
          actionable: true,
          details: {
            missingPermissions,
            helperInstalled: status.details?.helperInstalled ?? null,
            helperMode: status.details?.helperMode ?? null,
          },
        });
      }

      if (typeof helper.error === "string" && helper.error) {
        return signal({
          ...common,
          state: "degraded",
          code: "provider_helper_error",
          summary: "Desktop helper is installed but its runtime status could not be read cleanly.",
          actionable: true,
          details: { helperError: helper.error },
        });
      }
    }

    if (status.details?.helperInstalled === false) {
      return signal({
        ...common,
        state: "needs_attention",
        code: "provider_helper_missing",
        summary: "Desktop provider needs the OWL/Computer MCP native helper.",
        actionable: true,
        details: { helperMode: status.details?.helperMode ?? null },
      });
    }
  }

  return signal({
    ...common,
    state: "healthy",
    code: "provider_ready",
    summary: `${status.label} provider is available.`,
    actionable: false,
    details: { capabilities: status.capabilities },
  });
}

const severity: Record<HealthState, number> = {
  healthy: 0,
  paused: 1,
  degraded: 2,
  needs_attention: 3,
  broken: 4,
};

export function aggregateHealth(signals: HealthSignal[]): HealthSignal {
  if (signals.length === 0) {
    return signal({ source: "runtime", state: "healthy", code: "no_health_issues", summary: "No unhealthy execution signals are present.", actionable: false });
  }
  if (signals.every((item) => item.state === "paused")) {
    return signal({ source: "runtime", state: "paused", code: "all_paused", summary: "All observed execution components are paused.", actionable: signals.some((item) => item.actionable), details: { signals } });
  }
  const worst = [...signals].sort((a, b) => severity[b.state] - severity[a.state])[0]!;
  const state = worst.state === "paused" && signals.some((item) => item.state === "healthy")
    ? "degraded"
    : worst.state;
  return signal({
    source: "runtime",
    state,
    code: `aggregate_${state}`,
    summary: state === "healthy" ? "Observed execution components are healthy." : `Execution health is ${state}.`,
    actionable: signals.some((item) => item.actionable),
    details: { signals },
  });
}

export function getHealthModelManifest() {
  return {
    version: HEALTH_MODEL_VERSION,
    stability: "candidate" as const,
    states: [...HEALTH_STATES],
    sources: ["task", "process", "approval", "runtime", "provider"] as HealthSource[],
    invariant: "Health reports execution facts and attention needs; OWL Worker owns notification UX and business-level Worker status.",
  };
}
