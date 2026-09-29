import {
  executePrimitive,
  getPrimitiveCatalog,
} from "../primitives/primitiveRuntime.js";
import {
  executeSkill,
  getCapabilityManifest,
  getSkillCatalog,
} from "../skills/skillRuntime.js";
import {
  activateUserSkillVersion,
  compileSkillCandidateTest,
  dismissSkillCandidate,
  getSkillCandidate,
  getSkillCandidates,
  getUserSkill,
  inspectSkillCandidate,
  listUserSkills,
  promoteSkillCandidate,
  reviseSkillCandidate,
  rollbackUserSkill,
  setUserSkillEnabled,
  submitSkillCandidate,
  uninstallUserSkill,
  validateSkillCandidate,
} from "../skills/userSkillRuntime.js";
import {
  discoverWorkflowSkillCandidates,
  type WorkflowSkillDiscoveryRequest,
} from "../skills/workflowSkillDiscovery.js";
export type { WorkflowSkillDiscoveryRequest } from "../skills/workflowSkillDiscovery.js";
import {
  cancelPersistentTask,
  createPersistentTask,
  deletePersistentTask,
  getPersistentTaskStatus,
  listPersistentTasks,
  requestTaskPause,
  resolvePersistentTaskStep,
  runPersistentTask,
} from "../tasks/taskRuntime.js";
import {
  cancelPersistentSchedule,
  createPrimitiveSchedule,
  deletePersistentSchedule,
  getPersistentSchedule,
  listPersistentSchedules,
} from "../runtime/scheduler.js";
import {
  approveApproval,
  denyApproval,
  listApprovals,
  readApproval,
} from "../policy/approvalPolicy.js";
import { RUNTIME_VERSION } from "../runtime/runtimeVersion.js";
import { createSupportPackage } from "../diagnostics/supportPackage.js";
import { withChildExecutionContext } from "../runtime/executionContext.js";
import {
  assertExecutionTargetAvailable,
  getExecutionTargetManifest,
} from "../runtime/executionTarget.js";

export const RUNTIME_PUBLIC_API_VERSION = "0.1" as const;

export type RuntimeTransport = "in-process" | "ipc" | "http" | "mock";

export type RuntimeClientInfo = {
  apiVersion: typeof RUNTIME_PUBLIC_API_VERSION;
  runtimeVersion: string;
  transport: RuntimeTransport;
};

export type PublicExecutionTarget = {
  kind: "host" | "sandbox" | "remote";
  targetId?: string;
  providerAffinity?: string[];
  allowFallback?: false;
};

export type PublicVerificationOperator =
  | "exists"
  | "equals"
  | "contains"
  | "matches"
  | "truthy"
  | "falsy"
  | "gt"
  | "gte"
  | "lt"
  | "lte";

export type PublicVerificationExpectation = {
  path: string;
  operator: PublicVerificationOperator;
  expected?: unknown;
  description?: string;
};

export type PublicVerificationSpec = {
  id: string;
  description?: string;
  expectations: PublicVerificationExpectation[];
};

export type PrimitiveCallRequest = {
  primitive: string;
  op: string;
  args?: Record<string, unknown>;
  executionTarget?: PublicExecutionTarget;
};

export type SkillRunRequest = {
  skill: string;
  args?: Record<string, unknown>;
  dryRun?: boolean;
  executionTarget?: PublicExecutionTarget;
};
export type SkillCandidateSubmitRequest = { manifest: unknown };
export type SkillCandidateReviseRequest = {
  candidateId: string;
  expectedDigest: string;
  manifest: unknown;
};
export type SkillCandidateValidateRequest = {
  candidateId: string;
  expectedDigest?: string;
};
export type SkillCandidateCompileTestRequest = {
  candidateId: string;
  expectedDigest: string;
  inputs?: Record<string, unknown>;
};
export type SkillCandidateInspectRequest = {
  candidateId: string;
  testTaskId?: string;
};
export type SkillCandidatePromoteRequest = {
  candidateId: string;
  expectedDigest: string;
  testTaskId: string;
  confirm: boolean;
};
export type UserSkillVersionRequest = {
  skillId: string;
  version: string;
};
export type UserSkillRollbackRequest = {
  skillId: string;
  version?: string;
};
export type UserSkillUninstallRequest = {
  skillId: string;
  version?: string;
};

export type TaskStepRequest = {
  id: string;
  action: string;
  args?: Record<string, unknown>;
  dependsOn?: string[];
  verify?: PublicVerificationSpec;
};

