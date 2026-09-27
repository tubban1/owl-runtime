import { randomUUID } from "node:crypto";
import { z } from "zod";

export const OBSERVATION_ABI_VERSION = 1 as const;

export const OBSERVATION_CHANNELS = [
  "ui",
  "web",
  "process",
  "file",
  "environment",
] as const;

export const OBSERVATION_STATES = [
  "ready",
  "running",
  "waiting_input",
  "waiting_network",
  "terminating",
  "finished",
  "failed",
  "timed_out",
  "lost",
  "unknown",
] as const;

export const OBSERVATION_EVIDENCE_KINDS = [
  "dom",
  "accessibility",
  "text",
  "screenshot",
  "stdout",
  "stderr",
  "exit_code",
  "file_metadata",
  "file_content",
  "system",
  "structured",
] as const;

export type ObservationChannel = (typeof OBSERVATION_CHANNELS)[number];
export type ObservationState = (typeof OBSERVATION_STATES)[number];
export type ObservationEvidenceKind = (typeof OBSERVATION_EVIDENCE_KINDS)[number];

export type ObservationEvidence = {
  kind: ObservationEvidenceKind;
  ref?: string;
  mimeType?: string;
  summary?: string;
  metadata?: Record<string, unknown>;
};

export type Observation<T = unknown> = {
  abiVersion: typeof OBSERVATION_ABI_VERSION;
  observationId: string;
  capturedAt: string;
  channel: ObservationChannel;
  provider: string;
  subject?: string;
  state: ObservationState;
  data: T;
  evidence: ObservationEvidence[];
  metadata?: Record<string, unknown>;
};

const evidenceSchema = z.object({
  kind: z.enum(OBSERVATION_EVIDENCE_KINDS),
  ref: z.string().min(1).optional(),
  mimeType: z.string().min(1).optional(),
  summary: z.string().min(1).optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const observationSchema = z.object({
  abiVersion: z.literal(OBSERVATION_ABI_VERSION),
  observationId: z.string().min(1),
  capturedAt: z.string().min(1),
  channel: z.enum(OBSERVATION_CHANNELS),
  provider: z.string().min(1),
  subject: z.string().min(1).optional(),
  state: z.enum(OBSERVATION_STATES),
  data: z.unknown(),
  evidence: z.array(evidenceSchema),
  metadata: z.record(z.unknown()).optional(),
});

export function createObservation<T>(input: {
  channel: ObservationChannel;
  provider: string;
  state?: ObservationState;
  subject?: string;
  data: T;
  evidence?: ObservationEvidence[];
  metadata?: Record<string, unknown>;
  capturedAt?: string;
  observationId?: string;
}): Observation<T> {
  const observation: Observation<T> = {
    abiVersion: OBSERVATION_ABI_VERSION,
    observationId:
      input.observationId ??
      `observation_${Date.now().toString(36)}_${randomUUID().replaceAll("-", "").slice(0, 12)}`,
    capturedAt: input.capturedAt ?? new Date().toISOString(),
    channel: input.channel,
    provider: input.provider.trim(),
    ...(input.subject?.trim() ? { subject: input.subject.trim() } : {}),
    state: input.state ?? "ready",
    data: input.data,
    evidence: input.evidence ?? [],
    ...(input.metadata ? { metadata: input.metadata } : {}),
  };
  return observationSchema.parse(observation) as Observation<T>;
}

export function validateObservation(value: unknown): Observation {
  return observationSchema.parse(value) as Observation;
}

export function normalizeManagedProcessState(
  status: "running" | "exited" | "lost" | "terminating",
  exitCode?: number | null,
): ObservationState {
  if (status === "running") return "running";
  if (status === "terminating") return "terminating";
  if (status === "lost") return "lost";
  if (status === "exited") return exitCode === 0 ? "finished" : "failed";
  return "unknown";
}

export function getObservationAbiManifest() {
  return {
    version: OBSERVATION_ABI_VERSION,
    stability: "candidate" as const,
    channels: [...OBSERVATION_CHANNELS],
    states: [...OBSERVATION_STATES],
    evidenceKinds: [...OBSERVATION_EVIDENCE_KINDS],
    invariant:
      "Planner and verifier consume provider-neutral Observation envelopes; providers retain source-specific detail inside data/evidence.",
  };
}
