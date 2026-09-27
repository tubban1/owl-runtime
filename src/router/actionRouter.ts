import { z } from "zod";
import { listDirectory } from "../tools/listDirectory.js";
import { readFile } from "../tools/readFile.js";
import {
  appendFile,
  batchEditFiles,
  copyPath,
  createDirectory,
  deletePath,
  editFile,
  getFileInfo,
  listDirectoryTree,
  movePath,
  readMultipleFiles,
  searchFiles,
  writeFile,
} from "../tools/fileOps.js";
import {
  executeCommand,
  getProcessOutput,
  killProcess,
  listProcesses,
  sendProcessInput,
  startProcess,
} from "../tools/shellOps.js";
import {
  applyPatch,
  gitAdd,
  gitCommit,
  gitDiff,
  gitLog,
  gitPull,
  gitPush,
  gitStatus,
} from "../tools/gitOps.js";
import {
  beginTransaction,
  completeTransaction,
  getTransactionStatus,
  listTransactions,
  rollbackTransaction,
} from "../tools/transactionOps.js";
import { browserProvider } from "../providers/browserProvider.js";
import { desktopProvider } from "../providers/desktopProvider.js";
import { getProviderStatuses } from "../providers/registry.js";
import {
  getActionContract,
  summarizeActionContract,
} from "../runtime/actionContracts.js";
import { resourceArbiter } from "../runtime/resourceArbiter.js";
import { resolveActionWorkspaces } from "../runtime/workspaceResolver.js";
import {
  assertWorkspaceWriteAllowed,
  ensureWorkspaceWriteLease,
} from "../runtime/workspaceLeaseManager.js";
import { currentExecutionContext } from "../runtime/executionContext.js";
import { runtimeLifecycle } from "../runtime/runtimeLifecycle.js";

type JsonObject = Record<string, unknown>;

type ActionDefinition = {
  provider: string;
  description: string;
  schema: z.ZodTypeAny;
  run: (args: any) => Promise<unknown> | unknown;
  destructive?: boolean;
  openWorld?: boolean;
};

const noArgs = z.object({}).passthrough();

