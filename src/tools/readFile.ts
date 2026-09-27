import fs from "node:fs/promises";
import { assertAllowedPath } from "../security/pathGuard.js";

const MAX_BYTES = 512 * 1024;

export async function readFile(inputPath: string) {
  const safePath = await assertAllowedPath(inputPath);
  const stat = await fs.stat(safePath);

  if (!stat.isFile()) throw new Error("Path is not a file.");
  if (stat.size > MAX_BYTES) {
    throw new Error(`File is too large for PoC read_file (max ${MAX_BYTES} bytes).`);
  }

  return fs.readFile(safePath, "utf8");
}
