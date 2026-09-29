import { randomUUID } from "node:crypto";
import {
  RUNTIME_PUBLIC_API_VERSION,
  type ApprovalState,
  type CreateScheduleRequest,
  type CreateTaskRequest,
  type HealthRequest,
  type PrimitiveCallRequest,
  type ProcessRequest,
  type ResolveTaskStepRequest,
  type RunTaskRequest,
  type RuntimeClient,
  type RuntimeClientInfo,
  type UserSkillRuntimeClient,
  type WorkflowSkillDiscoveryRuntimeClient,
  type WorkflowSkillDiscoveryRequest,
  type SkillRunRequest,
  type SkillCandidateSubmitRequest,
  type SkillCandidateReviseRequest,
  type SkillCandidateValidateRequest,
  type SkillCandidateCompileTestRequest,
  type SkillCandidateInspectRequest,
  type SkillCandidatePromoteRequest,
  type UserSkillVersionRequest,
  type UserSkillRollbackRequest,
  type UserSkillUninstallRequest,
} from "./runtimeClient.js";
import type { RuntimeRpcMethod } from "./runtimeRpc.js";

type RpcSuccess = {
  ok: true;
  apiVersion: string;
  requestId: string;
  rpcId: string | null;
  result: unknown;
};

type RpcFailure = {
  ok: false;
  apiVersion: string;
  requestId?: string;
  error: {
    code: string;
    message: string;
  };
};

export class RuntimeRpcError extends Error {
  readonly code: string;
  readonly requestId?: string;

  constructor(error: RpcFailure) {
    super(error.error.message);
    this.name = "RuntimeRpcError";
    this.code = error.error.code;
    this.requestId = error.requestId;
  }
}

export type HttpRuntimeClientOptions = {
  baseUrl: string;
  sessionId: string;
  token?: string;
  userAgent?: string;
};

export type RuntimeInvokeOptions = {
  requestId?: string;
  signal?: AbortSignal;
};

export class HttpRuntimeClient implements RuntimeClient, UserSkillRuntimeClient, WorkflowSkillDiscoveryRuntimeClient {
  private readonly baseUrl: string;
  private readonly sessionId: string;
  private readonly token?: string;
  private readonly userAgent: string;

  constructor(options: HttpRuntimeClientOptions) {
    const sessionId = options.sessionId.trim();
    if (!sessionId) {
      throw new Error("HttpRuntimeClient requires a stable logical sessionId.");
    }
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.sessionId = sessionId;
    this.token = options.token;
    this.userAgent = options.userAgent ?? "owl-runtime-client/0.1";
  }

