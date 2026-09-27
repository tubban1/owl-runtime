import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { injectTestFault } from "../runtime/faultInjection.js";
import {
  assertAllowedExistingPath,
  assertAllowedTargetPath,
} from "../security/pathGuard.js";
import { requireCapability } from "../security/capabilities.js";

const DEFAULT_MAX_RESULTS = 200;

async function atomicReplaceText(
  target: string,
  content: string,
  options?: { mustNotExist?: boolean },
): Promise<void> {
  const directory = path.dirname(target);
  let existingMode: number | undefined;
  try {
    existingMode = (await fs.stat(target)).mode & 0o777;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const temp = path.join(
    directory,
    `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`,
  );

  try {
    await fs.writeFile(temp, content, {
      encoding: "utf8",
      mode: existingMode ?? 0o666,
      flag: "wx",
    });

    injectTestFault("filesystem.after_temp_before_commit");

    if (options?.mustNotExist) {
      try {
        await fs.link(temp, target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new Error("File already exists and overwrite=false.");
        }
        throw error;
      }
      await fs.rm(temp, { force: true });
    } else {
      await fs.rename(temp, target);
    }

    if (existingMode !== undefined) {
      await fs.chmod(target, existingMode).catch(() => undefined);
    }
  } finally {
    await fs.rm(temp, { force: true }).catch(() => undefined);
  }
}


export async function getFileInfo(inputPath: string) {
  const safePath = await assertAllowedExistingPath(inputPath);
  const stat = await fs.stat(safePath);
  return {
    path: safePath,
    type: stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other",
    size: stat.size,
    modifiedAt: stat.mtime.toISOString(),
    createdAt: stat.birthtime.toISOString(),
    mode: (stat.mode & 0o777).toString(8),
  };
}

export async function searchFiles(
  rootPath: string,
  query: string,
  maxResults = DEFAULT_MAX_RESULTS,
) {
  const root = await assertAllowedExistingPath(rootPath);
  const needle = query.toLowerCase();
  const results: Array<{ path: string; type: "file" | "directory" }> = [];

  async function walk(dir: string) {
    if (results.length >= maxResults) return;
    const entries = await fs.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (results.length >= maxResults) return;
      if (entry.isSymbolicLink()) continue;

      const fullPath = path.join(dir, entry.name);
      const relative = path.relative(root, fullPath);

      if (relative.toLowerCase().includes(needle)) {
        results.push({
          path: fullPath,
          type: entry.isDirectory() ? "directory" : "file",
        });
      }

      if (entry.isDirectory()) {
        await walk(fullPath);
      }
    }
  }

  await walk(root);
  return results;
}

export async function createDirectory(inputPath: string, recursive = true) {
  requireCapability("ALLOW_WRITE", true);
  const safePath = await assertAllowedTargetPath(inputPath);
  await fs.mkdir(safePath, { recursive });
  return { path: safePath, created: true };
}

export async function writeFile(
  inputPath: string,
  content: string,
  overwrite = true,
  createParents = true,
) {
  requireCapability("ALLOW_WRITE", true);
  const safePath = await assertAllowedTargetPath(inputPath);

  if (createParents) {
    await fs.mkdir(path.dirname(safePath), { recursive: true });
  }

  await atomicReplaceText(safePath, content, {
    mustNotExist: !overwrite,
  });
  return { path: safePath, bytes: Buffer.byteLength(content, "utf8") };
}

export async function appendFile(inputPath: string, content: string) {
  requireCapability("ALLOW_WRITE", true);
  const safePath = await assertAllowedTargetPath(inputPath);
  await fs.mkdir(path.dirname(safePath), { recursive: true });
  await fs.appendFile(safePath, content, { encoding: "utf8" });
  return { path: safePath, bytesAppended: Buffer.byteLength(content, "utf8") };
}

export async function editFile(
  inputPath: string,
  oldText: string,
  newText: string,
  replaceAll = false,
) {
  requireCapability("ALLOW_WRITE", true);
  const safePath = await assertAllowedExistingPath(inputPath);
  const original = await fs.readFile(safePath, "utf8");

  if (!original.includes(oldText)) {
    throw new Error("old_text was not found; no changes were made.");
  }

  let updated: string;
  let replacements: number;

  if (replaceAll) {
    replacements = original.split(oldText).length - 1;
    updated = original.split(oldText).join(newText);
  } else {
    replacements = 1;
    updated = original.replace(oldText, newText);
  }

  await atomicReplaceText(safePath, updated);
  return { path: safePath, replacements };
}

export async function movePath(sourcePath: string, destinationPath: string) {
  requireCapability("ALLOW_WRITE", true);
  const source = await assertAllowedExistingPath(sourcePath);
  const destination = await assertAllowedTargetPath(destinationPath);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.rename(source, destination);
  return { source, destination };
}