export type PrimitiveTaskStepRequest = {
  id: string;
  primitive: string;
  op: string;
  args?: Record<string, unknown>;
  dependsOn?: string[];
  verify?: PublicVerificationSpec;
};

export type CreateTaskRequest = {
  label: string;
  steps: TaskStepRequest[];
  maxConcurrency?: number;
  failFast?: boolean;
  executionTarget?: PublicExecutionTarget;
};

export type RunTaskRequest = {
  taskId: string;
  maxConcurrency?: number;
  failFast?: boolean;
  maxWaves?: number;
  timeBudgetMs?: number;
};

export type ResolveTaskStepRequest = {
  taskId: string;
  stepId: string;
  resolution: "retry" | "mark_succeeded";
  result?: unknown;
};

export type PublicScheduleTrigger =
  | { kind: "once"; at: string }
  | { kind: "interval"; everyMs: number; startAt?: string }
  | { kind: "daily"; time: string };

export type PublicScheduleStopWhen = {
  ref: string;
  equals?: unknown;
  truthy?: boolean;
};

export type CreateScheduleRequest = {
  label: string;
  trigger: PublicScheduleTrigger;
  steps: PrimitiveTaskStepRequest[];
  taskLabel?: string;
  maxConcurrency?: number;
  failFast?: boolean;
  maxWaves?: number;
  timeBudgetMs?: number;
  stopWhen?: PublicScheduleStopWhen;
  maxRuns?: number;
  endAt?: string;
  executionTarget?: PublicExecutionTarget;
};

export type ApprovalState =
  | "pending"
  | "approved"
  | "consumed"
  | "denied"
  | "expired";

export type DiagnosticsRequest = {
  auditLimit?: number;
};

export type HealthRequest =
  | { op?: "status" }
  | { op: "task"; task_id: string }
  | { op: "process"; process_id: string; tail_chars?: number }
  | { op: "approval"; approval_id: string }
  | { op: "provider"; provider_id: string }
  | { op: "providers" };

export type ProcessRequest = (
  | { op?: "list" }
  | { op: "status" | "observe"; process_id: string; tail_chars?: number }
  | {
      op: "wait";
      process_id: string;
      states?: string[];
      timeout_ms?: number;
      poll_ms?: number;
      tail_chars?: number;
    }
  | {
      op: "interact";
      process_id: string;
      input: string;
      timeout_ms?: number;
      poll_ms?: number;
      tail_chars?: number;
      control_token?: string;
    }
  | { op: "claim"; process_id: string; control_token?: string }
) & { executionTarget?: PublicExecutionTarget };

async function withPublicExecutionTarget<T>(
  input: PublicExecutionTarget | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  const executionTarget = assertExecutionTargetAvailable(input);
  return await withChildExecutionContext(
    { executionTarget },
    operation,
  );
}

export interface WorkflowDiscoveryRuntimeClient {
  discoverWorkflowSkillCandidates(
    request?: WorkflowSkillDiscoveryRequest,
  ): Promise<unknown>;
}

export interface UserSkillRuntimeClient {
  submitSkillCandidate(request: SkillCandidateSubmitRequest): Promise<unknown>;
  listSkillCandidates(): Promise<unknown>;
  getSkillCandidate(candidateId: string): Promise<unknown>;
  reviseSkillCandidate(request: SkillCandidateReviseRequest): Promise<unknown>;
  validateSkillCandidate(request: SkillCandidateValidateRequest): Promise<unknown>;
  dismissSkillCandidate(request: SkillCandidateValidateRequest): Promise<unknown>;
  compileSkillCandidateTest(request: SkillCandidateCompileTestRequest): Promise<unknown>;
  inspectSkillCandidate(request: SkillCandidateInspectRequest): Promise<unknown>;
  promoteSkillCandidate(request: SkillCandidatePromoteRequest): Promise<unknown>;

  listUserSkills(): Promise<unknown>;
  getUserSkill(skillId: string): Promise<unknown>;
  enableUserSkill(skillId: string): Promise<unknown>;
  disableUserSkill(skillId: string): Promise<unknown>;
  activateUserSkillVersion(request: UserSkillVersionRequest): Promise<unknown>;
  rollbackUserSkill(request: UserSkillRollbackRequest): Promise<unknown>;
  uninstallUserSkill(request: UserSkillUninstallRequest): Promise<unknown>;
}

export type RuntimeClientWithUserSkills = RuntimeClient & UserSkillRuntimeClient;
export type RuntimeClientWithWorkflowDiscovery =
  RuntimeClientWithUserSkills & WorkflowDiscoveryRuntimeClient;

export interface RuntimeClient {
  info(): Promise<RuntimeClientInfo>;

