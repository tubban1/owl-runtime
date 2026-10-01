import type { Express, Request } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { runtimeSessionManager } from "../runtime/runtimeSessionManager.js";
import { withExecutionContext } from "../runtime/executionContext.js";
import { runtimeMode } from "../runtime/runtimePaths.js";
import { assertRuntimeAccessAllowed } from "../runtime/runtimeAccessState.js";
import { withCancellationSignal } from "../runtime/cancellation.js";
import { runtimeRequestCancellationRegistry } from "../runtime/requestCancellationRegistry.js";
import {
  withRuntimeRequestReplay,
} from "../runtime/requestReplayStore.js";
import {
  InProcessRuntimeClient,
  RUNTIME_PUBLIC_API_VERSION,
  type RuntimeClient,
  type RuntimeEventRuntimeClient,
  type StorageRuntimeClient,
  type UserSkillRuntimeClient,
  type WorkflowDiscoveryRuntimeClient,
} from "./runtimeClient.js";
import {
  RUNTIME_RPC_METHODS,
  invokeRuntimeRpc,
} from "./runtimeRpc.js";

const SESSION_ID_PATTERN = /^[A-Za-z0-9._:@/-]{3,200}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:@/-]{1,200}$/;

const READ_ONLY_RPC_METHODS = new Set<string>([
  "info",
  "access.get",
  "capabilities.get",
  "execution-targets.get",
  "primitives.catalog",
  "skills.catalog",
  "skill-candidates.discover-workflows",
  "skill-candidates.list",
  "skill-candidates.get",
  "user-skills.list",
  "user-skills.get",
  "tasks.list",
  "tasks.get",
  "schedules.list",
  "schedules.get",
  "approvals.list",
  "approvals.get",
  "health",
  "events.list",
  "storage.status",
  "storage.artifacts.list",
  "storage.reconcile",
  "storage.legacy.inventory",
  "diagnostics.get",
]);

function requestIdempotencyKey(req: Request): string | undefined {
  const value = req.header("x-owl-idempotency-key")?.trim();
  if (!value) return undefined;
  if (!IDEMPOTENCY_KEY_PATTERN.test(value)) {
    throw new Error(
      "IDEMPOTENCY_KEY_INVALID: x-owl-idempotency-key must be 1-200 safe characters.",
    );
  }
  return value;
}

const ACCESS_CONTROL_RPC_METHODS = new Set<string>([
  "access.get",
  "access.authorize",
  "access.lock",
  "access.revoke",
]);

function requiresConsequentialReplay(
  method: string,
  params: unknown,
): boolean {
  if (READ_ONLY_RPC_METHODS.has(method)) return false;
  if (method !== "process") return true;
  const object =
    params && typeof params === "object" && !Array.isArray(params)
      ? (params as Record<string, unknown>)
      : {};
  return !["list", "status", "observe", "wait"].includes(
    typeof object.op === "string" ? object.op : "list",
  );
}

function requiresRuntimeAccess(method: string): boolean {
  if (ACCESS_CONTROL_RPC_METHODS.has(method)) return false;
  return method !== "info";
}

const rpcRequestSchema = z.object({
  id: z.string().min(1).max(200).optional(),
  method: z.enum(RUNTIME_RPC_METHODS),
  params: z.unknown().optional(),
});

const cancelRequestSchema = z.object({
  requestId: z.string().min(1).max(200),
  reason: z.string().min(1).max(500).optional(),
});

function apiTokenAuthorized(req: Request): boolean {
  const expected = process.env.OWL_RUNTIME_API_TOKEN?.trim();
  if (!expected) {
    return runtimeMode() !== "production";
  }
  return req.header("authorization") === `Bearer ${expected}`;
}

function logicalSessionId(req: Request): string {
  const value = req.header("x-owl-session-id")?.trim();
  if (!value || !SESSION_ID_PATTERN.test(value)) {
    throw new Error(
      "RUNTIME_SESSION_ID_REQUIRED: supply a stable x-owl-session-id (3-200 safe characters).",
    );
  }
  return value;
}

function errorCode(error: unknown, message: string): string {
  const prefixedCode = /^([A-Z][A-Z0-9_]{2,80}):/.exec(message)?.[1];
  if (message.startsWith("RUNTIME_SESSION_ID_REQUIRED:")) {
    return "RUNTIME_SESSION_ID_REQUIRED";
  }
  if (error instanceof z.ZodError) return "INVALID_REQUEST";
  return (
    prefixedCode ??
    (error instanceof Error
      ? error.name || "RUNTIME_ERROR"
      : "RUNTIME_ERROR")
  );
}

function unauthorized(res: any, requestId?: string) {
  res.status(401).json({
    ok: false,
    apiVersion: RUNTIME_PUBLIC_API_VERSION,
    ...(requestId ? { requestId } : {}),
    error: {
      code: "UNAUTHORIZED",
      message: "Invalid OWL Runtime API bearer token.",
    },
  });
}

