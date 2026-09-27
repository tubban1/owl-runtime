export type RiskLevel = "low" | "medium" | "high" | "critical";
export type RetryPolicy = "automatic" | "manual" | "never";
export type ResourceMode = "shared" | "exclusive";

export type ResourceRequirement = {
  key: string;
  mode: ResourceMode;
};

export type ActionContract = {
  riskLevel: RiskLevel;
  idempotent: boolean;
  sideEffects: string[];
  retryPolicy: RetryPolicy;
  requiresVerification: boolean;
  parallelSafe: boolean;
  resources: ResourceRequirement[];
};

function resource(key: string, mode: ResourceMode): ResourceRequirement {
  return { key, mode };
}

function text(args: unknown, key: string): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const value = (args as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function pathResource(args: unknown, key: string, mode: ResourceMode) {
  const value = text(args, key);
  return value ? [resource(`fs:${value}`, mode)] : [];
}

function repoResource(args: unknown, mode: ResourceMode) {
  const cwd = text(args, "cwd");
  return cwd ? [resource(`git:${cwd}`, mode)] : [resource("git", mode)];
}

const SAFE_READ: ActionContract = {
  riskLevel: "low",
  idempotent: true,
  sideEffects: [],
  retryPolicy: "automatic",
  requiresVerification: false,
  parallelSafe: true,
  resources: [],
};

const STATE_CHANGE: ActionContract = {
  riskLevel: "medium",
  idempotent: false,
  sideEffects: ["state_change"],
  retryPolicy: "manual",
  requiresVerification: false,
  parallelSafe: false,
  resources: [],
};

export function getActionContract(action: string, args: unknown = {}): ActionContract {
  if (action === "provider.status") return { ...SAFE_READ };

  if (["fs.list", "fs.tree", "fs.read", "fs.info", "fs.search"].includes(action)) {
    const key = action === "fs.search" ? "root_path" : "path";
    return { ...SAFE_READ, resources: pathResource(args, key, "shared") };
  }
  if (action === "fs.read_many") {
    const paths = Array.isArray((args as any)?.paths) ? (args as any).paths : [];
    return {
      ...SAFE_READ,
      resources: paths
        .filter((p: unknown): p is string => typeof p === "string")
        .map((p: string) => resource(`fs:${p}`, "shared")),
    };
  }
  if (["fs.mkdir", "fs.write", "fs.append", "fs.edit", "fs.delete"].includes(action)) {
    return {
      ...STATE_CHANGE,
      riskLevel: action === "fs.delete" ? "high" : "medium",
      sideEffects: [action === "fs.delete" ? "filesystem_delete" : "filesystem_write"],
      resources: pathResource(args, "path", "exclusive"),
    };
  }
  if (action === "fs.batch_edit") {
    const edits = Array.isArray((args as any)?.edits) ? (args as any).edits : [];
    return {
      ...STATE_CHANGE,
      sideEffects: ["filesystem_write"],
      resources: edits
        .map((e: any) => (typeof e?.path === "string" ? resource(`fs:${e.path}`, "exclusive") : null))
        .filter(Boolean) as ResourceRequirement[],
    };
  }
  if (["fs.move", "fs.copy"].includes(action)) {
    const source = text(args, "source_path");
    const dest = text(args, "destination_path");
    return {
      ...STATE_CHANGE,
      sideEffects: [action === "fs.move" ? "filesystem_move" : "filesystem_copy"],
      resources: [
        ...(source ? [resource(`fs:${source}`, action === "fs.copy" ? "shared" : "exclusive")] : []),
        ...(dest ? [resource(`fs:${dest}`, "exclusive")] : []),
      ],
    };
  }

  if (action === "shell.exec" || action === "shell.start") {
    return {
      riskLevel: "critical",
      idempotent: false,
      sideEffects: ["shell_execution"],
      retryPolicy: "manual",
      requiresVerification: true,
      parallelSafe: false,
      // v0.9.11 injects canonical workspace shared/exclusive resources in the
      // Action Router. A global "shell" mutex would unnecessarily serialize
      // independent repositories and defeat cross-workspace concurrency.
      resources: [],
    };
  }
  if (action === "shell.processes") return { ...SAFE_READ };
  if (action === "shell.output") {
    const processId = text(args, "process_id");
    return {
      ...SAFE_READ,
      resources: processId
        ? [resource(`process:${processId}`, "shared")]
        : [],
    };
  }
  if (["shell.input", "shell.kill"].includes(action)) {
    const processId = text(args, "process_id");
    return {
      ...STATE_CHANGE,
      riskLevel: "high",
      sideEffects: ["process_control"],
      resources: [
        resource(
          processId ? `process:${processId}` : "process",
          "exclusive",
        ),
      ],
    };
  }

  if (["git.status", "git.diff", "git.log"].includes(action)) {
    return { ...SAFE_READ, resources: repoResource(args, "shared") };
  }
  if (["git.add", "git.commit", "git.patch"].includes(action)) {
    return {
      ...STATE_CHANGE,
      riskLevel: "medium",
      sideEffects: ["git_mutation"],
      resources: repoResource(args, "exclusive"),
    };
  }
  if (["git.pull", "git.push"].includes(action)) {
    return {
      riskLevel: "high",
      idempotent: false,
      sideEffects: [action === "git.push" ? "remote_git_write" : "remote_git_read_write"],
      retryPolicy: "manual",
      requiresVerification: true,
      parallelSafe: false,
      resources: repoResource(args, "exclusive"),
    };
  }

  if (["tx.status", "tx.list"].includes(action)) return { ...SAFE_READ };
  if (["tx.begin", "tx.rollback", "tx.complete"].includes(action)) {
    return {
      ...STATE_CHANGE,
      riskLevel: action === "tx.rollback" ? "high" : "medium",
      sideEffects: ["transaction_state"],
      resources: [resource("transaction", "exclusive")],
    };
  }

  if (["browser.tabs", "browser.snapshot", "browser.screenshot", "browser.find"].includes(action)) {
    return {
      ...SAFE_READ,
      resources: [resource("browser.session", "shared")],
    };
  }
  if (["browser.open", "browser.use_tab", "browser.new_tab", "browser.click", "browser.type", "browser.upload", "browser.close"].includes(action)) {
    const externallyConsequential = ["browser.click", "browser.type", "browser.upload"].includes(action);
    return {
      riskLevel: externallyConsequential ? "high" : "medium",
      idempotent: action === "browser.use_tab" || action === "browser.close",
      sideEffects: externallyConsequential ? ["web_interaction"] : ["browser_state"],
      retryPolicy: externallyConsequential ? "manual" : "automatic",
      requiresVerification: externallyConsequential,
      parallelSafe: false,
      resources: [resource("browser.session", "exclusive")],
    };
  }

  if ([
    "desktop.frontmost_app",
    "desktop.window_bounds",
    "desktop.ui_tree",
    "desktop.ui_find",
    "desktop.screenshot",
    "desktop.screenshot_region",
    "desktop.screenshot_window",
    "desktop.ocr_window",
    "desktop.clipboard_read",
    "desktop.clipboard_info",
    "desktop.clipboard_snapshot",
    "desktop.clipboard_wait_change",
    "desktop.helper_status",
  ].includes(action)) {
    return {
      ...SAFE_READ,
      resources: action.startsWith("desktop.ui_")
        ? [resource("desktop.accessibility", "shared")]
        : action.startsWith("desktop.clipboard")
          ? [resource("desktop.clipboard", "shared")]
          : [],
    };
  }
  if (action === "desktop.helper_request_permissions") {
    return {
      riskLevel: "medium",
      idempotent: true,
      sideEffects: ["permission_prompt"],
      retryPolicy: "automatic",
      requiresVerification: false,
      parallelSafe: false,
      resources: [resource("desktop.permissions", "exclusive")],
    };
  }
  if (action === "desktop.open_app") {
    return {
      ...STATE_CHANGE,
      idempotent: true,
      retryPolicy: "automatic",
      sideEffects: ["window_focus"],
      resources: [resource("desktop.focus", "exclusive")],
    };
  }
  if (action === "desktop.clipboard_restore") {
    return {
      riskLevel: "medium",
      idempotent: true,
      sideEffects: ["clipboard_restore"],
      retryPolicy: "automatic",
      requiresVerification: false,
      parallelSafe: false,
      resources: [resource("desktop.clipboard", "exclusive")],
    };
  }
  if (action === "desktop.clipboard_copy_selection") {
    return {
      riskLevel: "medium",
      idempotent: false,
      sideEffects: ["clipboard_capture", "keyboard_input"],
      retryPolicy: "automatic",
      requiresVerification: false,
      parallelSafe: false,
      resources: [
        resource("desktop.input", "exclusive"),
        resource("desktop.clipboard", "exclusive"),
      ],
    };
  }
  if (["desktop.click", "desktop.type", "desktop.key", "desktop.click_element", "desktop.clipboard_write"].includes(action)) {
    return {
      riskLevel: "high",
      idempotent: false,
      sideEffects: [action === "desktop.click_element" || action === "desktop.click" ? "pointer_input" : "keyboard_or_clipboard_input"],
      retryPolicy: "manual",
      requiresVerification: true,
      parallelSafe: false,
      resources:
        action === "desktop.clipboard_write"
          ? [resource("desktop.clipboard", "exclusive")]
          : action === "desktop.type"
            ? [
                resource("desktop.input", "exclusive"),
                resource("desktop.clipboard", "exclusive"),
              ]
            : [resource("desktop.input", "exclusive")],
    };
  }

  return { ...STATE_CHANGE };
}

export function summarizeActionContract(contract: ActionContract) {
  return {
    riskLevel: contract.riskLevel,
    idempotent: contract.idempotent,
    sideEffects: contract.sideEffects,
    retryPolicy: contract.retryPolicy,
    requiresVerification: contract.requiresVerification,
    parallelSafe: contract.parallelSafe,
    resources: contract.resources,
  };
}
