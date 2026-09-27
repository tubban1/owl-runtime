import { randomUUID } from "node:crypto";
import {
  currentExecutionContext,
  executionOwnerKey,
  type ExecutionContext,
} from "./executionContext.js";

export type RuntimeLifecycleState = "running" | "draining";

export type RuntimeMutationRecord = {
  id: string;
  label: string;
  ownerKey: string;
  sessionId: string;
  taskId?: string;
  startedAt: string;
};

export class RuntimeDrainingError extends Error {
  readonly code = "RUNTIME_DRAINING";

  constructor(message = "RUNTIME_DRAINING: AgentOS Runtime is draining and is not accepting new side-effecting work.") {
    super(message);
    this.name = "RuntimeDrainingError";
  }
}

class RuntimeLifecycleManager {
  private state: RuntimeLifecycleState = "running";
  private stateChangedAt = new Date().toISOString();
  private drainReason: string | undefined;
  private drainRequestedBy: string | undefined;
  private readonly activeMutations = new Map<string, RuntimeMutationRecord>();

  beginMutation(
    label: string,
    options?: {
      context?: ExecutionContext;
      allowDuringDrain?: boolean;
    },
  ): RuntimeMutationRecord {
    if (this.state === "draining" && options?.allowDuringDrain !== true) {
      throw new RuntimeDrainingError();
    }

    const context = options?.context ?? currentExecutionContext();
    const record: RuntimeMutationRecord = {
      id: `mutation_${Date.now().toString(36)}_${randomUUID()
        .replaceAll("-", "")
        .slice(0, 10)}`,
      label,
      ownerKey: executionOwnerKey(context),
      sessionId: context.sessionId,
      ...(context.taskId ? { taskId: context.taskId } : {}),
      startedAt: new Date().toISOString(),
    };
    this.activeMutations.set(record.id, record);
    return { ...record };
  }

  endMutation(id: string): void {
    this.activeMutations.delete(id);
  }

  requestDrain(options?: {
    reason?: string;
    requestedBy?: string;
  }) {
    if (this.state !== "draining") {
      this.state = "draining";
      this.stateChangedAt = new Date().toISOString();
    }
    this.drainReason = options?.reason?.trim() || this.drainReason;
    this.drainRequestedBy =
      options?.requestedBy?.trim() ||
      this.drainRequestedBy ||
      executionOwnerKey(currentExecutionContext());
    return this.status();
  }

  resume() {
    this.state = "running";
    this.stateChangedAt = new Date().toISOString();
    this.drainReason = undefined;
    this.drainRequestedBy = undefined;
    return this.status();
  }

  isDraining(): boolean {
    return this.state === "draining";
  }

  status() {
    const active = [...this.activeMutations.values()]
      .map((item) => ({ ...item }))
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    return {
      state: this.state,
      acceptingNewMutations: this.state === "running",
      stateChangedAt: this.stateChangedAt,
      drainReason: this.drainReason ?? null,
      drainRequestedBy: this.drainRequestedBy ?? null,
      activeMutationCount: active.length,
      activeMutations: active,
    };
  }

  async waitForIdle(options?: {
    timeoutMs?: number;
    pollMs?: number;
  }) {
    const timeoutMs = Math.min(
      Math.max(Math.trunc(options?.timeoutMs ?? 60_000), 0),
      10 * 60_000,
    );
    const pollMs = Math.min(
      Math.max(Math.trunc(options?.pollMs ?? 50), 10),
      1_000,
    );
    const deadline = Date.now() + timeoutMs;

    while (this.activeMutations.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }

    return {
      idle: this.activeMutations.size === 0,
      timedOut: this.activeMutations.size > 0,
      waitedMs: Math.max(0, timeoutMs - Math.max(0, deadline - Date.now())),
      ...this.status(),
    };
  }
}

export const runtimeLifecycle = new RuntimeLifecycleManager();
