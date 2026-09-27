import { runtimeStatePath } from "./runtime/runtimePaths.js";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { envFlag } from "./security/capabilities.js";

export type AuditStatus = "success" | "error";

export interface AuditEntry {
  timestamp: string;
  tool: string;
  status: AuditStatus;
  durationMs: number;
  args: unknown;
  error?: string;
}

function auditPath(): string {
  return process.env.AUDIT_LOG_PATH?.trim() || runtimeStatePath("audit.jsonl");
}

function summarizeSecretLike(value: unknown) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return {
    redacted: true,
    bytes: Buffer.byteLength(text ?? "", "utf8"),
    sha256: createHash("sha256").update(text ?? "").digest("hex"),
  };
}

const sensitiveKeys = new Set([
  "content",
  "old_text",
  "new_text",
  "patch",
  "input",
  "command",
  "text",
  "url",
  "result",
  "manual_result",
  "steps",
  "args",
]);

export function sanitizeAuditArgs(value: unknown, key?: string): unknown {
  if (key && sensitiveKeys.has(key)) return summarizeSecretLike(value);

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeAuditArgs(item));
  }

  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
      result[childKey] = sanitizeAuditArgs(childValue, childKey);
    }
    return result;
  }

  return value;
}

export async function appendAudit(entry: AuditEntry): Promise<void> {
  if (!envFlag("AUDIT_LOG_ENABLED", true)) return;

  const filePath = auditPath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, JSON.stringify(entry) + "\n", "utf8");
}

export async function readAuditLog(limit = 50, tool?: string): Promise<AuditEntry[]> {
  const filePath = auditPath();

  let text: string;
  try {
    text = await fs.readFile(filePath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return [];
    throw error;
  }

  const parsed: AuditEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as AuditEntry;
      if (!tool || entry.tool === tool) parsed.push(entry);
    } catch {
      // Ignore malformed historical lines rather than failing the tool.
    }
  }

  return parsed.slice(-Math.min(Math.max(limit, 1), 500)).reverse();
}

export function getAuditLogPath(): string {
  return auditPath();
}
