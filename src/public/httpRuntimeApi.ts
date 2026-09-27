import type { Express, Request } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { runtimeSessionManager } from "../runtime/runtimeSessionManager.js";
import { withExecutionContext } from "../runtime/executionContext.js";
import { runtimeMode } from "../runtime/runtimePaths.js";
import {
  InProcessRuntimeClient,
  RUNTIME_PUBLIC_API_VERSION,
  type RuntimeClient,
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

function apiTokenAuthorized(req: Request): boolean {
  const expected = process.env.OWL_RUNTIME_API_TOKEN?.trim();
  if (!expected) {
    // Development/test remain frictionless on loopback. Production never
    // exposes the powerful Runtime RPC surface without an explicit bearer
    // token, even though the server itself binds only to 127.0.0.1.
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

export function registerRuntimeHttpApi(
  app: Express,
  client: RuntimeClient = new InProcessRuntimeClient(),
) {
  app.get("/runtime/v0.1/info", async (req, res) => {
    if (!apiTokenAuthorized(req)) {
      res.status(401).json({
        ok: false,
        apiVersion: RUNTIME_PUBLIC_API_VERSION,
        error: {
          code: "UNAUTHORIZED",
          message: "Invalid OWL Runtime API bearer token.",
        },
      });
      return;
    }

    res.json({
      ok: true,
      apiVersion: RUNTIME_PUBLIC_API_VERSION,
      result: await client.info(),
    });
  });

  app.post("/runtime/v0.1/rpc", async (req, res) => {
    const requestId =
      req.header("x-owl-request-id")?.trim() ||
      `api:${process.pid}:${randomUUID()}`;

    try {
      if (!apiTokenAuthorized(req)) {
        res.status(401).json({
          ok: false,
          apiVersion: RUNTIME_PUBLIC_API_VERSION,
          requestId,
          error: {
            code: "UNAUTHORIZED",
            message: "Invalid OWL Runtime API bearer token.",
          },
        });
        return;
      }

      const sessionId = logicalSessionId(req);
      const parsed = rpcRequestSchema.parse(req.body);
      runtimeSessionManager.beginCall(sessionId, {
        userAgent: req.header("user-agent") ?? undefined,
      });

      try {
        const result = await withExecutionContext(
          {
            sessionId,
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

        res.json({
          ok: true,
          apiVersion: RUNTIME_PUBLIC_API_VERSION,
          requestId,
          rpcId: parsed.id ?? null,
          result,
        });
      } finally {
        runtimeSessionManager.endCall(sessionId);
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      const prefixedCode = /^([A-Z][A-Z0-9_]{2,80}):/.exec(message)?.[1];
      const code =
        message.startsWith("RUNTIME_SESSION_ID_REQUIRED:")
          ? "RUNTIME_SESSION_ID_REQUIRED"
          : error instanceof z.ZodError
            ? "INVALID_REQUEST"
            : prefixedCode ??
              (error instanceof Error
                ? error.name || "RUNTIME_ERROR"
                : "RUNTIME_ERROR");

      res.status(code === "RUNTIME_SESSION_ID_REQUIRED" ? 400 : 500).json({
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
