import type {
  ApprovalState,
  CreateScheduleRequest,
  CreateTaskRequest,
  HealthRequest,
  PrimitiveCallRequest,
  ProcessRequest,
  ResolveTaskStepRequest,
  RunTaskRequest,
  RuntimeClient,
  UserSkillRuntimeClient,
  WorkflowDiscoveryRuntimeClient,
  WorkflowSkillDiscoveryRequest,
  SkillRunRequest,
  SkillCandidateSubmitRequest,
  SkillCandidateReviseRequest,
  SkillCandidateValidateRequest,
  SkillCandidateCompileTestRequest,
  SkillCandidateInspectRequest,
  SkillCandidatePromoteRequest,
  UserSkillVersionRequest,
  UserSkillRollbackRequest,
  UserSkillUninstallRequest,
} from "./runtimeClient.js";

export const RUNTIME_RPC_METHODS = [
  "info",
  "capabilities.get",
  "execution-targets.get",
  "primitives.catalog",
  "primitive.call",
  "skills.catalog",
  "skill.run",
  "skill-candidates.discover-workflows",
  "skill-candidates.submit",
  "skill-candidates.list",
  "skill-candidates.get",
  "skill-candidates.revise",
  "skill-candidates.validate",
  "skill-candidates.dismiss",
  "skill-candidates.compile-test",
  "skill-candidates.inspect",
  "skill-candidates.promote",
  "user-skills.list",
  "user-skills.get",
  "user-skills.enable",
  "user-skills.disable",
  "user-skills.activate-version",
  "user-skills.rollback",
  "user-skills.uninstall",
  "tasks.create",
  "tasks.list",
  "tasks.get",
  "tasks.run",
  "tasks.pause",
  "tasks.cancel",
  "tasks.resolve",
  "tasks.delete",
  "schedules.create",
  "schedules.list",
  "schedules.get",
  "schedules.cancel",
  "schedules.delete",
  "approvals.list",
  "approvals.get",
  "approvals.approve",
  "approvals.deny",
  "process",
  "health",
  "diagnostics.get",
] as const;

export type RuntimeRpcMethod = (typeof RUNTIME_RPC_METHODS)[number];

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as JsonObject;
}

