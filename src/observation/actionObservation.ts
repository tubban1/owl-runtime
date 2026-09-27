import fs from "node:fs/promises";
import { browserProvider } from "../providers/browserProvider.js";
import { desktopProvider } from "../providers/desktopProvider.js";
import { getFileInfo } from "../tools/fileOps.js";
import {
  createObservation,
  type Observation,
  type ObservationEvidence,
} from "./observationAbi.js";
import {
  verifyObservation,
  type VerificationExpectation,
  type VerificationReceipt,
} from "../verification/verifier.js";

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function stringField(value: unknown, key: string): string | undefined {
  const object = asObject(value);
  const field = object?.[key];
  return typeof field === "string" && field ? field : undefined;
}

function evidenceForResult(
  result: unknown,
  fallbackKind: ObservationEvidence["kind"] = "structured",
): ObservationEvidence[] {
  const object = asObject(result);
  const evidence: ObservationEvidence[] = [];

  const path = stringField(result, "path");
  const text = stringField(result, "text");
  if (path && /\.(png|jpe?g|webp)$/i.test(path)) {
    evidence.push({ kind: "screenshot", ref: path });
  }
  if (text) {
    evidence.push({ kind: "text", summary: text.slice(0, 500) });
  }
  if (object || Array.isArray(result)) {
    evidence.push({ kind: fallbackKind });
  }
  return evidence;
}

async function observeFileMutation(
  action: string,
  args: JsonObject,
  result: unknown,
): Promise<Observation | null> {
  if (action === "fs.delete") {
    const target = stringField(result, "path") ?? stringField(args, "path");
    if (!target) return null;
    try {
      const info = await getFileInfo(target);
      return createObservation({
        channel: "file",
        provider: "filesystem",
        subject: target,
        data: { exists: true, ...info },
        evidence: [{ kind: "file_metadata" }],
      });
    } catch (error) {
      const missing =
        (error as NodeJS.ErrnoException).code === "ENOENT" ||
        (error instanceof Error && error.message === "Path does not exist.");
      if (!missing) throw error;
      return createObservation({
        channel: "file",
        provider: "filesystem",
        subject: target,
        data: { path: target, exists: false },
        evidence: [{ kind: "file_metadata", metadata: { exists: false } }],
      });
    }
  }

  const target =
    stringField(result, "path") ??
    stringField(result, "destination") ??
    stringField(args, "path") ??
    stringField(args, "destination_path");
  if (!target) return null;

  const info = await getFileInfo(target);
  return createObservation({
    channel: "file",
    provider: "filesystem",
    subject: target,
    data: { exists: true, ...info },
    evidence: [{ kind: "file_metadata", metadata: { size: info.size, type: info.type } }],
  });
}

async function observeBatchEdit(args: JsonObject): Promise<Observation | null> {
  const edits = Array.isArray(args.edits) ? args.edits : [];
  const files: JsonObject[] = [];
  for (const edit of edits) {
    const path =
      edit && typeof edit === "object"
        ? (edit as JsonObject).path
        : undefined;
    if (typeof path !== "string") continue;
    const info = await getFileInfo(path);
    files.push({ exists: true, ...info });
  }
  return createObservation({
    channel: "file",
    provider: "filesystem",
    state: "ready",
    data: { files },
    evidence: [{ kind: "file_metadata", metadata: { count: files.length } }],
  });
}

async function observeBrowserAfterMutation(): Promise<Observation> {
  const snapshot = await browserProvider.snapshot(30_000);
  return createObservation({
    channel: "web",
    provider: "browser",
    subject: snapshot.url,
    state: "ready",
    data: snapshot,
    evidence: [
      { kind: "text", summary: snapshot.text.slice(0, 500) },
      { kind: "structured", metadata: { controls: snapshot.controls.length, links: snapshot.links.length } },
    ],
  });
}

