import {
  executeRoutedAction,
  validateRoutedAction,
} from "../router/actionRouter.js";

type JsonObject = Record<string, unknown>;

export const PRIMITIVE_ABI_VERSION = 1;

export type PrimitiveStability =
  | "experimental"
  | "candidate"
  | "stable"
  | "deprecated";

export type PrimitiveTier = "core" | "admin" | "privileged";

type PrimitiveOpMetadata = {
  deprecated?: boolean;
  replacement?: string;
  note?: string;
};

type PrimitiveDefinition = {
  id: string;
  domain: string;
  description: string;
  ops: string[];
  abiVersion?: number;
  stability?: PrimitiveStability;
  tier?: PrimitiveTier;
  deprecated?: boolean;
  replacement?: string;
  opMetadata?: Record<string, PrimitiveOpMetadata>;
  route: (op: string, args: JsonObject) => {
    action: string;
    args: JsonObject;
  };
};

type PrimitiveAlias = {
  id: string;
  canonical: string;
  replacement: string;
  note: string;
};

const primitiveAliases: PrimitiveAlias[] = [
  {
    id: "fs.query",
    canonical: "fs.stat",
    replacement: "fs.stat",
    note: "fs.query is retained as a v0.9 compatibility alias and will not be part of the frozen v1 core ISA.",
  },
];

function requireOp(op: string, allowed: string[], primitive: string): string {
  const normalized = op.trim().toLowerCase();
  if (!allowed.includes(normalized)) {
    throw new Error(
      `Primitive ${primitive} does not support op "${op}". Allowed: ${allowed.join(", ")}.`,
    );
  }
  return normalized;
}

