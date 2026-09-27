import { randomUUID } from "node:crypto";

export type ActiveRuntimeRequest = {
  requestId: string;
  sessionId: string;
  method: string;
  startedAt: string;
  controller: AbortController;
};

class RuntimeRequestCancellationRegistry {
  private readonly active = new Map<string, ActiveRuntimeRequest>();

  begin(input: {
    requestId: string;
    sessionId: string;
    method: string;
  }): ActiveRuntimeRequest {
    if (this.active.has(input.requestId)) {
      throw new Error(
        `REQUEST_ID_ACTIVE: request ${input.requestId} is already active.`,
      );
    }
    const request: ActiveRuntimeRequest = {
      ...input,
      startedAt: new Date().toISOString(),
      controller: new AbortController(),
    };
    this.active.set(input.requestId, request);
    return request;
  }

  finish(requestId: string) {
    this.active.delete(requestId);
  }

  cancel(
    requestId: string,
    sessionId: string,
    reason = "Cancelled by the Runtime client.",
  ) {
    const request = this.active.get(requestId);
    if (!request) {
      return {
        requestId,
        cancelled: false,
        status: "not_active" as const,
      };
    }
    if (request.sessionId !== sessionId) {
      throw new Error(
        `REQUEST_OWNED: request ${requestId} belongs to session:${request.sessionId} and cannot be cancelled by session:${sessionId}.`,
      );
    }
    if (!request.controller.signal.aborted) {
      request.controller.abort(
        new Error(reason || `Cancelled request ${requestId}.`),
      );
    }
    return {
      requestId,
      cancelled: true,
      status: "cancelling" as const,
      method: request.method,
      startedAt: request.startedAt,
    };
  }

  list(sessionId?: string) {
    return [...this.active.values()]
      .filter((request) => !sessionId || request.sessionId === sessionId)
      .map(({ controller: _controller, ...request }) => ({
        ...request,
        cancelled: false,
      }))
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }

  newRequestId(prefix = "request") {
    return `${prefix}:${process.pid}:${randomUUID()}`;
  }
}

export const runtimeRequestCancellationRegistry =
  new RuntimeRequestCancellationRegistry();
