import { runtimeStatePath } from "../runtime/runtimePaths.js";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";

export function configuredRoots(): string[] {
  return (process.env.ALLOWED_DIRECTORIES ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => path.resolve(value));
}

export function runtimeOwnedRoots(): string[] {
  const exposeStaging =
    (process.env.TASK_STAGING_EXPOSE_TO_FS ?? "true").trim().toLowerCase() !==
    "false";
  if (!exposeStaging) return [];

  return [
    path.resolve(
      process.env.TASK_STAGING_DIR?.trim() ||
        runtimeStatePath("staging"),
    ),
  ];
}

export function effectiveRoots(): string[] {
  return [...new Set([...configuredRoots(), ...runtimeOwnedRoots()])];
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function realConfiguredRoots(): Promise<string[]> {
  const roots = effectiveRoots();
  if (roots.length === 0) {
    throw new Error(
      "No ALLOWED_DIRECTORIES or runtime-owned staging roots are configured. Refusing filesystem access.",
    );
  }

  const resolved: string[] = [];
  for (const root of roots) {
    try {
      resolved.push(await fs.realpath(root));
    } catch {
      // Ignore missing configured roots; another configured root may still be valid.
    }
  }

  if (resolved.length === 0) {
    throw new Error("None of the configured ALLOWED_DIRECTORIES exist.");
  }
  return resolved;
}

export async function assertAllowedExistingPath(inputPath: string): Promise<string> {
  const roots = await realConfiguredRoots();
  const requested = path.resolve(inputPath);

  let realRequested: string;
  try {
    realRequested = await fs.realpath(requested);
  } catch {
    throw new Error("Path does not exist.");
  }

  if (roots.some((root) => isWithin(root, realRequested))) {
    return realRequested;
  }

  throw new Error("Access denied: path is outside ALLOWED_DIRECTORIES.");
}

export async function assertAllowedTargetPath(inputPath: string): Promise<string> {
  const roots = await realConfiguredRoots();
  const requested = path.resolve(inputPath);

  let exists = false;
  try {
    await fs.lstat(requested);
    exists = true;
  } catch {
    exists = false;
  }

  // Existing targets must resolve inside an allowed root, including symlinks.
  if (exists) {
    return await assertAllowedExistingPath(requested);
  }

  // For a new path, validate the nearest existing ancestor after resolving symlinks.
  let ancestor = path.dirname(requested);
  while (true) {
    try {
      const realAncestor = await fs.realpath(ancestor);
      if (!roots.some((root) => isWithin(root, realAncestor))) {
        throw new Error("Access denied: target parent is outside ALLOWED_DIRECTORIES.");
      }

      const relativeTail = path.relative(ancestor, requested);
      if (relativeTail.startsWith("..") || path.isAbsolute(relativeTail)) {
        throw new Error("Access denied: invalid target path.");
      }

      return path.resolve(realAncestor, relativeTail);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Access denied")) throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) break;
      ancestor = parent;
    }
  }

  throw new Error("Access denied: could not resolve an allowed parent directory.");
}

// Backward-compatible alias used by the original read-only tools.
export const assertAllowedPath = assertAllowedExistingPath;