const definitions: PrimitiveDefinition[] = [
  {
    id: "provider.status",
    domain: "state",
    description: "Inspect provider availability and enablement.",
    ops: ["get"],
    route: (op, args) => {
      requireOp(op, ["get"], "provider.status");
      return { action: "provider.status", args };
    },
  },
  {
    id: "vision.capture",
    domain: "perception",
    description:
      "Capture the whole desktop, a rectangular region, a background application window, or a browser page.",
    ops: ["screen", "region", "window", "page"],
    route: (op, args) => {
      const normalized = requireOp(
        op,
        ["screen", "region", "window", "page"],
        "vision.capture",
      );
      const action = {
        screen: "desktop.screenshot",
        region: "desktop.screenshot_region",
        window: "desktop.screenshot_window",
        page: "browser.screenshot",
      }[normalized]!;
      return { action, args };
    },
  },
  {
    id: "vision.ocr",
    domain: "perception",
    description:
      "Read text from a background application window through native OCR without focusing the app.",
    ops: ["window"],
    route: (op, args) => {
      requireOp(op, ["window"], "vision.ocr");
      return { action: "desktop.ocr_window", args };
    },
  },
  {
    id: "ui.query",
    domain: "perception",
    description: "Inspect macOS accessibility, app focus, or window geometry.",
    ops: ["tree", "find", "frontmost", "bounds"],
    opMetadata: {
      frontmost: {
        deprecated: true,
        replacement: "app.lifecycle(frontmost)",
        note: "Retained for v0.9 compatibility; application state belongs to app.lifecycle.",
      },
      bounds: {
        deprecated: true,
        replacement: "app.lifecycle(bounds)",
        note: "Retained for v0.9 compatibility; window state belongs to app.lifecycle.",
      },
    },
    route: (op, args) => {
      const normalized = requireOp(
        op,
        ["tree", "find", "frontmost", "bounds"],
        "ui.query",
      );
      const action = {
        tree: "desktop.ui_tree",
        find: "desktop.ui_find",
        frontmost: "desktop.frontmost_app",
        bounds: "desktop.window_bounds",
      }[normalized]!;
      return { action, args };
    },
  },
  {
    id: "pointer.click",
    domain: "input",
    description: "Click by absolute coordinate or semantic UI element.",
    ops: ["coordinate", "element"],
    route: (op, args) => {
      const normalized = requireOp(op, ["coordinate", "element"], "pointer.click");
      return {
        action:
          normalized === "coordinate"
            ? "desktop.click"
            : "desktop.click_element",
        args,
      };
    },
  },
  {
    id: "keyboard.type",
    domain: "input",
    description: "Paste text into the currently focused desktop control.",
    ops: ["text"],
    route: (op, args) => {
      requireOp(op, ["text"], "keyboard.type");
      return { action: "desktop.type", args };
    },
  },
  {
    id: "keyboard.press",
    domain: "input",
    description: "Send a key or shortcut to the desktop.",
    ops: ["key"],
    route: (op, args) => {
      requireOp(op, ["key"], "keyboard.press");
      return { action: "desktop.key", args };
    },
  },
  {
    id: "clipboard",
    domain: "input",
    description:
      "Read, write, snapshot, restore, monitor, or safely copy the current desktop selection through the macOS clipboard.",
    ops: [
      "read",
      "write",
      "info",
      "snapshot",
      "restore",
      "wait_change",
      "copy_selection",
    ],
    route: (op, args) => {
      const normalized = requireOp(
        op,
        [
          "read",
          "write",
          "info",
          "snapshot",
          "restore",
          "wait_change",
          "copy_selection",
        ],
        "clipboard",
      );
      const action = {
        read: "desktop.clipboard_read",
        write: "desktop.clipboard_write",
        info: "desktop.clipboard_info",
        snapshot: "desktop.clipboard_snapshot",
        restore: "desktop.clipboard_restore",
        wait_change: "desktop.clipboard_wait_change",
        copy_selection: "desktop.clipboard_copy_selection",
      }[normalized]!;
      return { action, args };
    },
  },
  {
    id: "app.lifecycle",
    domain: "app",
    description: "Activate an app, inspect the active app/window, or manage the native macOS helper permissions.",
    ops: ["launch", "frontmost", "bounds", "helper_status", "request_permissions"],
    opMetadata: {
      helper_status: {
        deprecated: true,
        replacement: "admin.permission(status)",
        note: "Helper administration is outside the frozen core ISA.",
      },
      request_permissions: {
        deprecated: true,
        replacement: "admin.permission(request)",
        note: "Permission prompting is an administrative operation, not application lifecycle.",
      },
    },
    route: (op, args) => {
      const normalized = requireOp(
        op,
        ["launch", "frontmost", "bounds", "helper_status", "request_permissions"],
        "app.lifecycle",
      );
      const action = {
        launch: "desktop.open_app",
        frontmost: "desktop.frontmost_app",
        bounds: "desktop.window_bounds",
        helper_status: "desktop.helper_status",
        request_permissions: "desktop.helper_request_permissions",
      }[normalized]!;
      return { action, args };
    },
  },
  {
    id: "admin.permission",
    domain: "admin",
    stability: "experimental",
    tier: "admin",
    description:
      "Inspect or request native desktop-helper permissions. Administrative extension; not part of the frozen core ISA candidate.",
    ops: ["status", "request"],
    route: (op, args) => {
      const normalized = requireOp(
        op,
        ["status", "request"],
        "admin.permission",
      );
      return {
        action:
          normalized === "status"
            ? "desktop.helper_status"
            : "desktop.helper_request_permissions",
        args,
      };
    },
  },
  {
    id: "web.open",
    domain: "web",
    description: "Navigate the managed browser, optionally selecting headless mode.",
    ops: ["navigate"],
    route: (op, args) => {
      requireOp(op, ["navigate"], "web.open");
      return { action: "browser.open", args };
    },
  },
  {
    id: "web.query",
    domain: "web",
    description: "Read page content, tabs, or find visible controls.",
    ops: ["snapshot", "find", "tabs"],
    opMetadata: {
      tabs: {
        deprecated: true,
        replacement: "web.session(tabs)",
        note: "Tab/session state has one canonical home in web.session.",
      },
    },
    route: (op, args) => {
      const normalized = requireOp(op, ["snapshot", "find", "tabs"], "web.query");
      const action = {
        snapshot: "browser.snapshot",
        find: "browser.find",
        tabs: "browser.tabs",
      }[normalized]!;
      return { action, args };
    },
  },
  {
    id: "web.act",
    domain: "web",
    description: "Interact with browser controls.",
    ops: ["click", "type", "use_tab"],
    opMetadata: {
      use_tab: {
        deprecated: true,
        replacement: "web.session(use_tab)",
        note: "Tab/session state belongs to web.session; retained for v0.9 compatibility.",
      },
    },
    route: (op, args) => {
      const normalized = requireOp(
        op,
        ["click", "type", "use_tab"],
        "web.act",
      );
      const action = {
        click: "browser.click",
        type: "browser.type",
        use_tab: "browser.use_tab",
      }[normalized]!;
      return { action, args };
    },
  },
  {
    id: "web.transfer",
    domain: "web",
    description: "Transfer files into a page or capture a page screenshot.",
    ops: ["upload", "screenshot"],
    opMetadata: {
      screenshot: {
        deprecated: true,
        replacement: "vision.capture(page)",
        note: "Page capture is perception, not file transfer.",
      },
    },
    route: (op, args) => {
      const normalized = requireOp(
        op,
        ["upload", "screenshot"],
        "web.transfer",
      );
      return {
        action:
          normalized === "upload"
            ? "browser.upload"
            : "browser.screenshot",
        args,
      };
    },
  },
  {
    id: "web.session",
    domain: "web",
    description: "Inspect, switch, create, or close managed browser tabs/sessions.",
    ops: ["tabs", "use_tab", "new_tab", "close"],
    route: (op, args) => {
      const normalized = requireOp(
        op,
        ["tabs", "use_tab", "new_tab", "close"],
        "web.session",
      );
      const action = {
        tabs: "browser.tabs",
        use_tab: "browser.use_tab",
        new_tab: "browser.new_tab",
        close: "browser.close",
      }[normalized]!;
      return { action, args };
    },
  },
  {
    id: "fs.read",
    domain: "data",
    description: "Read one or many files.",
    ops: ["one", "many"],
    route: (op, args) => {
      const normalized = requireOp(op, ["one", "many"], "fs.read");
      return {
        action: normalized === "one" ? "fs.read" : "fs.read_many",
        args,
      };
    },
  },
  {
    id: "fs.write",
    domain: "data",
    description: "Write, append, edit, or batch-edit files.",
    ops: ["write", "append", "edit", "batch_edit"],
    route: (op, args) => {
      const normalized = requireOp(
        op,
        ["write", "append", "edit", "batch_edit"],
        "fs.write",
      );
      const action = {
        write: "fs.write",
        append: "fs.append",
        edit: "fs.edit",
        batch_edit: "fs.batch_edit",
      }[normalized]!;
      return { action, args };
    },
  },
  {
    id: "fs.list",
    domain: "data",
    description: "List a directory or bounded directory tree.",
    ops: ["directory", "tree"],
    route: (op, args) => {
      const normalized = requireOp(op, ["directory", "tree"], "fs.list");
      return {
        action: normalized === "directory" ? "fs.list" : "fs.tree",
        args,
      };
    },
  },
  {
    id: "fs.stat",
    domain: "data",
    description: "Read file or directory metadata.",
    ops: ["get", "info"],
    opMetadata: {
      info: {
        deprecated: true,
        replacement: "fs.stat(get)",
        note: "The transitional info op remains accepted during v0.9.",
      },
    },
    route: (op, args) => {
      requireOp(op, ["get", "info"], "fs.stat");
      return { action: "fs.info", args };
    },
  },
  {
    id: "fs.manage",
    domain: "data",
    description: "Create, move, copy, or delete filesystem paths.",
    ops: ["mkdir", "move", "copy", "delete"],
    route: (op, args) => {
      const normalized = requireOp(
        op,
        ["mkdir", "move", "copy", "delete"],
        "fs.manage",
      );
      const action = {
        mkdir: "fs.mkdir",
        move: "fs.move",
        copy: "fs.copy",
        delete: "fs.delete",
      }[normalized]!;
      return { action, args };
    },
  },
  {
    id: "fs.search",
    domain: "data",
    description: "Search file and directory names.",
    ops: ["names"],
    route: (op, args) => {
      requireOp(op, ["names"], "fs.search");
      return { action: "fs.search", args };
    },
  },
  {
    id: "process.manage",
    domain: "system",
    description: "Start, inspect, interact with, or stop managed processes.",
    ops: ["start", "list", "input", "output", "kill"],
    route: (op, args) => {
      const normalized = requireOp(
        op,
        ["start", "list", "input", "output", "kill"],
        "process.manage",
      );
      const action = {
        start: "shell.start",
        list: "shell.processes",
        input: "shell.input",
        output: "shell.output",
        kill: "shell.kill",
      }[normalized]!;
      return { action, args };
    },
  },
  {
    id: "sys.exec",
    domain: "system",
    tier: "privileged",
    description:
      "Execute a controlled shell command as a privileged escape hatch. Prefer typed primitives or Skills when available.",
    ops: ["run"],
    route: (op, args) => {
      requireOp(op, ["run"], "sys.exec");
      return { action: "shell.exec", args };
    },
  },
  {
    id: "git.query",
    domain: "git",
    description: "Inspect repository status, diff, or log.",
    ops: ["status", "diff", "log"],
    route: (op, args) => {
      const normalized = requireOp(op, ["status", "diff", "log"], "git.query");
      return { action: `git.${normalized}`, args };
    },
  },
  {
    id: "git.mutate",
    domain: "git",
    description: "Stage, commit, pull, push, or apply a patch.",
    ops: ["add", "commit", "pull", "push", "patch"],
    route: (op, args) => {
      const normalized = requireOp(
        op,
        ["add", "commit", "pull", "push", "patch"],
        "git.mutate",
      );
      return { action: `git.${normalized}`, args };
    },
  },
  {
    id: "tx.manage",
    domain: "transaction",
    description: "Create, inspect, rollback, complete, or list checkpoints.",
    ops: ["begin", "status", "list", "rollback", "complete"],
    route: (op, args) => {
      const normalized = requireOp(
        op,
        ["begin", "status", "list", "rollback", "complete"],
        "tx.manage",
      );
      return { action: `tx.${normalized}`, args };
    },
  },
];

