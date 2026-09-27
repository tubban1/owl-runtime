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
  SkillRunRequest,
} from "./runtimeClient.js";

export const RUNTIME_RPC_METHODS = [
  "info",
  "capabilities.get",
  "execution-targets.get",
  "primitives.catalog",
  "primitive.call",
  "skills.catalog",
  "skill.run",
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

export async function invokeRuntimeRpc(
  client: RuntimeClient,
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
  }
}
