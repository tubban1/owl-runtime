import fs from "node:fs/promises";
import path from "node:path";
import { configuredRoots } from "../security/pathGuard.js";

export type WorkspaceAccessMode = "read" | "write";

export type ResolvedWorkspace = {
  workspace: string;
  mode: WorkspaceAccessMode;
  source: string;
};

async function nearestExistingPath(input: string): Promise<string> {
  let current = path.resolve(input);
  while (true) {
    try {
      const stat = await fs.stat(current);
      return stat.isDirectory() ? current : path.dirname(current);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return current;
      current = parent;
    }
  }
}

async function detectGitRoot(start: string): Promise<string | null> {
  let current = await fs.realpath(await nearestExistingPath(start)).catch(() =>
    path.resolve(start),
  );

  while (true) {
    try {
      await fs.stat(path.join(current, ".git"));
      return current;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }
}

function inside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

async function closestAllowedRoot(candidate: string): Promise<string | null> {
  const absolute = path.resolve(candidate);
  const roots = await Promise.all(
    configuredRoots().map(async (root) => ({
      configured: path.resolve(root),
      real: await fs.realpath(root).catch(() => path.resolve(root)),
    })),
  );

  const matches = roots.filter(
    ({ configured, real }) =>
      inside(absolute, configured) || inside(absolute, real),
  );
  if (matches.length === 0) return null;
  matches.sort((a, b) => b.real.length - a.real.length);
  return matches[0]!.real;
}

export async function resolveWorkspace(
  candidate: string,
): Promise<string> {
  const absolute = path.resolve(candidate);
  const gitRoot = await detectGitRoot(absolute);
  if (gitRoot) return await fs.realpath(gitRoot).catch(() => gitRoot);

  const allowedRoot = await closestAllowedRoot(absolute);
  if (allowedRoot) return allowedRoot;

  return await fs.realpath(await nearestExistingPath(absolute)).catch(
    () => absolute,
  );
}

function stringValue(args: unknown, key: string): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const value = (args as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function shellMode(args: unknown): WorkspaceAccessMode {
  if (!args || typeof args !== "object") return "write";
  const requested = (args as Record<string, unknown>).workspace_mode;
  return requested === "read" ? "read" : "write";
}

export async function resolveActionWorkspaces(
  action: string,
  args: unknown,
): Promise<ResolvedWorkspace[]> {
  const candidates: Array<{
    path: string;
    mode: WorkspaceAccessMode;
    source: string;
  }> = [];

  const add = (
    value: string | undefined,
    mode: WorkspaceAccessMode,
    source: string,
  ) => {
    if (value) candidates.push({ path: value, mode, source });
  };

  const fsReads = new Set([
    "fs.list",
    "fs.tree",
    "fs.read",
    "fs.info",
    "fs.search",
    "fs.read_many",
  ]);
  const fsWrites = new Set([
    "fs.mkdir",
    "fs.write",
    "fs.append",
    "fs.edit",
    "fs.batch_edit",
    "fs.move",
    "fs.copy",
    "fs.delete",
  ]);

  if (fsReads.has(action) || fsWrites.has(action)) {
    const mode: WorkspaceAccessMode = fsReads.has(action) ? "read" : "write";
    if (action === "fs.search") {
      add(stringValue(args, "root_path"), mode, "root_path");
    } else if (action === "fs.read_many") {
      const paths =
        args && typeof args === "object" &&
        Array.isArray((args as Record<string, unknown>).paths)
          ? ((args as Record<string, unknown>).paths as unknown[])
          : [];
      for (const value of paths) {
        if (typeof value === "string") add(value, mode, "paths");
      }
    } else if (action === "fs.batch_edit") {
      const edits =
        args && typeof args === "object" &&
        Array.isArray((args as Record<string, unknown>).edits)
          ? ((args as Record<string, unknown>).edits as unknown[])
          : [];
      for (const edit of edits) {
        if (edit && typeof edit === "object") {
          add(
            stringValue(edit, "path"),
            "write",
            "edits.path",
          );
        }
      }
    } else if (action === "fs.move" || action === "fs.copy") {
      add(stringValue(args, "source_path"), mode, "source_path");
      add(stringValue(args, "destination_path"), "write", "destination_path");
    } else {
      add(stringValue(args, "path"), mode, "path");
    }
  }

  if (action.startsWith("git.")) {
    const mode: WorkspaceAccessMode = ["git.status", "git.diff", "git.log"].includes(
      action,
    )
      ? "read"
      : "write";
    add(stringValue(args, "cwd"), mode, "cwd");
  }

  if (action === "shell.exec" || action === "shell.start") {
    add(stringValue(args, "cwd"), shellMode(args), "cwd");
  }

  if (action === "tx.begin") {
    add(stringValue(args, "cwd"), "write", "cwd");
  }

  const resolved: ResolvedWorkspace[] = [];
  for (const candidate of candidates) {
    resolved.push({
      workspace: await resolveWorkspace(candidate.path),
      mode: candidate.mode,
      source: candidate.source,
    });
  }

  const byWorkspace = new Map<string, ResolvedWorkspace>();
  for (const item of resolved) {
    const existing = byWorkspace.get(item.workspace);
    if (!existing || item.mode === "write") {
      byWorkspace.set(item.workspace, item);
    }
  }
  return [...byWorkspace.values()];
}