export function registerRuntimeHttpApi(
  app: Express,
  client: RuntimeClient &
    Partial<UserSkillRuntimeClient> &
    Partial<WorkflowDiscoveryRuntimeClient> &
    Partial<RuntimeEventRuntimeClient> &
    Partial<StorageRuntimeClient> = new InProcessRuntimeClient(),
) {
  app.get("/runtime/v0.1/info", async (req, res) => {
    if (!apiTokenAuthorized(req)) {
      unauthorized(res);
      return;
    }

    res.json({
      ok: true,
      apiVersion: RUNTIME_PUBLIC_API_VERSION,
      result: await client.info(),
    });
  });

  app.post("/runtime/v0.1/cancel", async (req, res) => {
    const apiRequestId =
      req.header("x-owl-request-id")?.trim() ||
      `cancel:${process.pid}:${randomUUID()}`;

    try {
      if (!apiTokenAuthorized(req)) {
        unauthorized(res, apiRequestId);
        return;
      }
      const sessionId = logicalSessionId(req);
      const parsed = cancelRequestSchema.parse(req.body);
      const result = runtimeRequestCancellationRegistry.cancel(
        parsed.requestId,
        sessionId,
        parsed.reason,
      );
      res.json({
        ok: true,
        apiVersion: RUNTIME_PUBLIC_API_VERSION,
        requestId: apiRequestId,
        result,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      const code = errorCode(error, message);
      res.status(code === "RUNTIME_SESSION_ID_REQUIRED" ? 400 : 500).json({
        ok: false,
        apiVersion: RUNTIME_PUBLIC_API_VERSION,
        requestId: apiRequestId,
        error: { code, message },
      });
    }
  });

  app.post("/runtime/v0.1/rpc", async (req, res) => {
    const requestId =
      req.header("x-owl-request-id")?.trim() ||
      `api:${process.pid}:${randomUUID()}`;

    let sessionId: string | undefined;
    let requestFinished = false;

    try {
      if (!apiTokenAuthorized(req)) {
        unauthorized(res, requestId);
        return;
      }

      sessionId = logicalSessionId(req);
      const parsed = rpcRequestSchema.parse(req.body);
      const idempotencyKey = requestIdempotencyKey(req);
      const replayProtected = requiresConsequentialReplay(
        parsed.method,
        parsed.params,
      );
      const active = runtimeRequestCancellationRegistry.begin({
        requestId,
        sessionId,
        method: parsed.method,
      });

      const cancelForDisconnect = () => {
        if (requestFinished || !sessionId) return;
        try {
          runtimeRequestCancellationRegistry.cancel(
            requestId,
            sessionId,
            "HTTP transport disconnected before the Runtime request completed.",
          );
        } catch {
          // The normal request error path owns reporting.
        }
      };

      req.once("aborted", cancelForDisconnect);
      res.once("close", () => {
        if (!res.writableEnded) cancelForDisconnect();
      });

      runtimeSessionManager.beginCall(sessionId, {
        userAgent: req.header("user-agent") ?? undefined,
      });

      try {
        const invoke = async () => {
          if (requiresRuntimeAccess(parsed.method)) {
            await assertRuntimeAccessAllowed();
          }
          return await withExecutionContext(
            {
              sessionId: sessionId!,
              requestId,
              origin: "api",
            },
            async () =>
              await invokeRuntimeRpc(
                client,
                parsed.method,
                parsed.params,
              ),
          );
        };

        const replay = await withCancellationSignal(
          active.controller.signal,
          async () => {
            if (!replayProtected || !idempotencyKey) {
              return {
                result: await invoke(),
                replayed: false,
                originalRequestId: requestId,
              };
            }
            return await withRuntimeRequestReplay(
              {
                sessionId: sessionId!,
                idempotencyKey,
                method: parsed.method,
                params: parsed.params,
                requestId,
              },
              invoke,
            );
          },
        );
        const result = replay.result;

        if (replayProtected) {
          res.setHeader(
            "x-owl-idempotency-status",
            idempotencyKey
              ? replay.replayed
                ? "replayed"
                : "executed"
              : "unprotected",
          );
          if (idempotencyKey) {
            res.setHeader(
              "x-owl-original-request-id",
              replay.originalRequestId,
            );
          }
        }

        requestFinished = true;
        res.json({
          ok: true,
          apiVersion: RUNTIME_PUBLIC_API_VERSION,
          requestId,
          rpcId: parsed.id ?? null,
          result,
        });
      } finally {
        requestFinished = true;
        runtimeRequestCancellationRegistry.finish(requestId);
        runtimeSessionManager.endCall(sessionId);
        req.removeListener("aborted", cancelForDisconnect);
      }
    } catch (error) {
      requestFinished = true;
      runtimeRequestCancellationRegistry.finish(requestId);
      if (sessionId) runtimeSessionManager.endCall(sessionId);

      if (res.headersSent || res.destroyed) return;

      const message =
        error instanceof Error ? error.message : String(error);
      const code = errorCode(error, message);

      res.status(
        code === "RUNTIME_SESSION_ID_REQUIRED" ? 400 :
        code === "OPERATION_CANCELLED" ? 409 :
        500,
      ).json({
        ok: false,
        apiVersion: RUNTIME_PUBLIC_API_VERSION,
        requestId,
        error: {
          code,
          message,
        },
      });
    }
  });
}
