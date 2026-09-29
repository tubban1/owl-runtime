import { randomUUID } from "node:crypto";

import { RUNTIME_VERSION } from "../runtime/runtimeVersion.js";

export const RUNTIME_PROVIDER_TELEMETRY_VERSION = 1 as const;
export const RUNTIME_TELEMETRY_MAX_EVENTS = 1_000;
export const RUNTIME_TELEMETRY_MAX_BATCH = 100;

export type RuntimeTelemetrySeverity = "info" | "warn" | "error" | "critical";
export type RuntimeTelemetryAttribute = string | number | boolean | null;

export type RuntimeProviderTelemetryEvent = {
  eventId: string;
  eventType: string;
  eventVersion: 1;
  occurredAt: string;
  producer: "owl-runtime";
  severity: RuntimeTelemetrySeverity;
  component: string;
  componentVersion: string;
  operation?: string;
  errorCode?: string;
  errorFingerprint?: string;
  durationMs?: number;
  retryCount?: number;
  recoverable?: boolean;
  correlationId?: string;
  taskId?: string;
  runId?: string;
  attributes?: Record<string, RuntimeTelemetryAttribute>;
};

type QueuedTelemetry = {
  cursor: number;
  event: RuntimeProviderTelemetryEvent;
};

const SENSITIVE_KEY =
  /(password|passwd|token|secret|api.?key|authorization|cookie|clipboard|prompt|content|body|message|screen|screenshot)/i;
const ATTRIBUTE_KEY = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

class RuntimeProviderTelemetryBuffer {
  private nextCursor = 1;
  private readonly events: QueuedTelemetry[] = [];

  emit(
    input: Omit<
      RuntimeProviderTelemetryEvent,
      "eventId" | "eventVersion" | "occurredAt" | "producer" | "componentVersion"
    > & {
      eventId?: string;
      occurredAt?: string;
      componentVersion?: string;
    },
  ): RuntimeProviderTelemetryEvent {
    const event = normalizeEvent(input);
    this.events.push({ cursor: this.nextCursor++, event });
    if (this.events.length > RUNTIME_TELEMETRY_MAX_EVENTS) {
      this.events.splice(0, this.events.length - RUNTIME_TELEMETRY_MAX_EVENTS);
    }
    return event;
  }

  list(afterCursor = 0, limit = RUNTIME_TELEMETRY_MAX_BATCH) {
    const normalizedAfter =
      Number.isSafeInteger(afterCursor) && afterCursor >= 0 ? afterCursor : 0;
    const normalizedLimit = Math.min(
      Math.max(Number.isSafeInteger(limit) ? limit : RUNTIME_TELEMETRY_MAX_BATCH, 1),
      RUNTIME_TELEMETRY_MAX_BATCH,
    );

    const selected = this.events
      .filter((item) => item.cursor > normalizedAfter)
      .slice(0, normalizedLimit);
    const nextCursor =
      selected.at(-1)?.cursor ??
      Math.max(normalizedAfter, this.events.at(-1)?.cursor ?? 0);

    return {
      version: RUNTIME_PROVIDER_TELEMETRY_VERSION,
      events: selected.map((item) => ({
        cursor: item.cursor,
        event: structuredClone(item.event),
      })),
      nextCursor,
      oldestCursor: this.events[0]?.cursor ?? null,
      newestCursor: this.events.at(-1)?.cursor ?? null,
    };
  }

  resetForTest(): void {
    this.events.length = 0;
    this.nextCursor = 1;
  }
}

export const runtimeProviderTelemetry = new RuntimeProviderTelemetryBuffer();

export function emitRuntimeProviderTelemetry(
  input: Parameters<RuntimeProviderTelemetryBuffer["emit"]>[0],
): RuntimeProviderTelemetryEvent {
  return runtimeProviderTelemetry.emit(input);
}

function normalizeEvent(
  input: Parameters<RuntimeProviderTelemetryBuffer["emit"]>[0],
): RuntimeProviderTelemetryEvent {
  const component = boundedRequired(input.component, "component", 128);
  const eventType = boundedRequired(input.eventType, "eventType", 128);
  const severity = input.severity;
  if (!["info", "warn", "error", "critical"].includes(severity)) {
    throw new Error("TELEMETRY_INVALID_SEVERITY");
  }

  const event: RuntimeProviderTelemetryEvent = {
    eventId: input.eventId?.trim() || `rtel_${randomUUID()}`,
    eventType,
    eventVersion: RUNTIME_PROVIDER_TELEMETRY_VERSION,
    occurredAt: input.occurredAt ?? new Date().toISOString(),
    producer: "owl-runtime",
    severity,
    component,
    componentVersion:
      input.componentVersion?.trim() || RUNTIME_VERSION,
  };

  assignOptional(event, "operation", input.operation, 128);
  assignOptional(event, "errorCode", input.errorCode, 128);
  assignOptional(event, "errorFingerprint", input.errorFingerprint, 256);
  assignOptional(event, "correlationId", input.correlationId, 256);
  assignOptional(event, "taskId", input.taskId, 256);
  assignOptional(event, "runId", input.runId, 256);

  if (input.durationMs !== undefined) {
    if (!Number.isFinite(input.durationMs) || input.durationMs < 0) {
      throw new Error("TELEMETRY_INVALID_DURATION");
    }
    event.durationMs = input.durationMs;
  }
  if (input.retryCount !== undefined) {
    if (!Number.isInteger(input.retryCount) || input.retryCount < 0) {
      throw new Error("TELEMETRY_INVALID_RETRY_COUNT");
    }
    event.retryCount = input.retryCount;
  }
  if (input.recoverable !== undefined) event.recoverable = input.recoverable;

  if (input.attributes) {
    const entries = Object.entries(input.attributes);
    if (entries.length > 20) throw new Error("TELEMETRY_TOO_MANY_ATTRIBUTES");
    const attributes: Record<string, RuntimeTelemetryAttribute> = {};
    for (const [key, value] of entries) {
      if (!ATTRIBUTE_KEY.test(key) || SENSITIVE_KEY.test(key)) {
        throw new Error(`TELEMETRY_SENSITIVE_ATTRIBUTE_KEY:${key}`);
      }
      if (
        value !== null &&
        typeof value !== "string" &&
        typeof value !== "number" &&
        typeof value !== "boolean"
      ) {
        throw new Error(`TELEMETRY_INVALID_ATTRIBUTE:${key}`);
      }
      if (typeof value === "string" && value.length > 256) {
        throw new Error(`TELEMETRY_ATTRIBUTE_TOO_LONG:${key}`);
      }
      if (typeof value === "number" && !Number.isFinite(value)) {
        throw new Error(`TELEMETRY_INVALID_ATTRIBUTE:${key}`);
      }
      attributes[key] = value;
    }
    event.attributes = attributes;
  }

  return event;
}

function boundedRequired(value: string, name: string, max: number): string {
  const normalized = value?.trim();
  if (!normalized || normalized.length > max) {
    throw new Error(`TELEMETRY_INVALID_${name.toUpperCase()}`);
  }
  return normalized;
}

function assignOptional(
  target: RuntimeProviderTelemetryEvent,
  key:
    | "operation"
    | "errorCode"
    | "errorFingerprint"
    | "correlationId"
    | "taskId"
    | "runId",
  value: string | undefined,
  max: number,
): void {
  if (value === undefined) return;
  const normalized = value.trim();
  if (!normalized || normalized.length > max) {
    throw new Error(`TELEMETRY_INVALID_${key.toUpperCase()}`);
  }
  target[key] = normalized;
}