  getCapabilities(goal?: string): Promise<unknown>;
  getExecutionTargets(): Promise<unknown>;
  getPrimitiveCatalog(): Promise<unknown>;
  callPrimitive(request: PrimitiveCallRequest): Promise<unknown>;
  getSkillCatalog(): Promise<unknown>;
  runSkill(request: SkillRunRequest): Promise<unknown>;

  createTask(request: CreateTaskRequest): Promise<unknown>;
  listTasks(): Promise<unknown>;
  getTask(taskId: string, includeResults?: boolean): Promise<unknown>;
  runTask(request: RunTaskRequest): Promise<unknown>;
  pauseTask(taskId: string): Promise<unknown>;
  cancelTask(taskId: string): Promise<unknown>;
  resolveTaskStep(request: ResolveTaskStepRequest): Promise<unknown>;
  deleteTask(taskId: string): Promise<unknown>;

  createSchedule(request: CreateScheduleRequest): Promise<unknown>;
  listSchedules(): Promise<unknown>;
  getSchedule(scheduleId: string): Promise<unknown>;
  cancelSchedule(scheduleId: string): Promise<unknown>;
  deleteSchedule(scheduleId: string): Promise<unknown>;

  listApprovals(state?: ApprovalState): Promise<unknown>;
  getApproval(approvalId: string): Promise<unknown>;
  approve(approvalId: string, confirm: boolean): Promise<unknown>;
  deny(approvalId: string, confirm: boolean): Promise<unknown>;

  process(request: ProcessRequest): Promise<unknown>;
  health(request?: HealthRequest): Promise<unknown>;
  getDiagnostics(request?: DiagnosticsRequest): Promise<unknown>;
}

/**
 * Reference implementation used inside OWL Runtime and by conformance tests.
 *
 * External products MUST depend on RuntimeClient semantics, not import Runtime
 * internals. IPC/HTTP implementations should preserve this interface.
 */
export class InProcessRuntimeClient implements RuntimeClient, UserSkillRuntimeClient, WorkflowDiscoveryRuntimeClient {
  async info(): Promise<RuntimeClientInfo> {
    return {
      apiVersion: RUNTIME_PUBLIC_API_VERSION,
      runtimeVersion: RUNTIME_VERSION,
      transport: "in-process",
    };
  }

  async getCapabilities(goal = ""): Promise<unknown> {
    return await getCapabilityManifest(goal);
  }

  async getExecutionTargets(): Promise<unknown> {
    return getExecutionTargetManifest();
  }

  async getPrimitiveCatalog(): Promise<unknown> {
    return getPrimitiveCatalog();
  }

  async callPrimitive(request: PrimitiveCallRequest): Promise<unknown> {
    return await withPublicExecutionTarget(
      request.executionTarget,
      async () =>
        await executePrimitive(
          request.primitive,
          request.op,
          request.args ?? {},
        ),
    );
  }

  async getSkillCatalog(): Promise<unknown> {
    return getSkillCatalog();
  }

  async runSkill(request: SkillRunRequest): Promise<unknown> {
    return await withPublicExecutionTarget(
      request.executionTarget,
      async () =>
        await executeSkill(
          request.skill,
          request.args ?? {},
          request.dryRun ?? false,
        ),
    );
  }
  async discoverWorkflowSkillCandidates(
    request: WorkflowSkillDiscoveryRequest = {},
  ): Promise<unknown> {
    return await discoverWorkflowSkillCandidates(request);
  }

  async submitSkillCandidate(request: SkillCandidateSubmitRequest): Promise<unknown> {
    return await submitSkillCandidate(request.manifest);
  }

  async listSkillCandidates(): Promise<unknown> {
    return await getSkillCandidates();
  }

  async getSkillCandidate(candidateId: string): Promise<unknown> {
    return await getSkillCandidate(candidateId);
  }

  async reviseSkillCandidate(request: SkillCandidateReviseRequest): Promise<unknown> {
    return await reviseSkillCandidate(request);
  }

  async validateSkillCandidate(request: SkillCandidateValidateRequest): Promise<unknown> {
    return await validateSkillCandidate(request);
  }

  async dismissSkillCandidate(request: SkillCandidateValidateRequest): Promise<unknown> {
    return await dismissSkillCandidate(request);
  }

  async compileSkillCandidateTest(request: SkillCandidateCompileTestRequest): Promise<unknown> {
    return await compileSkillCandidateTest(request);
  }

  async inspectSkillCandidate(request: SkillCandidateInspectRequest): Promise<unknown> {
    return await inspectSkillCandidate(request);
  }

