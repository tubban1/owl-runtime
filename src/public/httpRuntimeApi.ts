import type { Express, Request } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { runtimeSessionManager } from "../runtime/runtimeSessionManager.js";
import { withExecutionContext } from "../runtime/executionContext.js";
import { runtimeMode } from "../runtime/runtimePaths.js";
import { withCancellationSignal } from "../runtime/cancellation.js";
import { runtimeRequestCancellationRegistry } from "../runtime/requestCancellationRegistry.js";
import {
  InProcessRuntimeClient,
  RUNTIME_PUBLIC_API_VERSION,
  type RuntimeClient,
  type UserSkillRuntimeClient,
} from "./runtimeClient.js";
import {
  RUNTIME_RPC_METHODS,
  invokeRuntimeRpc,
} from "./runtimeRpc.js";

const SESSION_ID_PATTERN = /^[A-Za-z0-9._:@/-]{3,200}$/;

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
  client: RuntimeClient & Partial<UserSkillRuntimeClient> = new InProcessRuntimeClient(),
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
        const result = await withCancellationSignal(
          active.controller.signal,
          async () =>
            await withExecutionContext(
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
            ),
        );

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
