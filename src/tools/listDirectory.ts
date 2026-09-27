import fs from "node:fs/promises";
import { assertAllowedPath } from "../security/pathGuard.js";

export async function listDirectory(inputPath: string) {
  const safePath = await assertAllowedPath(inputPath);
  const entries = await fs.readdir(safePath, { withFileTypes: true });

  return entries
    .map((entry) => ({
      name: entry.name,
      type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other",
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