export async function observeRoutedActionOutcome(
  action: string,
  args: JsonObject,
  result: unknown,
): Promise<Observation | null> {
  if (
    [
      "fs.mkdir",
      "fs.write",
      "fs.append",
      "fs.edit",
      "fs.move",
      "fs.copy",
      "fs.delete",
    ].includes(action)
  ) {
    return await observeFileMutation(action, args, result);
  }
  if (action === "fs.batch_edit") return await observeBatchEdit(args);

  if (action === "fs.read") {
    const path = stringField(args, "path");
    return createObservation({
      channel: "file",
      provider: "filesystem",
      ...(path ? { subject: path } : {}),
      data: { path: path ?? null, content: result },
      evidence: [{ kind: "file_content", ...(path ? { ref: path } : {}) }],
    });
  }
  if (
    ["fs.read_many", "fs.list", "fs.tree", "fs.info", "fs.search"].includes(action)
  ) {
    const subject =
      stringField(args, "path") ??
      stringField(args, "root_path");
    return createObservation({
      channel: "file",
      provider: "filesystem",
      ...(subject ? { subject } : {}),
      data: result,
      evidence: evidenceForResult(result, "structured"),
    });
  }

  if (["browser.click", "browser.type", "browser.upload"].includes(action)) {
    return await observeBrowserAfterMutation();
  }
  if (
    [
      "browser.open",
      "browser.tabs",
      "browser.use_tab",
      "browser.new_tab",
      "browser.snapshot",
      "browser.find",
    ].includes(action)
  ) {
    const subject = stringField(result, "url");
    return createObservation({
      channel: "web",
      provider: "browser",
      ...(subject ? { subject } : {}),
      state: "ready",
      data: result,
      evidence: evidenceForResult(
        result,
        action === "browser.snapshot" ? "text" : "structured",
      ),
    });
  }
  if (action === "browser.screenshot") {
    return createObservation({
      channel: "web",
      provider: "browser",
      subject: stringField(result, "url"),
      data: result,
      evidence: evidenceForResult(result, "screenshot"),
    });
  }

  if (action === "desktop.helper_status") {
    return createObservation({
      channel: "environment",
      provider: "desktop",
      state: "ready",
      data: result,
      evidence: [{ kind: "system" }],
    });
  }
  if (action === "desktop.open_app") {
    const frontmost = await desktopProvider.frontmostApp();
    return createObservation({
      channel: "ui",
      provider: "desktop",
      subject: stringField(frontmost, "app"),
      state: "ready",
      data: frontmost,
      evidence: [{ kind: "system" }],
    });
  }
  if (
    [
      "desktop.frontmost_app",
      "desktop.window_bounds",
      "desktop.ui_tree",
      "desktop.ui_find",
      "desktop.clipboard_read",
      "desktop.clipboard_info",
      "desktop.clipboard_snapshot",
      "desktop.clipboard_wait_change",
    ].includes(action)
  ) {
    return createObservation({
      channel: "ui",
      provider: "desktop",
      subject:
        stringField(result, "app") ??
        stringField(args, "app_name"),
      state: "ready",
      data: result,
      evidence: evidenceForResult(
        result,
        action.startsWith("desktop.ui_") ? "accessibility" : "structured",
      ),
    });
  }
  if (
    [
      "desktop.screenshot",
      "desktop.screenshot_window",
      "desktop.screenshot_region",
      "desktop.ocr_window",
    ].includes(action)
  ) {
    return createObservation({
      channel: "ui",
      provider: "desktop",
      subject: stringField(args, "app_name"),
      state: "ready",
      data: result,
      evidence: evidenceForResult(result, "screenshot"),
    });
  }

  return null;
}

export function defaultVerificationForAction(
  action: string,
  result: unknown,
  observation: Observation | null,
): VerificationReceipt | null {
  if (!observation) return null;

  if (["fs.mkdir", "fs.append", "fs.edit", "fs.copy", "fs.move"].includes(action)) {
    return verifyObservation(observation, {
      id: `default:${action}`,
      expectations: [{ path: "data.exists", operator: "equals", expected: true }],
    });
  }

  if (action === "fs.write") {
    const bytes = asObject(result)?.bytes;
    const expectations: VerificationExpectation[] = [
      { path: "data.exists", operator: "equals", expected: true },
    ];
    if (typeof bytes === "number") {
      expectations.push({
        path: "data.size",
        operator: "equals" as const,
        expected: bytes,
      });
    }
    return verifyObservation(observation, {
      id: "default:fs.write",
      expectations,
    });
  }

  if (action === "fs.delete") {
    return verifyObservation(observation, {
      id: "default:fs.delete",
      expectations: [{ path: "data.exists", operator: "equals", expected: false }],
    });
  }

  if (action === "fs.batch_edit") {
    return verifyObservation(observation, {
      id: "default:fs.batch_edit",
      expectations: [{ path: "data.files", operator: "exists" }],
    });
  }

  return null;
}