const actions = {
  "provider.status": {
    provider: "registry",
    description: "Inspect all provider availability and enablement.",
    schema: noArgs,
    run: async () => getProviderStatuses(),
  },

  "fs.list": {
    provider: "filesystem",
    description: "List a directory.",
    schema: z.object({ path: z.string() }),
    run: ({ path }: any) => listDirectory(path),
  },
  "fs.tree": {
    provider: "filesystem",
    description: "Read a bounded recursive directory tree.",
    schema: z.object({
      path: z.string(),
      depth: z.number().int().min(1).max(8).optional(),
      max_entries_per_directory: z.number().int().min(1).max(500).optional(),
    }),
    run: ({ path, depth, max_entries_per_directory }: any) =>
      listDirectoryTree(path, depth ?? 2, max_entries_per_directory ?? 100),
  },
  "fs.read": {
    provider: "filesystem",
    description: "Read one UTF-8 file.",
    schema: z.object({ path: z.string() }),
    run: ({ path }: any) => readFile(path),
  },
  "fs.read_many": {
    provider: "filesystem",
    description: "Read up to 50 UTF-8 files in one action.",
    schema: z.object({ paths: z.array(z.string()).min(1).max(50) }),
    run: ({ paths }: any) => readMultipleFiles(paths),
  },
  "fs.info": {
    provider: "filesystem",
    description: "Get file or directory metadata.",
    schema: z.object({ path: z.string() }),
    run: ({ path }: any) => getFileInfo(path),
  },
  "fs.search": {
    provider: "filesystem",
    description: "Search file and directory names recursively.",
    schema: z.object({
      root_path: z.string(),
      query: z.string(),
      max_results: z.number().int().min(1).max(1000).optional(),
    }),
    run: ({ root_path, query, max_results }: any) =>
      searchFiles(root_path, query, max_results),
  },
  "fs.mkdir": {
    provider: "filesystem",
    description: "Create a directory.",
    schema: z.object({ path: z.string(), recursive: z.boolean().optional() }),
    destructive: false,
    run: ({ path, recursive }: any) => createDirectory(path, recursive ?? true),
  },
  "fs.write": {
    provider: "filesystem",
    description: "Create or replace a UTF-8 file.",
    schema: z.object({
      path: z.string(),
      content: z.string(),
      overwrite: z.boolean().optional(),
      create_parents: z.boolean().optional(),
    }),
    destructive: true,
    run: ({ path, content, overwrite, create_parents }: any) =>
      writeFile(path, content, overwrite ?? true, create_parents ?? true),
  },
  "fs.append": {
    provider: "filesystem",
    description: "Append UTF-8 text to a file.",
    schema: z.object({ path: z.string(), content: z.string() }),
    destructive: true,
    run: ({ path, content }: any) => appendFile(path, content),
  },
  "fs.edit": {
    provider: "filesystem",
    description: "Perform an exact text replacement.",
    schema: z.object({
      path: z.string(),
      old_text: z.string().min(1),
      new_text: z.string(),
      replace_all: z.boolean().optional(),
    }),
    destructive: true,
    run: ({ path, old_text, new_text, replace_all }: any) =>
      editFile(path, old_text, new_text, replace_all ?? false),
  },
  "fs.batch_edit": {
    provider: "filesystem",
    description: "Validate then apply exact replacements across multiple files.",
    schema: z.object({
      edits: z.array(
        z.object({
          path: z.string(),
          old_text: z.string().min(1),
          new_text: z.string(),
          replace_all: z.boolean().optional(),
        }),
      ).min(1).max(100),
    }),
    destructive: true,
    run: ({ edits }: any) =>
      batchEditFiles(
        edits.map((edit: any) => ({
          path: edit.path,
          oldText: edit.old_text,
          newText: edit.new_text,
          replaceAll: edit.replace_all ?? false,
        })),
      ),
  },
  "fs.move": {
    provider: "filesystem",
    description: "Move or rename a path.",
    schema: z.object({ source_path: z.string(), destination_path: z.string() }),
    destructive: true,
    run: ({ source_path, destination_path }: any) => movePath(source_path, destination_path),
  },
  "fs.copy": {
    provider: "filesystem",
    description: "Copy a file or directory.",
    schema: z.object({
      source_path: z.string(),
      destination_path: z.string(),
      recursive: z.boolean().optional(),
    }),
    destructive: true,
    run: ({ source_path, destination_path, recursive }: any) =>
      copyPath(source_path, destination_path, recursive ?? true),
  },
  "fs.delete": {
    provider: "filesystem",
    description: "Delete a file or directory.",
    schema: z.object({ path: z.string(), recursive: z.boolean().optional() }),
    destructive: true,
    run: ({ path, recursive }: any) => deletePath(path, recursive ?? false),
  },

  "shell.exec": {
    provider: "shell",
    description: "Run a shell command and wait for completion.",
    schema: z.object({
      command: z.string().min(1),
      cwd: z.string(),
      timeout_ms: z.number().int().min(1000).max(600000).optional(),
      workspace_mode: z.enum(["read", "write"]).optional(),
    }),
    destructive: true,
    openWorld: true,
    run: ({ command, cwd, timeout_ms }: any) =>
      executeCommand(command, cwd, timeout_ms ?? 60000),
  },
  "shell.start": {
    provider: "shell",
    description: "Start a managed long-running process.",
    schema: z.object({
      command: z.string().min(1),
      cwd: z.string(),
      workspace_mode: z.enum(["read", "write"]).optional(),
    }),
    destructive: true,
    openWorld: true,
    run: ({ command, cwd, workspace_mode }: any) =>
      startProcess(command, cwd, workspace_mode ?? "write"),
  },
  "shell.processes": {
    provider: "shell",
    description: "List managed processes.",
    schema: noArgs,
    run: () => listProcesses(),
  },
  "shell.input": {
    provider: "shell",
    description: "Send stdin to a managed process.",
    schema: z.object({ process_id: z.string(), input: z.string() }),
    destructive: true,
    run: ({ process_id, input }: any) => sendProcessInput(process_id, input),
  },
  "shell.output": {
    provider: "shell",
    description: "Read stdout/stderr from a managed process.",
    schema: z.object({
      process_id: z.string(),
      tail_chars: z.number().int().min(1000).max(200000).optional(),
    }),
    run: ({ process_id, tail_chars }: any) =>
      getProcessOutput(process_id, tail_chars ?? 20000),
  },
  "shell.kill": {
    provider: "shell",
    description: "Stop a managed process.",
    schema: z.object({
      process_id: z.string(),
      signal: z.enum(["SIGTERM", "SIGKILL", "SIGINT"]).optional(),
    }),
    destructive: true,
    run: ({ process_id, signal }: any) => killProcess(process_id, signal ?? "SIGTERM"),
  },

  "git.status": {
    provider: "git",
    description: "Read Git status.",
    schema: z.object({ cwd: z.string() }),
    run: ({ cwd }: any) => gitStatus(cwd),
  },
  "git.diff": {
    provider: "git",
    description: "Read Git diff.",
    schema: z.object({ cwd: z.string(), staged: z.boolean().optional() }),
    run: ({ cwd, staged }: any) => gitDiff(cwd, staged ?? false),
  },
  "git.log": {
    provider: "git",
    description: "Read recent Git commits.",
    schema: z.object({
      cwd: z.string(),
      max_count: z.number().int().min(1).max(100).optional(),
    }),
    run: ({ cwd, max_count }: any) => gitLog(cwd, max_count ?? 20),
  },
  "git.add": {
    provider: "git",
    description: "Stage paths.",
    schema: z.object({ cwd: z.string(), paths: z.array(z.string()).min(1) }),
    destructive: true,
    run: ({ cwd, paths }: any) => gitAdd(cwd, paths),
  },
  "git.commit": {
    provider: "git",
    description: "Create a Git commit.",
    schema: z.object({ cwd: z.string(), message: z.string().min(1) }),
    destructive: true,
    run: ({ cwd, message }: any) => gitCommit(cwd, message),
  },
  "git.pull": {
    provider: "git",
    description: "Pull from a remote.",
    schema: z.object({
      cwd: z.string(),
      remote: z.string().optional(),
      branch: z.string().optional(),
    }),
    destructive: true,
    openWorld: true,
    run: ({ cwd, remote, branch }: any) => gitPull(cwd, remote, branch),
  },
  "git.push": {
    provider: "git",
    description: "Push to a remote.",
    schema: z.object({
      cwd: z.string(),
      remote: z.string().optional(),
      branch: z.string().optional(),
    }),
    destructive: true,
    openWorld: true,
    run: ({ cwd, remote, branch }: any) => gitPush(cwd, remote, branch),
  },
  "git.patch": {
    provider: "git",
    description: "Validate and apply a unified patch.",
    schema: z.object({ cwd: z.string(), patch: z.string().min(1) }),
    destructive: true,
    run: ({ cwd, patch }: any) => applyPatch(cwd, patch),
  },

  "tx.begin": {
    provider: "transaction",
    description: "Create a Git-backed checkpoint.",
    schema: z.object({ cwd: z.string(), label: z.string().max(200).optional() }),
    run: ({ cwd, label }: any) => beginTransaction(cwd, label ?? "computer-mcp task"),
  },
  "tx.status": {
    provider: "transaction",
    description: "Inspect a transaction.",
    schema: z.object({ transaction_id: z.string() }),
    run: ({ transaction_id }: any) => getTransactionStatus(transaction_id),
  },
  "tx.list": {
    provider: "transaction",
    description: "List recent transactions.",
    schema: z.object({ cwd: z.string().optional() }),
    run: ({ cwd }: any) => listTransactions(cwd),
  },
  "tx.rollback": {
    provider: "transaction",
    description: "Rollback an active transaction.",
    schema: z.object({ transaction_id: z.string() }),
    destructive: true,
    run: ({ transaction_id }: any) => rollbackTransaction(transaction_id),
  },
  "tx.complete": {
    provider: "transaction",
    description: "Complete an active transaction.",
    schema: z.object({
      transaction_id: z.string(),
      keep_checkpoint: z.boolean().optional(),
    }),
    destructive: true,
    run: ({ transaction_id, keep_checkpoint }: any) =>
      completeTransaction(transaction_id, keep_checkpoint ?? false),
  },

  "browser.open": {
    provider: "browser",
    description: "Open a URL in the managed browser.",
    schema: z.object({
      url: z.string().url(),
      wait_until: z.enum(["load", "domcontentloaded", "networkidle"]).optional(),
      headless: z.boolean().optional(),
    }),
    openWorld: true,
    run: ({ url, wait_until, headless }: any) =>
      browserProvider.open(url, wait_until ?? "domcontentloaded", headless),
  },
  "browser.tabs": {
    provider: "browser",
    description: "List browser tabs.",
    schema: noArgs,
    openWorld: true,
    run: () => browserProvider.listTabs(),
  },
  "browser.use_tab": {
    provider: "browser",
    description: "Switch browser tab.",
    schema: z.object({ index: z.number().int().min(0) }),
    openWorld: true,
    run: ({ index }: any) => browserProvider.useTab(index),
  },
  "browser.new_tab": {
    provider: "browser",
    description: "Create a new managed browser tab and optionally navigate it.",
    schema: z.object({
      url: z.string().url().optional(),
      wait_until: z.enum(["load", "domcontentloaded", "networkidle"]).optional(),
    }),
    openWorld: true,
    run: ({ url, wait_until }: any) =>
      browserProvider.newTab(url, wait_until ?? "domcontentloaded"),
  },
  "browser.snapshot": {
    provider: "browser",
    description: "Read visible page text, links, and controls.",
    schema: z.object({
      max_chars: z.number().int().min(1000).max(100000).optional(),
      selector: z.string().min(1).optional(),
      last: z.boolean().optional(),
    }),
    openWorld: true,
    run: ({ max_chars, selector, last }: any) =>
      browserProvider.snapshot(max_chars ?? 30000, selector, last ?? false),
  },
  "browser.click": {
    provider: "browser",
    description: "Click a Playwright selector.",
    schema: z.object({ selector: z.string().min(1) }),
    destructive: true,
    openWorld: true,
    run: ({ selector }: any) => browserProvider.click(selector),
  },
  "browser.type": {
    provider: "browser",
    description: "Fill a selector and optionally submit.",
    schema: z.object({
      selector: z.string().min(1),
      text: z.string(),
      submit: z.boolean().optional(),
    }),
    destructive: true,
    openWorld: true,
    run: ({ selector, text, submit }: any) =>
      browserProvider.type(selector, text, submit ?? false),
  },
  "browser.screenshot": {
    provider: "browser",
    description: "Save a browser screenshot.",
    schema: z.object({ path: z.string(), full_page: z.boolean().optional() }),
    openWorld: true,
    run: ({ path, full_page }: any) => browserProvider.screenshot(path, full_page ?? false),
  },
  "browser.find": {
    provider: "browser",
    description: "Find visible interactive browser elements by semantic text.",
    schema: z.object({
      query: z.string().min(1),
      max_results: z.number().int().min(1).max(100).optional(),
    }),
    openWorld: true,
    run: ({ query, max_results }: any) =>
      browserProvider.find(query, max_results ?? 20),
  },
  "browser.upload": {
    provider: "browser",
    description: "Upload local files through a browser file input.",
    schema: z.object({
      selector: z.string().min(1),
      files: z.array(z.string()).min(1).max(20),
    }),
    destructive: true,
    openWorld: true,
    run: ({ selector, files }: any) => browserProvider.upload(selector, files),
  },
  "browser.close": {
    provider: "browser",
    description: "Close the managed browser.",
    schema: noArgs,
    run: () => browserProvider.close(),
  },

  "desktop.frontmost_app": {
    provider: "desktop",
    description: "Read the frontmost macOS application.",
    schema: noArgs,
    run: () => desktopProvider.frontmostApp(),
  },
  "desktop.open_app": {
    provider: "desktop",
    description: "Activate a macOS application.",
    schema: z.object({ app_name: z.string().min(1) }),
    run: ({ app_name }: any) => desktopProvider.openApp(app_name),
  },
  "desktop.helper_status": {
    provider: "desktop",
    description: "Read the standalone Computer MCP Helper.app runtime and permission status.",
    schema: noArgs,
    run: () => desktopProvider.helperStatus(),
  },
  "desktop.helper_request_permissions": {
    provider: "desktop",
    description: "Ask macOS to grant Accessibility and Screen Recording permissions to Computer MCP Helper.app.",
    schema: noArgs,
    destructive: true,
    run: () => desktopProvider.helperRequestPermissions(),
  },
  "desktop.click": {
    provider: "desktop",
    description: "Click an absolute macOS screen coordinate.",
    schema: z.object({ x: z.number().min(0), y: z.number().min(0) }),
    destructive: true,
    run: ({ x, y }: any) => desktopProvider.click(x, y),
  },
  "desktop.type": {
    provider: "desktop",
    description: "Type into the focused macOS control using clipboard paste. Preserves a plain-text clipboard by default.",
    schema: z.object({
      text: z.string(),
      preserve_clipboard: z.boolean().optional(),
    }),
    destructive: true,
    run: ({ text, preserve_clipboard }: any) =>
      desktopProvider.type(text, preserve_clipboard ?? true),
  },
  "desktop.key": {
    provider: "desktop",
    description: "Send a key with optional modifiers.",
    schema: z.object({
      key: z.string().min(1),
      modifiers: z.array(z.enum(["command", "option", "control", "shift"])).optional(),
    }),
    destructive: true,
    run: ({ key, modifiers }: any) => desktopProvider.key(key, modifiers ?? []),
  },
  "desktop.screenshot": {
    provider: "desktop",
    description: "Save a macOS desktop screenshot.",
    schema: z.object({ path: z.string() }),
    run: ({ path }: any) => desktopProvider.screenshot(path),
  },
  "desktop.screenshot_window": {
    provider: "desktop",
    description:
      "Capture a specific application's main macOS window without bringing it to the foreground. Requires Computer MCP Helper.",
    schema: z.object({
      path: z.string(),
      app_name: z.string().min(1).optional(),
    }),
    run: ({ path, app_name }: any) =>
      desktopProvider.screenshotWindow(path, app_name),
  },
  "desktop.ocr_window": {
    provider: "desktop",
    description:
      "Capture and OCR a specific application's main macOS window without bringing it to the foreground. Requires Computer MCP Helper.",
    schema: z.object({
      path: z.string(),
      app_name: z.string().min(1).optional(),
      languages: z.array(z.string().min(2)).max(8).optional(),
    }),
    run: ({ path, app_name, languages }: any) =>
      desktopProvider.ocrWindow(path, app_name, languages ?? []),
  },
  "desktop.window_bounds": {
    provider: "desktop",
    description: "Read the front window bounds for an application.",
    schema: z.object({ app_name: z.string().min(1).optional() }),
    run: ({ app_name }: any) => desktopProvider.windowBounds(app_name),
  },
  "desktop.ui_tree": {
    provider: "desktop",
    description: "Read a bounded macOS Accessibility UI tree for an application.",
    schema: z.object({
      app_name: z.string().min(1).optional(),
      max_elements: z.number().int().min(1).max(1000).optional(),
    }),
    run: ({ app_name, max_elements }: any) =>
      desktopProvider.uiTree(app_name, max_elements ?? 300),
  },
  "desktop.ui_find": {
    provider: "desktop",
    description: "Find accessible UI elements by semantic text.",
    schema: z.object({
      query: z.string().min(1),
      app_name: z.string().min(1).optional(),
      max_results: z.number().int().min(1).max(100).optional(),
      max_elements: z.number().int().min(1).max(1000).optional(),
    }),
    run: ({ query, app_name, max_results, max_elements }: any) =>
      desktopProvider.uiFind(
        query,
        app_name,
        max_results ?? 20,
        max_elements ?? 500,
      ),
  },
  "desktop.click_element": {
    provider: "desktop",
    description: "Find an accessible UI element by semantic text and click its center.",
    schema: z.object({
      query: z.string().min(1),
      app_name: z.string().min(1).optional(),
      match_index: z.number().int().min(0).max(99).optional(),
    }),
    destructive: true,
    run: ({ query, app_name, match_index }: any) =>
      desktopProvider.clickElement(query, app_name, match_index ?? 0),
  },
  "desktop.screenshot_region": {
    provider: "desktop",
    description: "Capture a rectangular macOS screen region.",
    schema: z.object({
      path: z.string(),
      x: z.number().min(0),
      y: z.number().min(0),
      width: z.number().positive(),
      height: z.number().positive(),
    }),
    run: ({ path, x, y, width, height }: any) =>
      desktopProvider.screenshotRegion(path, x, y, width, height),
  },
  "desktop.clipboard_read": {
    provider: "desktop",
    description: "Read the macOS clipboard as text.",
    schema: noArgs,
    run: () => desktopProvider.clipboardRead(),
  },
  "desktop.clipboard_write": {
    provider: "desktop",
    description: "Write text to the macOS clipboard.",
    schema: z.object({ text: z.string() }),
    destructive: true,
    run: ({ text }: any) => desktopProvider.clipboardWrite(text),
  },
  "desktop.clipboard_info": {
    provider: "desktop",
    description: "Read macOS clipboard metadata and change counter without returning clipboard content.",
    schema: noArgs,
    run: () => desktopProvider.clipboardInfo(),
  },
  "desktop.clipboard_snapshot": {
    provider: "desktop",
    description: "Capture the current text clipboard into a short-lived in-memory snapshot token for later restore.",
    schema: noArgs,
    run: () => desktopProvider.clipboardSnapshot(),
  },
  "desktop.clipboard_restore": {
    provider: "desktop",
    description: "Restore a previously snapshotted plain-text clipboard.",
    schema: z.object({ token: z.string().min(1) }),
    destructive: true,
    run: ({ token }: any) => desktopProvider.clipboardRestore(token),
  },
  "desktop.clipboard_wait_change": {
    provider: "desktop",
    description: "Wait for the macOS clipboard change counter to advance and return newly copied text.",
    schema: z.object({
      previous_change_count: z.number().int().min(0),
      timeout_ms: z.number().int().min(100).max(30000).optional(),
      poll_ms: z.number().int().min(20).max(1000).optional(),
    }),
    run: ({ previous_change_count, timeout_ms, poll_ms }: any) =>
      desktopProvider.clipboardWaitChange(
        previous_change_count,
        timeout_ms ?? 2000,
        poll_ms ?? 50,
      ),
  },
  "desktop.clipboard_copy_selection": {
    provider: "desktop",
    description: "Press Cmd+C, capture copied text, and restore the previous plain-text clipboard when safe.",
    schema: z.object({
      timeout_ms: z.number().int().min(100).max(30000).optional(),
      restore: z.boolean().optional(),
    }),
    destructive: true,
    run: ({ timeout_ms, restore }: any) =>
      desktopProvider.clipboardCopySelection(
        timeout_ms ?? 2000,
        restore ?? true,
      ),
  },
} satisfies Record<string, ActionDefinition>;