export async function copyPath(sourcePath: string, destinationPath: string, recursive = true) {
  requireCapability("ALLOW_WRITE", true);
  const source = await assertAllowedExistingPath(sourcePath);
  const destination = await assertAllowedTargetPath(destinationPath);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.cp(source, destination, { recursive, force: true });
  return { source, destination };
}

export async function deletePath(inputPath: string, recursive = false) {
  requireCapability("ALLOW_DELETE", false);
  const safePath = await assertAllowedExistingPath(inputPath);
  await fs.rm(safePath, { recursive, force: false });
  return { path: safePath, deleted: true };
}


const MAX_MULTI_FILE_BYTES = 512 * 1024;

export async function readMultipleFiles(paths: string[]) {
  if (paths.length === 0) throw new Error("At least one path is required.");
  if (paths.length > 50) throw new Error("read_multiple_files accepts at most 50 paths.");

  return await Promise.all(
    paths.map(async (inputPath) => {
      try {
        const safePath = await assertAllowedExistingPath(inputPath);
        const stat = await fs.stat(safePath);
        if (!stat.isFile()) throw new Error("Path is not a file.");
        if (stat.size > MAX_MULTI_FILE_BYTES) {
          throw new Error(`File is too large (max ${MAX_MULTI_FILE_BYTES} bytes).`);
        }

        return {
          path: safePath,
          ok: true as const,
          content: await fs.readFile(safePath, "utf8"),
        };
      } catch (error) {
        return {
          path: inputPath,
          ok: false as const,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  );
}

export async function listDirectoryTree(
  inputPath: string,
  depth = 2,
  maxEntriesPerDirectory = 100,
) {
  const root = await assertAllowedExistingPath(inputPath);
  const maxDepth = Math.min(Math.max(depth, 1), 8);
  const perDirectory = Math.min(Math.max(maxEntriesPerDirectory, 1), 500);

  type TreeNode = {
    name: string;
    path: string;
    type: "directory" | "file" | "other";
    children?: TreeNode[];
    truncated?: number;
  };

  async function walk(dir: string, currentDepth: number): Promise<TreeNode[]> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const visible = entries.slice(0, perDirectory);
    const nodes: TreeNode[] = [];

    for (const entry of visible) {
      if (entry.isSymbolicLink()) continue;
      const fullPath = path.join(dir, entry.name);
      const type: TreeNode["type"] = entry.isDirectory()
        ? "directory"
        : entry.isFile()
          ? "file"
          : "other";
      const node: TreeNode = { name: entry.name, path: fullPath, type };

      if (entry.isDirectory() && currentDepth < maxDepth) {
        node.children = await walk(fullPath, currentDepth + 1);
      }
      nodes.push(node);
    }

    if (entries.length > visible.length) {
      nodes.push({
        name: "[truncated]",
        path: dir,
        type: "other",
        truncated: entries.length - visible.length,
      });
    }

    return nodes;
  }

  return {
    root,
    depth: maxDepth,
    maxEntriesPerDirectory: perDirectory,
    children: await walk(root, 1),
  };
}

export async function batchEditFiles(
  edits: Array<{
    path: string;
    oldText: string;
    newText: string;
    replaceAll?: boolean;
  }>,
) {
  requireCapability("ALLOW_WRITE", true);
  if (edits.length === 0) throw new Error("At least one edit is required.");
  if (edits.length > 100) {
    throw new Error("batch_edit_files accepts at most 100 edits.");
  }

  // Multiple edits targeting the same file must compose in the order supplied.
  // Validate the complete batch in memory first; only write after every edit
  // has succeeded so a late mismatch cannot leave earlier files half-applied.
  const files = new Map<
    string,
    { original: string; updated: string }
  >();
  const results: Array<{ path: string; replacements: number }> = [];

  for (const edit of edits) {
    if (!edit.oldText) throw new Error("old_text must not be empty.");
    const safePath = await assertAllowedExistingPath(edit.path);
    let state = files.get(safePath);
    if (!state) {
      const original = await fs.readFile(safePath, "utf8");
      state = { original, updated: original };
      files.set(safePath, state);
    }

    if (!state.updated.includes(edit.oldText)) {
      throw new Error(
        `old_text was not found in ${safePath}; no files were changed.`,
      );
    }

    const replacements = edit.replaceAll
      ? state.updated.split(edit.oldText).length - 1
      : 1;
    state.updated = edit.replaceAll
      ? state.updated.split(edit.oldText).join(edit.newText)
      : state.updated.replace(edit.oldText, edit.newText);

    results.push({ path: safePath, replacements });
  }

  for (const [filePath, state] of files) {
    if (state.updated !== state.original) {
      await atomicReplaceText(filePath, state.updated);
    }
  }

  return results;
}
