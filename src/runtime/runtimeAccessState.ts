import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  hasRuntimeLeaseVerificationKey,
  verifyRuntimeLeaseToken,
  type RuntimeLeaseClaimsV1,
} from "./runtimeAccessLease.js";
import { runtimeMode, runtimeStatePath } from "./runtimePaths.js";

export type RuntimeAccessStateName = "LOCKED" | "READY" | "REVOKED";
export type RuntimeAccessMode = "compat" | "enforced";

export type RuntimeAccessGrant = {
  grantId: string;
  deviceId: string;
  organizationId: string | null;
  principalId: string | null;
  issuedAt: string;
  expiresAt: string;
  evidenceDigest: string;
  source?: "cloud-signed-lease" | "legacy-desktop-projection";
  cloudLeaseId?: string;
  entitlementPlan?: string;
  entitlementStatus?: string;
  entitlementVersion?: number;
  features?: Record<string, boolean>;
  limits?: Record<string, number>;
  signatureVerified?: boolean;
};

export type RuntimeAccessState = {
  schemaVersion: 1;
  mode: RuntimeAccessMode;
  state: RuntimeAccessStateName;
  updatedAt: string;
  reasonCode: string | null;
  grant: RuntimeAccessGrant | null;
};

export type AuthorizeRuntimeAccessRequest = {
  leaseToken?: string;
  deviceId?: string;
  organizationId?: string;
  principalId?: string;
  canRun?: boolean;
  leaseExpiresAt?: string;
  evidence?: Record<string, unknown>;
};

const ACCESS_FILE = runtimeStatePath("access", "runtime-access.json");

function signedLeaseRequired(): boolean {
  if (runtimeMode() === "production") return true;
  if (hasRuntimeLeaseVerificationKey()) return true;
  return (
    process.env.OWL_RUNTIME_REQUIRE_SIGNED_LEASE?.trim().toLowerCase() === "true"
  );
}

export function runtimeAccessMode(): RuntimeAccessMode {
  const raw = process.env.OWL_RUNTIME_ACCESS_MODE?.trim().toLowerCase();
  if (raw === "enforced" || raw === "compat") return raw;
  if (signedLeaseRequired()) return "enforced";
  return runtimeMode() === "production" ? "enforced" : "compat";
}

function maxLeaseMs(): number {
  const raw = Number(process.env.OWL_RUNTIME_ACCESS_MAX_LEASE_MS ?? 86_400_000);
  if (!Number.isFinite(raw) || raw < 60_000) return 86_400_000;
  return Math.min(raw, 7 * 86_400_000);
}

function initialState(): RuntimeAccessState {
  const mode = runtimeAccessMode();
  return {
    schemaVersion: 1,
    mode,
    state: mode === "compat" ? "READY" : "LOCKED",
    updatedAt: new Date().toISOString(),
    reasonCode: mode === "compat" ? "COMPAT_MODE" : "AUTHORIZATION_REQUIRED",
    grant: null,
  };
}

async function readPersistedState(): Promise<RuntimeAccessState | null> {
  try {
    const raw = JSON.parse(await fs.readFile(ACCESS_FILE, "utf8"));
    if (
      raw?.schemaVersion !== 1 ||
      !["LOCKED", "READY", "REVOKED"].includes(raw?.state)
    ) {
      return null;
    }
    return {
      ...raw,
      mode: runtimeAccessMode(),
    } as RuntimeAccessState;
  } catch {
    return null;
  }
}