const byId = new Map(definitions.map((definition) => [definition.id, definition]));
const aliasById = new Map(primitiveAliases.map((alias) => [alias.id, alias]));

function primitiveMetadata(definition: PrimitiveDefinition) {
  return {
    abiVersion: definition.abiVersion ?? PRIMITIVE_ABI_VERSION,
    stability: definition.stability ?? "candidate",
    tier: definition.tier ?? "core",
    deprecated: definition.deprecated ?? false,
    replacement: definition.replacement ?? null,
  } as const;
}

export function getPrimitiveCatalog() {
  const canonical = definitions.map((definition) => {
    const { route: _route, ...catalogDefinition } = definition;
    return {
      ...primitiveMetadata(definition),
      ...catalogDefinition,
      canonical: true,
    };
  });

  const aliases = primitiveAliases.map((alias) => {
    const definition = byId.get(alias.canonical);
    if (!definition) {
      throw new Error(
        `Primitive alias "${alias.id}" points to unknown primitive "${alias.canonical}".`,
      );
    }
    return {
      ...primitiveMetadata(definition),
      id: alias.id,
      domain: definition.domain,
      description: `Deprecated alias for ${alias.canonical}.`,
      ops: definition.ops,
      opMetadata: definition.opMetadata ?? {},
      stability: "deprecated" as const,
      deprecated: true,
      replacement: alias.replacement,
      canonical: false,
      canonicalId: alias.canonical,
      note: alias.note,
    };
  });

  return [...canonical, ...aliases];
}