  async promoteSkillCandidate(request: SkillCandidatePromoteRequest): Promise<unknown> {
    return await promoteSkillCandidate(request);
  }

  async listUserSkills(): Promise<unknown> {
    return await listUserSkills();
  }

  async getUserSkill(skillId: string): Promise<unknown> {
    return await getUserSkill(skillId);
  }

  async enableUserSkill(skillId: string): Promise<unknown> {
    return await setUserSkillEnabled(skillId, true);
  }

  async disableUserSkill(skillId: string): Promise<unknown> {
    return await setUserSkillEnabled(skillId, false);
  }

  async activateUserSkillVersion(request: UserSkillVersionRequest): Promise<unknown> {
    return await activateUserSkillVersion(request);
  }

  async rollbackUserSkill(request: UserSkillRollbackRequest): Promise<unknown> {
    return await rollbackUserSkill(request);
  }

  async uninstallUserSkill(request: UserSkillUninstallRequest): Promise<unknown> {
    return await uninstallUserSkill(request);
  }

  async createTask(request: CreateTaskRequest): Promise<unknown> {
    return await withPublicExecutionTarget(
      request.executionTarget,
      async () =>
        await createPersistentTask(
          request.label,
          request.steps as Parameters<typeof createPersistentTask>[1],
          {
            maxConcurrency: request.maxConcurrency,
            failFast: request.failFast,
            executionTarget: assertExecutionTargetAvailable(
              request.executionTarget,
            ),
          },
        ),
    );
  }

  async listTasks(): Promise<unknown> {
    return await listPersistentTasks();
  }

  async getTask(taskId: string, includeResults = false): Promise<unknown> {
    return await getPersistentTaskStatus(taskId, includeResults);
  }

  async runTask(request: RunTaskRequest): Promise<unknown> {
    return await runPersistentTask(request.taskId, {
      maxConcurrency: request.maxConcurrency,
      failFast: request.failFast,
      maxWaves: request.maxWaves,
      timeBudgetMs: request.timeBudgetMs,
    });
  }

  async pauseTask(taskId: string): Promise<unknown> {
    return await requestTaskPause(taskId);
  }

  async cancelTask(taskId: string): Promise<unknown> {
    return await cancelPersistentTask(taskId);
  }

  async resolveTaskStep(request: ResolveTaskStepRequest): Promise<unknown> {
    return await resolvePersistentTaskStep(
      request.taskId,
      request.stepId,
      request.resolution,
      request.result,
    );
  }

  async deleteTask(taskId: string): Promise<unknown> {
    return await deletePersistentTask(taskId);
  }

  async createSchedule(request: CreateScheduleRequest): Promise<unknown> {
    return await withPublicExecutionTarget(
      request.executionTarget,
      async () =>
        await createPrimitiveSchedule(
          request as Parameters<typeof createPrimitiveSchedule>[0],
        ),
    );
  }

  async listSchedules(): Promise<unknown> {
    return await listPersistentSchedules();
  }

  async getSchedule(scheduleId: string): Promise<unknown> {
    return await getPersistentSchedule(scheduleId);
  }

  async cancelSchedule(scheduleId: string): Promise<unknown> {
    return await cancelPersistentSchedule(scheduleId);
  }

  async deleteSchedule(scheduleId: string): Promise<unknown> {
    return await deletePersistentSchedule(scheduleId);
  }

  async listApprovals(state?: ApprovalState): Promise<unknown> {
    return await listApprovals(
      state
        ? {
            state: state as Parameters<typeof listApprovals>[0] extends
              | { state?: infer S }
              | undefined
              ? S
              : never,
          }
        : undefined,
    );
  }

  async getApproval(approvalId: string): Promise<unknown> {
    return await readApproval(approvalId);
  }

  async approve(approvalId: string, confirm: boolean): Promise<unknown> {
    return await approveApproval(approvalId, confirm);
  }

  async deny(approvalId: string, confirm: boolean): Promise<unknown> {
    return await denyApproval(approvalId, confirm);
  }

  async process(request: ProcessRequest): Promise<unknown> {
    const { executionTarget, ...args } = request;
    return await withPublicExecutionTarget(
      executionTarget,
      async () =>
        await executeSkill(
          "runtime.process",
          args as Record<string, unknown>,
          false,
        ),
    );
  }

  async health(request: HealthRequest = { op: "status" }): Promise<unknown> {
    return await executeSkill(
      "runtime.health",
      request as Record<string, unknown>,
      false,
    );
  }

  async getDiagnostics(
    request: DiagnosticsRequest = {},
  ): Promise<unknown> {
    return await createSupportPackage(request);
  }
}
