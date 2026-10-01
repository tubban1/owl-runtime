import fs from "node:fs";
import { verify } from "node:crypto";

export const RUNTIME_LEASE_PREFIX = "owllease1";

export type RuntimeLeaseClaimsV1 = {
  schemaVersion: 1;
  issuer: "owl-cloud";
  audience: "owl-runtime";
  leaseId: string;
  userId: string;
  organizationId: string;
  deviceId: string;
  plan: "trial" | "credit" | "pro" | "business";
  entitlementStatus:
    | "trial_active"
    | "active"
    | "trial_expired"
    | "payment_required"
    | "suspended";
  entitlementVersion: number;
  features: Record<string, boolean>;
  limits: Record<string, number>;
  issuedAt: string;
  expiresAt: string;
};

function configuredPublicKeyPem(): string | null {
  const plain = process.env.OWL_RUNTIME_LEASE_PUBLIC_KEY_PEM?.trim();
  if (plain) return plain.replace(/\\n/g, "\n");

  const encoded = process.env.OWL_RUNTIME_LEASE_PUBLIC_KEY_B64?.trim();
  if (encoded) {
    return Buffer.from(encoded, "base64").toString("utf8").trim();
  }

  const file = process.env.OWL_RUNTIME_LEASE_PUBLIC_KEY_FILE?.trim();
  if (!file) return null;
  try {
    const value = fs.readFileSync(file, "utf8").trim();
    return value || null;
  } catch {
    return null;
  }
}

export function hasRuntimeLeaseVerificationKey(): boolean {
  return configuredPublicKeyPem() !== null;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 512) {
    throw new Error(`RUNTIME_ACCESS_INVALID_SIGNED_LEASE: invalid ${name}.`);
  }
  return value.trim();
}

export function verifyRuntimeLeaseToken(
  token: string,
  options: {
    expectedDeviceId?: string;
    now?: Date;
    maxLeaseMs: number;
  },
): RuntimeLeaseClaimsV1 {
  const publicKeyPem = configuredPublicKeyPem();
  if (!publicKeyPem) {
    throw new Error(
      "RUNTIME_ACCESS_LEASE_KEY_MISSING: Cloud runtime lease public key is not configured.",
    );
  }

  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== RUNTIME_LEASE_PREFIX) {
    throw new Error(
      "RUNTIME_ACCESS_INVALID_SIGNED_LEASE: malformed lease token.",
    );
  }
  const [, payloadPart, signaturePart] = parts;
  if (!payloadPart || !signaturePart) {
    throw new Error(
      "RUNTIME_ACCESS_INVALID_SIGNED_LEASE: malformed lease token.",
    );
  }

  const signingInput = `${RUNTIME_LEASE_PREFIX}.${payloadPart}`;
  let signature: Buffer;
  let payload: unknown;
  try {
    signature = Buffer.from(signaturePart, "base64url");
    payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8"));
  } catch {
    throw new Error(
      "RUNTIME_ACCESS_INVALID_SIGNED_LEASE: invalid lease encoding.",
    );
  }
  if (
    !verify(
      null,
      Buffer.from(signingInput, "utf8"),
      publicKeyPem,
      signature,
    )
  ) {
    throw new Error(
      "RUNTIME_ACCESS_INVALID_SIGNED_LEASE: signature verification failed.",
    );
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error(
      "RUNTIME_ACCESS_INVALID_SIGNED_LEASE: claims must be an object.",
    );
  }

  const claims = payload as Record<string, unknown>;
  if (claims.schemaVersion !== 1) {
    throw new Error(
      "RUNTIME_ACCESS_INVALID_SIGNED_LEASE: unsupported schemaVersion.",
    );
  }
  if (claims.issuer !== "owl-cloud" || claims.audience !== "owl-runtime") {
    throw new Error(
      "RUNTIME_ACCESS_INVALID_SIGNED_LEASE: issuer/audience mismatch.",
    );
  }

  const leaseId = requiredString(claims.leaseId, "leaseId");
  const userId = requiredString(claims.userId, "userId");
  const organizationId = requiredString(claims.organizationId, "organizationId");
  const deviceId = requiredString(claims.deviceId, "deviceId");
  if (
    options.expectedDeviceId?.trim() &&
    deviceId !== options.expectedDeviceId.trim()
  ) {
    throw new Error(
      "RUNTIME_ACCESS_DEVICE_MISMATCH: signed lease is bound to a different device.",
    );
  }

  const plan = requiredString(claims.plan, "plan");
  if (!["trial", "credit", "pro", "business"].includes(plan)) {
    throw new Error("RUNTIME_ACCESS_INVALID_SIGNED_LEASE: invalid plan.");
  }
  const entitlementStatus = requiredString(
    claims.entitlementStatus,
    "entitlementStatus",
  );
  if (!["trial_active", "active"].includes(entitlementStatus)) {
    throw new Error(
      "RUNTIME_ACCESS_ENTITLEMENT_INACTIVE: signed entitlement does not permit execution.",
    );
  }
  const entitlementVersion = Number(claims.entitlementVersion);
  if (!Number.isInteger(entitlementVersion) || entitlementVersion < 1) {
    throw new Error(
      "RUNTIME_ACCESS_INVALID_SIGNED_LEASE: invalid entitlementVersion.",
    );
  }

  const features =
    claims.features &&
    typeof claims.features === "object" &&
    !Array.isArray(claims.features)
      ? (claims.features as Record<string, boolean>)
      : null;
  if (!features || features.runtime !== true) {
    throw new Error(
      "RUNTIME_ACCESS_RUN_NOT_GRANTED: signed entitlement does not grant Runtime.",
    );
  }
  const limits =
    claims.limits &&
    typeof claims.limits === "object" &&
    !Array.isArray(claims.limits)
      ? (claims.limits as Record<string, number>)
      : {};

  const now = options.now ?? new Date();
  const nowMs = now.getTime();
  const issuedAt = requiredString(claims.issuedAt, "issuedAt");
  const expiresAt = requiredString(claims.expiresAt, "expiresAt");
  const issuedAtMs = Date.parse(issuedAt);
  const expiresAtMs = Date.parse(expiresAt);
  if (!Number.isFinite(issuedAtMs) || !Number.isFinite(expiresAtMs)) {
    throw new Error(
      "RUNTIME_ACCESS_INVALID_SIGNED_LEASE: invalid lease timestamps.",
    );
  }
  if (issuedAtMs > nowMs + 5 * 60_000) {
    throw new Error(
      "RUNTIME_ACCESS_INVALID_SIGNED_LEASE: lease issue time is in the future.",
    );
  }
  if (expiresAtMs <= nowMs) {
    throw new Error("RUNTIME_ACCESS_LEASE_EXPIRED: signed lease expired.");
  }
  if (expiresAtMs - nowMs > options.maxLeaseMs) {
    throw new Error(
      "RUNTIME_ACCESS_INVALID_LEASE: signed lease exceeds Runtime maximum.",
    );
  }

  return {
    schemaVersion: 1,
    issuer: "owl-cloud",
    audience: "owl-runtime",
    leaseId,
    userId,
    organizationId,
    deviceId,
    plan: plan as RuntimeLeaseClaimsV1["plan"],
    entitlementStatus:
      entitlementStatus as RuntimeLeaseClaimsV1["entitlementStatus"],
    entitlementVersion,
    features,
    limits,
    issuedAt: new Date(issuedAtMs).toISOString(),
    expiresAt: new Date(expiresAtMs).toISOString(),
  };
}