export type RoutedActionName = keyof typeof actions;

function definitionFor(action: string): ActionDefinition {
  const definition = (actions as Record<string, ActionDefinition>)[action];
  if (!definition) {
    throw new Error(
      `Unknown routed action "${action}". Call router_catalog to inspect supported actions.`,
    );
  }
  return definition;
}

function resolvePath(root: unknown, path: string): unknown {
  const segments = path.split(".").filter(Boolean);
  let current = root;
  for (const segment of segments) {
    if (current == null || typeof current !== "object") {
      throw new Error(`Cannot resolve batch reference path "${path}".`);
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function resolveReferences(value: unknown, results: Record<string, unknown>): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => resolveReferences(item, results));
  }

  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    if (
      Object.keys(object).length === 1 &&
      typeof object.$ref === "string"
    ) {
      const [stepId, ...path] = object.$ref.split(".");
      if (!stepId || !(stepId in results)) {
        throw new Error(`Unknown batch reference "${object.$ref}".`);
      }
      return path.length ? resolvePath(results[stepId], path.join(".")) : results[stepId];
    }

    const resolved: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(object)) {
      resolved[key] = resolveReferences(child, results);
    }
    return resolved;
  }

  return value;
}

export function getRouterCatalog() {
  return Object.entries(actions).map(([name, definition]) => {
    const def = definition as ActionDefinition;
    const contract = getActionContract(name);
    return {
      action: name,
      provider: def.provider,
      description: def.description,
      destructive: def.destructive ?? false,
      openWorld: def.openWorld ?? false,
      contract: summarizeActionContract(contract),
    };
  });
}

