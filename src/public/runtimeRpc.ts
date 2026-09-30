import type {
  ActivateExecutionRevisionRequest,
  AuthorizeRuntimeAccessRequest,
  ApprovalState,
  CreateScheduleRequest,
  CreateTaskFromActivationRequest,
  CreateTaskRequest,
  HealthRequest,
  PrimitiveCallRequest,
  ProcessRequest,
  ResolveTaskStepRequest,
  ResumeScheduleRequest,
  RunTaskRequest,
  StartTaskRequest,
  RuntimeClient,
  RuntimeEventRuntimeClient,
  RuntimeEventListRequest,
  StorageRuntimeClient,
  StorageGarbageCollectionRequest,
  StorageArtifactRequest,
  LegacyStorageMigrationRequest,
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
  "access.get",
  "access.authorize",
  "access.lock",
  "access.revoke",
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
  "execution-revisions.activate",
  "execution-revisions.create-task",
  "tasks.list",
  "tasks.get",
  "tasks.start",
  "tasks.run",
  "tasks.pause",
  "tasks.cancel",
  "tasks.resolve",
  "tasks.delete",
  "schedules.create",
  "schedules.list",
  "schedules.get",
  "schedules.pause",
  "schedules.resume",
  "schedules.cancel",
  "schedules.delete",
  "approvals.list",
  "approvals.get",
  "approvals.approve",
  "approvals.deny",
  "process",
  "health",
  "events.list",
  "storage.status",
  "storage.artifacts.list",
  "storage.reconcile",
  "storage.retention.evaluate",
  "storage.gc",
  "storage.artifacts.pin",
  "storage.artifacts.unpin",
  "storage.legacy.inventory",
  "storage.legacy.migrate",
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

function requireRuntimeEventRuntimeClient(
  client: RuntimeClient & Partial<RuntimeEventRuntimeClient>,
): RuntimeEventRuntimeClient {
  if (typeof client.listEvents !== "function") {
    throw new Error(
      "RUNTIME_CAPABILITY_UNAVAILABLE: public-event-journal extension is not implemented by this RuntimeClient.",
    );
  }
  return client as RuntimeClient & RuntimeEventRuntimeClient;
}

function requireStorageRuntimeClient(
  client: RuntimeClient & Partial<StorageRuntimeClient>,
): StorageRuntimeClient {
  const required: Array<keyof StorageRuntimeClient> = [
    "getStorageStatus",
    "listStorageArtifacts",
    "reconcileStorage",
    "evaluateStorageRetention",
    "collectStorageGarbage",
    "pinStorageArtifact",
    "unpinStorageArtifact",
    "inventoryLegacyStorage",
    "migrateLegacyStorage",
  ];
  const missing = required.filter((method) => typeof client[method] !== "function");
  if (missing.length > 0) {
    throw new Error(
      "RUNTIME_CAPABILITY_UNAVAILABLE: storage-management extension is not implemented by this RuntimeClient.",
    );
  }
  return client as RuntimeClient & StorageRuntimeClient;
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
    Partial<WorkflowDiscoveryRuntimeClient> &
    Partial<RuntimeEventRuntimeClient> &
    Partial<StorageRuntimeClient>,
  method: RuntimeRpcMethod,
  params?: unknown,
): Promise<unknown> {
  const object = asObject(params);

  switch (method) {
    case "info":
      return await client.info();
    case "access.get":
      return await client.getRuntimeAccessState();
    case "access.authorize":
      return await client.authorizeRuntimeAccess(
        object as AuthorizeRuntimeAccessRequest,
      );
    case "access.lock":
      return await client.lockRuntimeAccess(
        typeof object.reasonCode === "string" ? object.reasonCode : undefined,
      );
    case "access.revoke":
      return await client.revokeRuntimeAccess(
        typeof object.reasonCode === "string" ? object.reasonCode : undefined,
      );
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
    case "execution-revisions.activate":
      return await client.activateExecutionRevision(
        object as ActivateExecutionRevisionRequest,
      );
    case "execution-revisions.create-task":
      return await client.createTaskFromActivation(
        object as CreateTaskFromActivationRequest,
      );
    case "tasks.list":
      return await client.listTasks();
    case "tasks.get":
      return await client.getTask(
        requiredString(object, "taskId"),
        optionalBoolean(object, "includeResults") ?? false,
      );
    case "tasks.start":
      return await client.startTask(object as StartTaskRequest);
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
    case "schedules.pause":
      return await client.pauseSchedule(requiredString(object, "scheduleId"));
    case "schedules.resume":
      return await client.resumeSchedule(object as ResumeScheduleRequest);
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
    case "events.list":
      return await requireRuntimeEventRuntimeClient(client).listEvents(
        object as RuntimeEventListRequest,
      );
    case "storage.status":
      return await requireStorageRuntimeClient(client).getStorageStatus();
    case "storage.artifacts.list":
      return await requireStorageRuntimeClient(client).listStorageArtifacts();
    case "storage.reconcile":
      return await requireStorageRuntimeClient(client).reconcileStorage();
    case "storage.retention.evaluate":
      return await requireStorageRuntimeClient(client).evaluateStorageRetention();
    case "storage.gc":
      return await requireStorageRuntimeClient(client).collectStorageGarbage(
        object as StorageGarbageCollectionRequest,
      );
    case "storage.artifacts.pin":
      return await requireStorageRuntimeClient(client).pinStorageArtifact(
        object as StorageArtifactRequest,
      );
    case "storage.artifacts.unpin":
      return await requireStorageRuntimeClient(client).unpinStorageArtifact(
        object as StorageArtifactRequest,
      );
    case "storage.legacy.inventory":
      return await requireStorageRuntimeClient(client).inventoryLegacyStorage();
    case "storage.legacy.migrate":
      return await requireStorageRuntimeClient(client).migrateLegacyStorage(
        object as LegacyStorageMigrationRequest,
      );
    case "diagnostics.get":
      return await client.getDiagnostics(object);
  }
}