export function routePrimitive(
  primitive: string,
  op: string,
  args: JsonObject = {},
) {
  const alias = aliasById.get(primitive);
  const canonicalPrimitive = alias?.canonical ?? primitive;
  const definition = byId.get(canonicalPrimitive);
  if (!definition) {
    throw new Error(
      `Unknown primitive "${primitive}". Call primitive_catalog for supported primitives.`,
    );
  }

  const routed = definition.route(op, args);
  const opMetadata = definition.opMetadata?.[op.trim().toLowerCase()] ?? null;
  return {
    primitive,
    canonicalPrimitive,
    aliasUsed: alias
      ? {
          deprecated: true,
          replacement: alias.replacement,
          note: alias.note,
        }
      : null,
    op,
    opMetadata,
    domain: definition.domain,
    description: definition.description,
    ...(alias
      ? {
          abiVersion: definition.abiVersion ?? PRIMITIVE_ABI_VERSION,
          stability: "deprecated" as const,
          tier: definition.tier ?? "core",
          deprecated: true,
          replacement: alias.replacement,
        }
      : primitiveMetadata(definition)),
    routedAction: routed.action,
    routedArgs: routed.args,
  };
}

export function resolvePrimitive(
  primitive: string,
  op: string,
  args: JsonObject = {},
) {
  const routed = routePrimitive(primitive, op, args);
  const validated = validateRoutedAction(routed.routedAction, routed.routedArgs);
  return {
    ...routed,
    validation: validated,
  };
}

export async function executePrimitive(
  primitive: string,
  op: string,
  args: JsonObject = {},
  options?: { bypassResourceKeys?: string[] },
) {
  const resolved = resolvePrimitive(primitive, op, args);
  const executed = await executeRoutedAction(
    resolved.routedAction,
    resolved.validation.args,
    options,
  );
  return {
    primitive,
    canonicalPrimitive: resolved.canonicalPrimitive,
    aliasUsed: resolved.aliasUsed,
    op,
    opMetadata: resolved.opMetadata,
    abiVersion: resolved.abiVersion,
    stability: resolved.stability,
    tier: resolved.tier,
    routedAction: resolved.routedAction,
    provider: executed.provider,
    contract: executed.contract,
    resourceWaitMs: executed.resourceWaitMs,
    durationMs: executed.durationMs,
    result: executed.result,
  };
}