export function validateRoutedAction(action: string, args: unknown) {
  const definition = definitionFor(action);
  const parsed = definition.schema.parse(args ?? {});
  const contract = getActionContract(action, parsed);
  return {
    action,
    provider: definition.provider,
    destructive: definition.destructive ?? false,
    openWorld: definition.openWorld ?? false,
    contract,
    args: parsed,
  };
}

export async function executeRoutedAction(
  action: string,
  args: unknown,
  options?: { bypassResourceKeys?: string[] },
) {
  const definition = definitionFor(action);
  const parsed = definition.schema.parse(args ?? {});
  const contract = getActionContract(action, parsed);
  const startedAt = Date.now();
  const executionContext = currentExecutionContext();
  const lifecycleMutation =
    contract.sideEffects.length > 0
      ? runtimeLifecycle.beginMutation(action, {
          context: executionContext,
          allowDuringDrain:
            Boolean(executionContext.taskId) ||
            ["shell.kill", "tx.complete", "tx.rollback"].includes(action),
        })
      : null;

  try {
  const bypass = new Set(options?.bypassResourceKeys ?? []);

  const workspaces = await resolveActionWorkspaces(action, parsed);
  const workspaceResources = workspaces
    .map((item) => ({
      key: `workspace:${item.workspace}`,
      mode: item.mode === "write" ? ("exclusive" as const) : ("shared" as const),
    }))
    .filter((requirement) => !bypass.has(requirement.key));
  const resources = [
    ...contract.resources.filter(
      (requirement) => !bypass.has(requirement.key),
    ),
    ...workspaceResources,
  ];
  const workspaceOwnership: Array<Record<string, unknown>> = [];
  for (const item of workspaces) {
    if (item.mode === "write") {
      if (executionContext.taskId) {
        const lease = await ensureWorkspaceWriteLease(item.workspace, {
          context: executionContext,
          purpose: `${action} via ${item.source}`,
          auto: true,
        });
        workspaceOwnership.push({
          workspace: item.workspace,
          mode: item.mode,
          leaseId: lease.id,
          ownerKey: lease.ownerKey,
          expiresAt: lease.expiresAt,
          runtimeSelf: lease.runtimeSelf,
          scope: "task",
        });
      } else {
        const allowed = await assertWorkspaceWriteAllowed(
          item.workspace,
          executionContext,
        );
        workspaceOwnership.push({
          workspace: item.workspace,
          mode: item.mode,
          leaseId: allowed.coveringLease?.id ?? null,
          ownerKey: allowed.coveringLease?.ownerKey ?? null,
          scope: "action",
        });
      }
    } else {
      workspaceOwnership.push({
        workspace: item.workspace,
        mode: item.mode,
        leaseId: null,
        scope: "action",
      });
    }
  }

  const executed = await resourceArbiter.withResources(
    action,
    resources,
    async () => await definition.run(parsed),
  );

  return {
    action,
    provider: definition.provider,
    durationMs: Date.now() - startedAt,
    resourceWaitMs: executed.lease.waitMs,
    contract: summarizeActionContract(contract),
    workspaceOwnership,
    result: executed.result,
  };
  } finally {
    if (lifecycleMutation) runtimeLifecycle.endMutation(lifecycleMutation.id);
  }
}