function requiredString(object: JsonObject, key: string): string {
  const value = object[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Missing required string "${key}".`);
  }
  return value.trim();
}

function optionalBoolean(object: JsonObject, key: string): boolean | undefined {
  const value = object[key];
  return typeof value === "boolean" ? value : undefined;
}

function requireUserSkillRuntimeClient(
  client: RuntimeClient & Partial<UserSkillRuntimeClient>,
): UserSkillRuntimeClient {
  const required: Array<keyof UserSkillRuntimeClient> = [
    "submitSkillCandidate",
    "listSkillCandidates",
    "getSkillCandidate",
    "reviseSkillCandidate",
    "validateSkillCandidate",
    "dismissSkillCandidate",
    "compileSkillCandidateTest",
    "inspectSkillCandidate",
    "promoteSkillCandidate",
    "listUserSkills",
    "getUserSkill",
    "enableUserSkill",
    "disableUserSkill",
    "activateUserSkillVersion",
    "rollbackUserSkill",
    "uninstallUserSkill",
  ];
  const missing = required.filter(
    (method) => typeof client[method] !== "function",
  );
  if (missing.length > 0) {
    throw new Error(
      "RUNTIME_CAPABILITY_UNAVAILABLE: user-skill-registry extension is not implemented by this RuntimeClient.",
    );
  }
  return client as RuntimeClient & UserSkillRuntimeClient;
}

function requireWorkflowDiscoveryRuntimeClient(
  client: RuntimeClient & Partial<WorkflowDiscoveryRuntimeClient>,
): WorkflowDiscoveryRuntimeClient {
  if (typeof client.discoverWorkflowSkillCandidates !== "function") {
    throw new Error(
      "RUNTIME_CAPABILITY_UNAVAILABLE: workflow-discovery extension is not implemented by this RuntimeClient.",
    );
  }
  return client as RuntimeClient & WorkflowDiscoveryRuntimeClient;
}

export async function invokeRuntimeRpc(
  client: RuntimeClient &
    Partial<UserSkillRuntimeClient> &
    Partial<WorkflowDiscoveryRuntimeClient>,
  method: RuntimeRpcMethod,
  params?: unknown,
): Promise<unknown> {
  const object = asObject(params);

  switch (method) {
    case "info":
      return await client.info();
    case "capabilities.get":
      return await client.getCapabilities(
        typeof object.goal === "string" ? object.goal : "",
      );
    case "execution-targets.get":
      return await client.getExecutionTargets();
    case "primitives.catalog":
      return await client.getPrimitiveCatalog();
    case "primitive.call":
      return await client.callPrimitive(object as PrimitiveCallRequest);
    case "skills.catalog":
      return await client.getSkillCatalog();
    case "skill.run":
      return await client.runSkill(object as SkillRunRequest);
    case "skill-candidates.discover-workflows":
      return await requireWorkflowDiscoveryRuntimeClient(client).discoverWorkflowSkillCandidates(
        object as WorkflowSkillDiscoveryRequest,
      );
    case "skill-candidates.submit":
      return await requireUserSkillRuntimeClient(client).submitSkillCandidate(object as SkillCandidateSubmitRequest);
    case "skill-candidates.list":
      return await requireUserSkillRuntimeClient(client).listSkillCandidates();
    case "skill-candidates.get":
      return await requireUserSkillRuntimeClient(client).getSkillCandidate(requiredString(object, "candidateId"));
    case "skill-candidates.revise":
      return await requireUserSkillRuntimeClient(client).reviseSkillCandidate(object as SkillCandidateReviseRequest);
    case "skill-candidates.validate":
      return await requireUserSkillRuntimeClient(client).validateSkillCandidate(object as SkillCandidateValidateRequest);
    case "skill-candidates.dismiss":
      return await requireUserSkillRuntimeClient(client).dismissSkillCandidate(object as SkillCandidateValidateRequest);
    case "skill-candidates.compile-test":
      return await requireUserSkillRuntimeClient(client).compileSkillCandidateTest(object as SkillCandidateCompileTestRequest);
    case "skill-candidates.inspect":
      return await requireUserSkillRuntimeClient(client).inspectSkillCandidate(object as SkillCandidateInspectRequest);
    case "skill-candidates.promote":
      return await requireUserSkillRuntimeClient(client).promoteSkillCandidate(object as SkillCandidatePromoteRequest);
    case "user-skills.list":
      return await requireUserSkillRuntimeClient(client).listUserSkills();
    case "user-skills.get":
      return await requireUserSkillRuntimeClient(client).getUserSkill(requiredString(object, "skillId"));
    case "user-skills.enable":
      return await requireUserSkillRuntimeClient(client).enableUserSkill(requiredString(object, "skillId"));
    case "user-skills.disable":
      return await requireUserSkillRuntimeClient(client).disableUserSkill(requiredString(object, "skillId"));
    case "user-skills.activate-version":
      return await requireUserSkillRuntimeClient(client).activateUserSkillVersion(object as UserSkillVersionRequest);
    case "user-skills.rollback":
      return await requireUserSkillRuntimeClient(client).rollbackUserSkill(object as UserSkillRollbackRequest);
    case "user-skills.uninstall":
      return await requireUserSkillRuntimeClient(client).uninstallUserSkill(object as UserSkillUninstallRequest);

    case "tasks.create":
      return await client.createTask(object as CreateTaskRequest);
    case "tasks.list":
      return await client.listTasks();
    case "tasks.get":
      return await client.getTask(
        requiredString(object, "taskId"),
        optionalBoolean(object, "includeResults") ?? false,
      );
    case "tasks.run":
      return await client.runTask(object as RunTaskRequest);
    case "tasks.pause":
      return await client.pauseTask(requiredString(object, "taskId"));
    case "tasks.cancel":
      return await client.cancelTask(requiredString(object, "taskId"));
    case "tasks.resolve":
      return await client.resolveTaskStep(object as ResolveTaskStepRequest);
    case "tasks.delete":
      return await client.deleteTask(requiredString(object, "taskId"));

    case "schedules.create":
      return await client.createSchedule(object as CreateScheduleRequest);
    case "schedules.list":
      return await client.listSchedules();
    case "schedules.get":
      return await client.getSchedule(requiredString(object, "scheduleId"));
    case "schedules.cancel":
      return await client.cancelSchedule(requiredString(object, "scheduleId"));
    case "schedules.delete":
      return await client.deleteSchedule(requiredString(object, "scheduleId"));

    case "approvals.list":
      return await client.listApprovals(
        typeof object.state === "string"
          ? (object.state as ApprovalState)
          : undefined,
      );
    case "approvals.get":
      return await client.getApproval(requiredString(object, "approvalId"));
    case "approvals.approve":
      return await client.approve(
        requiredString(object, "approvalId"),
        object.confirm === true,
      );
    case "approvals.deny":
      return await client.deny(
        requiredString(object, "approvalId"),
        object.confirm === true,
      );

    case "process":
      return await client.process(object as ProcessRequest);
    case "health":
      return await client.health(object as HealthRequest);
    case "diagnostics.get":
      return await client.getDiagnostics(object);
  }
}