  async invoke(
    method: RuntimeRpcMethod,
    params?: unknown,
    options: RuntimeInvokeOptions = {},
  ): Promise<unknown> {
    const requestId =
      options.requestId ??
      `client:${Date.now().toString(36)}:${randomUUID()}`;
    const response = await fetch(`${this.baseUrl}/runtime/v0.1/rpc`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": this.userAgent,
        "x-owl-session-id": this.sessionId,
        "x-owl-request-id": requestId,
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      },
      body: JSON.stringify({
        id: requestId,
        method,
        ...(params === undefined ? {} : { params }),
      }),
      ...(options.signal ? { signal: options.signal } : {}),
    });

    const payload = (await response.json()) as RpcSuccess | RpcFailure;
    if (!response.ok || payload.ok !== true) {
      throw new RuntimeRpcError(
        payload.ok === false
          ? payload
          : {
              ok: false,
              apiVersion: RUNTIME_PUBLIC_API_VERSION,
              requestId,
              error: {
                code: `HTTP_${response.status}`,
                message: `OWL Runtime HTTP ${response.status}`,
              },
            },
      );
    }
    return payload.result;
  }

  async cancelRequest(requestId: string, reason?: string): Promise<unknown> {
    const apiRequestId =
      `cancel:${Date.now().toString(36)}:${randomUUID()}`;
    const response = await fetch(`${this.baseUrl}/runtime/v0.1/cancel`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": this.userAgent,
        "x-owl-session-id": this.sessionId,
        "x-owl-request-id": apiRequestId,
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      },
      body: JSON.stringify({
        requestId,
        ...(reason ? { reason } : {}),
      }),
    });

    const payload = (await response.json()) as RpcSuccess | RpcFailure;
    if (!response.ok || payload.ok !== true) {
      throw new RuntimeRpcError(
        payload.ok === false
          ? payload
          : {
              ok: false,
              apiVersion: RUNTIME_PUBLIC_API_VERSION,
              requestId: apiRequestId,
              error: {
                code: `HTTP_${response.status}`,
                message: `OWL Runtime HTTP ${response.status}`,
              },
            },
      );
    }
    return payload.result;
  }

  private async rpc(
    method: RuntimeRpcMethod,
    params?: unknown,
  ): Promise<unknown> {
    return await this.invoke(method, params);
  }

  async info(): Promise<RuntimeClientInfo> {
    const info = (await this.rpc("info")) as RuntimeClientInfo;
    return {
      ...info,
      transport: "http",
    };
  }

  async getCapabilities(goal = ""): Promise<unknown> {
    return await this.rpc("capabilities.get", { goal });
  }

  async getExecutionTargets(): Promise<unknown> {
    return await this.rpc("execution-targets.get");
  }

  async getPrimitiveCatalog(): Promise<unknown> {
    return await this.rpc("primitives.catalog");
  }

  async callPrimitive(request: PrimitiveCallRequest): Promise<unknown> {
    return await this.rpc("primitive.call", request);
  }

  async getSkillCatalog(): Promise<unknown> {
    return await this.rpc("skills.catalog");
  }

  async runSkill(request: SkillRunRequest): Promise<unknown> {
    return await this.rpc("skill.run", request);
  }
  async discoverWorkflowSkillCandidates(
    request: WorkflowSkillDiscoveryRequest = {},
  ): Promise<unknown> {
    return await this.rpc("skill-candidates.discover-workflows", request);
  }

  async submitSkillCandidate(request: SkillCandidateSubmitRequest): Promise<unknown> {
    return await this.rpc("skill-candidates.submit", request);
  }

  async listSkillCandidates(): Promise<unknown> {
    return await this.rpc("skill-candidates.list");
  }

  async getSkillCandidate(candidateId: string): Promise<unknown> {
    return await this.rpc("skill-candidates.get", { candidateId });
  }

  async reviseSkillCandidate(request: SkillCandidateReviseRequest): Promise<unknown> {
    return await this.rpc("skill-candidates.revise", request);
  }

  async validateSkillCandidate(request: SkillCandidateValidateRequest): Promise<unknown> {
    return await this.rpc("skill-candidates.validate", request);
  }

  async dismissSkillCandidate(request: SkillCandidateValidateRequest): Promise<unknown> {
    return await this.rpc("skill-candidates.dismiss", request);
  }

  async compileSkillCandidateTest(request: SkillCandidateCompileTestRequest): Promise<unknown> {
    return await this.rpc("skill-candidates.compile-test", request);
  }

  async inspectSkillCandidate(request: SkillCandidateInspectRequest): Promise<unknown> {
    return await this.rpc("skill-candidates.inspect", request);
  }

  async promoteSkillCandidate(request: SkillCandidatePromoteRequest): Promise<unknown> {
    return await this.rpc("skill-candidates.promote", request);
  }

  async listUserSkills(): Promise<unknown> {
    return await this.rpc("user-skills.list");
  }

  async getUserSkill(skillId: string): Promise<unknown> {
    return await this.rpc("user-skills.get", { skillId });
  }

  async enableUserSkill(skillId: string): Promise<unknown> {
    return await this.rpc("user-skills.enable", { skillId });
  }

  async disableUserSkill(skillId: string): Promise<unknown> {
    return await this.rpc("user-skills.disable", { skillId });
  }

  async activateUserSkillVersion(request: UserSkillVersionRequest): Promise<unknown> {
    return await this.rpc("user-skills.activate-version", request);
  }

  async rollbackUserSkill(request: UserSkillRollbackRequest): Promise<unknown> {
    return await this.rpc("user-skills.rollback", request);
  }

  async uninstallUserSkill(request: UserSkillUninstallRequest): Promise<unknown> {
    return await this.rpc("user-skills.uninstall", request);
  }

  async createTask(request: CreateTaskRequest): Promise<unknown> {
    return await this.rpc("tasks.create", request);
  }

  async listTasks(): Promise<unknown> {
    return await this.rpc("tasks.list");
  }

  async getTask(taskId: string, includeResults = false): Promise<unknown> {
    return await this.rpc("tasks.get", { taskId, includeResults });
  }

  async runTask(request: RunTaskRequest): Promise<unknown> {
    return await this.rpc("tasks.run", request);
  }

  async pauseTask(taskId: string): Promise<unknown> {
    return await this.rpc("tasks.pause", { taskId });
  }

  async cancelTask(taskId: string): Promise<unknown> {
    return await this.rpc("tasks.cancel", { taskId });
  }

  async resolveTaskStep(request: ResolveTaskStepRequest): Promise<unknown> {
    return await this.rpc("tasks.resolve", request);
  }

  async deleteTask(taskId: string): Promise<unknown> {
    return await this.rpc("tasks.delete", { taskId });
  }

  async createSchedule(request: CreateScheduleRequest): Promise<unknown> {
    return await this.rpc("schedules.create", request);
  }

  async listSchedules(): Promise<unknown> {
    return await this.rpc("schedules.list");
  }

  async getSchedule(scheduleId: string): Promise<unknown> {
    return await this.rpc("schedules.get", { scheduleId });
  }

  async cancelSchedule(scheduleId: string): Promise<unknown> {
    return await this.rpc("schedules.cancel", { scheduleId });
  }

  async deleteSchedule(scheduleId: string): Promise<unknown> {
    return await this.rpc("schedules.delete", { scheduleId });
  }

  async listApprovals(state?: ApprovalState): Promise<unknown> {
    return await this.rpc("approvals.list", state ? { state } : {});
  }

  async getApproval(approvalId: string): Promise<unknown> {
    return await this.rpc("approvals.get", { approvalId });
  }

  async approve(approvalId: string, confirm: boolean): Promise<unknown> {
    return await this.rpc("approvals.approve", { approvalId, confirm });
  }

  async deny(approvalId: string, confirm: boolean): Promise<unknown> {
    return await this.rpc("approvals.deny", { approvalId, confirm });
  }

  async process(request: ProcessRequest): Promise<unknown> {
    return await this.rpc("process", request);
  }

  async health(request: HealthRequest = { op: "status" }): Promise<unknown> {
    return await this.rpc("health", request);
  }

  async getDiagnostics(request: { auditLimit?: number } = {}): Promise<unknown> {
    return await this.rpc("diagnostics.get", request);
  }
}