export async function executeActionBatch(
  steps: Array<{ id: string; action: string; args?: JsonObject }>,
  options?: { stopOnError?: boolean; dryRun?: boolean },
) {
  if (steps.length === 0) throw new Error("computer_batch requires at least one step.");
  if (steps.length > 30) throw new Error("computer_batch accepts at most 30 steps.");

  const seen = new Set<string>();
  for (const step of steps) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(step.id)) {
      throw new Error(`Invalid step id "${step.id}". Use 1-64 letters, numbers, _ or -.`);
    }
    if (seen.has(step.id)) throw new Error(`Duplicate step id "${step.id}".`);
    seen.add(step.id);
  }

  const stopOnError = options?.stopOnError ?? true;
  const outputs: Record<string, unknown> = {};
  const results: Array<Record<string, unknown>> = [];
  const batchStartedAt = Date.now();

  for (const step of steps) {
    const startedAt = Date.now();
    try {
      const resolvedArgs = resolveReferences(step.args ?? {}, outputs);
      const validated = validateRoutedAction(step.action, resolvedArgs);

      if (options?.dryRun) {
        results.push({
          id: step.id,
          ok: true,
          dryRun: true,
          action: step.action,
          provider: validated.provider,
          destructive: validated.destructive,
          openWorld: validated.openWorld,
          durationMs: Date.now() - startedAt,
        });
        outputs[step.id] = validated;
        continue;
      }

      const executed = await executeRoutedAction(step.action, resolvedArgs);
      outputs[step.id] = executed.result;
      results.push({
        id: step.id,
        ok: true,
        action: step.action,
        provider: executed.provider,
        durationMs: Date.now() - startedAt,
        result: executed.result,
      });
    } catch (error) {
      results.push({
        id: step.id,
        ok: false,
        action: step.action,
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      });
      if (stopOnError) break;
    }
  }

  const succeeded = results.filter((result) => result.ok === true).length;
  const failed = results.filter((result) => result.ok === false).length;

  return {
    ok: failed === 0,
    dryRun: options?.dryRun ?? false,
    requestedSteps: steps.length,
    executedSteps: results.length,
    succeeded,
    failed,
    durationMs: Date.now() - batchStartedAt,
    results,
  };
}
