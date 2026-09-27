export type ExecutionTargetKind = "host" | "sandbox" | "remote";

export type ExecutionTarget = {
  kind: ExecutionTargetKind;
  targetId?: string;
  providerAffinity?: string[];
  /**
   * OWL Runtime 1.0 never silently falls back between execution targets.
   * The field exists so the contract can reject callers that request it.
   */
  allowFallback?: false;
};

export type ExecutionTargetStatus = {
  kind: ExecutionTargetKind;
  available: boolean;
  stability: "stable" | "candidate" | "planned";
  reason?: string;
};

export const HOST_EXECUTION_TARGET: ExecutionTarget = Object.freeze({
  kind: "host",
  allowFallback: false,
});

function cleanProviderAffinity(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error(
      "INVALID_EXECUTION_TARGET: providerAffinity must be an array of provider ids.",
    );
  }

  const unique = [
    ...new Set(
      value.map((item) => {
        if (typeof item !== "string" || !item.trim()) {
          throw new Error(
            "INVALID_EXECUTION_TARGET: providerAffinity entries must be non-empty strings.",
          );
        }
        return item.trim();
      }),
    ),
  ];

  return unique.length > 0 ? unique : undefined;
}

export function normalizeExecutionTarget(
  input: unknown,
): ExecutionTarget {
  if (input === undefined || input === null) {
    return { ...HOST_EXECUTION_TARGET };
  }

  if (typeof input === "string") {
    input = { kind: input };
  }

  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(
      "INVALID_EXECUTION_TARGET: execution target must be an object or target kind.",
    );
  }

  const object = input as Record<string, unknown>;
  const kind = object.kind;
  if (kind !== "host" && kind !== "sandbox" && kind !== "remote") {
    throw new Error(
      'INVALID_EXECUTION_TARGET: kind must be "host", "sandbox", or "remote".',
    );
  }

  if (object.allowFallback === true) {
    throw new Error(
      "EXECUTION_TARGET_FALLBACK_FORBIDDEN: OWL Runtime 1.0 does not silently fall back between execution targets.",
    );
  }
  if (
    object.allowFallback !== undefined &&
    object.allowFallback !== false
  ) {
    throw new Error(
      "INVALID_EXECUTION_TARGET: allowFallback may only be false.",
    );
  }

  const targetId =
    typeof object.targetId === "string" && object.targetId.trim()
      ? object.targetId.trim()
      : undefined;

  if (
    object.targetId !== undefined &&
    typeof object.targetId !== "string"
  ) {
    throw new Error(
      "INVALID_EXECUTION_TARGET: targetId must be a string.",
    );
  }

  const providerAffinity = cleanProviderAffinity(
    object.providerAffinity,
  );

  return {
    kind,
    ...(targetId ? { targetId } : {}),
    ...(providerAffinity ? { providerAffinity } : {}),
    allowFallback: false,
  };
}

export function executionTargetStatuses(): ExecutionTargetStatus[] {
  return [
    {
      kind: "host",
      available: true,
      stability: "stable",
    },
    {
      kind: "sandbox",
      available: false,
      stability: "planned",
      reason:
        "The 1.0 contract reserves sandbox execution, but no production sandbox provider is bundled.",
    },
    {
      kind: "remote",
      available: false,
      stability: "planned",
      reason:
        "The 1.0 contract reserves remote execution, but no remote execution provider is bundled.",
    },
  ];
}

export function assertExecutionTargetAvailable(
  input: unknown,
): ExecutionTarget {
  const target = normalizeExecutionTarget(input);
  const status = executionTargetStatuses().find(
    (item) => item.kind === target.kind,
  );

  if (!status?.available) {
    throw new Error(
      `EXECUTION_TARGET_UNAVAILABLE: ${target.kind}${target.targetId ? `:${target.targetId}` : ""} is not available in this OWL Runtime build.`,
    );
  }

  return target;
}

export function assertProviderAffinity(
  providerId: string,
  input: unknown,
): ExecutionTarget {
  const target = assertExecutionTargetAvailable(input);
  if (
    target.providerAffinity &&
    !target.providerAffinity.includes(providerId)
  ) {
    throw new Error(
      `PROVIDER_AFFINITY_MISMATCH: action requires provider "${providerId}" but execution target allows only ${target.providerAffinity.join(", ")}.`,
    );
  }
  return target;
}

export function getExecutionTargetManifest() {
  return {
    version: 1 as const,
    defaultTarget: "host" as const,
    silentFallback: false,
    targets: executionTargetStatuses(),
  };
}