async function writeState(state: RuntimeAccessState): Promise<void> {
  await fs.mkdir(path.dirname(ACCESS_FILE), { recursive: true });
  const temp = `${ACCESS_FILE}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(state, null, 2) + "\n", {
    mode: 0o600,
  });
  await fs.rename(temp, ACCESS_FILE);
}

function effectiveState(state: RuntimeAccessState): RuntimeAccessState {
  const mode = runtimeAccessMode();
  if (mode === "compat") {
    return {
      ...state,
      mode,
      state: "READY",
      reasonCode: "COMPAT_MODE",
    };
  }
  if (
    state.state === "READY" &&
    state.grant &&
    Date.parse(state.grant.expiresAt) <= Date.now()
  ) {
    return {
      ...state,
      mode,
      state: "LOCKED",
      reasonCode: "LEASE_EXPIRED",
    };
  }
  return { ...state, mode };
}

export async function getRuntimeAccessState(): Promise<RuntimeAccessState> {
  return effectiveState((await readPersistedState()) ?? initialState());
}

function cleanRequired(value: unknown, name: string): string {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized.length > 512) {
    throw new Error(`RUNTIME_ACCESS_INVALID: ${name} is required.`);
  }
  return normalized;
}

function grantFromSignedLease(
  claims: RuntimeLeaseClaimsV1,
  token: string,
): RuntimeAccessGrant {
  return {
    grantId: `grant_${randomUUID()}`,
    deviceId: claims.deviceId,
    organizationId: claims.organizationId,
    principalId: claims.userId,
    issuedAt: claims.issuedAt,
    expiresAt: claims.expiresAt,
    evidenceDigest: createHash("sha256").update(token, "utf8").digest("hex"),
    source: "cloud-signed-lease",
    cloudLeaseId: claims.leaseId,
    entitlementPlan: claims.plan,
    entitlementStatus: claims.entitlementStatus,
    entitlementVersion: claims.entitlementVersion,
    features: { ...claims.features },
    limits: { ...claims.limits },
    signatureVerified: true,
  };
}

function grantFromLegacyProjection(
  request: AuthorizeRuntimeAccessRequest,
): RuntimeAccessGrant {
  if (request.canRun !== true) {
    throw new Error(
      "RUNTIME_ACCESS_RUN_NOT_GRANTED: Cloud effective access does not grant run.",
    );
  }
  const deviceId = cleanRequired(request.deviceId, "deviceId");
  const leaseExpiresAt = cleanRequired(request.leaseExpiresAt, "leaseExpiresAt");
  const expiresAtMs = Date.parse(leaseExpiresAt);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
    throw new Error(
      "RUNTIME_ACCESS_INVALID_LEASE: leaseExpiresAt must be in the future.",
    );
  }
  if (expiresAtMs - Date.now() > maxLeaseMs()) {
    throw new Error(
      "RUNTIME_ACCESS_INVALID_LEASE: requested offline lease exceeds Runtime maximum.",
    );
  }

  const issuedAt = new Date().toISOString();
  const organizationId = request.organizationId?.trim() || null;
  const principalId = request.principalId?.trim() || null;
  const evidenceDigest = createHash("sha256")
    .update(
      JSON.stringify({
        deviceId,
        organizationId,
        principalId,
        canRun: true,
        leaseExpiresAt: new Date(expiresAtMs).toISOString(),
        evidence: request.evidence ?? {},
      }),
    )
    .digest("hex");
  return {
    grantId: `grant_${randomUUID()}`,
    deviceId,
    organizationId,
    principalId,
    issuedAt,
    expiresAt: new Date(expiresAtMs).toISOString(),
    evidenceDigest,
    source: "legacy-desktop-projection",
    signatureVerified: false,
  };
}

export async function authorizeRuntimeAccess(
  request: AuthorizeRuntimeAccessRequest,
): Promise<RuntimeAccessState> {
  let grant: RuntimeAccessGrant;
  let reasonCode: string;

  if (request.leaseToken?.trim()) {
    const expectedDeviceId = request.deviceId?.trim() || undefined;
    const claims = verifyRuntimeLeaseToken(request.leaseToken.trim(), {
      expectedDeviceId,
      maxLeaseMs: maxLeaseMs(),
    });
    grant = grantFromSignedLease(claims, request.leaseToken.trim());
    reasonCode = "AUTHORIZED_CLOUD_SIGNED_LEASE";
  } else {
    if (signedLeaseRequired()) {
      throw new Error(
        "RUNTIME_ACCESS_SIGNED_LEASE_REQUIRED: Cloud-signed Runtime lease is required.",
      );
    }
    grant = grantFromLegacyProjection(request);
    reasonCode = "AUTHORIZED_LEGACY_PROJECTION";
  }

  const updatedAt = new Date().toISOString();
  const next: RuntimeAccessState = {
    schemaVersion: 1,
    mode: runtimeAccessMode(),
    state: "READY",
    updatedAt,
    reasonCode,
    grant,
  };
  await writeState(next);
  return effectiveState(next);
}

export async function lockRuntimeAccess(
  reasonCode = "LOCKED_BY_DESKTOP",
): Promise<RuntimeAccessState> {
  const previous = await getRuntimeAccessState();
  const next: RuntimeAccessState = {
    schemaVersion: 1,
    mode: runtimeAccessMode(),
    state: "LOCKED",
    updatedAt: new Date().toISOString(),
    reasonCode: cleanRequired(reasonCode, "reasonCode"),
    grant: previous.grant,
  };
  await writeState(next);
  return effectiveState(next);
}

export async function revokeRuntimeAccess(
  reasonCode = "DEVICE_REVOKED",
): Promise<RuntimeAccessState> {
  const previous = await getRuntimeAccessState();
  const next: RuntimeAccessState = {
    schemaVersion: 1,
    mode: runtimeAccessMode(),
    state: "REVOKED",
    updatedAt: new Date().toISOString(),
    reasonCode: cleanRequired(reasonCode, "reasonCode"),
    grant: previous.grant,
  };
  await writeState(next);
  return effectiveState(next);
}

export async function assertRuntimeMutationAllowed(): Promise<RuntimeAccessState> {
  const state = await getRuntimeAccessState();
  if (state.mode === "compat" || state.state === "READY") return state;

  if (state.state === "REVOKED") {
    throw new Error(
      `RUNTIME_ACCESS_REVOKED: Runtime mutations are disabled (${state.reasonCode ?? "DEVICE_REVOKED"}).`,
    );
  }
  if (state.reasonCode === "LEASE_EXPIRED") {
    throw new Error(
      "RUNTIME_ACCESS_LEASE_EXPIRED: Runtime authorization lease expired.",
    );
  }
  throw new Error(
    `RUNTIME_ACCESS_LOCKED: Runtime mutations are locked (${state.reasonCode ?? "AUTHORIZATION_REQUIRED"}).`,
  );
}
